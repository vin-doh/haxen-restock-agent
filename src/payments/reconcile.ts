// Reconciliation: does our ledger agree with the chain?
//
// 1. Read every USD₮ and cNGN Transfer into or out of the wallet since the start block.
// 2. Classify each one:
//      - part of a recorded swap or supplier payment            -> matched to the booking
//      - our own tx, USD₮ out that isn't the swap itself         -> relay fee, booked to network fees
//      - coming in from outside                                  -> owner funding, booked
//      - going out in a transaction we never sent                -> UNEXPLAINED, booked to suspense and flagged
// 3. Check each PAID payment's transfer: right token, right supplier, exact amount, our attribution tag.
// 4. Compare the ledger's wallet balance with the token balance onchain, per currency.
// Anything that doesn't line up is reported, never silently corrected.
import type { Address, Hex, PublicClient } from "viem";
import { TOKENS, atomicToWhole, type TokenSymbol } from "../config.ts";
import { ACCOUNTS, type Currency, type Ledger } from "../ledger/ledger.ts";
import { TRANSFER_EVENT } from "../wallet/altana.ts";

/** Every token the agent can hold or pay with. */
export const TRACKED = ["USDT", "GHSm", "cNGN"] as const;

export type Finding = { level: "ok" | "warn" | "error"; message: string };

export type ReconcileReport = {
  fromBlock: bigint;
  toBlock: bigint;
  findings: Finding[];
  balances: Array<{ currency: Currency; ledger: bigint; chain: bigint }>;
  reconciled: string[];
};

type TransferLog = { token: TokenSymbol; txHash: Hex; logIndex: number; from: Address; to: Address; value: bigint };

export interface ChainReader {
  blockNumber(): Promise<bigint>;
  transfers(token: TokenSymbol, wallet: Address, fromBlock: bigint, toBlock: bigint): Promise<TransferLog[]>;
  balance(token: TokenSymbol, wallet: Address): Promise<bigint>;
  txInput(hash: Hex): Promise<Hex>;
  txSucceeded(hash: Hex): Promise<boolean>;
}

export function viemChainReader(client: PublicClient, chunk = 20_000n): ChainReader {
  return {
    blockNumber: () => client.getBlockNumber(),
    async transfers(token, wallet, fromBlock, toBlock) {
      const out: TransferLog[] = [];
      for (let start = fromBlock; start <= toBlock; start += chunk) {
        const end = start + chunk - 1n < toBlock ? start + chunk - 1n : toBlock;
        for (const args of [{ from: wallet }, { to: wallet }]) {
          const logs = await client.getLogs({ address: TOKENS[token].address, event: TRANSFER_EVENT, args, fromBlock: start, toBlock: end });
          for (const l of logs) {
            out.push({ token, txHash: l.transactionHash!, logIndex: l.logIndex!, from: l.args.from!, to: l.args.to!, value: l.args.value! });
          }
        }
      }
      return out;
    },
    balance: (token, wallet) =>
      client.readContract({ address: TOKENS[token].address, abi: [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] }], functionName: "balanceOf", args: [wallet] }) as Promise<bigint>,
    async txInput(hash) {
      return (await client.getTransaction({ hash })).input;
    },
    async txSucceeded(hash) {
      return (await client.getTransactionReceipt({ hash })).status === "success";
    },
  };
}

/** The ERC-8021 suffix bytes for our code, as lowercase hex without 0x. Schema 0: code, length byte, 0x00, marker. */
export function attributionNeedle(code: string): string {
  const codeHex = Buffer.from(code, "utf8").toString("hex");
  const len = code.length.toString(16).padStart(2, "0");
  return `${codeHex}${len}0080218021802180218021802180218021`;
}

/**
 * True if the transaction input carries our code inside an ERC-8021 tag. Altana sends "altana,<code>",
 * so we look for our code's bytes followed (in the same tag) by the 16-byte marker.
 */
export function hasAttribution(input: Hex, code: string): boolean {
  const hex = input.toLowerCase().replace(/^0x/, "");
  const codeHex = Buffer.from(code, "utf8").toString("hex");
  const marker = "80218021802180218021802180218021";
  let at = hex.indexOf(codeHex);
  while (at !== -1) {
    const after = hex.slice(at + codeHex.length, at + codeHex.length + 4 + marker.length);
    if (after.endsWith(marker)) return true; // code, length byte, schema byte, marker
    at = hex.indexOf(codeHex, at + 1);
  }
  return false;
}

export async function reconcile(ledger: Ledger, chain: ChainReader, wallet: Address, attributionCode: string, opts: { fromBlock?: bigint } = {}): Promise<ReconcileReport> {
  const findings: Finding[] = [];
  const startMeta = ledger.getMeta("reconcile_start_block");
  const fromBlock = opts.fromBlock ?? (startMeta ? BigInt(startMeta) : null);
  if (fromBlock === null) throw new Error('No start block. Run reconcile once with --from-block <block where the wallet was funded>.');
  if (!startMeta) ledger.setMeta("reconcile_start_block", fromBlock.toString());
  const toBlock = await chain.blockNumber();

  const payments = ledger.list();
  const ourTxs = new Map(ledger.walletTxs().map((t) => [t.txHash, t]));
  const swapByTx = new Map(payments.filter((p) => p.swapTx).map((p) => [p.swapTx!, p]));
  const payByTx = new Map(payments.filter((p) => p.payTx).map((p) => [p.payTx!, p]));
  const w = wallet.toLowerCase();

  const logs: TransferLog[] = [];
  for (const t of TRACKED) logs.push(...(await chain.transfers(t, wallet, fromBlock, toBlock)));
  // A self-transfer appears in both the from and to queries; keep one copy of each log.
  const seen = new Set<string>();
  const unique = logs.filter((l) => {
    const k = `${l.txHash}:${l.logIndex}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  // Group USD₮ fee transfers by tx so each tx's fees book once.
  const feesByTx = new Map<string, bigint>();
  const swapOut = new Map<string, bigint>();
  for (const l of unique) {
    const tx = l.txHash.toLowerCase();
    const out = l.from.toLowerCase() === w;
    const inn = l.to.toLowerCase() === w;
    if (out && inn) continue;
    const swap = swapByTx.get(tx);
    const pay = payByTx.get(tx);

    if (swap && out && l.token === "USDT") {
      // The swap's USD₮ can leave in several pieces (one per maker) plus the relay fee. Sorted out below.
      swapOut.set(tx, (swapOut.get(tx) ?? 0n) + l.value);
      continue;
    }
    if (swap && inn && l.token === swap.currency) continue; // the swap's cNGN leg
    if (pay && out && l.token === pay.currency && l.to.toLowerCase() === pay.supplierAddress.toLowerCase() && l.value === pay.amount) continue; // the supplier payment

    if (out && ourTxs.has(tx) && l.token === "USDT") {
      feesByTx.set(tx, (feesByTx.get(tx) ?? 0n) + l.value);
      continue;
    }
    if (inn) {
      const kind = `deposit:${l.logIndex}`;
      if (!ledger.hasBooking(tx, kind)) {
        ledger.book({
          kind,
          txHash: tx,
          memo: `from ${l.from}`,
          postings: [
            { account: ACCOUNTS.wallet, currency: l.token, amount: l.value },
            { account: ACCOUNTS.ownerEquity, currency: l.token, amount: -l.value },
          ],
        });
        findings.push({ level: "ok", message: `Booked incoming ${fmt(l.value, l.token)} from ${l.from} (tx ${short(tx)}) as owner funding` });
      }
      continue;
    }
    // Money left the wallet in a transaction the agent did not send, or in a shape we don't recognise.
    const kind = `unexplained:${l.logIndex}`;
    if (!ledger.hasBooking(tx, kind)) {
      ledger.book({
        kind,
        txHash: tx,
        memo: `to ${l.to}`,
        postings: [
          { account: ACCOUNTS.wallet, currency: l.token, amount: -l.value },
          { account: ACCOUNTS.unexplained, currency: l.token, amount: l.value },
        ],
      });
    }
    findings.push({ level: "error", message: `UNEXPLAINED: ${fmt(l.value, l.token)} left the wallet to ${l.to} in tx ${tx}. Not sent by this agent or not matching any payment.` });
  }

  for (const [tx, total] of swapOut) {
    const booked = swapByTx.get(tx)!.usdtSpent ?? 0n;
    if (total < booked) {
      findings.push({ level: "error", message: `Swap tx ${tx}: only ${fmt(total, "USDT")} left the wallet but the ledger booked ${fmt(booked, "USDT")}` });
    } else if (total > booked) {
      feesByTx.set(tx, (feesByTx.get(tx) ?? 0n) + (total - booked)); // the rest is the relay's fee
    }
  }

  for (const [tx, fee] of feesByTx) {
    if (!ledger.hasBooking(tx, "network_fee")) {
      ledger.book({
        kind: "network_fee",
        txHash: tx,
        memo: ourTxs.get(tx)?.purpose,
        postings: [
          { account: ACCOUNTS.wallet, currency: "USDT", amount: -fee },
          { account: ACCOUNTS.networkFees, currency: "USDT", amount: fee },
        ],
      });
      findings.push({ level: "ok", message: `Booked relay fee ${fmt(fee, "USDT")} for ${ourTxs.get(tx)?.purpose} tx ${short(tx)}` });
    }
  }

  // Each PAID payment: the transfer exists, succeeded, and carries our attribution tag.
  const reconciled: string[] = [];
  for (const p of ledger.list(["PAID"])) {
    const tx = p.payTx as Hex;
    const transfer = unique.find((l) => l.txHash.toLowerCase() === tx && l.token === p.currency && l.from.toLowerCase() === w && l.to.toLowerCase() === p.supplierAddress.toLowerCase() && l.value === p.amount);
    if (!transfer) {
      findings.push({ level: "error", message: `${p.purchaseOrderId}: no matching ${p.currency} transfer to ${p.supplierAddress} in ${tx}` });
      continue;
    }
    if (!(await chain.txSucceeded(tx))) {
      findings.push({ level: "error", message: `${p.purchaseOrderId}: payment tx ${tx} did not succeed` });
      continue;
    }
    const tagged = hasAttribution(await chain.txInput(tx), attributionCode);
    const swapTagged = p.swapTx ? hasAttribution(await chain.txInput(p.swapTx as Hex), attributionCode) : true;
    if (!tagged || !swapTagged) findings.push({ level: "warn", message: `${p.purchaseOrderId}: attribution tag ${attributionCode} missing on ${!tagged ? "payment" : "swap"} tx; it will not count for the hackathon` });
    ledger.transition(p, "RECONCILED", { detail: `transfer matched at log ${transfer.logIndex}${tagged && swapTagged ? ", tagged" : ", NOT tagged"}` });
    reconciled.push(p.purchaseOrderId);
    findings.push({ level: "ok", message: `${p.purchaseOrderId}: ${fmt(p.amount, p.currency as TokenSymbol)} to ${p.supplierAddress} matched onchain${tagged && swapTagged ? " and tagged" : ""}` });
  }

  // Ledger vs chain, per currency.
  const balances: ReconcileReport["balances"] = [];
  for (const cur of TRACKED) {
    const l = ledger.balance(ACCOUNTS.wallet, cur);
    const c = await chain.balance(cur, wallet);
    balances.push({ currency: cur, ledger: l, chain: c });
    if (l === c) findings.push({ level: "ok", message: `${cur}: ledger and chain both show ${fmt(c, cur)}` });
    else findings.push({ level: "error", message: `${cur}: ledger shows ${fmt(l, cur)} but the chain shows ${fmt(c, cur)} (difference ${fmt(c - l, cur)})` });
  }

  return { fromBlock, toBlock, findings, balances, reconciled };
}

function fmt(v: bigint, t: TokenSymbol): string {
  return `${atomicToWhole(v, TOKENS[t].decimals)} ${t}`;
}
function short(tx: string): string {
  return `${tx.slice(0, 10)}…`;
}
