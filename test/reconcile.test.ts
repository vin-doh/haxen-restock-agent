import { test } from "node:test";
import assert from "node:assert/strict";
import type { Hex } from "viem";
import { ACCOUNTS, Ledger } from "../src/ledger/ledger.ts";
import { PaymentExecutor } from "../src/payments/executor.ts";
import { attributionNeedle, hasAttribution, reconcile } from "../src/payments/reconcile.ts";
import { FakeChain, FakeTextile, FakeWallet, SUPPLIER, WALLET } from "../src/sim/rails.ts";

const CODE = "celo_test01";

async function paidScenario() {
  const chain = new FakeChain();
  const fx = new FakeTextile();
  const wallet = new FakeWallet(chain, fx);
  chain.mint("USDT", WALLET, 100_000_000n);
  const ledger = new Ledger(":memory:");
  const exec = new PaymentExecutor(ledger, wallet, { cNGN: fx.asRail() }, { maxUsdtPerOrder: 25_000_000n, maxUsdtPerRun: 50_000_000n });
  const order = {
    id: "po_r1",
    supplier: { id: "sup_1", name: "S", country: "NG", currency: "cNGN" as const, payoutAddress: SUPPLIER, leadTimeDays: 5 },
    lines: [],
    total: 15_000_000_000n,
  };
  await exec.payOrder(order);
  return { chain, ledger };
}

test("after a clean payment: deposit and fees booked, payment reconciled, ledger equals chain", async () => {
  const { chain, ledger } = await paidScenario();
  const report = await reconcile(ledger, chain, WALLET, CODE, { fromBlock: 0n });
  const errors = report.findings.filter((f) => f.level !== "ok");
  assert.deepEqual(errors, []);
  assert.deepEqual(report.reconciled, ["po_r1"]);
  for (const b of report.balances) assert.equal(b.ledger, b.chain, `${b.currency} ledger ${b.ledger} vs chain ${b.chain}`);
  assert.equal(ledger.balance(ACCOUNTS.networkFees, "USDT"), 30_000n, "three txs x 0.01 USD₮ relay fee");
  assert.equal(ledger.getByOrder("po_r1")!.state, "RECONCILED");
});

test("reconciling twice books nothing new", async () => {
  const { chain, ledger } = await paidScenario();
  await reconcile(ledger, chain, WALLET, CODE, { fromBlock: 0n });
  const before = ledger.trialBalance();
  const again = await reconcile(ledger, chain, WALLET, CODE);
  assert.deepEqual(ledger.trialBalance(), before);
  assert.ok(again.findings.every((f) => f.level === "ok"));
});

test("money leaving in a transaction the agent did not send is flagged, not hidden", async () => {
  const { chain, ledger } = await paidScenario();
  const stranger = "0x6666666666666666666666666666666666666666";
  const tx = chain.nextHash();
  chain.move("USDT", WALLET, stranger, 5_000_000n, tx);
  const report = await reconcile(ledger, chain, WALLET, CODE, { fromBlock: 0n });
  const errs = report.findings.filter((f) => f.level === "error");
  assert.equal(errs.length, 1);
  assert.match(errs[0]!.message, /UNEXPLAINED: 5 USDT left the wallet to 0x6666/);
  assert.equal(ledger.balance(ACCOUNTS.unexplained, "USDT"), 5_000_000n);
  // Booked to suspense, so the balance check still holds and the gap is visible in one place.
  for (const b of report.balances) assert.equal(b.ledger, b.chain);
});

test("a missing attribution tag is reported", async () => {
  const { chain, ledger } = await paidScenario();
  for (const k of chain.inputs.keys()) chain.inputs.set(k, "0x1234" as Hex);
  const report = await reconcile(ledger, chain, WALLET, CODE, { fromBlock: 0n });
  assert.ok(report.findings.some((f) => f.level === "warn" && /attribution tag celo_test01 missing/.test(f.message)));
});

test("attribution: finds our code inside Altana's multi-code tag, rejects look-alikes", () => {
  const tag = (codes: string) => `${Buffer.from(codes).toString("hex")}${codes.length.toString(16).padStart(2, "0")}0080218021802180218021802180218021`;
  assert.equal(hasAttribution(`0xabcdef${tag("altana,celo_3175e01fb588")}`, "celo_3175e01fb588"), true);
  assert.equal(hasAttribution(`0x${tag("celo_3175e01fb588")}`, "celo_3175e01fb588"), true);
  assert.equal(hasAttribution(`0x${tag("altana")}`, "celo_3175e01fb588"), false);
  assert.equal(hasAttribution(`0x${Buffer.from("celo_3175e01fb588").toString("hex")}ffff`, "celo_3175e01fb588"), false);
  assert.equal(attributionNeedle("ab"), "6162020080218021802180218021802180218021");
});
