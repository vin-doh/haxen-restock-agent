import { test } from "node:test";
import assert from "node:assert/strict";
import { ACCOUNTS, Ledger, LedgerError, StaleStateError, fxConversionPostings } from "../src/ledger/ledger.ts";
import { hash } from "./fakes.ts";

const newLedger = () => new Ledger(":memory:");
const order = { purchaseOrderId: "po_1", supplierId: "sup", supplierAddress: "0x2222222222222222222222222222222222222222", currency: "cNGN" as const, amount: 15_000_000_000n };

test("journal entries must balance per currency", () => {
  const l = newLedger();
  assert.throws(() => l.book({ kind: "x", postings: [{ account: "a", currency: "USDT", amount: 5n }, { account: "b", currency: "USDT", amount: -4n }] }), LedgerError);
  // Balanced in USD₮ but not in cNGN: still rejected.
  assert.throws(() => l.book({ kind: "x", postings: [...fxConversionPostings(10n, 15_000n).slice(0, 3)] }), LedgerError);
  assert.ok(l.book({ kind: "fx", postings: fxConversionPostings(10n, 15_000n) }));
  assert.equal(l.balance(ACCOUNTS.wallet, "USDT"), -10n);
  assert.equal(l.balance(ACCOUNTS.wallet, "cNGN"), 15_000n);
  const sum = (cur: "USDT" | "cNGN") => l.trialBalance().filter((b) => b.currency === cur).reduce((s, b) => s + b.balance, 0n);
  assert.equal(sum("USDT"), 0n);
  assert.equal(sum("cNGN"), 0n);
});

test("booking the same onchain tx twice is a no-op", () => {
  const l = newLedger();
  const entry = { kind: "fx", txHash: hash(7), postings: fxConversionPostings(10n, 15_000n) };
  assert.ok(l.book(entry));
  assert.equal(l.book(entry), null);
  assert.equal(l.balance(ACCOUNTS.wallet, "USDT"), -10n);
});

test("one payment per purchase order: retries return the same payment", () => {
  const l = newLedger();
  const a = l.createPayment(order);
  const b = l.createPayment(order);
  assert.equal(a.created, true);
  assert.equal(b.created, false);
  assert.equal(a.payment.id, b.payment.id);
  assert.equal(l.list().length, 1);
});

test("the same order id with different details is refused, not paid twice", () => {
  const l = newLedger();
  l.createPayment(order);
  assert.throws(() => l.createPayment({ ...order, amount: order.amount + 1n }), /different details/);
  assert.throws(() => l.createPayment({ ...order, supplierAddress: "0x3333333333333333333333333333333333333333" }), /different details/);
});

test("state can only move along allowed transitions", () => {
  const l = newLedger();
  const { payment } = l.createPayment(order);
  assert.throws(() => l.transition(payment, "PAID"), /Illegal payment transition CREATED -> PAID/);
  const q = l.transition(payment, "QUOTED", { fields: { rfqId: "r1", rfqClaim: "c1", usdtSpent: 10n } });
  assert.equal(q.state, "QUOTED");
  assert.equal(l.rfqClaim(q.id), "c1");
});

test("compare-and-set: a stale copy cannot move a payment", () => {
  const l = newLedger();
  const { payment } = l.createPayment(order);
  l.transition(payment, "QUOTED"); // someone else moved it
  assert.throws(() => l.transition(payment, "QUOTED"), StaleStateError);
});

test("state change and booking commit together or not at all", () => {
  const l = newLedger();
  const { payment } = l.createPayment(order);
  const q = l.transition(payment, "QUOTED");
  const s = l.transition(q, "SWAP_SUBMITTING");
  // An unbalanced booking makes the whole transition roll back.
  assert.throws(() => l.transition(s, "SWAPPED", { fields: { swapTx: hash(1) }, book: { kind: "fx", txHash: hash(1), postings: [{ account: "a", currency: "USDT", amount: 1n }, { account: "b", currency: "USDT", amount: 1n }] } }));
  const after = l.get(payment.id)!;
  assert.equal(after.state, "SWAP_SUBMITTING");
  assert.equal(after.swapTx, null);
  assert.equal(l.trialBalance().length, 0);
});

test("postings and the payment audit trail cannot be edited or deleted", () => {
  const l = newLedger();
  l.book({ kind: "fx", postings: fxConversionPostings(10n, 15_000n) });
  const { payment } = l.createPayment(order);
  assert.throws(() => l.db.exec("UPDATE postings SET amount = '0'"), /immutable/);
  assert.throws(() => l.db.exec("DELETE FROM postings"), /immutable/);
  assert.throws(() => l.db.exec("UPDATE payment_events SET detail = 'x'"), /append-only/);
  assert.throws(() => l.db.exec("DELETE FROM payment_events"), /append-only/);
  assert.equal(l.events(payment.id).length, 1);
});
