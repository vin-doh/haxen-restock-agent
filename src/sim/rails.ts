// Test doubles for the wallet, Textile, Mento and the chain. They behave like the real things in the
// ways the payment flow depends on, and let tests inject crashes at exact points.
import type { Address, Hex } from "viem";
import { decodeFunctionData, encodeFunctionData, erc20Abi, keccak256, toHex } from "viem";
import { CONTRACTS, TOKENS, type TokenSymbol } from "../config.ts";
import type { FirmQuote, RfqStatus, TextileClient } from "../fx/textile.ts";
import type { MentoQuoter } from "../fx/mento.ts";
import { TextileRail } from "../fx/textile-rail.ts";
import type { ChainReader } from "../payments/reconcile.ts";
import { type AgentWallet, type Call, WalletBlockedError, WalletFailedError } from "../wallet/altana.ts";

/** Simulated transaction hash: deterministic, looks like a real one, never a real transaction. */
export const hash = (n: number): Hex => keccak256(toHex(`haxen-restock-sim:${n}`));
export const WALLET = "0x1111111111111111111111111111111111111111" as Address;
export const SUPPLIER = "0x2222222222222222222222222222222222222222" as Address;
export const MAKER = "0x3333333333333333333333333333333333333333" as Address;
export const RELAY = "0x4444444444444444444444444444444444444444" as Address;
export const POOL = "0x6060606060606060606060606060606060606060" as Address;

export function symbolFor(token: Address): TokenSymbol {
  const t = token.toLowerCase();
  const hit = (Object.keys(TOKENS) as TokenSymbol[]).find((k) => TOKENS[k].address.toLowerCase() === t);
  if (!hit) throw new Error(`unknown token ${token}`);
  return hit;
}

type Log = { token: TokenSymbol; txHash: Hex; logIndex: number; from: Address; to: Address; value: bigint; block: bigint };

/** A tiny chain: token balances, Transfer logs, blocks. */
export class FakeChain implements ChainReader {
  block = 100n;
  logs: Log[] = [];
  balances: Record<TokenSymbol, Map<string, bigint>> = { USDT: new Map(), cNGN: new Map(), GHSm: new Map() };
  inputs = new Map<string, Hex>();
  failed = new Set<string>();
  private n = 1;

  nextHash(): Hex {
    return hash(this.n++);
  }
  move(token: TokenSymbol, from: Address, to: Address, value: bigint, txHash: Hex): void {
    const b = this.balances[token];
    const fb = b.get(from.toLowerCase()) ?? 0n;
    if (from !== MAKER && from !== POOL && fb < value) throw new Error(`insufficient ${token}`);
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

/** A wallet that applies calls to the FakeChain: approve is a no-op, swaps pull USD₮ and push the local stablecoin, transfers move tokens. */
export class FakeWallet implements AgentWallet {
  readonly address = WALLET;
  calls: Array<{ label: string; calls: Call[]; tx: Hex }> = [];
  executeCount = 0;
  private readonly chain: FakeChain;
  private readonly fx: FakeTextile;
  private readonly mento: FakeMento | null;
  script: WalletScript;
  fee = 10_000n; // 0.01 USD₮ relay fee per tx
  attributionInput: Hex = `0x${"ab".repeat(4)}${Buffer.from("altana,celo_test01").toString("hex")}12${"00"}80218021802180218021802180218021` as Hex;

  constructor(chain: FakeChain, fx: FakeTextile, script: WalletScript = {}, mento: FakeMento | null = null) {
    this.chain = chain;
    this.fx = fx;
    this.script = script;
    this.mento = mento;
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
      } else if (c.to.toLowerCase() === CONTRACTS.mentoRouter.toLowerCase()) {
        const swap = this.mento?.byData.get(c.data);
        if (!swap) throw new Error("swap data not from a known Mento quote");
        this.chain.move("USDT", WALLET, POOL, swap.amountIn, tx);
        this.chain.move(symbolFor(swap.tokenOut), POOL, WALLET, swap.expectedOut, tx);
      } else {
        const d = decodeFunctionData({ abi: erc20Abi, data: c.data });
        if (d.functionName === "transfer") this.chain.move(symbolFor(c.to), WALLET, d.args[0] as Address, d.args[1] as bigint, tx);
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
    const sym = symbolFor(token);
    const hit = this.chain.logs.find((l) => l.token === sym && l.from === WALLET && l.to.toLowerCase() === to.toLowerCase() && l.value === amount && l.block >= fromBlock);
    return hit?.txHash ?? null;
  }
  tokenBalance(token: Address) {
    return this.chain.balance(symbolFor(token), WALLET);
  }
  async received(token: Address, txHash: Hex) {
    const sym = symbolFor(token);
    return this.chain.logs.filter((l) => l.token === sym && l.txHash === txHash && l.to === WALLET).reduce((a, l) => a + l.value, 0n);
  }
  async sent(token: Address, txHash: Hex) {
    const sym = symbolFor(token);
    return this.chain.logs.filter((l) => l.token === sym && l.txHash === txHash && l.from === WALLET).reduce((a, l) => a + l.value, 0n);
  }
  async incomingTxs(token: Address, minAmount: bigint, fromBlock: bigint) {
    const sym = symbolFor(token);
    return [...new Set(this.chain.logs.filter((l) => l.token === sym && l.to === WALLET && l.value >= minAmount && l.block >= fromBlock).map((l) => l.txHash))];
  }
}

/** Mento stand-in: a fixed USD₮ -> cedi rate minus a route cost (1% by default), exact-input swaps through the Router address. */
export class FakeMento implements MentoQuoter {
  ghsPerUsd = 11.85;
  /** Route cost in basis points. Set to 0 when ghsPerUsd is already an all-in rate from a live quote. */
  costBps = 100n;
  byData = new Map<string, { amountIn: bigint; tokenOut: Address; expectedOut: bigint }>();
  routeAvailable = true;
  routerTarget: Address = CONTRACTS.mentoRouter;
  private n = 0;

  async amountOut(_tokenIn: Address, tokenOut: Address, amountIn: bigint) {
    if (!this.routeAvailable) throw new Error("no route");
    const outDecimals = TOKENS[symbolFor(tokenOut)].decimals;
    const rate = BigInt(Math.round(this.ghsPerUsd * 1_000_000)); // 6-decimal fixed point
    return (amountIn * rate * 10n ** BigInt(outDecimals) * (10_000n - this.costBps)) / (10n ** 6n * 10n ** 6n * 10_000n);
  }
  async buildSwap(p: { tokenIn: Address; tokenOut: Address; amountIn: bigint; recipient: Address; slippagePct: number; deadlineSec: bigint }) {
    const expectedOut = await this.amountOut(p.tokenIn, p.tokenOut, p.amountIn);
    const amountOutMin = (expectedOut * BigInt(Math.round((100 - p.slippagePct) * 100))) / 10_000n;
    const data = `0x3375aa2a${keccak256(toHex(`mento-sim:${this.n++}`)).slice(2)}` as Hex;
    this.byData.set(data, { amountIn: p.amountIn, tokenOut: p.tokenOut, expectedOut });
    return { to: this.routerTarget, data, amountOutMin, expectedOut };
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
      const { NoQuoteError } = await import("../fx/textile.ts");
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
  asRail(): TextileRail {
    return new TextileRail(this.asClient());
  }
}
