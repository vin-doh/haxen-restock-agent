// Where the agent learns what is running low and who supplies it.
//
// The agent never reads the pharmacy's database. It asks one narrow question
// ("what needs restocking, and from whom?") through this interface. The HaxenMed
// implementation calls a small, key-protected restock endpoint that returns only
// the fields below: no patients, no sales records, no prices beyond unit cost.
import { readFileSync } from "node:fs";
import { getAddress, isAddress, type Address } from "viem";
import type { Currency } from "../ledger/ledger.ts";

export type StockItem = {
  sku: string;
  name: string;
  /** Units on hand now. */
  stock: number;
  /** HaxenMed's reorder level for the item. */
  reorderLevel: number;
  /** Average units sold per day over the recent window. */
  dailySales: number;
  supplierId: string;
  /** Supplier's price per unit, in the supplier's currency, as a decimal string (e.g. "1450.00"). */
  unitPrice: string;
  /** Smallest quantity the supplier ships (a carton). */
  packSize: number;
};

export type Supplier = {
  id: string;
  name: string;
  country: string;
  /** The stablecoin the supplier is paid in. */
  currency: Currency;
  /** The supplier's own wallet on Celo. Must be outside the pharmacy's team. */
  payoutAddress: Address;
  /** Days from payment to delivery. */
  leadTimeDays: number;
};

export type InventorySnapshot = {
  pharmacy: string;
  takenAt: string;
  items: StockItem[];
  suppliers: Supplier[];
  /** Suppliers whose payout address is a zero or burn address (demo data). The executor refuses to pay them. */
  unspendableSuppliers?: string[];
};

export interface InventorySource {
  snapshot(): Promise<InventorySnapshot>;
}

export class FileInventorySource implements InventorySource {
  private readonly path: string;
  constructor(path: string) {
    this.path = path;
  }
  async snapshot(): Promise<InventorySnapshot> {
    return validateSnapshot(JSON.parse(readFileSync(this.path, "utf8")));
  }
}

/**
 * How the agent pays each HaxenMed supplier. Kept on the agent's side (state/suppliers.json, not in Git):
 * HaxenMed knows stock and suppliers, only the owner knows which wallet each supplier is paid at.
 */
export type SupplierWallets = Record<
  string,
  { payoutAddress: string; currency: Currency; leadTimeDays: number; country?: string; packSize?: number; packSizes?: Record<string, number> }
>;

/**
 * Calls HaxenMed's restock endpoint (GET {baseUrl}/api/agent/restock, bearer key) and joins it with the
 * owner's supplier wallets. Items whose supplier has no wallet are left out of the plan and reported.
 */
export class HaxenMedInventorySource implements InventorySource {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly wallets: SupplierWallets;
  private readonly fetchFn: typeof fetch;
  skippedItems: string[] = [];
  constructor(baseUrl: string, apiKey: string, wallets: SupplierWallets, fetchFn: typeof fetch = fetch) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
    this.wallets = wallets;
    this.fetchFn = fetchFn;
  }
  async snapshot(): Promise<InventorySnapshot> {
    const res = await this.fetchFn(`${this.baseUrl}/api/agent/restock`, {
      headers: { authorization: `Bearer ${this.apiKey}`, accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`HaxenMed restock endpoint answered ${res.status}`);
    const body = (await res.json()) as { success?: boolean; data?: { pharmacy: string; takenAt: string; items: Array<Record<string, unknown>>; suppliers: Array<{ id: string; name: string }> } };
    if (!body.success || !body.data) throw new Error("HaxenMed restock endpoint returned no data");
    const d = body.data;
    this.skippedItems = [];
    const suppliers = d.suppliers
      .filter((s) => this.wallets[s.id])
      .map((s) => {
        const w = this.wallets[s.id]!;
        return { id: s.id, name: s.name, country: w.country ?? "GH", currency: w.currency, payoutAddress: w.payoutAddress, leadTimeDays: w.leadTimeDays };
      });
    const items = d.items.filter((i) => {
      const ok = !!this.wallets[i.supplierId as string];
      if (!ok) this.skippedItems.push(String(i.name));
      return ok;
    }).map((i) => {
      const w = this.wallets[i.supplierId as string]!;
      return { ...i, packSize: w.packSizes?.[i.sku as string] ?? w.packSize ?? 1 };
    });
    return validateSnapshot({ pharmacy: d.pharmacy, takenAt: d.takenAt, items, suppliers });
  }
}

/** Checks the shape of a snapshot, so bad data stops the run instead of producing a wrong payment. */
export function validateSnapshot(raw: unknown): InventorySnapshot {
  const fail = (msg: string): never => {
    throw new Error(`Invalid inventory snapshot: ${msg}`);
  };
  if (!raw || typeof raw !== "object") fail("not an object");
  const s = raw as Record<string, unknown>;
  if (typeof s.pharmacy !== "string" || !s.pharmacy) fail("pharmacy missing");
  if (!Array.isArray(s.items) || !Array.isArray(s.suppliers)) fail("items and suppliers must be arrays");
  const unspendable: string[] = [];
  const suppliers: Supplier[] = (s.suppliers as Record<string, unknown>[]).map((x, i) => {
    if (typeof x.id !== "string" || typeof x.name !== "string") fail(`supplier ${i}: id and name required`);
    if (x.currency !== "GHSm" && x.currency !== "cNGN" && x.currency !== "USDT") fail(`supplier ${x.id}: currency must be GHSm, cNGN or USDT`);
    if (typeof x.payoutAddress !== "string" || !isAddress(x.payoutAddress)) fail(`supplier ${x.id}: payoutAddress is not an address`);
    if (isUnspendable(x.payoutAddress as string)) unspendable.push(String(x.id));
    if (typeof x.leadTimeDays !== "number" || x.leadTimeDays < 0) fail(`supplier ${x.id}: leadTimeDays`);
    return {
      id: x.id as string,
      name: x.name as string,
      country: String(x.country ?? ""),
      currency: x.currency as Currency,
      payoutAddress: getAddress(x.payoutAddress as string),
      leadTimeDays: x.leadTimeDays as number,
    };
  });
  const ids = new Set(suppliers.map((x) => x.id));
  const items: StockItem[] = (s.items as Record<string, unknown>[]).map((x, i) => {
    for (const k of ["sku", "name", "supplierId", "unitPrice"]) if (typeof x[k] !== "string" || !x[k]) fail(`item ${i}: ${k} required`);
    for (const k of ["stock", "reorderLevel", "dailySales", "packSize"]) if (typeof x[k] !== "number" || !Number.isFinite(x[k]) || (x[k] as number) < 0) fail(`item ${x.sku}: ${k} must be a non-negative number`);
    if (!ids.has(x.supplierId as string)) fail(`item ${x.sku}: unknown supplier ${x.supplierId}`);
    if (!/^\d+(\.\d+)?$/.test(x.unitPrice as string)) fail(`item ${x.sku}: unitPrice must be a decimal string`);
    if ((x.packSize as number) < 1) fail(`item ${x.sku}: packSize must be at least 1`);
    return x as unknown as StockItem;
  });
  return { pharmacy: s.pharmacy as string, takenAt: String(s.takenAt ?? new Date().toISOString()), items, suppliers, unspendableSuppliers: unspendable };
}

/** Zero and burn addresses: fine in demo data, never a real payee. */
export function isUnspendable(address: string): boolean {
  const a = address.toLowerCase();
  return /^0x0{40}$/.test(a) || a === "0x000000000000000000000000000000000000dead";
}
