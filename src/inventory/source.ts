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

/** Calls HaxenMed's restock endpoint: GET {baseUrl}/api/agent/restock with a bearer key. */
export class HaxenMedInventorySource implements InventorySource {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchFn: typeof fetch;
  constructor(baseUrl: string, apiKey: string, fetchFn: typeof fetch = fetch) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
    this.fetchFn = fetchFn;
  }
  async snapshot(): Promise<InventorySnapshot> {
    const res = await this.fetchFn(`${this.baseUrl}/api/agent/restock`, {
      headers: { authorization: `Bearer ${this.apiKey}`, accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`HaxenMed restock endpoint answered ${res.status}`);
    return validateSnapshot(await res.json());
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
