import { test } from "node:test";
import assert from "node:assert/strict";
import { CONTRACTS, TOKENS } from "../src/config.ts";
import { MentoRail } from "../src/fx/mento.ts";
import { ACCOUNTS, Ledger } from "../src/ledger/ledger.ts";
import { PaymentExecutor } from "../src/payments/executor.ts";
import { reconcile } from "../src/payments/reconcile.ts";
import type { PurchaseOrder } from "../src/planner.ts";
import { FakeChain, FakeMento, FakeTextile, FakeWallet, SUPPLIER, WALLET, type WalletScript } from "../src/sim/rails.ts";

const GHS = (n: number) => BigInt(n) * 10n ** 18n;

function order(id = "po_ghs_1", total = GHS(368)): PurchaseOrder {
  return {
    id,
    supplier: { id: "sup_gh", name: "Supplier, Kumasi", country: "GH", currency: "GHSm", payoutAddress: SUPPLIER, leadTimeDays: 3 },
    lines: [{ sku: "A", name: "A", qty: 1, unitPrice: "368", lineTotal: total, reason: "test" }],
    total,
  };
}

function setup(script: WalletScript = {}) {
  const chain = new FakeChain();
  const fx = new FakeTextile();
  const mento = new FakeMento();
  const wallet = new FakeWallet(chain, fx, script, mento);
  chain.mint("USDT", WALLET, 100_000_000n);
  const ledger = new Ledger(":memory:");
  const rail = new MentoRail(mento, wallet);
  const exec = new PaymentExecutor(ledger, wallet, { GHSm: rail }, { maxUsdtPerOrder: 60_000_000n, maxUsdtPerRun: 100_000_000n, settleBlocks: 5n });
  return { chain, mento, wallet, ledger, rail, exec };
}
const supplierGhs = (chain: FakeChain) => chain.balances.GHSm.get(SUPPLIER.toLowerCase()) ?? 0n;

test("Mento plan: one transaction (approve + Router swap) whose guaranteed minimum covers the invoice, priced once", async () => {
  const { rail, mento } = setup();
  const plan = await rail.planExactOut({ taker: WALLET, buyToken: TOKENS.GHSm.address, buyAmount: GHS(368) });
  assert.ok(plan.minOut >= GHS(368));
  assert.equal(mento.byData.size, 1, "sized right first time");
  assert.equal(plan.txs.length, 1);
  assert.equal(plan.txs[0]!.calls.length, 2);
  assert.equal(plan.txs[0]!.calls[0]!.to, TOKENS.USDT.address);
  assert.equal(plan.txs[0]!.calls[1]!.to, CONTRACTS.mentoRouter);
  // Sized tightly: within 2% of the cost at the quoted rate.
  const atRate = (GHS(368) * 1_000_000n) / ((11_850_000n * 99n) / 100n) / 10n ** 12n;
  assert.ok(plan.usdtIn <= (atRate * 102n) / 100n, `usdtIn ${plan.usdtIn} vs ${atRate}`);
});

test("pays a Ghana supplier exactly the cedis owed; the small surplus stays in the wallet and the books match the chain", async () => {
  const { chain, ledger, exec } = setup();
  const r = await exec.payOrder(order());
  assert.equal(r.payment.state, "PAID");
  assert.equal(supplierGhs(chain), GHS(368));
  const report = await reconcile(ledger, chain, WALLET, "celo_test01", { fromBlock: 0n });
  assert.deepEqual(report.findings.filter((f) => f.level !== "ok"), []);
  for (const b of report.balances) assert.equal(b.ledger, b.chain, b.currency);
  assert.ok(ledger.balance(ACCOUNTS.wallet, "GHSm") >= 0n);
});

test("crash right after the swap: found on the chain, booked once, supplier paid once", async () => {
  const { chain, wallet, exec } = setup({ dropAfterSend: 1 });
  const r = await exec.payOrder(order());
  assert.equal(r.payment.state, "PAID");
  assert.equal(wallet.calls.filter((c) => c.label.startsWith("Mento")).length, 1);
  assert.equal(supplierGhs(chain), GHS(368));
});

test("an owner's cedi top-up after a lost swap is not mistaken for the swap", async () => {
  const { chain, exec, ledger } = setup({ failBeforeSend: 1 });
  const first = await exec.payOrder(order());
  assert.equal(first.payment.state, "SWAP_SUBMITTING");
  assert.match(first.note, /not resending/);
  chain.mint("GHSm", WALLET, GHS(1000)); // owner deposit, bigger than the swap's minimum
  chain.block += 10n;
  const again = await exec.advance(ledger.get(first.payment.id)!);
  assert.equal(again.payment.state, "CREATED", "the deposit spent no USD₮, so it is not the swap");
  assert.equal(supplierGhs(chain), 0n);
});

test("swap never landed: after confirmations it is retried, and the supplier is paid once", async () => {
  const { chain, wallet, exec, ledger } = setup({ failBeforeSend: 1 });
  const first = await exec.payOrder(order());
  chain.block += 10n;
  wallet.script = {};
  await exec.advance(ledger.get(first.payment.id)!); // -> CREATED
  const done = await exec.advance(ledger.get(first.payment.id)!);
  assert.equal(done.payment.state, "PAID");
  assert.equal(supplierGhs(chain), GHS(368));
});

test("a Router address that isn't Mento's is refused before anything is sent", async () => {
  const { mento, wallet, exec } = setup();
  mento.routerTarget = "0x7777777777777777777777777777777777777777";
  const r = await exec.payOrder(order());
  assert.equal(r.payment.state, "CREATED");
  assert.match(r.note, /no mento quote/);
  assert.equal(wallet.executeCount, 0);
});

test("no Mento route: nothing sent, the payment waits for the next run", async () => {
  const { mento, wallet, exec } = setup();
  mento.routeAvailable = false;
  const r = await exec.payOrder(order());
  assert.equal(r.payment.state, "CREATED");
  assert.equal(wallet.executeCount, 0);
});
