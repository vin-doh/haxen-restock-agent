import { test } from "node:test";
import assert from "node:assert/strict";
import type { Address } from "viem";
import { ACCOUNTS, Ledger } from "../src/ledger/ledger.ts";
import { PaymentExecutor, resumeBlocked } from "../src/payments/executor.ts";
import type { PurchaseOrder } from "../src/planner.ts";
import { FakeChain, FakeTextile, FakeWallet, SUPPLIER, WALLET, type WalletScript } from "../src/sim/rails.ts";

const NGN = (n: number) => BigInt(n) * 1_000_000n;
const USD = (n: number) => BigInt(Math.round(n * 1_000_000));

function order(id = "po_test_1", total = NGN(15_000), supplierAddress: Address = SUPPLIER): PurchaseOrder {
  return {
    id,
    supplier: { id: "sup_1", name: "Supplier", country: "NG", currency: "cNGN", payoutAddress: supplierAddress, leadTimeDays: 5 },
    lines: [{ sku: "A", name: "A", qty: 10, unitPrice: "1500", lineTotal: total, reason: "test" }],
    total,
  };
}

function setup(script: WalletScript = {}, limits = { perOrder: USD(25), perRun: USD(50) }) {
  const chain = new FakeChain();
  const fx = new FakeTextile();
  const wallet = new FakeWallet(chain, fx, script);
  chain.mint("USDT", WALLET, USD(100));
  const ledger = new Ledger(":memory:");
  const exec = new PaymentExecutor(ledger, wallet, fx.asClient(), { maxUsdtPerOrder: limits.perOrder, maxUsdtPerRun: limits.perRun, settleBlocks: 5n });
  return { chain, fx, wallet, ledger, exec };
}

const supplierBalance = (chain: FakeChain) => chain.balances.cNGN.get(SUPPLIER.toLowerCase()) ?? 0n;

test("happy path: quote, approve, swap, pay, and the books agree", async () => {
  const { chain, fx, wallet, ledger, exec } = setup();
  const r = await exec.payOrder(order());
  assert.equal(r.payment.state, "PAID");
  assert.equal(supplierBalance(chain), NGN(15_000));
  assert.deepEqual(wallet.calls.map((c) => c.label), ["approve USD₮ for Textile", "Textile swap", "pay supplier sup_1"]);
  const q = fx.quotes[0]!;
  assert.equal(ledger.balance(ACCOUNTS.supplier("sup_1"), "cNGN"), NGN(15_000));
  assert.equal(ledger.balance(ACCOUNTS.wallet, "USDT"), -q.takerPays); // deposits are booked by the reconciler
  assert.equal(ledger.balance(ACCOUNTS.wallet, "cNGN"), 0n);
  assert.deepEqual(ledger.events(r.payment.id).map((e) => e.to), ["CREATED", "QUOTED", "SWAP_SUBMITTING", "SWAPPED", "PAY_SUBMITTING", "PAID"]);
});

test("running the same order again never pays twice", async () => {
  const { chain, wallet, exec } = setup();
  await exec.payOrder(order());
  const sent = wallet.executeCount;
  const again = await exec.payOrder(order());
  assert.equal(again.payment.state, "PAID");
  assert.equal(wallet.executeCount, sent);
  assert.equal(supplierBalance(chain), NGN(15_000));
});

test("crash after the swap was sent: recovery asks Textile, books it once, then pays once", async () => {
  const { chain, fx, ledger, exec } = setup({ dropAfterSend: 2 }); // 2nd execute = the swap
  const r = await exec.payOrder(order());
  assert.equal(r.payment.state, "PAID");
  assert.equal(fx.quotes.length, 1, "no second quote, so no second swap");
  assert.equal(supplierBalance(chain), NGN(15_000));
  assert.equal(ledger.balance(ACCOUNTS.wallet, "cNGN"), 0n);
});

test("crash after the supplier transfer was sent: found onchain, not resent", async () => {
  const { chain, wallet, ledger, exec } = setup({ dropAfterSend: 3 }); // 3rd execute = the transfer
  const r = await exec.payOrder(order());
  assert.equal(r.payment.state, "PAID");
  assert.equal(wallet.executeCount, 3);
  assert.equal(supplierBalance(chain), NGN(15_000));
  assert.equal(ledger.balance(ACCOUNTS.supplier("sup_1"), "cNGN"), NGN(15_000));
});

test("transfer never landed: waits for confirmations before retrying, then pays exactly once", async () => {
  const { chain, wallet, exec } = setup({ failBeforeSend: 3 });
  const first = await exec.payOrder(order());
  assert.equal(first.payment.state, "PAY_SUBMITTING", "too soon to know; must not resend yet");
  assert.match(first.note, /not resending/);
  assert.equal(supplierBalance(chain), 0n);

  chain.block += 10n; // confirmations pass, still no transfer onchain
  wallet.script = {};
  const second = await exec.advance(first.payment);
  assert.equal(second.payment.state, "PAID");
  assert.equal(supplierBalance(chain), NGN(15_000));
  assert.equal(wallet.calls.filter((c) => c.label.startsWith("pay supplier")).length, 1);
});

test("the owner's onchain cap stops the payment; after the owner resumes it, it pays once", async () => {
  const { chain, ledger, wallet, exec } = setup({ blockOn: { call: 3, code: "spend_limit_exceeded" } });
  const r = await exec.payOrder(order());
  assert.equal(r.payment.state, "BLOCKED");
  assert.match(r.payment.error!, /blocked by session policy/);
  assert.equal(supplierBalance(chain), 0n);
  assert.ok(r.payment.swapTx, "the swap had already happened");

  const resumed = resumeBlocked(ledger, r.payment.id);
  assert.equal(resumed.state, "SWAPPED", "resumes at the payment step, not a second swap");
  wallet.script = {};
  const done = await exec.advance(resumed);
  assert.equal(done.payment.state, "PAID");
  assert.equal(supplierBalance(chain), NGN(15_000));
});

test("a revoked session blocks the agent before anything moves, and the quote is released", async () => {
  const { chain, fx, wallet, exec } = setup({ blockOn: { call: 1, code: "call_not_permitted" } });
  const r = await exec.payOrder(order());
  assert.equal(r.payment.state, "BLOCKED");
  assert.equal(wallet.calls.length, 0);
  assert.equal(supplierBalance(chain), 0n);
  assert.deepEqual(fx.cancelled, ["rfq_1"]);
});

test("local per-order limit: blocked before any transaction, quote released", async () => {
  const { fx, wallet, exec } = setup({}, { perOrder: USD(5), perRun: USD(50) });
  const r = await exec.payOrder(order()); // 15,000 NGN ≈ 10 USD₮
  assert.equal(r.payment.state, "BLOCKED");
  assert.match(r.payment.error!, /per-order limit/);
  assert.equal(wallet.executeCount, 0);
  assert.deepEqual(fx.cancelled, ["rfq_1"]);
});

test("local per-run limit applies across orders", async () => {
  const { wallet, exec } = setup({}, { perOrder: USD(25), perRun: USD(15) });
  const a = await exec.payOrder(order("po_a"));
  const b = await exec.payOrder(order("po_b"));
  assert.equal(a.payment.state, "PAID");
  assert.equal(b.payment.state, "BLOCKED");
  assert.match(b.payment.error!, /per-run limit/);
  assert.equal(wallet.calls.filter((c) => c.label.startsWith("pay supplier")).length, 1);
});

test("a swap that points at an unknown contract is refused", async () => {
  const { fx, wallet, exec } = setup();
  fx.swapTarget = "0x5555555555555555555555555555555555555555";
  const r = await exec.payOrder(order());
  assert.equal(r.payment.state, "FAILED");
  assert.equal(wallet.executeCount, 0);
});

test("no quote available: nothing sent, payment stays ready for the next run", async () => {
  const { fx, wallet, exec } = setup();
  fx.noQuote = true;
  const r = await exec.payOrder(order());
  assert.equal(r.payment.state, "CREATED");
  assert.equal(wallet.executeCount, 0);
});

test("burn and zero payout addresses are never paid", async () => {
  const { wallet, exec } = setup();
  await assert.rejects(exec.payOrder(order("po_dead", NGN(100), "0x000000000000000000000000000000000000dEaD")), /burn/);
  assert.equal(wallet.executeCount, 0);
});
