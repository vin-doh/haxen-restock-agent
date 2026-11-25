// Chain constants and environment settings. Addresses are Celo mainnet (42220),
// checked against the Textile FX address book and the Celo docs (Nov 2026).
import type { Address, Hex } from "viem";

export const CELO_CHAIN_ID = 42220;

export const TOKENS = {
  USDT: { symbol: "USDT", address: "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e" as Address, decimals: 6 },
  cNGN: { symbol: "cNGN", address: "0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f" as Address, decimals: 6 },
  /** Mento Ghanaian Cedi (formerly cGHS). Checked onchain: symbol GHSm, 18 decimals. */
  GHSm: { symbol: "GHSm", address: "0xfAeA5F3404bbA20D3cc2f8C4B0A888F55a3c7313" as Address, decimals: 18 },
} as const;
export type TokenSymbol = keyof typeof TOKENS;

export const CONTRACTS = {
  /** Textile FX settlement contract. Swaps are sent here; USD₮ is approved to the spender each quote names. */
  textileReactor: "0xa9AA0a64769cBed4d3B1Ceb4Df01CdE915C235b3" as Address,
  /** Textile settlement path used when a quote fills from an Operator Vault. */
  textileVaultExecutor: "0x01b006d5c687bde182aa36F542f1f014144742e2" as Address,
  /** Mento v3 Router (docs.mento.org deployments). USD₮ -> USDm -> GHSm swaps go through it. */
  mentoRouter: "0x4861840C2EfB2b98312B0aE34d86fD73E8f9B6f6" as Address,
  /** ERC-8004 Identity Registry on Celo mainnet. */
  erc8004Identity: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" as Address,
} as const;

export const TEXTILE_API = "https://api.textilecredit.com/v2";

export type Settings = {
  attributionCode: string;
  rpcUrl: string;
  inventorySource: "sample" | "haxenmed";
  haxenmedUrl?: string;
  haxenmedApiKey?: string;
  /** Local guards, in USD₮ atomic units. The onchain session cap is the hard limit; these stop the agent earlier. */
  maxUsdtPerOrder: bigint;
  maxUsdtPerRun: bigint;
  dbPath: string;
  sessionPath: string;
};

const CODE_RE = /^[a-z0-9_]{1,32}$/;

export function readSettings(env: NodeJS.ProcessEnv = process.env): Settings {
  const attributionCode = env.ATTRIBUTION_CODE ?? "celo_3175e01fb588";
  if (!CODE_RE.test(attributionCode)) throw new Error(`ATTRIBUTION_CODE must be lowercase letters, digits or _ (got "${attributionCode}")`);
  const source = env.INVENTORY_SOURCE ?? "sample";
  if (source !== "sample" && source !== "haxenmed") throw new Error(`INVENTORY_SOURCE must be "sample" or "haxenmed"`);
  return {
    attributionCode,
    rpcUrl: env.CELO_RPC_URL || "https://forno.celo.org",
    inventorySource: source,
    haxenmedUrl: env.HAXENMED_URL || undefined,
    haxenmedApiKey: env.HAXENMED_API_KEY || undefined,
    maxUsdtPerOrder: wholeToAtomic(env.MAX_USDT_PER_ORDER ?? "25", TOKENS.USDT.decimals),
    maxUsdtPerRun: wholeToAtomic(env.MAX_USDT_PER_RUN ?? "50", TOKENS.USDT.decimals),
    dbPath: env.LEDGER_DB ?? "state/ledger.db",
    sessionPath: env.SESSION_FILE ?? "state/session.json",
  };
}

export function requireKey(name: "OWNER_PRIVATE_KEY" | "SESSION_PRIVATE_KEY", env: NodeJS.ProcessEnv = process.env): Hex {
  const v = env[name];
  if (!v || !/^0x[0-9a-fA-F]{64}$/.test(v)) throw new Error(`${name} is missing or not a 0x-prefixed 32-byte hex key. Put it in .env (never in Git).`);
  return v as Hex;
}

/** "12.5" with 6 decimals -> 12500000n. Rejects more decimals than the token has. */
export function wholeToAtomic(value: string, decimals: number): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!m) throw new Error(`Not a positive decimal amount: "${value}"`);
  const frac = m[2] ?? "";
  if (frac.length > decimals) throw new Error(`"${value}" has more than ${decimals} decimal places`);
  return BigInt(m[1]!) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}

/** 12500000n with 6 decimals -> "12.5". */
export function atomicToWhole(value: bigint, decimals: number): string {
  const neg = value < 0n;
  const abs = neg ? -value : value;
  const base = 10n ** BigInt(decimals);
  const frac = (abs % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${abs / base}${frac ? "." + frac : ""}`;
}
