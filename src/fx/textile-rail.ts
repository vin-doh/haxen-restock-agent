// Textile FX rail: USD₮ -> cNGN (and Textile's other corridors) via firm RFQ quotes.
// Used when a supplier is paid in naira. Textile quotes exact output, so minOut == the amount owed.
import type { Hex } from "viem";
import { CONTRACTS, TOKENS } from "../config.ts";
import { type FirmQuote, NoQuoteError, type TextileClient } from "./textile.ts";
import { type FxPlan, type FxRail, NoRouteError, type SwapRecovery } from "./rail.ts";

type TextileLike = Pick<TextileClient, "firmQuoteForExactOutput" | "msLeft" | "status" | "submit" | "cancel">;

export class TextileRail implements FxRail {
  readonly name = "textile";
  readonly knownTargets: ReadonlySet<string> = new Set([
    CONTRACTS.textileReactor.toLowerCase(),
    CONTRACTS.textileVaultExecutor.toLowerCase(),
    TOKENS.USDT.address.toLowerCase(),
  ]);
  private readonly client: TextileLike;
  private readonly quotes = new Map<string, FirmQuote>();

  constructor(client: TextileLike) {
    this.client = client;
  }

  async planExactOut(p: Parameters<FxRail["planExactOut"]>[0]): Promise<FxPlan> {
    let q: FirmQuote;
    try {
      q = await this.client.firmQuoteForExactOutput({ taker: p.taker, sellToken: TOKENS.USDT.address, buyToken: p.buyToken, buyAmount: p.buyAmount });
    } catch (e) {
      if (e instanceof NoQuoteError) throw new NoRouteError(`Textile: ${e.reason}`);
      throw e;
    }
    this.quotes.set(q.rfqId, q);
    return {
      rail: this.name,
      ref: q.rfqId,
      claim: q.claimToken,
      usdtIn: q.takerPays,
      minOut: q.buyAmount,
      expectedOut: q.buyAmount,
      // Textile asks for the approval to confirm before the swap, so they are two transactions.
      txs: [
        { label: "approve USD₮ for Textile", calls: [{ to: q.approval.to, data: q.approval.data }] },
        { label: "Textile swap", calls: [{ to: q.swap.to, data: q.swap.data }] },
      ],
      expiresAt: q.expiresAt,
    };
  }

  msLeft(plan: FxPlan): number {
    const q = this.quotes.get(plan.ref);
    return q ? this.client.msLeft(q) : plan.expiresAt - Date.now();
  }

  async release(ref: string, claim: string | null): Promise<void> {
    if (claim) await this.client.cancel(ref, claim).catch(() => {});
  }

  async settled(plan: FxPlan, txHash: Hex): Promise<{ out: bigint }> {
    if (plan.claim) await this.client.submit(plan.ref, plan.claim, txHash).catch(() => {});
    return { out: plan.minOut };
  }

  async recover(p: { ref: string; claim: string | null; usdtIn: bigint; minOut: bigint }): Promise<SwapRecovery> {
    if (!p.claim) return { status: "not_seen" };
    const st = await this.client.status(p.ref, p.claim);
    if (st.status === "filled" && st.txHash) return { status: "filled", txHash: st.txHash, usdtIn: st.sellAmount ?? p.usdtIn, out: st.buyAmount ?? p.minOut };
    if (st.status === "expired" || st.status === "failed" || st.status === "no_quote") return { status: "not_filled", reason: `Textile says ${st.status}` };
    return { status: "pending", reason: `Textile says ${st.status}` };
  }
}
