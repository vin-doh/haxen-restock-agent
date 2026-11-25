// The agent's money record: a double-entry ledger plus a payment state machine.
//
// Rules this file enforces:
//  - Every movement of money is a journal entry whose postings sum to zero per currency.
//    Debits are positive, credits negative. Amounts are integers in each token's atomic units.
//  - Each supplier payment has one idempotency key (the purchase order id). Asking to pay the
//    same order twice returns the existing payment instead of creating a second one.
//  - Payment state only moves along the allowed transitions, and only with a compare-and-set
//    on (state, version), so two processes can never advance the same payment at once.
//  - Every state change is written to an append-only event log in the same database transaction.
//  - A journal entry tied to an onchain transaction is booked at most once per (tx, kind).
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Currency = "USDT" | "cNGN" | "GHSm";

export const PAYMENT_STATES = [
  "CREATED",          // order approved, nothing sent yet
  "QUOTED",           // Textile gave a firm quote for the cNGN we need
  "SWAP_SUBMITTING",  // about to send approve+swap; if we crash here, ask Textile whether it filled
  "SWAPPED",          // USD₮ -> cNGN conversion confirmed onchain and booked
  "PAY_SUBMITTING",   // about to send the cNGN transfer; if we crash here, look for the Transfer log
  "PAID",             // supplier received cNGN, confirmed onchain and booked
  "RECONCILED",       // reconciler matched our record to the chain
  "BLOCKED",          // the owner's limits stopped it (cap, revoked or expired session, disallowed call)
  "FAILED",           // gave up; see error. Never silently retried.
] as const;
export type PaymentState = (typeof PAYMENT_STATES)[number];

const TRANSITIONS: Record<PaymentState, readonly PaymentState[]> = {
  CREATED: ["QUOTED", "SWAPPED", "BLOCKED", "FAILED"], // straight to SWAPPED when the supplier takes USD₮ (no conversion)
  QUOTED: ["SWAP_SUBMITTING", "CREATED", "BLOCKED", "FAILED"], // back to CREATED when a quote expires unused
  SWAP_SUBMITTING: ["SWAPPED", "CREATED", "BLOCKED", "FAILED"], // CREATED only when Textile confirms it never filled
  SWAPPED: ["PAY_SUBMITTING", "BLOCKED"],
  PAY_SUBMITTING: ["PAID", "SWAPPED", "BLOCKED", "FAILED"], // SWAPPED only when the chain shows no transfer
  PAID: ["RECONCILED"],
  RECONCILED: [],
  BLOCKED: ["CREATED", "SWAPPED"], // owner raised the cap or granted a new session; resume where it stopped
  FAILED: [],
};

export function canTransition(from: PaymentState, to: PaymentState): boolean {
  return TRANSITIONS[from].includes(to);
}

export type Payment = {
  id: string;
  purchaseOrderId: string;
  supplierId: string;
  supplierAddress: string;
  currency: Currency;
  amount: bigint;
  state: PaymentState;
  version: number;
  usdtSpent: bigint | null;
  rfqId: string | null;
  swapTx: string | null;
  payTx: string | null;
  payFromBlock: bigint | null;
  /** Block the swap was sent after, and the minimum it must deliver: what crash recovery searches the chain for. */
  swapFromBlock: bigint | null;
  fxMinOut: bigint | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

export type Posting = { account: string; currency: Currency; amount: bigint };

export class LedgerError extends Error {}
export class StaleStateError extends LedgerError {}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS journal (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  payment_id TEXT,
  tx_hash TEXT,
  memo TEXT,
  created_at TEXT NOT NULL
);
-- One booking per onchain transaction and kind: replaying a receipt can never double-count.
CREATE UNIQUE INDEX IF NOT EXISTS journal_tx_kind ON journal(tx_hash, kind) WHERE tx_hash IS NOT NULL;
CREATE TABLE IF NOT EXISTS postings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  journal_id INTEGER NOT NULL REFERENCES journal(id),
  account TEXT NOT NULL,
  currency TEXT NOT NULL,
  amount TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS postings_account ON postings(account, currency);
CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  purchase_order_id TEXT NOT NULL UNIQUE,
  supplier_id TEXT NOT NULL,
  supplier_address TEXT NOT NULL,
  currency TEXT NOT NULL,
  amount TEXT NOT NULL,
  state TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  usdt_spent TEXT,
  rfq_id TEXT,
  rfq_claim TEXT,
  swap_tx TEXT,
  pay_tx TEXT,
  pay_from_block TEXT,
  swap_from_block TEXT,
  fx_min_out TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- Every transaction the agent sends, so the reconciler can tell our fees from someone else's movement.
CREATE TABLE IF NOT EXISTS wallet_txs (
  tx_hash TEXT PRIMARY KEY,
  payment_id TEXT,
  purpose TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS payment_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id TEXT NOT NULL REFERENCES payments(id),
  from_state TEXT,
  to_state TEXT NOT NULL,
  detail TEXT,
  at TEXT NOT NULL
);
-- The audit trail is append-only.
CREATE TRIGGER IF NOT EXISTS payment_events_no_update BEFORE UPDATE ON payment_events
  BEGIN SELECT RAISE(ABORT, 'payment_events is append-only'); END;
CREATE TRIGGER IF NOT EXISTS payment_events_no_delete BEFORE DELETE ON payment_events
  BEGIN SELECT RAISE(ABORT, 'payment_events is append-only'); END;
CREATE TRIGGER IF NOT EXISTS postings_no_update BEFORE UPDATE ON postings
  BEGIN SELECT RAISE(ABORT, 'postings are immutable; book a correcting entry instead'); END;
CREATE TRIGGER IF NOT EXISTS postings_no_delete BEFORE DELETE ON postings
  BEGIN SELECT RAISE(ABORT, 'postings are immutable; book a correcting entry instead'); END;
`;

type Row = Record<string, unknown>;

export class Ledger {
  readonly db: DatabaseSync;
  private readonly now: () => string;

  constructor(path: string, opts: { now?: () => string } = {}) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
    this.now = opts.now ?? (() => new Date().toISOString());
  }

  close(): void {
    this.db.close();
  }

  /** Runs fn inside one SQLite transaction (BEGIN IMMEDIATE takes the write lock up front). */
  tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  // ---------- journal ----------

  /**
   * Books a balanced journal entry. Returns the new journal id, or null if an entry for
   * the same (txHash, kind) already exists (the booking is idempotent per onchain tx).
   */
  book(entry: { kind: string; postings: Posting[]; paymentId?: string; txHash?: string; memo?: string }): number | null {
    assertBalanced(entry.postings);
    const run = () => {
      if (entry.txHash) {
        const dup = this.db.prepare("SELECT id FROM journal WHERE tx_hash = ? AND kind = ?").get(entry.txHash.toLowerCase(), entry.kind);
        if (dup) return null;
      }
      const res = this.db
        .prepare("INSERT INTO journal (kind, payment_id, tx_hash, memo, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(entry.kind, entry.paymentId ?? null, entry.txHash?.toLowerCase() ?? null, entry.memo ?? null, this.now());
      const journalId = Number(res.lastInsertRowid);
      const ins = this.db.prepare("INSERT INTO postings (journal_id, account, currency, amount) VALUES (?, ?, ?, ?)");
      for (const p of entry.postings) ins.run(journalId, p.account, p.currency, p.amount.toString());
      return journalId;
    };
    return this.inTx() ? run() : this.tx(run);
  }

  balance(account: string, currency: Currency): bigint {
    const rows = this.db.prepare("SELECT amount FROM postings WHERE account = ? AND currency = ?").all(account, currency) as Row[];
    return rows.reduce((sum, r) => sum + BigInt(r.amount as string), 0n);
  }

  /** All account balances, for reports. Every currency's balances sum to zero by construction. */
  trialBalance(): Array<{ account: string; currency: Currency; balance: bigint }> {
    const rows = this.db.prepare("SELECT account, currency, amount FROM postings").all() as Row[];
    const acc = new Map<string, bigint>();
    for (const r of rows) {
      const key = `${r.account}\u0000${r.currency}`;
      acc.set(key, (acc.get(key) ?? 0n) + BigInt(r.amount as string));
    }
    return [...acc.entries()]
      .map(([k, balance]) => {
        const [account, currency] = k.split("\u0000") as [string, Currency];
        return { account, currency, balance };
      })
      .sort((a, b) => a.account.localeCompare(b.account) || a.currency.localeCompare(b.currency));
  }

  hasBooking(txHash: string, kind: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM journal WHERE tx_hash = ? AND kind = ?").get(txHash.toLowerCase(), kind);
  }

  // ---------- payments ----------

  /**
   * Creates the payment for a purchase order, or returns the existing one.
   * The purchase order id is the idempotency key: retries never create a second payment.
   * If the same order id comes back with different details, that is an error, not a new payment.
   */
  createPayment(p: { purchaseOrderId: string; supplierId: string; supplierAddress: string; currency: Currency; amount: bigint }): { payment: Payment; created: boolean } {
    if (p.amount <= 0n) throw new LedgerError("Payment amount must be positive");
    return this.tx(() => {
      const existing = this.getByOrder(p.purchaseOrderId);
      if (existing) {
        if (existing.amount !== p.amount || existing.supplierAddress.toLowerCase() !== p.supplierAddress.toLowerCase() || existing.currency !== p.currency) {
          throw new LedgerError(`Order ${p.purchaseOrderId} already has a payment with different details; refusing to create a second one`);
        }
        return { payment: existing, created: false };
      }
      const id = `pay_${p.purchaseOrderId}`;
      const at = this.now();
      this.db
        .prepare(
          `INSERT INTO payments (id, purchase_order_id, supplier_id, supplier_address, currency, amount, state, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'CREATED', 0, ?, ?)`,
        )
        .run(id, p.purchaseOrderId, p.supplierId, p.supplierAddress, p.currency, p.amount.toString(), at, at);
      this.db.prepare("INSERT INTO payment_events (payment_id, from_state, to_state, detail, at) VALUES (?, NULL, 'CREATED', ?, ?)").run(id, "order approved", at);
      return { payment: this.get(id)!, created: true };
    });
  }

  get(id: string): Payment | null {
    const r = this.db.prepare("SELECT * FROM payments WHERE id = ?").get(id) as Row | undefined;
    return r ? toPayment(r) : null;
  }

  getByOrder(orderId: string): Payment | null {
    const r = this.db.prepare("SELECT * FROM payments WHERE purchase_order_id = ?").get(orderId) as Row | undefined;
    return r ? toPayment(r) : null;
  }

  list(states?: PaymentState[]): Payment[] {
    const rows = (states?.length
      ? this.db.prepare(`SELECT * FROM payments WHERE state IN (${states.map(() => "?").join(",")}) ORDER BY created_at`).all(...states)
      : this.db.prepare("SELECT * FROM payments ORDER BY created_at").all()) as Row[];
    return rows.map(toPayment);
  }

  rfqClaim(id: string): string | null {
    const r = this.db.prepare("SELECT rfq_claim FROM payments WHERE id = ?").get(id) as Row | undefined;
    return (r?.rfq_claim as string | null) ?? null;
  }

  events(id: string): Array<{ from: string | null; to: string; detail: string | null; at: string }> {
    return (this.db.prepare("SELECT from_state, to_state, detail, at FROM payment_events WHERE payment_id = ? ORDER BY id").all(id) as Row[]).map((r) => ({
      from: (r.from_state as string | null) ?? null,
      to: r.to_state as string,
      detail: (r.detail as string | null) ?? null,
      at: r.at as string,
    }));
  }

  /**
   * Moves a payment from `expect` to `to`, compare-and-set on state and version.
   * Throws StaleStateError if someone else moved it first. `fields` are saved in the same write;
   * `book` (if given) is booked in the same database transaction, so state and money never disagree.
   */
  transition(
    payment: Payment,
    to: PaymentState,
    opts: {
      detail?: string;
      fields?: Partial<{ usdtSpent: bigint; rfqId: string; rfqClaim: string | null; swapTx: string; payTx: string; payFromBlock: bigint; swapFromBlock: bigint; fxMinOut: bigint; error: string | null }>;
      book?: Parameters<Ledger["book"]>[0];
    } = {},
  ): Payment {
    if (!canTransition(payment.state, to)) throw new LedgerError(`Illegal payment transition ${payment.state} -> ${to} (${payment.id})`);
    return this.tx(() => {
      const f = opts.fields ?? {};
      const sets: string[] = ["state = ?", "version = version + 1", "updated_at = ?"];
      const at = this.now();
      const vals: Array<string | null> = [to, at];
      const col = (name: string, v: string | null | undefined) => {
        if (v === undefined) return;
        sets.push(`${name} = ?`);
        vals.push(v);
      };
      col("usdt_spent", f.usdtSpent?.toString());
      col("rfq_id", f.rfqId);
      col("rfq_claim", f.rfqClaim === null ? null : f.rfqClaim);
      col("swap_tx", f.swapTx?.toLowerCase());
      col("pay_tx", f.payTx?.toLowerCase());
      col("pay_from_block", f.payFromBlock?.toString());
      col("swap_from_block", f.swapFromBlock?.toString());
      col("fx_min_out", f.fxMinOut?.toString());
      col("error", f.error === null ? null : f.error);
      const res = this.db
        .prepare(`UPDATE payments SET ${sets.join(", ")} WHERE id = ? AND state = ? AND version = ?`)
        .run(...vals, payment.id, payment.state, payment.version);
      if (Number(res.changes) !== 1) throw new StaleStateError(`Payment ${payment.id} changed underneath us (expected ${payment.state} v${payment.version})`);
      this.db.prepare("INSERT INTO payment_events (payment_id, from_state, to_state, detail, at) VALUES (?, ?, ?, ?, ?)").run(payment.id, payment.state, to, opts.detail ?? null, at);
      if (opts.book) this.book({ ...opts.book, paymentId: payment.id });
      return this.get(payment.id)!;
    });
  }

  // ---------- wallet transactions and settings ----------

  recordWalletTx(txHash: string, purpose: string, paymentId?: string): void {
    this.db.prepare("INSERT OR IGNORE INTO wallet_txs (tx_hash, payment_id, purpose, at) VALUES (?, ?, ?, ?)").run(txHash.toLowerCase(), paymentId ?? null, purpose, this.now());
  }

  walletTxs(): Array<{ txHash: string; paymentId: string | null; purpose: string }> {
    return (this.db.prepare("SELECT tx_hash, payment_id, purpose FROM wallet_txs ORDER BY at").all() as Row[]).map((r) => ({
      txHash: r.tx_hash as string,
      paymentId: (r.payment_id as string | null) ?? null,
      purpose: r.purpose as string,
    }));
  }

  getMeta(key: string): string | null {
    const r = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as Row | undefined;
    return (r?.value as string | undefined) ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  private inTx(): boolean {
    return this.db.isTransaction;
  }
}

export function assertBalanced(postings: Posting[]): void {
  if (postings.length < 2) throw new LedgerError("A journal entry needs at least two postings");
  const sums = new Map<Currency, bigint>();
  for (const p of postings) {
    if (p.amount === 0n) throw new LedgerError(`Zero-amount posting to ${p.account}`);
    sums.set(p.currency, (sums.get(p.currency) ?? 0n) + p.amount);
  }
  for (const [cur, sum] of sums) if (sum !== 0n) throw new LedgerError(`Unbalanced entry: ${cur} postings sum to ${sum}, not 0`);
}

function toPayment(r: Row): Payment {
  const big = (v: unknown) => (v === null || v === undefined ? null : BigInt(v as string));
  return {
    id: r.id as string,
    purchaseOrderId: r.purchase_order_id as string,
    supplierId: r.supplier_id as string,
    supplierAddress: r.supplier_address as string,
    currency: r.currency as Currency,
    amount: BigInt(r.amount as string),
    state: r.state as PaymentState,
    version: Number(r.version),
    usdtSpent: big(r.usdt_spent),
    rfqId: (r.rfq_id as string | null) ?? null,
    swapTx: (r.swap_tx as string | null) ?? null,
    payTx: (r.pay_tx as string | null) ?? null,
    payFromBlock: big(r.pay_from_block),
    swapFromBlock: big(r.swap_from_block),
    fxMinOut: big(r.fx_min_out),
    error: (r.error as string | null) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

// ---------- account names and standard entries ----------

export const ACCOUNTS = {
  wallet: "assets:agent_wallet",
  ownerEquity: "equity:owner_funding",
  fxClearing: "clearing:fx",
  networkFees: "expenses:network_fees",
  supplier: (supplierId: string) => `expenses:supplier:${supplierId}`,
  unexplained: "suspense:unexplained",
} as const;

/** USD₮ -> local stablecoin conversion: each currency balances through the FX clearing account. */
export function fxConversionPostings(usdtPaid: bigint, received: bigint, currency: Exclude<Currency, "USDT"> = "cNGN"): Posting[] {
  return [
    { account: ACCOUNTS.wallet, currency: "USDT", amount: -usdtPaid },
    { account: ACCOUNTS.fxClearing, currency: "USDT", amount: usdtPaid },
    { account: ACCOUNTS.fxClearing, currency, amount: -received },
    { account: ACCOUNTS.wallet, currency, amount: received },
  ];
}

export function supplierPaymentPostings(supplierId: string, currency: Currency, amount: bigint): Posting[] {
  return [
    { account: ACCOUNTS.wallet, currency, amount: -amount },
    { account: ACCOUNTS.supplier(supplierId), currency, amount },
  ];
}
