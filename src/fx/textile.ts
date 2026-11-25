// Textile FX RFQ v2 client (keyless): firm quotes for converting USD₮ into a local stablecoin.
// Docs: https://fx-docs.textilecredit.com/api/v2/rfq.html and /authentication.html
//
// Keyless callers prove control of the taker wallet with an EIP-712 "Textile Taker Control"
// signature. That proof grants quoting for ~12h; it grants no spending power. Spending only
// happens when the wallet itself sends transactions.swap, inside the owner's session cap.
import { randomBytes } from "node:crypto";
import type { Address, Hex } from "viem";
import { CELO_CHAIN_ID, TEXTILE_API } from "../config.ts";

export type TxRequest = { to: Address; data: Hex; value: string; chainId?: number };

export type FirmQuote = {
  rfqId: string;
  claimToken: string;
  sellAmount: bigint;
  buyAmount: bigint;
  feeAmount: bigint;
  /** Exact amount of the sell token that leaves the wallet (fee included). */
  takerPays: bigint;
  expiresAt: number;
  reactor: Address;
  approval: TxRequest;
  swap: TxRequest;
};

export type RfqStatus = "soliciting" | "quoted" | "no_quote" | "submitted" | "filled" | "failed" | "expired";

export type TakerProof = { nonce: Hex; issuedAt: number; signature: Hex };

/** Signs the EIP-712 TakerControl message for the taker wallet (the Altana wallet's owner key, an EOA under EIP-7702). */
export type ProofSigner = (typed: ReturnType<typeof takerControlTypedData>) => Promise<Hex>;

export class TextileError extends Error {
  readonly status: number;
  readonly code: string;
  readonly reason?: string;
  constructor(status: number, code: string, message: string, reason?: string) {
    super(`Textile ${status} ${code}: ${message}${reason ? ` (${reason})` : ""}`);
    this.status = status;
    this.code = code;
    this.reason = reason;
  }
}

export class NoQuoteError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`Textile returned no quote: ${reason}`);
    this.reason = reason;
  }
}

export function takerControlTypedData(taker: Address, nonce: Hex, issuedAt: number, chainId = CELO_CHAIN_ID) {
  return {
    domain: { name: "Textile Taker Control", version: "1", chainId },
    types: {
      TakerControl: [
        { name: "taker", type: "address" },
        { name: "chainId", type: "uint256" },
        { name: "nonce", type: "bytes32" },
        { name: "issuedAt", type: "uint256" },
      ],
    },
    primaryType: "TakerControl" as const,
    message: { taker, chainId: BigInt(chainId), nonce, issuedAt: BigInt(issuedAt) },
  };
}

export class TextileClient {
  private readonly base: string;
  private readonly fetchFn: typeof fetch;
  private readonly signProof: ProofSigner | null;
  private readonly now: () => number;

  constructor(opts: { baseUrl?: string; fetchFn?: typeof fetch; signProof?: ProofSigner; now?: () => number } = {}) {
    this.base = (opts.baseUrl ?? TEXTILE_API).replace(/\/$/, "");
    this.fetchFn = opts.fetchFn ?? fetch;
    this.signProof = opts.signProof ?? null;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Asks for a firm quote that delivers exactly `buyAmount` of `buyToken` to `taker`.
   * Sends without a proof first; if Textile asks for proof of control (401), signs one and retries once.
   */
  async firmQuoteForExactOutput(p: { taker: Address; sellToken: Address; buyToken: Address; buyAmount: bigint; chainId?: number }): Promise<FirmQuote> {
    const body: Record<string, unknown> = {
      chainId: p.chainId ?? CELO_CHAIN_ID,
      sellToken: p.sellToken,
      buyToken: p.buyToken,
      buyAmount: p.buyAmount.toString(),
      taker: p.taker,
    };
    let res = await this.post("/rfq/request", body);
    if (res.status === 401 && isProofRequest(res.json)) {
      if (!this.signProof) throw new TextileError(401, "unauthorized", "Textile needs proof of wallet control and no proof signer is configured", "proof_of_control_required");
      body.takerProof = await this.makeProof(p.taker, p.chainId ?? CELO_CHAIN_ID);
      res = await this.post("/rfq/request", body);
    }
    if (res.status !== 200) throw toError(res.status, res.json);
    const data = (res.json as { data?: Record<string, any> }).data ?? {};
    if (data.status === "no_quote") throw new NoQuoteError(String(data.reason ?? "unknown"));
    if (data.status !== "quoted" || !data.quote || !data.transactions?.swap || !data.transactions?.approval) {
      throw new TextileError(200, "unexpected_response", `RFQ status ${data.status} without a complete quote`);
    }
    const q = data.quote;
    const quote: FirmQuote = {
      rfqId: String(data.rfqId),
      claimToken: String(data.claimToken),
      sellAmount: BigInt(q.sellAmount),
      buyAmount: BigInt(q.buyAmount),
      feeAmount: BigInt(q.feeAmount ?? 0),
      takerPays: BigInt(q.takerPays),
      expiresAt: toMillis(q.expiresAt),
      reactor: q.reactor as Address,
      approval: data.transactions.approval as TxRequest,
      swap: data.transactions.swap as TxRequest,
    };
    // Never trust a quote that delivers less than we asked for, or names a different taker.
    if (quote.buyAmount < p.buyAmount) throw new TextileError(200, "short_quote", `quote buys ${quote.buyAmount}, asked for ${p.buyAmount}`);
    if (q.taker && String(q.taker).toLowerCase() !== p.taker.toLowerCase()) throw new TextileError(200, "taker_mismatch", `quote is bound to ${q.taker}`);
    if (quote.approval.to.toLowerCase() !== p.sellToken.toLowerCase()) throw new TextileError(200, "approval_mismatch", `approval targets ${quote.approval.to}, not the sell token`);
    return quote;
  }

  /** Milliseconds left before the quote can no longer be accepted. */
  msLeft(q: FirmQuote): number {
    return q.expiresAt - this.now();
  }

  async status(rfqId: string, claimToken: string): Promise<{ status: RfqStatus; txHash?: Hex; buyAmount?: bigint; sellAmount?: bigint }> {
    const res = await this.request("GET", `/rfq/${encodeURIComponent(rfqId)}`, undefined, { "x-rfq-claim": claimToken });
    if (res.status !== 200) throw toError(res.status, res.json);
    const d = (res.json as { data?: Record<string, any> }).data ?? {};
    return {
      status: d.status as RfqStatus,
      txHash: d.txHash as Hex | undefined,
      buyAmount: d.buyAmount !== undefined ? BigInt(d.buyAmount) : undefined,
      sellAmount: d.sellAmount !== undefined ? BigInt(d.sellAmount) : undefined,
    };
  }

  /** Tells Textile the swap hash. Optional (settlement is read from chain) and idempotent. */
  async submit(rfqId: string, claimToken: string, txHash: Hex): Promise<void> {
    const res = await this.request("POST", `/rfq/${encodeURIComponent(rfqId)}/submit`, { txHash }, { "x-rfq-claim": claimToken });
    if (res.status !== 200 && res.status !== 409) throw toError(res.status, res.json);
  }

  async cancel(rfqId: string, claimToken: string): Promise<void> {
    const res = await this.request("POST", `/rfq/${encodeURIComponent(rfqId)}/cancel`, {}, { "x-rfq-claim": claimToken });
    if (res.status !== 200 && res.status !== 409) throw toError(res.status, res.json);
  }

  private async makeProof(taker: Address, chainId: number): Promise<TakerProof> {
    const nonce = `0x${randomBytes(32).toString("hex")}` as Hex;
    const issuedAt = this.now();
    const signature = await this.signProof!(takerControlTypedData(taker, nonce, issuedAt, chainId));
    return { nonce, issuedAt, signature };
  }

  private post(path: string, body: unknown) {
    return this.request("POST", path, body);
  }

  private async request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await this.fetchFn(`${this.base}${path}`, {
      method,
      headers: { "content-type": "application/json", accept: "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      // /rfq/request can take up to ~70s while makers price it.
      signal: AbortSignal.timeout(75_000),
    });
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { status: res.status, json };
  }
}

function isProofRequest(json: unknown): boolean {
  const reason = (json as { error?: { details?: { reason?: string } } })?.error?.details?.reason;
  return reason === "proof_of_control_required" || reason === "proof_of_control_stale";
}

function toError(status: number, json: unknown): TextileError {
  const e = (json as { error?: { code?: string; message?: string; details?: { reason?: string } } })?.error;
  return new TextileError(status, e?.code ?? "http_error", e?.message ?? "request failed", e?.details?.reason);
}

function toMillis(v: unknown): number {
  if (typeof v === "number") return v < 1e12 ? v * 1000 : v;
  const n = Date.parse(String(v));
  if (Number.isNaN(n)) throw new TextileError(200, "bad_expiry", `cannot read expiresAt ${String(v)}`);
  return n;
}
