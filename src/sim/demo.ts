// A full restock run of the REAL planner, ledger, executor and reconciler, against
// simulated Textile, wallet and chain. Used by the web demo so anyone can try the agent,
// including the failure cases, without moving real money.
import type { Address, Hex } from "viem";
import { TOKENS, atomicToWhole } from "../config.ts";
import { validateSnapshot, type InventorySnapshot } from "../inventory/source.ts";
import { ACCOUNTS, Ledger, type Payment } from "../ledger/ledger.ts";
import { PaymentExecutor, resumeBlocked } from "../payments/executor.ts";
import { reconcile, type Finding } from "../payments/reconcile.ts";
import { planRestock, type PurchaseOrder } from "../planner.ts";
import { FakeChain, FakeTextile, FakeWallet, WALLET, type WalletScript } from "./rails.ts";
import sample from "../../data/sample-inventory.json" with { type: "json" };

export const SCENARIOS = {
  normal: "Everything works",
  crash_after_swap: "Connection drops right after the swap is sent",
  crash_after_transfer: "Connection drops right after the supplier payment is sent",
  transfer_lost: "The supplier payment never reaches the chain",
  cap_hit: "The owner's onchain daily cap is too small for the payment",
  revoked: "The owner revoked the agent's session key",
} as const;
export type Scenario = keyof typeof SCENARIOS;

/** Clearly simulated supplier address. Only ever used inside this simulation. */
const SIM_SUPPLIER = "0x5151515151515151515151515151515151515151" as Address;

export type DemoInput = {
  scenario: Scenario;
  /** Units on hand per SKU, to let people change the stock picture. */
  stock?: Record<string, number>;
  /** Local guards, whole USD₮. */
  maxUsdtPerOrder?: number;
  maxUsdtPerRun?: number;
  /** NGN per USD₮ to price the simulated swap with (the web route passes Textile's live indicative rate). */
  ngnPerUsd?: number;
  attributionCode: string;
};

export type DemoStep = { kind: "plan" | "log" | "chain" | "owner" | "recover" | "result"; text: string; tx?: Hex };

export type DemoResult = {
  scenario: Scenario;
  ngnPerUsd: number;
  orders: Array<{ id: string; supplier: string; total: string; lines: Array<{ name: string; qty: number; reason: string; lineTotal: string }> }>;
  steps: DemoStep[];
  payments: Array<{ id: string; order: string; state: string; amount: string; usdtSpent: string | null; swapTx: string | null; payTx: string | null; error: string | null; events: Array<{ from: string | null; to: string; detail: string | null }> }>;
  ledger: Array<{ account: string; currency: string; balance: string }>;
  reconcile: { findings: Finding[]; balances: Array<{ currency: string; ledger: string; chain: string }> };
  supplierReceived: string;
  transactionsSent: number;
};

export function demoSnapshot(stock: Record<string, number> = {}): InventorySnapshot {
  const raw = structuredClone(sample) as unknown as { pharmacy: string; suppliers: Array<Record<string, unknown>>; items: Array<Record<string, unknown>> };
  raw.pharmacy = "Demo pharmacy (simulated)";
  for (const s of raw.suppliers) s.payoutAddress = SIM_SUPPLIER;
  for (const i of raw.items) {
    const v = stock[i.sku as string];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 10_000) i.stock = Math.floor(v);
  }
  return validateSnapshot(raw);
}

export async function runDemo(input: DemoInput): Promise<DemoResult> {
  const steps: DemoStep[] = [];
  const say = (kind: DemoStep["kind"], text: string, tx?: Hex) => steps.push({ kind, text, tx });
  const ngnPerUsd = Math.round(input.ngnPerUsd && input.ngnPerUsd > 100 && input.ngnPerUsd < 100_000 ? input.ngnPerUsd : 1440);

  const chain = new FakeChain();
  const fx = new FakeTextile();
  fx.rateNgnPerUsd = BigInt(ngnPerUsd);
  const script: WalletScript =
    input.scenario === "crash_after_swap" ? { dropAfterSend: 2 }
    : input.scenario === "crash_after_transfer" ? { dropAfterSend: 3 }
    : input.scenario === "transfer_lost" ? { failBeforeSend: 3 }
    : input.scenario === "cap_hit" ? { blockOn: { call: 3, code: "spend_limit_exceeded" } }
    : input.scenario === "revoked" ? { blockOn: { call: 1, code: "call_not_permitted" } }
    : {};
  const wallet = new FakeWallet(chain, fx, script);
  wallet.attributionInput = attributionInput(input.attributionCode);

  const ledger = new Ledger(":memory:");
  try {
    const funding = 100_000_000n; // 100 USD₮ the owner put in the wallet
    chain.mint("USDT", WALLET, funding);
    say("owner", `Owner funded the agent wallet with ${atomicToWhole(funding, 6)} USD₮ (simulated).`);

    const snapshot = demoSnapshot(input.stock);
    const orders = planRestock(snapshot, { coverDays: 14, day: new Date().toISOString().slice(0, 10) });
    if (!orders.length) say("plan", "Nothing is at or below its reorder point, so there is nothing to order.");
    for (const o of orders) say("plan", `Planned ${o.id}: ${o.lines.length} line(s) from ${o.supplier.name}, total ${fmt(o.total, "cNGN")}.`);

    const exec = new PaymentExecutor(ledger, wallet, fx.asClient(), {
      maxUsdtPerOrder: BigInt(Math.round((input.maxUsdtPerOrder ?? 60) * 1e6)),
      maxUsdtPerRun: BigInt(Math.round((input.maxUsdtPerRun ?? 100) * 1e6)),
      settleBlocks: 5n,
      log: (line) => say("log", line),
    });

    let sentBefore = 0;
    for (const o of orders) {
      const r = await exec.payOrder(o);
      for (const c of wallet.calls.slice(sentBefore)) say("chain", `Sent "${c.label}" (simulated tx)`, c.tx);
      sentBefore = wallet.calls.length;
      say("result", `${o.id}: ${r.payment.state}${r.note && r.note.toUpperCase() !== r.payment.state ? `. ${r.note}` : ""}`);
      await followUp(r.payment, o);
    }

    async function followUp(p: Payment, o: PurchaseOrder) {
      if (input.scenario === "transfer_lost" && p.state === "PAY_SUBMITTING") {
        say("recover", "Next run, after 10 more blocks: the agent searches the chain for the transfer, finds none, and only then pays.");
        chain.block += 10n;
        wallet.script = {};
        const r = await exec.advance(ledger.get(p.id)!);
        for (const c of wallet.calls.slice(sentBefore)) say("chain", `Sent "${c.label}" (simulated tx)`, c.tx);
        sentBefore = wallet.calls.length;
        say("result", `${o.id}: ${r.payment.state}`);
      }
      if (input.scenario === "cap_hit" && p.state === "BLOCKED") {
        say("owner", "The owner raises the daily cap and resumes the payment. It continues from SWAPPED, so the swap is not repeated.");
        resumeBlocked(ledger, p.id);
        wallet.script = {};
        const r = await exec.advance(ledger.get(p.id)!);
        for (const c of wallet.calls.slice(sentBefore)) say("chain", `Sent "${c.label}" (simulated tx)`, c.tx);
        sentBefore = wallet.calls.length;
        say("result", `${o.id}: ${r.payment.state}`);
      }
    }

    const report = await reconcile(ledger, chain, WALLET, input.attributionCode, { fromBlock: 0n });
    say("log", `Reconciled: ${report.findings.filter((f) => f.level === "error").length} error(s), ${report.findings.filter((f) => f.level === "warn").length} warning(s).`);

    return {
      scenario: input.scenario,
      ngnPerUsd,
      orders: orders.map((o) => ({
        id: o.id,
        supplier: o.supplier.name,
        total: fmt(o.total, "cNGN"),
        lines: o.lines.map((l) => ({ name: l.name, qty: l.qty, reason: l.reason, lineTotal: fmt(l.lineTotal, "cNGN") })),
      })),
      steps,
      payments: ledger.list().map((p) => ({
        id: p.id,
        order: p.purchaseOrderId,
        state: p.state,
        amount: fmt(p.amount, p.currency),
        usdtSpent: p.usdtSpent === null ? null : fmt(p.usdtSpent, "USDT"),
        swapTx: p.swapTx,
        payTx: p.payTx,
        error: p.error,
        events: ledger.events(p.id).map(({ from, to, detail }) => ({ from, to, detail })),
      })),
      ledger: ledger.trialBalance().map((b) => ({ account: b.account, currency: b.currency, balance: fmt(b.balance, b.currency) })),
      reconcile: {
        findings: report.findings,
        balances: report.balances.map((b) => ({ currency: b.currency, ledger: fmt(b.ledger, b.currency), chain: fmt(b.chain, b.currency) })),
      },
      supplierReceived: fmt(await chain.balance("cNGN", SIM_SUPPLIER), "cNGN"),
      transactionsSent: wallet.calls.length,
    };
  } finally {
    ledger.close();
  }
}

/** Simulated calldata carrying the same ERC-8021 tag shape Altana appends: "altana,<code>". */
function attributionInput(code: string): Hex {
  const codes = `altana,${code}`;
  return `0xabababab${Buffer.from(codes).toString("hex")}${codes.length.toString(16).padStart(2, "0")}0080218021802180218021802180218021` as Hex;
}

function fmt(v: bigint, t: keyof typeof TOKENS): string {
  return `${Number(atomicToWhole(v, TOKENS[t].decimals)).toLocaleString("en-US", { maximumFractionDigits: 6 })} ${t === "USDT" ? "USD₮" : t}`;
}

export { ACCOUNTS };
