// Pays a purchase order end to end, one recorded step at a time:
//   CREATED -> QUOTED -> SWAP_SUBMITTING -> SWAPPED -> PAY_SUBMITTING -> PAID
//
// The swap goes through the FX rail for the supplier's currency: Mento for Ghana cedis (GHSm),
// Textile FX for naira (cNGN). Suppliers paid in USD₮ need no swap.
//
// Before anything is sent, the step's intent is saved. If the process dies mid-step, the next
// run asks the outside world what actually happened (the venue, or the chain's Transfer logs)
// instead of guessing, so a crash can delay a payment but never pay a supplier twice.
import type { Address, Hex } from "viem";
import { TOKENS, atomicToWhole } from "../config.ts";
import { type FxPlan, type FxRail, NoRouteError } from "../fx/rail.ts";
import { type Currency, type Ledger, type Payment, StaleStateError, fxConversionPostings, supplierPaymentPostings } from "../ledger/ledger.ts";
import type { PurchaseOrder } from "../planner.ts";
import { isUnspendable } from "../inventory/source.ts";
import { type AgentWallet, WalletBlockedError, WalletFailedError, transferCall } from "../wallet/altana.ts";

export type ExecutorOptions = {
  maxUsdtPerOrder: bigint;
  maxUsdtPerRun: bigint;
  /** Don't send a swap with less than this left on its quote. */
  minQuoteMsLeft?: number;
  /** Blocks to wait before deciding an unseen transfer never happened. */
  settleBlocks?: bigint;
  log?: (line: string) => void;
};

export type Outcome = { payment: Payment; note: string };
export type Rails = Partial<Record<Exclude<Currency, "USDT">, FxRail>>;

export class PaymentExecutor {
  private readonly ledger: Ledger;
  private readonly wallet: AgentWallet;
  private readonly rails: Rails;
  private readonly opts: Required<Omit<ExecutorOptions, "log">> & { log: (line: string) => void };
  private spentThisRun = 0n;

  constructor(ledger: Ledger, wallet: AgentWallet, rails: Rails, opts: ExecutorOptions) {
    this.ledger = ledger;
    this.wallet = wallet;
    this.rails = rails;
    this.opts = { minQuoteMsLeft: 15_000, settleBlocks: 30n, log: () => {}, ...opts };
  }

  /** Creates (or finds) the payment for an order and drives it as far as it can go. */
  /** `approval` says who approved the order and how; it becomes the payment's first audit event. */
  async payOrder(order: PurchaseOrder, approval?: string): Promise<Outcome> {
    if (isUnspendable(order.supplier.payoutAddress)) throw new Error(`${order.id}: supplier ${order.supplier.id} has a zero/burn payout address; refusing to pay`);
    const { payment, created } = this.ledger.createPayment({
      purchaseOrderId: order.id,
      supplierId: order.supplier.id,
      supplierAddress: order.supplier.payoutAddress,
      currency: order.supplier.currency,
      amount: order.total,
      approval,
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
            return { payment: p, note: "" };
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

  private rail(p: Payment): FxRail {
    const rail = p.currency === "USDT" ? undefined : this.rails[p.currency];
    if (!rail) throw new Error(`No FX rail configured for ${p.currency}`);
    return rail;
  }

  private async fromCreated(p: Payment): Promise<{ payment: Payment; stop?: boolean; note: string }> {
    if (p.currency === "USDT") {
      this.checkBudget(p.amount, p);
      return { payment: this.ledger.transition(p, "SWAPPED", { detail: "supplier is paid in USD₮; no conversion", fields: { usdtSpent: p.amount } }), note: "" };
    }

    const rail = this.rail(p);
    let plan: FxPlan;
    try {
      plan = await rail.planExactOut({ taker: this.wallet.address, buyToken: TOKENS[p.currency].address, buyAmount: p.amount });
    } catch (e) {
      if (e instanceof NoRouteError) return { payment: p, stop: true, note: `no ${rail.name} quote (${e.reason}); will retry next run` };
      throw e;
    }
    const cur = TOKENS[p.currency];
    this.opts.log(`${p.purchaseOrderId}: ${rail.name} quote ${plan.ref}: ${atomicToWhole(plan.usdtIn, 6)} USD₮ -> at least ${atomicToWhole(plan.minOut, cur.decimals)} ${p.currency}`);

    try {
      this.checkBudget(plan.usdtIn, p);
    } catch (e) {
      await rail.release(plan.ref, plan.claim);
      throw e;
    }
    if (plan.minOut < p.amount) {
      await rail.release(plan.ref, plan.claim);
      const failed = this.ledger.transition(p, "FAILED", { detail: "quote short", fields: { error: `${rail.name} plan guarantees ${plan.minOut}, less than the ${p.amount} owed` } });
      return { payment: failed, stop: true, note: "refused: the swap would not cover the invoice" };
    }
    const unknown = plan.txs.flatMap((t) => t.calls).find((c) => !rail.knownTargets.has(c.to.toLowerCase()));
    if (unknown) {
      await rail.release(plan.ref, plan.claim);
      const failed = this.ledger.transition(p, "FAILED", { detail: "unexpected swap target", fields: { error: `${rail.name} swap calls unknown contract ${unknown.to}` } });
      return { payment: failed, stop: true, note: "refused: swap goes to an unknown contract" };
    }

    let q = this.ledger.transition(p, "QUOTED", {
      detail: `${rail.name} ${plan.ref}`,
      fields: { rfqId: plan.ref, rfqClaim: plan.claim, usdtSpent: plan.usdtIn, fxMinOut: plan.minOut },
    });
    if (rail.msLeft(plan) < this.opts.minQuoteMsLeft) {
      await rail.release(plan.ref, plan.claim);
      q = this.ledger.transition(q, "CREATED", { detail: "quote too close to expiry", fields: { rfqClaim: null } });
      return { payment: q, stop: true, note: "quote expired before it could be used; will retry" };
    }
    return { payment: await this.swap(q, rail, plan), note: "" };
  }

  private async swap(p: Payment, rail: FxRail, plan: FxPlan): Promise<Payment> {
    const fromBlock = await this.wallet.blockNumber();
    const submitting = this.ledger.transition(p, "SWAP_SUBMITTING", { detail: `usdtIn ${plan.usdtIn}`, fields: { swapFromBlock: fromBlock } });
    try {
      let txHash: Hex | undefined;
      for (const [i, tx] of plan.txs.entries()) {
        if (i > 0 && rail.msLeft(plan) <= 0) throw new WalletFailedError("quote expired between transactions");
        const sent = await this.wallet.execute(tx.calls, tx.label);
        this.ledger.recordWalletTx(sent.txHash, i === plan.txs.length - 1 ? "swap" : "approve", p.id);
        txHash = sent.txHash;
      }
      const { out } = await rail.settled(plan, txHash!);
      this.opts.log(`${p.purchaseOrderId}: swapped in ${txHash}, received ${atomicToWhole(out, TOKENS[p.currency].decimals)} ${p.currency}`);
      return this.ledger.transition(submitting, "SWAPPED", {
        detail: txHash,
        fields: { swapTx: txHash!, rfqClaim: null },
        book: { kind: "fx_conversion", txHash: txHash!, postings: fxConversionPostings(plan.usdtIn, out, p.currency as Exclude<Currency, "USDT">), memo: `${rail.name} ${plan.ref}` },
      });
    } catch (e) {
      if (e instanceof WalletBlockedError) {
        // The chain refused before anything was sent: release the quote so it isn't left reserved.
        await rail.release(plan.ref, plan.claim);
        throw e;
      }
      // We don't know for sure whether the swap landed; recovery asks the venue or the chain.
      this.opts.log(`${p.purchaseOrderId}: swap did not confirm (${(e as Error).message}); checking what happened`);
      return (await this.recoverSwap(this.ledger.get(p.id)!)).payment;
    }
  }

  private async recoverSwap(p: Payment): Promise<{ payment: Payment; stop?: boolean; note: string }> {
    const rail = this.rail(p);
    const claim = this.ledger.rfqClaim(p.id);
    if (!p.rfqId || p.usdtSpent === null || p.fxMinOut === null || p.swapFromBlock === null) {
      const failed = this.ledger.transition(p, "FAILED", { detail: "cannot recover swap", fields: { error: "swap record is incomplete; check the wallet by hand" } });
      return { payment: failed, stop: true, note: "needs a person: swap record incomplete" };
    }
    const r = await rail.recover({ ref: p.rfqId, claim, buyToken: TOKENS[p.currency].address, minOut: p.fxMinOut, usdtIn: p.usdtSpent, fromBlock: p.swapFromBlock });
    if (r.status === "filled") {
      this.ledger.recordWalletTx(r.txHash, "swap", p.id); // ours, even though we learned the hash afterwards
      return {
        payment: this.ledger.transition(p, "SWAPPED", {
          detail: `recovered: ${r.txHash}`,
          fields: { swapTx: r.txHash, rfqClaim: null },
          book: { kind: "fx_conversion", txHash: r.txHash, postings: fxConversionPostings(r.usdtIn, r.out, p.currency as Exclude<Currency, "USDT">), memo: `${rail.name} ${p.rfqId} (recovered)` },
        }),
        note: "",
      };
    }
    if (r.status === "not_filled") {
      return { payment: this.ledger.transition(p, "CREATED", { detail: `${r.reason}; nothing moved`, fields: { rfqClaim: null } }), stop: true, note: `swap not filled (${r.reason}); will retry next run` };
    }
    if (r.status === "pending") return { payment: p, stop: true, note: `swap still pending (${r.reason}); check again next run` };
    // not_seen: wait for confirmations before deciding it never happened.
    const now = await this.wallet.blockNumber();
    if (now < p.swapFromBlock + this.opts.settleBlocks) {
      return { payment: p, stop: true, note: `swap not seen yet (block ${now}, waiting until ${p.swapFromBlock + this.opts.settleBlocks}); not resending` };
    }
    return { payment: this.ledger.transition(p, "CREATED", { detail: `no swap seen after block ${p.swapFromBlock}; safe to retry`, fields: { rfqClaim: null } }), stop: true, note: "swap never landed; will retry next run" };
  }

  private async releaseStaleQuote(p: Payment): Promise<Payment> {
    if (p.rfqId && p.currency !== "USDT") await this.rail(p).release(p.rfqId, this.ledger.rfqClaim(p.id));
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
