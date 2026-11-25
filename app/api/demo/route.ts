// Runs one simulated restock with the agent's real code. Nothing here touches mainnet:
// the wallet, Mento and the chain are simulators. Only the cedi rate is live
// (Mento's own quote for USD₮ -> GHSm on Celo), so the numbers match today's market.
import { SCENARIOS, runDemo, type Scenario } from "../../../src/sim/demo.ts";
import { TOKENS } from "../../../src/config.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

let cachedRate: { value: number; at: number } | null = null;

async function liveRate(): Promise<{ ghsPerUsd: number; live: boolean }> {
  if (cachedRate && Date.now() - cachedRate.at < 60_000) return { ghsPerUsd: cachedRate.value, live: true };
  try {
    const { Mento, ChainId } = (await import("@mento-protocol/mento-sdk")) as unknown as {
      Mento: { create(id: number): Promise<{ quotes: { getAmountOut(a: string, b: string, n: bigint): Promise<bigint> } }> };
      ChainId: { CELO: number };
    };
    const mento = await Mento.create(ChainId.CELO);
    const tenUsd = 10n * 10n ** 6n;
    const out = await Promise.race([
      mento.quotes.getAmountOut(TOKENS.USDT.address, TOKENS.GHSm.address, tenUsd),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 8_000)),
    ]);
    const rate = Number(out) / 1e18 / 10; // all-in: Mento's route cost included
    if (rate > 1 && rate < 1000) {
      cachedRate = { value: rate, at: Date.now() };
      return { ghsPerUsd: rate, live: true };
    }
  } catch {
    // fall through to the fixed rate
  }
  return { ghsPerUsd: 11.73, live: false };
}

export async function GET() {
  const r = await liveRate();
  return Response.json({ ...r, scenarios: SCENARIOS });
}

export async function POST(request: Request) {
  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Send JSON" }, { status: 400 });
  }
  const scenario = String(body.scenario ?? "normal") as Scenario;
  if (!(scenario in SCENARIOS)) return Response.json({ error: "Unknown scenario" }, { status: 400 });
  const num = (v: unknown, min: number, max: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : undefined);
  const stock: Record<string, number> = {};
  if (body.stock && typeof body.stock === "object") {
    for (const [k, v] of Object.entries(body.stock as Record<string, unknown>)) {
      const n = num(v, 0, 10_000);
      if (n !== undefined && /^[A-Z0-9-]{1,32}$/.test(k)) stock[k] = n;
    }
  }
  const rate = await liveRate();
  const result = await runDemo({
    scenario,
    stock,
    maxUsdtPerOrder: num(body.maxUsdtPerOrder, 0, 10_000),
    maxUsdtPerRun: num(body.maxUsdtPerRun, 0, 10_000),
    ghsPerUsd: rate.ghsPerUsd,
    attributionCode: process.env.ATTRIBUTION_CODE || "celo_3175e01fb588",
  });
  return Response.json({ ...result, rateIsLive: rate.live });
}
