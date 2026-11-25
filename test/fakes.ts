// Test doubles for the wallet, Textile and the chain. They behave like the real things in the
// ways the payment flow depends on, and let tests inject crashes at exact points.
import type { Address, Hex } from "viem";
import { decodeFunctionData, encodeFunctionData, erc20Abi } from "viem";
import { CONTRACTS, TOKENS, type TokenSymbol } from "../src/config.ts";
import type { FirmQuote, RfqStatus, TextileClient } from "../src/fx/textile.ts";
import type { ChainReader } from "../src/payments/reconcile.ts";
import { type AgentWallet, type Call, WalletBlockedError, WalletFailedError } from "../src/wallet/altana.ts";

export const hash = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}` as Hex;
export const WALLET = "0x1111111111111111111111111111111111111111" as Address;
export const SUPPLIER = "0x2222222222222222222222222222222222222222" as Address;
export const MAKER = "0x3333333333333333333333333333333333333333" as Address;
export const RELAY = "0x4444444444444444444444444444444444444444" as Address;

type Log = { token: TokenSymbol; txHash: Hex; logIndex: number; from: Address; to: Address; value: bigint; block: bigint };

/** A tiny chain: token balances, Transfer logs, blocks. */
export class FakeChain implements ChainReader {
  block = 100n;
  logs: Log[] = [];
  balances: Record<TokenSymbol, Map<string, bigint>> = { USDT: new Map(), cNGN: new Map() };
  inputs = new Map<string, Hex>();
  failed = new Set<string>();
  private n = 1;

  nextHash(): Hex {
    return hash(this.n++);
  }
  move(token: TokenSymbol, from: Address, to: Address, value: bigint, txHash: Hex): void {
    const b = this.balances[token];
    const fb = b.get(from.toLowerCase()) ?? 0n;
    if (from !== MAKER && fb < value) throw new Error(`insufficient ${token}`);
    b.set(from.toLowerCase(), fb - value);
    b.set(to.toLowerCase(), (b.get(to.toLowerCase()) ?? 0n) + value);
    this.logs.push({ token, txHash, logIndex: this.logs.length, from, to, value, block: this.block });
  }
  mint(token: TokenSymbol, to: Address, value: bigint): Hex {
    const tx = this.nextHash();
    this.balances[token].set(to.toLowerCase(), (this.balances[token].get(to.toLowerCase()) ?? 0n) + value);
    this.logs.push({ token, txHash: tx, logIndex: this.logs.length, from: "0x9999999999999999999999999999999999999999", to, value, block: this.block });
    this.block++;
    return tx;
  }
  async blockNumber() {
    return this.block;
  }
  async transfers(token: TokenSymbol, wallet: Address, fromBlock: bigint, toBlock: bigint) {
    const w = wallet.toLowerCase();
    return this.logs
      .filter((l) => l.token === token && l.block >= fromBlock && l.block <= toBlock && (l.from.toLowerCase() === w || l.to.toLowerCase() === w))
      .map(({ block: _b, ...l }) => l);
  }
  async balance(token: TokenSymbol, wallet: Address) {
    return this.balances[token].get(wallet.toLowerCase()) ?? 0n;
  }
  async txInput(h: Hex) {
    return this.inputs.get(h.toLowerCase()) ?? "0x";
  }
  async txSucceeded(h: Hex) {
    return !this.failed.has(h.toLowerCase());
  }
}

export type WalletScript = {
  /** Throw this before sending the Nth execute (1-based). */
  blockOn?: { call: number; code: string };
  /** Send the Nth execute, then throw as if the relay connection dropped (the tx still landed). */
  dropAfterSend?: number;
  /** Throw before sending the Nth execute, as if the relay was unreachable (nothing landed). */
  failBeforeSend?: number;
};

/** A wallet that applies calls to the FakeChain: approve is a no-op, swaps pull USD₮ and push cNGN, transfers move tokens. */
export class FakeWallet implements AgentWallet {
  readonly address = WALLET;
  calls: Array<{ label: string; calls: Call[]; tx: Hex }> = [];
  executeCount = 0;
  private readonly chain: FakeChain;
  private readonly fx: FakeTextile;
  script: WalletScript;
  fee = 10_000n; // 0.01 USD₮ relay fee per tx
  attributionInput: Hex = `0x${"ab".repeat(4)}${Buffer.from("altana,celo_test01").toString("hex")}12${"00"}80218021802180218021802180218021` as Hex;

  constructor(chain: FakeChain, fx: FakeTextile, script: WalletScript = {}) {
    this.chain = chain;
    this.fx = fx;
    this.script = script;
  }

  async execute(calls: Call[], label: string): Promise<{ txHash: Hex }> {
    this.executeCount++;
    const n = this.executeCount;
    if (this.script.blockOn?.call === n) throw new WalletBlockedError(this.script.blockOn.code, `${label}: blocked by session policy`);
    if (this.script.failBeforeSend === n) throw new WalletFailedError(`${label}: relay unreachable`);
    const tx = this.chain.nextHash();
    for (const c of calls) {
      if (c.to.toLowerCase() === CONTRACTS.textileReactor.toLowerCase()) {
        const q = this.fx.byData.get(c.data);
        if (!q) throw new Error("swap data not from a known quote");
        this.chain.move("USDT", WALLET, MAKER, q.takerPays, tx);
        this.chain.move("cNGN", MAKER, WALLET, q.buyAmount, tx);
        this.fx.filled.set(q.rfqId, tx);
      } else if (c.to.toLowerCase() === TOKENS.cNGN.address.toLowerCase() || c.to.toLowerCase() === TOKENS.USDT.address.toLowerCase()) {
        const d = decodeFunctionData({ abi: erc20Abi, data: c.data });
        if (d.functionName === "transfer") {
          const token: TokenSymbol = c.to.toLowerCase() === TOKENS.cNGN.address.toLowerCase() ? "cNGN" : "USDT";
          this.chain.move(token, WALLET, d.args[0] as Address, d.args[1] as bigint, tx);
        }
      }
    }
    this.chain.move("USDT", WALLET, RELAY, this.fee, tx);
    this.chain.inputs.set(tx.toLowerCase(), this.attributionInput);
    this.chain.block++;
    this.calls.push({ label, calls, tx });
    if (this.script.dropAfterSend === n) throw new WalletFailedError(`${label}: connection dropped after send`);
    return { txHash: tx };
  }
  blockNumber() {
    return this.chain.blockNumber();
  }
  async findTransfer(token: Address, to: Address, amount: bigint, fromBlock: bigint) {
    const sym: TokenSymbol = token.toLowerCase() === TOKENS.cNGN.address.toLowerCase() ? "cNGN" : "USDT";
    const hit = this.chain.logs.find((l) => l.token === sym && l.from === WALLET && l.to.toLowerCase() === to.toLowerCase() && l.value === amount && l.block >= fromBlock);
    return hit?.txHash ?? null;
  }
  tokenBalance(token: Address) {
    return this.chain.balance(token.toLowerCase() === TOKENS.cNGN.address.toLowerCase() ? "cNGN" : "USDT", WALLET);
  }
}

/** Textile stand-in: quotes at a fixed rate, remembers fills, supports status/cancel/submit. */
export class FakeTextile {
  rateNgnPerUsd = 1500n;
  feeBps = 2n;
  quotes: FirmQuote[] = [];
  byData = new Map<string, FirmQuote>();
  filled = new Map<string, Hex>();
  cancelled: string[] = [];
  now = 1_000_000;
  ttlMs = 60_000;
  swapTarget: Address = CONTRACTS.textileReactor;
  noQuote = false;

  async firmQuoteForExactOutput(p: { taker: Address; sellToken: Address; buyToken: Address; buyAmount: bigint }): Promise<FirmQuote> {
    if (this.noQuote) {
      const { NoQuoteError } = await import("../src/fx/textile.ts");
      throw new NoQuoteError("no_makers_online");
    }
    const sell = (p.buyAmount + this.rateNgnPerUsd - 1n) / this.rateNgnPerUsd; // both 6 decimals
    const fee = (sell * this.feeBps + 9_999n) / 10_000n;
    const id = `rfq_${this.quotes.length + 1}`;
    const q: FirmQuote = {
      rfqId: id,
      claimToken: `claim_${id}`,
      sellAmount: sell,
      buyAmount: p.buyAmount,
      feeAmount: fee,
      takerPays: sell + fee,
      expiresAt: this.now + this.ttlMs,
      reactor: CONTRACTS.textileReactor,
      approval: { to: p.sellToken, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [CONTRACTS.textileReactor, sell + fee] }), value: "0" },
      swap: { to: this.swapTarget, data: `0xdeadbeef${Buffer.from(id).toString("hex")}` as Hex, value: "0" },
    };
    this.quotes.push(q);
    this.byData.set(q.swap.data, q);
    return q;
  }
  msLeft(q: FirmQuote) {
    return q.expiresAt - this.now;
  }
  async status(rfqId: string, _claim: string): Promise<{ status: RfqStatus; txHash?: Hex; buyAmount?: bigint; sellAmount?: bigint }> {
    const tx = this.filled.get(rfqId);
    const q = this.quotes.find((x) => x.rfqId === rfqId)!;
    if (tx) return { status: "filled", txHash: tx, buyAmount: q.buyAmount, sellAmount: q.takerPays };
    return { status: this.now > q.expiresAt ? "expired" : "quoted" };
  }
  async submit() {}
  async cancel(rfqId: string) {
    this.cancelled.push(rfqId);
  }
  asClient(): TextileClient {
    return this as unknown as TextileClient;
  }
}
