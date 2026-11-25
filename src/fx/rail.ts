// An FX rail turns USD₮ into the stablecoin a supplier is paid in.
// The executor doesn't care which venue it is; it needs these guarantees:
//  - at least the owed amount arrives (minOut >= owed), and the USD₮ leaving the wallet is known exactly
//  - every contract the swap touches is one the rail knows (checked before sending)
//  - after a crash, the rail can say whether the swap landed, by asking the venue or the chain
import type { Address, Hex } from "viem";
import type { Call } from "../wallet/altana.ts";

export type FxPlan = {
  rail: string;
  /** Venue reference: Textile's RFQ id, or our own id for Mento. */
  ref: string;
  /** Textile's claim token (needed to ask about the RFQ later). Null for Mento. */
  claim: string | null;
  /** Exact USD₮ that leaves the wallet for the swap. */
  usdtIn: bigint;
  /** At least this much of the buy token arrives. Always >= the amount owed. */
  minOut: bigint;
  expectedOut: bigint;
  /** Wallet transactions to send in order; each can batch several calls. */
  txs: Array<{ label: string; calls: Call[] }>;
  /** After this (ms since epoch) the plan must not be sent. */
  expiresAt: number;
};

export type SwapRecovery =
  | { status: "filled"; txHash: Hex; usdtIn: bigint; out: bigint }
  | { status: "not_filled"; reason: string }
  | { status: "pending"; reason: string }
  /** The rail can't tell from the venue; the executor waits for confirmations before deciding. */
  | { status: "not_seen" };

export interface FxRail {
  readonly name: string;
  /** Contracts this rail's transactions may call. */
  readonly knownTargets: ReadonlySet<string>;
  planExactOut(p: { taker: Address; buyToken: Address; buyAmount: bigint }): Promise<FxPlan>;
  msLeft(plan: FxPlan): number;
  release(ref: string, claim: string | null): Promise<void>;
  /** Called once the swap tx confirmed: returns what actually arrived. */
  settled(plan: FxPlan, txHash: Hex): Promise<{ out: bigint }>;
  recover(p: { ref: string; claim: string | null; buyToken: Address; minOut: bigint; usdtIn: bigint; fromBlock: bigint }): Promise<SwapRecovery>;
}

export class NoRouteError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`No FX route: ${reason}`);
    this.reason = reason;
  }
}
