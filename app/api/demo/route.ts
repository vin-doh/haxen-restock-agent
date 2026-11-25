// Runs one simulated restock with the agent's real code. Nothing here touches mainnet:
// the wallet, Textile and the chain are simulators. Only the NGN/USD₮ rate is live
// (Textile's free indicative preview), so the numbers match today's market.
import { SCENARIOS, runDemo, type Scenario } from "../../../src/sim/demo.ts";
import { TEXTILE_API, TOKENS } from "../../../src/config.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

let cachedRate: { value: number; at: number } | null = null;

async function liveRate(): Promise<{ ngnPerUsd: number; live: boolean }> {
  if (cachedRate && Date.now() - cachedRate.at < 60_000) return { ngnPerUsd: cachedRate.value, live: true };
  try {
    const res = await fetch(`${TEXTILE_API}/rfq/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chainId: 42220, sellToken: TOKENS.USDT.address, buyToken: TOKENS.cNGN.address, buyAmount: "15000000000" }),
      signal: AbortSignal.timeout(8_000),
    });
    const json = (await res.json()) as { data?: { buyAmount?: string; takerPays?: string } };
    const buy = Number(json.data?.buyAmount);
    const pays = Number(json.data?.takerPays);
    if (res.ok && buy > 0 && pays > 0) {
      cachedRate = { value: buy / pays, at: Date.now() }; // both tokens use 6 decimals
      return { ngnPerUsd: cachedRate.value, live: true };
    }
  } catch {
    // fall through to the fixed rate
  }
  return { ngnPerUsd: 1440, live: false };
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
    ngnPerUsd: rate.ngnPerUsd,
    attributionCode: process.env.ATTRIBUTION_CODE || "celo_3175e01fb588",
  });
  return Response.json({ ...result, rateIsLive: rate.live });
}
