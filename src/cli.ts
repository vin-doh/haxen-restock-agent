// Command line for the owner and the agent. Run with: npm run agent -- <command>
//
//   plan                       Show what the agent would order today. Sends nothing.
//   run [--yes]                Plan, then pay each order. Without --yes it stops before sending.
//   status                     Payments, their history, and the ledger's balances.
//   reconcile [--from-block N] Match the ledger against the chain and report differences.
//   owner:grant --usdt-per-day N --ghs-per-day N [--cngn-per-day N] [--days N]   Grant the agent its session key.
//   owner:revoke               Revoke the agent's session key in one transaction.
//   owner:identity             Register (or re-register) the agent's ERC-8004 identity.
//   owner:resume <paymentId>   Put a BLOCKED payment back in line.
import { parseArgs } from "node:util";
import { privateKeyToAccount } from "viem/accounts";
import { TOKENS, atomicToWhole, readSettings, requireKey, wholeToAtomic } from "./config.ts";
import { loadDotEnv } from "./env.ts";
import { TextileClient } from "./fx/textile.ts";
import { TextileRail } from "./fx/textile-rail.ts";
import { MentoRail } from "./fx/mento.ts";
import { createMentoQuoter } from "./fx/mento-sdk.ts";
import { FileInventorySource, HaxenMedInventorySource, type InventorySource } from "./inventory/source.ts";
import { Ledger } from "./ledger/ledger.ts";
import { PaymentExecutor, resumeBlocked } from "./payments/executor.ts";
import { reconcile, viemChainReader } from "./payments/reconcile.ts";
import { planRestock, type PurchaseOrder } from "./planner.ts";
import { AltanaAgentWallet, makeAltanaClient, makePublicClient } from "./wallet/altana.ts";
import { loadSession } from "./wallet/session-store.ts";
import { grantAgentSession, ownerProofSigner, ownerWallet, revokeAgentSession } from "./wallet/owner.ts";

loadDotEnv();
const settings = readSettings();
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    yes: { type: "boolean", default: false },
    "from-block": { type: "string" },
    "usdt-per-day": { type: "string" },
    "ghs-per-day": { type: "string" },
    "cngn-per-day": { type: "string" },
    days: { type: "string", default: "14" },
    "cover-days": { type: "string", default: "14" },
    inventory: { type: "string" },
  },
});
const [command, arg] = positionals;
const log = (s: string) => console.log(s);

function inventory(): InventorySource {
  if (values.inventory) return new FileInventorySource(values.inventory);
  if (settings.inventorySource === "haxenmed") {
    if (!settings.haxenmedUrl || !settings.haxenmedApiKey) throw new Error("INVENTORY_SOURCE=haxenmed needs HAXENMED_URL and HAXENMED_API_KEY");
    return new HaxenMedInventorySource(settings.haxenmedUrl, settings.haxenmedApiKey);
  }
  return new FileInventorySource("data/sample-inventory.json");
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function printOrders(orders: PurchaseOrder[]): void {
  if (!orders.length) return log("Nothing needs restocking today.");
  for (const o of orders) {
    const cur = o.supplier.currency;
    log(`\n${o.id}  ${o.supplier.name} (${o.supplier.country}), paid in ${cur} to ${o.supplier.payoutAddress}`);
    for (const l of o.lines) log(`  ${String(l.qty).padStart(5)} x ${l.name.padEnd(28)} @ ${l.unitPrice}  = ${atomicToWhole(l.lineTotal, TOKENS[cur].decimals)} ${cur}\n          ${l.reason}`);
    log(`  TOTAL ${atomicToWhole(o.total, TOKENS[cur].decimals)} ${cur}`);
  }
}

async function main(): Promise<void> {
  switch (command) {
    case "plan": {
      const snap = await inventory().snapshot();
      log(`Stock picture for ${snap.pharmacy} at ${snap.takenAt}`);
      printOrders(planRestock(snap, { coverDays: Number(values["cover-days"]), day: today() }));
      return;
    }

    case "run": {
      const snap = await inventory().snapshot();
      const orders = planRestock(snap, { coverDays: Number(values["cover-days"]), day: today() });
      printOrders(orders);
      if (!orders.length) return;
      if (!values.yes) return log("\nDry run. Add --yes to pay these orders on Celo mainnet.");
      if (settings.inventorySource === "sample" && !values.inventory) {
        throw new Error("Refusing to pay from the bundled demo data. Use INVENTORY_SOURCE=haxenmed or --inventory <file with real suppliers>.");
      }
      const ledger = new Ledger(settings.dbPath);
      try {
        const session = loadSession(settings.sessionPath, requireKey("SESSION_PRIVATE_KEY"));
        const wallet = new AltanaAgentWallet(session, makeAltanaClient(settings.attributionCode), makePublicClient(settings.rpcUrl));
        const ownerKey = process.env.OWNER_PRIVATE_KEY;
        const fx = new TextileClient({ signProof: ownerKey ? ownerProofSigner(requireKey("OWNER_PRIVATE_KEY")) : undefined });
        // Cedis through Mento; naira through Textile.
        const rails = { GHSm: new MentoRail(await createMentoQuoter(), wallet), cNGN: new TextileRail(fx) };
        const exec = new PaymentExecutor(ledger, wallet, rails, { maxUsdtPerOrder: settings.maxUsdtPerOrder, maxUsdtPerRun: settings.maxUsdtPerRun, log });
        // Finish anything an earlier run left half-done before starting new orders.
        for (const p of ledger.list(["QUOTED", "SWAP_SUBMITTING", "SWAPPED", "PAY_SUBMITTING"])) {
          const r = await exec.advance(p);
          log(`${p.purchaseOrderId}: ${r.payment.state} ${r.note}`);
        }
        for (const o of orders) {
          const r = await exec.payOrder(o);
          log(`${o.id}: ${r.payment.state} ${r.note}`);
        }
      } finally {
        ledger.close();
      }
      return;
    }

    case "status": {
      const ledger = new Ledger(settings.dbPath);
      try {
        const payments = ledger.list();
        if (!payments.length) log("No payments yet.");
        for (const p of payments) {
          log(`\n${p.id}  ${p.state}  ${atomicToWhole(p.amount, TOKENS[p.currency].decimals)} ${p.currency} -> ${p.supplierAddress}`);
          if (p.usdtSpent !== null) log(`  USD₮ spent: ${atomicToWhole(p.usdtSpent, 6)}`);
          if (p.swapTx) log(`  swap:    https://celoscan.io/tx/${p.swapTx}`);
          if (p.payTx) log(`  payment: https://celoscan.io/tx/${p.payTx}`);
          if (p.error) log(`  error:   ${p.error}`);
          for (const e of ledger.events(p.id)) log(`  ${e.at}  ${e.from ?? "-"} -> ${e.to}${e.detail ? `  (${e.detail})` : ""}`);
        }
        log("\nLedger balances:");
        for (const b of ledger.trialBalance()) log(`  ${b.account.padEnd(32)} ${atomicToWhole(b.balance, TOKENS[b.currency].decimals).padStart(18)} ${b.currency}`);
      } finally {
        ledger.close();
      }
      return;
    }

    case "reconcile": {
      const ledger = new Ledger(settings.dbPath);
      try {
        const session = loadSession(settings.sessionPath, requireKey("SESSION_PRIVATE_KEY"));
        const report = await reconcile(ledger, viemChainReader(makePublicClient(settings.rpcUrl)), session.walletAddress, settings.attributionCode, {
          fromBlock: values["from-block"] ? BigInt(values["from-block"]) : undefined,
        });
        log(`Reconciled blocks ${report.fromBlock}..${report.toBlock}`);
        for (const f of report.findings) log(`  [${f.level.toUpperCase()}] ${f.message}`);
        if (report.findings.some((f) => f.level === "error")) process.exitCode = 2;
      } finally {
        ledger.close();
      }
      return;
    }

    case "owner:grant": {
      if (!values["usdt-per-day"] || !values["ghs-per-day"]) throw new Error("Give the daily caps: --usdt-per-day 30 --ghs-per-day 300 (add --cngn-per-day N only for naira suppliers)");
      const ownerKey = requireKey("OWNER_PRIVATE_KEY");
      log(`Owner wallet: ${privateKeyToAccount(ownerKey).address}`);
      await grantAgentSession({
        ownerKey,
        attributionCode: settings.attributionCode,
        usdtPerDay: wholeToAtomic(values["usdt-per-day"], 6),
        ghsPerDay: wholeToAtomic(values["ghs-per-day"], 18),
        cngnPerDay: values["cngn-per-day"] ? wholeToAtomic(values["cngn-per-day"], 6) : undefined,
        days: Number(values.days),
        sessionPath: settings.sessionPath,
        log,
      });
      return;
    }

    case "owner:revoke": {
      const ownerKey = requireKey("OWNER_PRIVATE_KEY");
      const session = loadSession(settings.sessionPath, requireKey("SESSION_PRIVATE_KEY"));
      const r = await revokeAgentSession({ ownerKey, attributionCode: settings.attributionCode, session });
      log(`Revoke ${r.status}: ${r.transactionHash ? `https://celoscan.io/tx/${r.transactionHash}` : "(no tx hash)"}`);
      return;
    }

    case "owner:identity": {
      const ownerKey = requireKey("OWNER_PRIVATE_KEY");
      const { signer, wallet } = ownerWallet(ownerKey);
      const out = await makeAltanaClient(settings.attributionCode).registerAgentIdentity({ wallet, signer, feeToken: TOKENS.USDT.address });
      log(JSON.stringify(out, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
      return;
    }

    case "owner:resume": {
      if (!arg) throw new Error("Usage: owner:resume <paymentId>");
      const ledger = new Ledger(settings.dbPath);
      try {
        const p = resumeBlocked(ledger, arg);
        log(`${p.id} is ${p.state} again; the next run continues it.`);
      } finally {
        ledger.close();
      }
      return;
    }

    default:
      log("Commands: plan, run [--yes], status, reconcile [--from-block N], owner:grant, owner:revoke, owner:identity, owner:resume <id>");
      if (command) process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(`Error: ${(e as Error).message}`);
  process.exitCode = 1;
});
