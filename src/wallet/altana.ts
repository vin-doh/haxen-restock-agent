// The agent's wallet: a non-custodial Altana smart agentic wallet on Celo.
//
// Two roles, two keys:
//  - The OWNER key controls the wallet. It grants the agent a session key with a spend cap,
//    a contract allowlist and an expiry, and can revoke it in one transaction.
//  - The AGENT only ever holds the SESSION key. The chain refuses anything outside the grant.
import {
  CELO,
  createClient,
  isAltanaError,
  type Session,
} from "@altananetwork/sdk";
import { createPublicClient, encodeFunctionData, erc20Abi, http, parseAbiItem, parseEventLogs, type Address, type Hex, type PublicClient } from "viem";
import { celo } from "viem/chains";
import { CONTRACTS, TOKENS } from "../config.ts";

export type Call = { to: Address; data: Hex; value?: bigint };

/** The owner's limits stopped the call. Not retried; the owner decides. */
export class WalletBlockedError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
/** The call was sent but did not succeed onchain, or the relay refused it for a non-policy reason. */
export class WalletFailedError extends Error {
  readonly txHash?: Hex;
  constructor(message: string, txHash?: Hex) {
    super(message);
    this.txHash = txHash;
  }
}

/** What the payment flow needs from a wallet. The Altana wallet implements it; tests use a fake. */
export interface AgentWallet {
  readonly address: Address;
  /** Sends the calls as one transaction from the wallet and waits for it. Throws WalletBlockedError / WalletFailedError. */
  execute(calls: Call[], label: string): Promise<{ txHash: Hex }>;
  blockNumber(): Promise<bigint>;
  /** Finds an ERC-20 Transfer from this wallet to `to` of exactly `amount`, at or after `fromBlock`. */
  findTransfer(token: Address, to: Address, amount: bigint, fromBlock: bigint): Promise<Hex | null>;
  tokenBalance(token: Address): Promise<bigint>;
  /** Total of `token` that arrived in this wallet within one transaction. */
  received(token: Address, txHash: Hex): Promise<bigint>;
  /** Total of `token` that left this wallet within one transaction. */
  sent(token: Address, txHash: Hex): Promise<bigint>;
  /** Transactions with a transfer of at least `minAmount` of `token` into this wallet, at or after `fromBlock`. */
  incomingTxs(token: Address, minAmount: bigint, fromBlock: bigint): Promise<Hex[]>;
}

export const BLOCKING_CODES = new Set(["spend_limit_exceeded", "call_not_permitted", "session_expired"]);

export function makeAltanaClient(attributionCode: string, rpcUrl = process.env.CELO_RPC_URL || "https://forno.celo.org") {
  return createClient({
    // Celo's own RPC for the SDK's chain reads; the SDK's default public endpoint timed out on us once.
    chains: [{ ...CELO, publicRpcUrl: rpcUrl }],
    // Every transaction carries "altana,<our code>" as an ERC-8021 suffix, so Celo credits it to this entry.
    appCode: [attributionCode],
    agentIdentity: {
      name: "HaxenMed Restock Agent",
      description: "Restocks a pharmacy and pays its suppliers in their local stablecoin on Celo, inside limits the owner sets.",
      endpoint: "https://github.com/vin-doh/haxen-restock-agent",
    },
  });
}

export function makePublicClient(rpcUrl: string): PublicClient {
  return createPublicClient({ chain: celo, transport: http(rpcUrl) }) as PublicClient;
}

export class AltanaAgentWallet implements AgentWallet {
  readonly address: Address;
  private readonly session: Session;
  private readonly client: ReturnType<typeof makeAltanaClient>;
  private readonly chain: PublicClient;

  constructor(session: Session, client: ReturnType<typeof makeAltanaClient>, chain: PublicClient) {
    this.session = session;
    this.client = client;
    this.chain = chain;
    this.address = session.walletAddress;
  }

  async execute(calls: Call[], label: string): Promise<{ txHash: Hex }> {
    if (this.session.expiry * 1000 <= Date.now()) throw new WalletBlockedError("session_expired", "The agent's session key has expired; the owner must grant a new one.");
    try {
      const res = await this.client.execute({
        session: this.session,
        calls: calls.map((c) => ({ to: c.to, data: c.data, value: c.value ?? 0n })),
        feeToken: TOKENS.USDT.address, // relay fees come out of the session's USD₮ cap
      });
      if (res.status === "CONFIRMED" && res.transactionHash) return { txHash: res.transactionHash };
      throw new WalletFailedError(`${label}: relay status ${res.status}${res.statusCode ? ` (${res.statusCode})` : ""}`, res.transactionHash);
    } catch (e) {
      if (e instanceof WalletFailedError) throw e;
      if (isAltanaError(e) && BLOCKING_CODES.has(e.code)) throw new WalletBlockedError(e.code, `${label}: ${e.message}`);
      throw new WalletFailedError(`${label}: ${(e as Error).message}`);
    }
  }

  blockNumber(): Promise<bigint> {
    return this.chain.getBlockNumber();
  }

  async findTransfer(token: Address, to: Address, amount: bigint, fromBlock: bigint): Promise<Hex | null> {
    const logs = await this.chain.getLogs({
      address: token,
      event: TRANSFER_EVENT,
      args: { from: this.address, to },
      fromBlock,
      toBlock: "latest",
    });
    const hit = logs.find((l) => l.args.value === amount);
    return hit?.transactionHash ?? null;
  }

  tokenBalance(token: Address): Promise<bigint> {
    return this.chain.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [this.address] });
  }

  received(token: Address, txHash: Hex): Promise<bigint> {
    return this.flow(token, txHash, "in");
  }

  sent(token: Address, txHash: Hex): Promise<bigint> {
    return this.flow(token, txHash, "out");
  }

  async incomingTxs(token: Address, minAmount: bigint, fromBlock: bigint): Promise<Hex[]> {
    const logs = await this.chain.getLogs({ address: token, event: TRANSFER_EVENT, args: { to: this.address }, fromBlock, toBlock: "latest" });
    return [...new Set(logs.filter((l) => (l.args.value ?? 0n) >= minAmount).map((l) => l.transactionHash!))];
  }

  private async flow(token: Address, txHash: Hex, dir: "in" | "out"): Promise<bigint> {
    const receipt = await this.chain.getTransactionReceipt({ hash: txHash });
    const me = this.address.toLowerCase();
    return parseEventLogs({ abi: [TRANSFER_EVENT], logs: receipt.logs, eventName: "Transfer" })
      .filter((l) => l.address.toLowerCase() === token.toLowerCase() && (dir === "in" ? l.args.to : l.args.from).toLowerCase() === me)
      .reduce((sum, l) => sum + l.args.value, 0n);
  }
}

export const TRANSFER_EVENT = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

export function transferCall(token: Address, to: Address, amount: bigint): Call {
  return { to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount] }) };
}

/**
 * The permissions the owner grants the agent. Exactly the calls the restock flow makes:
 *  - approve USD₮ (the exchange pulls exactly the swap's input)
 *  - swap on Mento's Router (cedis) or Textile's settlement contracts (naira)
 *  - transfer GHSm, cNGN or USD₮ (paying the supplier)
 * Caps are per UTC day, in atomic units. The USD₮ cap also pays the relay's fees.
 */
export function restockPermissions(caps: { usdtPerDay: bigint; ghsPerDay: bigint; cngnPerDay?: bigint }) {
  const calls: Array<{ signature?: string; to: Address }> = [
    { signature: "approve(address,uint256)", to: TOKENS.USDT.address },
    { to: CONTRACTS.mentoRouter },
    { signature: "transfer(address,uint256)", to: TOKENS.GHSm.address },
    { signature: "transfer(address,uint256)", to: TOKENS.USDT.address },
  ];
  const spend = [
    { limit: caps.usdtPerDay, period: "day" as const, token: TOKENS.USDT.address },
    { limit: caps.ghsPerDay, period: "day" as const, token: TOKENS.GHSm.address },
  ];
  // Naira suppliers (via Textile) only when the owner sets a cNGN cap.
  if (caps.cngnPerDay && caps.cngnPerDay > 0n) {
    calls.push({ to: CONTRACTS.textileReactor }, { to: CONTRACTS.textileVaultExecutor }, { signature: "transfer(address,uint256)", to: TOKENS.cNGN.address });
    spend.push({ limit: caps.cngnPerDay, period: "day" as const, token: TOKENS.cNGN.address });
  }
  return { calls: calls as Array<{ signature: string; to: Address } | { to: Address }>, spend };
}
