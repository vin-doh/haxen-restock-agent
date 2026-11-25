import { test } from "node:test";
import assert from "node:assert/strict";
import { HaxenMedInventorySource } from "../src/inventory/source.ts";
import { planRestock } from "../src/planner.ts";

// The same shape HaxenMed's GET /api/agent/restock returns ({ success, data }).
const body = {
  success: true,
  data: {
    pharmacy: "Pilot Pharmacy",
    takenAt: "2026-11-26T08:00:00.000Z",
    currency: "GHS",
    salesWindowDays: 30,
    items: [
      { sku: "d1", name: "Paracetamol", stock: 6, reorderLevel: 10, dailySales: 1.5, supplierId: "s_gh", unitPrice: "6.50" },
      { sku: "d2", name: "ORS", stock: 3, reorderLevel: 8, dailySales: 0.8, supplierId: "s_gh", unitPrice: "8.00" },
      { sku: "d3", name: "Imported item", stock: 0, reorderLevel: 2, dailySales: 0.1, supplierId: "s_no_wallet", unitPrice: "40.00" },
    ],
    suppliers: [{ id: "s_gh", name: "Kumasi Distributor" }, { id: "s_no_wallet", name: "No wallet yet" }],
    withoutSupplier: 0,
  },
};

const wallets = {
  s_gh: { payoutAddress: "0x2222222222222222222222222222222222222222", currency: "GHSm" as const, leadTimeDays: 3, packSizes: { d1: 4, d2: 5 } },
};

test("joins HaxenMed's stock with the owner's supplier wallets, and skips suppliers without one", async () => {
  let sentAuth = "";
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    assert.equal(url, "https://app.example.test/api/agent/restock");
    sentAuth = (init?.headers as Record<string, string>).authorization ?? "";
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
  const src = new HaxenMedInventorySource("https://app.example.test/", "agent-key-123", wallets, fakeFetch);
  const snap = await src.snapshot();
  assert.equal(sentAuth, "Bearer agent-key-123");
  assert.deepEqual(snap.items.map((i) => [i.sku, i.packSize]), [["d1", 4], ["d2", 5]]);
  assert.deepEqual(snap.suppliers.map((s) => [s.id, s.currency, s.payoutAddress]), [["s_gh", "GHSm", "0x2222222222222222222222222222222222222222"]]);
  assert.deepEqual(src.skippedItems, ["Imported item"]);
  const orders = planRestock(snap, { coverDays: 14, day: "2026-11-26" });
  assert.equal(orders.length, 1);
  assert.equal(orders[0]!.supplier.currency, "GHSm");
});

test("a refused key stops the run", async () => {
  const fakeFetch = (async () => new Response(JSON.stringify({ success: false, error: "Unauthorized" }), { status: 401 })) as unknown as typeof fetch;
  const src = new HaxenMedInventorySource("https://app.example.test", "wrong", wallets, fakeFetch);
  await assert.rejects(src.snapshot(), /answered 401/);
});
