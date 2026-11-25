// Mento rail: USD₮ -> GHSm (Ghana cedi) through Mento's Router on Celo.
//
// Mento swaps are exact-input. To pay an exact cedi invoice, the rail finds the smallest
// USD₮ input whose minimum output (after the slippage allowance) still covers the invoice.
// Any small surplus of cedis stays in the wallet and is booked, so the ledger still matches the chain.
import { encodeFunctionData, erc20Abi, type Address, type Hex } from "viem";
import { CONTRACTS, TOKENS } from "../config.ts";
import { type FxPlan, type FxRail, NoRouteError, type SwapRecovery } from "./rail.ts";

/** What the rail needs from Mento. The real one wraps @mento-protocol/mento-sdk; tests use a simulator. */
export interface MentoQuoter {
  /** Expected output for an exact input, along the best route. */
  amountOut(tokenIn: Address, tokenOut: Address, amountIn: bigint): Promise<bigint>;
  /** Unsigned Router call for an exact-input swap, with its guaranteed minimum output. */
  buildSwap(p: { tokenIn: Address; tokenOut: Address; amountIn: bigint; recipient: Address; slippagePct: number; deadlineSec: bigint }): Promise<{ to: Address; data: Hex; amountOutMin: bigint; expectedOut: bigint }>;
}

/** Chain lookups the rail uses to settle and recover swaps. The agent wallet provides them. */
export interface ChainLookup {
  received(token: Address, txHash: Hex): Promise<bigint>;
  sent(token: Address, txHash: Hex): Promise<bigint>;
  incomingTxs(token: Address, minAmount: bigint, fromBlock: bigint): Promise<Hex[]>;
}

export class MentoRail implements FxRail {
  readonly name = "mento";
  readonly knownTargets: ReadonlySet<string> = new Set([CONTRACTS.mentoRouter.toLowerCase(), TOKENS.USDT.address.toLowerCase()]);
  private readonly quoter: MentoQuoter;
  private readonly chain: ChainLookup;
  private readonly slippagePct: number;
  private readonly now: () => number;
  private seq = 0;

  constructor(quoter: MentoQuoter, chain: ChainLookup, opts: { slippagePct?: number; now?: () => number } = {}) {
    this.quoter = quoter;
    this.chain = chain;
    this.slippagePct = opts.slippagePct ?? 0.5;
    this.now = opts.now ?? Date.now;
  }

  async planExactOut(p: { taker: Address; buyToken: Address; buyAmount: bigint }): Promise<FxPlan> {
    const usdt = TOKENS.USDT.address;
    // Price a round amount first to learn the rate, then size the input from it.
    const probeIn = 10n * 10n ** BigInt(TOKENS.USDT.decimals);
    let probeOut: bigint;
    try {
      probeOut = await this.quoter.amountOut(usdt, p.buyToken, probeIn);
    } catch (e) {
      throw new NoRouteError(`Mento has no USD₮ route to ${p.buyToken}: ${(e as Error).message}`);
    }
    if (probeOut <= 0n) throw new NoRouteError("Mento quoted zero output");

    // Smallest input whose minimum output (expected minus the slippage allowance) covers the invoice:
    // in = owed / rate / (1 - slippage), rounded up.
    const keepBps = 10_000n - BigInt(Math.ceil(this.slippagePct * 100));
    let amountIn = (p.buyAmount * probeIn * 10_000n + probeOut * keepBps - 1n) / (probeOut * keepBps) + 1n;
    const deadlineSec = BigInt(Math.floor(this.now() / 1000) + 300);
    for (let attempt = 0; attempt < 8; attempt++) {
      const swap = await this.quoter.buildSwap({ tokenIn: usdt, tokenOut: p.buyToken, amountIn, recipient: p.taker, slippagePct: this.slippagePct, deadlineSec });
      if (swap.amountOutMin >= p.buyAmount) {
        if (swap.to.toLowerCase() !== CONTRACTS.mentoRouter.toLowerCase()) throw new NoRouteError(`Mento SDK targets ${swap.to}, not the known Router`);
        const ref = `mento_${Date.now().toString(36)}_${(this.seq++).toString(36)}`;
        return {
          rail: this.name,
          ref,
          claim: null,
          usdtIn: amountIn,
          minOut: swap.amountOutMin,
          expectedOut: swap.expectedOut,
          // Approve and swap in ONE wallet transaction: both succeed or neither does.
          txs: [
            {
              label: "Mento swap (approve + swap)",
              calls: [
                { to: usdt, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [swap.to, amountIn] }) },
                { to: swap.to, data: swap.data },
              ],
            },
          ],
          expiresAt: Number(deadlineSec) * 1000,
        };
      }
      // Not quite enough after slippage: add 0.5% and price again.
      amountIn += amountIn / 200n + 1n;
    }
    throw new NoRouteError("could not size a Mento swap that covers the invoice");
  }

  msLeft(plan: FxPlan): number {
    return plan.expiresAt - this.now();
  }

  async release(): Promise<void> {
    // Mento quotes reserve nothing; there is nothing to release.
  }

  async settled(plan: FxPlan, txHash: Hex): Promise<{ out: bigint }> {
    const out = await this.chain.received(TOKENS.GHSm.address, txHash);
    if (out < plan.minOut) throw new Error(`Mento swap ${txHash} delivered ${out}, below the minimum ${plan.minOut}`);
    return { out };
  }

  async recover(p: { buyToken: Address; minOut: bigint; usdtIn: bigint; fromBlock: bigint }): Promise<SwapRecovery> {
    // A cedi deposit from the owner could also arrive. Only a transaction that also spent exactly
    // this swap's USD₮ is the swap.
    for (const tx of await this.chain.incomingTxs(p.buyToken, p.minOut, p.fromBlock)) {
      if ((await this.chain.sent(TOKENS.USDT.address, tx)) >= p.usdtIn) {
        return { status: "filled", txHash: tx, usdtIn: p.usdtIn, out: await this.chain.received(p.buyToken, tx) };
      }
    }
    return { status: "not_seen" };
  }
}
