import { test } from "node:test";
import assert from "node:assert/strict";
import { SCENARIOS, runDemo, type Scenario } from "../src/sim/demo.ts";

const CODE = "celo_3175e01fb588";

for (const scenario of Object.keys(SCENARIOS) as Scenario[]) {
  test(`demo scenario "${scenario}" ends with the supplier paid exactly once (or not at all if revoked) and books matching the chain`, async () => {
    const r = await runDemo({ scenario, attributionCode: CODE, ngnPerUsd: 1440 });
    assert.ok(r.orders.length >= 1);
    const total = r.orders[0]!.total;
    if (scenario === "revoked") {
      assert.equal(r.supplierReceived, "0 cNGN");
      assert.equal(r.payments[0]!.state, "BLOCKED");
      assert.equal(r.transactionsSent, 0);
    } else {
      assert.equal(r.supplierReceived, total, `supplier should receive exactly ${total}`);
      assert.equal(r.payments[0]!.state, "RECONCILED");
    }
    for (const b of r.reconcile.balances) assert.equal(b.ledger, b.chain, `${b.currency} ledger vs chain`);
    assert.ok(r.reconcile.findings.every((f) => f.level !== "error"), JSON.stringify(r.reconcile.findings));
  });
}

test("demo: nothing low on stock means nothing ordered and nothing sent", async () => {
  const r = await runDemo({ scenario: "normal", attributionCode: CODE, stock: { "PCM-500-100": 500, "ORS-SACHET-20": 500 } });
  assert.equal(r.orders.length, 0);
  assert.equal(r.transactionsSent, 0);
});

test("demo: a per-order limit below the order total blocks before any transaction", async () => {
  const r = await runDemo({ scenario: "normal", attributionCode: CODE, maxUsdtPerOrder: 5 });
  assert.equal(r.payments[0]!.state, "BLOCKED");
  assert.equal(r.transactionsSent, 0);
});
