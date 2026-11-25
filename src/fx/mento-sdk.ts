// The real MentoQuoter, backed by @mento-protocol/mento-sdk.
// Loaded through require(): the SDK's ESM build has extensionless imports Node can't resolve.
import { createRequire } from "node:module";
import type { Address, Hex } from "viem";
import type { MentoQuoter } from "./mento.ts";

const require = createRequire(import.meta.url);

type Sdk = {
  quotes: { getAmountOut(tokenIn: string, tokenOut: string, amountIn: bigint): Promise<bigint> };
  swap: {
    buildSwapParams(
      tokenIn: string,
      tokenOut: string,
      amountIn: bigint,
      recipient: string,
      options: { slippageTolerance: number; deadline: bigint },
    ): Promise<{ params: { to: string; data: string; value: string }; amountOutMin: bigint; expectedAmountOut: bigint }>;
  };
};

export async function createMentoQuoter(): Promise<MentoQuoter> {
  const { Mento, ChainId } = require("@mento-protocol/mento-sdk") as { Mento: { create(chainId: number): Promise<Sdk> }; ChainId: { CELO: number } };
  const mento = await Mento.create(ChainId.CELO);
  return {
    amountOut: (tokenIn, tokenOut, amountIn) => mento.quotes.getAmountOut(tokenIn, tokenOut, amountIn),
    async buildSwap(p) {
      const d = await mento.swap.buildSwapParams(p.tokenIn, p.tokenOut, p.amountIn, p.recipient, { slippageTolerance: p.slippagePct, deadline: p.deadlineSec });
      if (BigInt(d.params.value || 0) !== 0n) throw new Error("Mento swap unexpectedly sends CELO value");
      return { to: d.params.to as Address, data: d.params.data as Hex, amountOutMin: d.amountOutMin, expectedOut: d.expectedAmountOut };
    },
  };
}
