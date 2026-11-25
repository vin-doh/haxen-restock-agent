// Decides what to reorder. Deterministic on purpose: the same stock picture always gives
// the same orders, and every number in an order can be traced back to the snapshot.
import { createHash } from "node:crypto";
import { TOKENS, wholeToAtomic } from "./config.ts";
import type { InventorySnapshot, StockItem, Supplier } from "./inventory/source.ts";

export type OrderLine = { sku: string; name: string; qty: number; unitPrice: string; lineTotal: bigint; reason: string };

export type PurchaseOrder = {
  /** Stable id: the same supplier, lines and day give the same id, so a re-run cannot pay twice. */
  id: string;
  supplier: Supplier;
  lines: OrderLine[];
  /** Total in the supplier's stablecoin, atomic units. */
  total: bigint;
};

export type PlanOptions = {
  /** Days of sales the order should cover after it arrives. */
  coverDays: number;
  /** Day the plan is for (YYYY-MM-DD, UTC). Part of the order id. */
  day: string;
};

export function planRestock(snapshot: InventorySnapshot, opts: PlanOptions): PurchaseOrder[] {
  const suppliers = new Map(snapshot.suppliers.map((s) => [s.id, s]));
  const bySupplier = new Map<string, OrderLine[]>();

  for (const item of snapshot.items) {
    const supplier = suppliers.get(item.supplierId)!;
    const line = lineFor(item, supplier, opts.coverDays);
    if (!line) continue;
    const lines = bySupplier.get(supplier.id) ?? [];
    lines.push(line);
    bySupplier.set(supplier.id, lines);
  }

  const orders: PurchaseOrder[] = [];
  for (const [supplierId, lines] of bySupplier) {
    const supplier = suppliers.get(supplierId)!;
    lines.sort((a, b) => a.sku.localeCompare(b.sku));
    const total = lines.reduce((sum, l) => sum + l.lineTotal, 0n);
    const fingerprint = JSON.stringify([snapshot.pharmacy, supplierId, opts.day, lines.map((l) => [l.sku, l.qty, l.unitPrice])]);
    const id = `po_${opts.day.replaceAll("-", "")}_${createHash("sha256").update(fingerprint).digest("hex").slice(0, 10)}`;
    orders.push({ id, supplier, lines, total });
  }
  return orders.sort((a, b) => a.id.localeCompare(b.id));
}

function lineFor(item: StockItem, supplier: Supplier, coverDays: number): OrderLine | null {
  // Stock that will be sold while we wait for delivery.
  const usedDuringLead = item.dailySales * supplier.leadTimeDays;
  const reorderPoint = Math.max(item.reorderLevel, Math.ceil(usedDuringLead));
  if (item.stock > reorderPoint) return null;

  const target = Math.ceil(item.dailySales * (supplier.leadTimeDays + coverDays)) + item.reorderLevel;
  const needed = target - item.stock;
  if (needed <= 0) return null;
  const qty = Math.ceil(needed / item.packSize) * item.packSize; // whole cartons only

  const decimals = TOKENS[supplier.currency].decimals;
  const lineTotal = wholeToAtomic(item.unitPrice, decimals) * BigInt(qty);
  const reason =
    `${item.stock} on hand, reorder point ${reorderPoint} (level ${item.reorderLevel}, ` +
    `${item.dailySales}/day x ${supplier.leadTimeDays}d lead); ordering up to ${target} in packs of ${item.packSize}`;
  return { sku: item.sku, name: item.name, qty, unitPrice: item.unitPrice, lineTotal, reason };
}
