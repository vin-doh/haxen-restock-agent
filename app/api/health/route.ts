// A small JSON status endpoint for agents and automated reviewers: what this service is,
// what's live, and how to call the demo. Read-only; no secrets, no chain calls.
import { CONTRACTS, TOKENS } from "../../../src/config.ts";
import { SCENARIOS } from "../../../src/sim/demo.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const AGENT_WALLET = process.env.AGENT_WALLET || "0xa97a7C6c3ec143986E739805b5875a1FB0a97909";

function body() {
  return {
    status: "ok",
    service: "HaxenMed Restock Agent",
    repository: "https://github.com/vin-doh/haxen-restock-agent",
    commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
    chain: { name: "Celo mainnet", chainId: 42220 },
    agentWallet: AGENT_WALLET,
    mainnetStatus: process.env.ERC8004_AGENT_ID ? "live" : "not yet run on mainnet; the demo below runs the real code against simulators",
    erc8004AgentId: process.env.ERC8004_AGENT_ID ?? null,
    endpoints: {
      health: "GET /api/health",
      demoInfo: "GET /api/demo (live Mento cedi rate and the scenario list)",
      demoRun: 'POST /api/demo with JSON {"scenario": "normal"} (scenarios below)',
      pages: ["/", "/demo", "/live"],
    },
    scenarios: SCENARIOS,
    thirdPartyContracts: {
      note: "Not ours: shared contracts the agent calls.",
      mentoRouter: CONTRACTS.mentoRouter,
      ghsm: TOKENS.GHSm.address,
      usdt: TOKENS.USDT.address,
      erc8004IdentityRegistry: CONTRACTS.erc8004Identity,
    },
  };
}

export async function GET() {
  return Response.json(body(), { headers: { "cache-control": "no-store" } });
}

export async function HEAD() {
  return new Response(null, { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
