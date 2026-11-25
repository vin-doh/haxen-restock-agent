// Pays a purchase order end to end, one recorded step at a time:
//   CREATED -> QUOTED -> SWAP_SUBMITTING -> SWAPPED -> PAY_SUBMITTING -> PAID
//
// Before anything is sent, the step's intent is saved. If the process dies mid-step,
// the next run asks the outside world what actually happened (Textile's RFQ status for
// the swap, the chain's Transfer logs for the payment) instead of guessing, so a crash
// can delay a payment but never pay a supplier twice.
import type { Address, Hex } from "viem";
import { CONTRACTS, TOKENS, atomicToWhole } from "../config.ts";
import { type FirmQuote, NoQuoteError, type TextileClient } from "../fx/textile.ts";
import {
  type Ledger,
  type Payment,
  StaleStateError,
  fxConversionPostings,
  supplierPaymentPostings,
} from "../ledger/ledger.ts";
import type { PurchaseOrder } from "../planner.ts";
import { isUnspendable } from "../inventory/source.ts";
import { type AgentWallet, WalletBlockedError, WalletFailedError, transferCall } from "../wallet/altana.ts";

export type ExecutorOptions = {
  maxUsdtPerOrder: bigint;
  maxUsdtPerRun: bigint;
  /** Don't send a swap with less than this left on the quote. */
  minQuoteMsLeft?: number;
  /** Blocks to wait before deciding an unseen transfer never happened. */
  settleBlocks?: bigint;
  log?: (line: string) => void;
};

export type Outcome = { payment: Payment; note: string };

const TEXTILE_TARGETS = new Set([CONTRACTS.textileReactor.toLowerCase(), CONTRACTS.textileVaultExecutor.toLowerCase()]);

export class PaymentExecutor {
  private readonly ledger: Ledger;
  private readonly wallet: AgentWallet;
  private readonly fx: TextileClient;
  private readonly opts: Required<Omit<ExecutorOptions, "log">> & { log: (line: string) => void };
  private spentThisRun = 0n;

  constructor(ledger: Ledger, wallet: AgentWallet, fx: TextileClient, opts: ExecutorOptions) {
    this.ledger = ledger;
    this.wallet = wallet;
    this.fx = fx;
    this.opts = { minQuoteMsLeft: 15_000, settleBlocks: 30n, log: () => {}, ...opts };
  }

  /** Creates (or finds) the payment for an order and drives it as far as it can go. */
  async payOrder(order: PurchaseOrder): Promise<Outcome> {
    if (isUnspendable(order.supplier.payoutAddress)) throw new Error(`${order.id}: supplier ${order.supplier.id} has a zero/burn payout address; refusing to pay`);
    const { payment, created } = this.ledger.createPayment({
      purchaseOrderId: order.id,
      supplierId: order.supplier.id,
      supplierAddress: order.supplier.payoutAddress,
      currency: order.supplier.currency,
      amount: order.total,
    });
    if (!created) this.opts.log(`${order.id}: already known (${payment.state}), resuming`);
    return this.advance(payment);
  }

  /** Drives a payment until it is PAID or stops for a reason that needs a person or a later run. */
  async advance(start: Payment): Promise<Outcome> {
    let p = start;
    for (let guard = 0; guard < 8; guard++) {
      try {
        switch (p.state) {
          case "CREATED": {
            const r = await this.fromCreated(p);
            if (r.stop) return { payment: r.payment, note: r.note };
            p = r.payment;
            break;
          }
          case "QUOTED":
            // A quote lives only in memory. If we find one saved from an earlier run, it has expired: let it go.
            p = await this.releaseStaleQuote(p);
            break;
          case "SWAP_SUBMITTING": {
            const r = await this.recoverSwap(p);
            if (r.stop) return { payment: r.payment, note: r.note };
            p = r.payment;
            break;
          }
          case "SWAPPED":
            p = await this.sendPayment(p);
            break;
          case "PAY_SUBMITTING": {
            const r = await this.recoverPayment(p);
            if (r.stop) return { payment: r.payment, note: r.note };
            p = r.payment;
            break;
          }
          case "PAID":
          case "RECONCILED":
            return { payment: p, note: "paid" };
          case "BLOCKED":
            return { payment: p, note: `blocked by the owner's limits: ${p.error}` };
          case "FAILED":
            return { payment: p, note: `failed: ${p.error}` };
        }
      } catch (e) {
        if (e instanceof WalletBlockedError) {
          const fresh = this.ledger.get(p.id)!;
          const blocked = this.ledger.transition(fresh, "BLOCKED", { detail: e.code, fields: { error: e.message } });
          this.opts.log(`${p.purchaseOrderId}: BLOCKED (${e.code}) ${e.message}`);
          return { payment: blocked, note: `blocked: ${e.code}` };
        }
        if (e instanceof StaleStateError) return { payment: this.ledger.get(p.id)!, note: "another run is handling this payment" };
        throw e;
      }
    }
    return { payment: p, note: "stopped after too many steps" };
  }

  // ---------- steps ----------

  private async fromCreated(p: Payment): Promise<{ payment: Payment; stop?: boolean; note: string }> {
    if (p.currency === "USDT") {
      this.checkBudget(p.amount, p);
      return { payment: this.ledger.transition(p, "SWAPPED", { detail: "supplier is paid in USD₮; no conversion", fields: { usdtSpent: p.amount } }), note: "" };
    }

    let quote: FirmQuote;
    try {
      quote = await this.fx.firmQuoteForExactOutput({
        taker: this.wallet.address,
        sellToken: TOKENS.USDT.address,
        buyToken: TOKENS[p.currency].address,
        buyAmount: p.amount,
      });
    } catch (e) {
      if (e instanceof NoQuoteError) return { payment: p, stop: true, note: `no quote from Textile (${e.reason}); will retry next run` };
      throw e;
    }
    const usd = atomicToWhole(quote.takerPays, TOKENS.USDT.decimals);
    this.opts.log(`${p.purchaseOrderId}: quote ${quote.rfqId}: ${usd} USD₮ -> ${atomicToWhole(quote.buyAmount, TOKENS[p.currency].decimals)} ${p.currency}`);

    try {
      this.checkBudget(quote.takerPays, p);
    } catch (e) {
      await this.fx.cancel(quote.rfqId, quote.claimToken).catch(() => {});
      throw e;
    }
    if (!TEXTILE_TARGETS.has(quote.swap.to.toLowerCase())) {
      await this.fx.cancel(quote.rfqId, quote.claimToken).catch(() => {});
      const failed = this.ledger.transition(p, "FAILED", { detail: "unexpected swap target", fields: { error: `Textile swap targets unknown contract ${quote.swap.to}` } });
      return { payment: failed, stop: true, note: "refused: swap goes to an unknown contract" };
    }

    let q = this.ledger.transition(p, "QUOTED", { detail: quote.rfqId, fields: { rfqId: quote.rfqId, rfqClaim: quote.claimToken, usdtSpent: quote.takerPays } });
    if (this.fx.msLeft(quote) < this.opts.minQuoteMsLeft) {
      await this.fx.cancel(quote.rfqId, quote.claimToken).catch(() => {});
      q = this.ledger.transition(q, "CREATED", { detail: "quote too close to expiry", fields: { rfqClaim: null } });
      return { payment: q, stop: true, note: "quote expired before it could be used; will retry" };
    }
    return { payment: await this.swap(q, quote), note: "" };
  }

  private async swap(p: Payment, quote: FirmQuote): Promise<Payment> {
    const submitting = this.ledger.transition(p, "SWAP_SUBMITTING", { detail: `takerPays ${quote.takerPays}` });
    try {
      // Approval must confirm before the swap (Textile's rule), so they go as two transactions.
      const approve = await this.wallet.execute([{ to: quote.approval.to, data: quote.approval.data }], "approve USD₮ for Textile");
      this.ledger.recordWalletTx(approve.txHash, "approve", p.id);
      if (this.fx.msLeft(quote) <= 0) throw new WalletFailedError("quote expired while the approval confirmed");
      const { txHash } = await this.wallet.execute([{ to: quote.swap.to, data: quote.swap.data }], "Textile swap");
      this.ledger.recordWalletTx(txHash, "swap", p.id);
      await this.fx.submit(quote.rfqId, quote.claimToken, txHash).catch(() => {});
      this.opts.log(`${p.purchaseOrderId}: swapped in ${txHash}`);
      return this.ledger.transition(submitting, "SWAPPED", {
        detail: txHash,
        fields: { swapTx: txHash, rfqClaim: null },
        book: { kind: "fx_conversion", txHash, postings: fxConversionPostings(quote.takerPays, quote.buyAmount), memo: `Textile ${quote.rfqId}` },
      });
    } catch (e) {
      if (e instanceof WalletBlockedError) {
        // The chain refused before anything was sent: release the quote so the maker isn't left holding it.
        await this.fx.cancel(quote.rfqId, quote.claimToken).catch(() => {});
        throw e;
      }
      // We don't know for sure whether the swap landed; recovery asks Textile.
      this.opts.log(`${p.purchaseOrderId}: swap did not confirm (${(e as Error).message}); checking with Textile`);
      const r = await this.recoverSwap(submitting, quote.claimToken, quote);
      return r.payment;
    }
  }

  private async recoverSwap(p: Payment, claim?: string, quote?: FirmQuote): Promise<{ payment: Payment; stop?: boolean; note: string }> {
    const claimToken = claim ?? this.ledger.rfqClaim(p.id);
    if (!p.rfqId || !claimToken) {
      const failed = this.ledger.transition(p, "FAILED", { detail: "cannot recover swap", fields: { error: "swap state lost its RFQ id or claim token; check the wallet by hand" } });
      return { payment: failed, stop: true, note: "needs a person: swap record incomplete" };
    }
    const st = await this.fx.status(p.rfqId, claimToken);
    if (st.status === "filled" && st.txHash) {
      const buy = st.buyAmount ?? quote?.buyAmount ?? p.amount;
      const sell = st.sellAmount ?? quote?.takerPays ?? p.usdtSpent!;
      this.ledger.recordWalletTx(st.txHash, "swap", p.id); // ours, even though we learned the hash from Textile
      return {
        payment: this.ledger.transition(p, "SWAPPED", {
          detail: `recovered: ${st.txHash}`,
          fields: { swapTx: st.txHash, rfqClaim: null },
          book: { kind: "fx_conversion", txHash: st.txHash, postings: fxConversionPostings(sell, buy), memo: `Textile ${p.rfqId} (recovered)` },
        }),
        note: "",
      };
    }
    if (st.status === "expired" || st.status === "failed" || st.status === "no_quote") {
      return { payment: this.ledger.transition(p, "CREATED", { detail: `Textile says ${st.status}; nothing moved`, fields: { rfqClaim: null } }), stop: true, note: `swap ${st.status}; will retry next run` };
    }
    return { payment: p, stop: true, note: `swap still ${st.status} at Textile; check again next run` };
  }

  private async releaseStaleQuote(p: Payment): Promise<Payment> {
    const claim = this.ledger.rfqClaim(p.id);
    if (p.rfqId && claim) await this.fx.cancel(p.rfqId, claim).catch(() => {});
    return this.ledger.transition(p, "CREATED", { detail: "stale quote released", fields: { rfqClaim: null } });
  }

  private async sendPayment(p: Payment): Promise<Payment> {
    const token = TOKENS[p.currency].address;
    const fromBlock = await this.wallet.blockNumber();
    const submitting = this.ledger.transition(p, "PAY_SUBMITTING", { detail: `from block ${fromBlock}`, fields: { payFromBlock: fromBlock } });
    try {
      const { txHash } = await this.wallet.execute([transferCall(token, p.supplierAddress as Address, p.amount)], `pay supplier ${p.supplierId}`);
      this.ledger.recordWalletTx(txHash, "supplier_payment", p.id);
      this.opts.log(`${p.purchaseOrderId}: paid ${atomicToWhole(p.amount, TOKENS[p.currency].decimals)} ${p.currency} to ${p.supplierAddress} in ${txHash}`);
      return this.booked(submitting, txHash);
    } catch (e) {
      if (e instanceof WalletBlockedError) throw e;
      this.opts.log(`${p.purchaseOrderId}: payment did not confirm (${(e as Error).message}); checking the chain`);
      return (await this.recoverPayment(submitting)).payment;
    }
  }

  private async recoverPayment(p: Payment): Promise<{ payment: Payment; stop?: boolean; note: string }> {
    const token = TOKENS[p.currency].address;
    const from = p.payFromBlock ?? 0n;
    const found = await this.wallet.findTransfer(token, p.supplierAddress as Address, p.amount, from);
    if (found) return { payment: this.booked(p, found), note: "" };
    const now = await this.wallet.blockNumber();
    if (now < from + this.opts.settleBlocks) {
      // Too soon to say it never happened: a pending transfer could still land. Don't resend yet.
      return { payment: p, stop: true, note: `payment not seen yet (block ${now}, waiting until ${from + this.opts.settleBlocks}); not resending` };
    }
    return { payment: this.ledger.transition(p, "SWAPPED", { detail: `no transfer seen after block ${from}; safe to retry` }), note: "" };
  }

  private booked(p: Payment, txHash: Hex): Payment {
    // Recorded here too, so a transfer found after a dropped connection still counts as ours (its relay fee included).
    this.ledger.recordWalletTx(txHash, "supplier_payment", p.id);
    return this.ledger.transition(p, "PAID", {
      detail: txHash,
      fields: { payTx: txHash },
      book: { kind: "supplier_payment", txHash, postings: supplierPaymentPostings(p.supplierId, p.currency, p.amount), memo: p.purchaseOrderId },
    });
  }

  private checkBudget(usdt: bigint, p: Payment): void {
    if (usdt > this.opts.maxUsdtPerOrder) {
      throw new WalletBlockedError("local_order_limit", `${p.purchaseOrderId} needs ${atomicToWhole(usdt, 6)} USD₮, over the per-order limit of ${atomicToWhole(this.opts.maxUsdtPerOrder, 6)}`);
    }
    if (this.spentThisRun + usdt > this.opts.maxUsdtPerRun) {
      throw new WalletBlockedError("local_run_limit", `${p.purchaseOrderId} would take this run to ${atomicToWhole(this.spentThisRun + usdt, 6)} USD₮, over the per-run limit of ${atomicToWhole(this.opts.maxUsdtPerRun, 6)}`);
    }
    this.spentThisRun += usdt;
  }
}

/** Owner action: put a BLOCKED payment back in line after raising a limit or granting a new session. */
export function resumeBlocked(ledger: Ledger, paymentId: string): Payment {
  const p = ledger.get(paymentId);
  if (!p) throw new Error(`No payment ${paymentId}`);
  if (p.state !== "BLOCKED") throw new Error(`${paymentId} is ${p.state}, not BLOCKED`);
  return ledger.transition(p, p.swapTx ? "SWAPPED" : "CREATED", { detail: "resumed by owner", fields: { error: null } });
}
