// The owner's yes or no before an order is paid.
//
// Approval is a gate in front of the payment flow, not part of it: the executor's money logic,
// the onchain session caps and the local limits all still apply after a yes. A decision is stored
// per purchase order, so re-running the agent never asks twice for the same order, and a "no"
// is never silently turned into a payment.
import { TOKENS, atomicToWhole } from "../config.ts";
import type { Ledger } from "../ledger/ledger.ts";
import type { PurchaseOrder } from "../planner.ts";

export type Decision = { decision: "approved" | "declined" | "timeout"; by?: string; at: string; via: string };

export interface Approver {
  readonly via: string;
  request(order: PurchaseOrder, summary: string): Promise<Decision>;
}

/** Plain-language summary of an order, used in the approval message. */
export function orderSummary(order: PurchaseOrder, pharmacy: string): string {
  const cur = order.supplier.currency;
  const dec = TOKENS[cur].decimals;
  const lines = order.lines.map((l) => `• ${l.qty} × ${l.name}: ${atomicToWhole(l.lineTotal, dec)} ${cur}`);
  return [
    `${pharmacy}: restock order ${order.id}`,
    `Supplier: ${order.supplier.name} (${order.supplier.payoutAddress.slice(0, 6)}…${order.supplier.payoutAddress.slice(-4)})`,
    ...lines,
    `Total: ${atomicToWhole(order.total, dec)} ${cur}`,
  ].join("\n");
}

const key = (orderId: string) => `approval:${orderId}`;

export function storedDecision(ledger: Ledger, orderId: string): Decision | null {
  const raw = ledger.getMeta(key(orderId));
  return raw ? (JSON.parse(raw) as Decision) : null;
}

/**
 * Returns the owner's decision for an order, asking only if none is stored.
 * A timeout is not stored, so the next run asks again; approved and declined are final.
 */
export async function decide(ledger: Ledger, approver: Approver, order: PurchaseOrder, pharmacy: string): Promise<Decision> {
  const existing = storedDecision(ledger, order.id);
  if (existing && existing.decision !== "timeout") return existing;
  const d = await approver.request(order, orderSummary(order, pharmacy));
  if (d.decision !== "timeout") ledger.setMeta(key(order.id), JSON.stringify(d));
  return d;
}

/** Used when the owner approves at the command line (run --yes): records who approved and how. */
export class CliApprover implements Approver {
  readonly via = "command line (--yes)";
  async request(): Promise<Decision> {
    return { decision: "approved", by: "owner at the command line", at: new Date().toISOString(), via: this.via };
  }
}
