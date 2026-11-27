// Owner approval over Telegram: the agent sends the order with "Pay" / "Don't pay" buttons and waits.
//
// Safety rules:
//  - Only a button press from the owner's own Telegram user id counts. Anyone else is ignored.
//  - Each request carries a fresh random code; a press must match this order AND this code,
//    so an old or forwarded button can never approve a new order.
//  - Updates already waiting when the request is sent are skipped.
//  - No answer before the deadline means no payment.
//  - The bot token never appears in logs or error messages.
import { randomBytes } from "node:crypto";
import type { PurchaseOrder } from "../planner.ts";
import type { Approver, Decision } from "./approver.ts";

type Update = {
  update_id: number;
  callback_query?: { id: string; from: { id: number; first_name?: string; username?: string }; data?: string; message?: { message_id: number; chat: { id: number } } };
  message?: { chat: { id: number; first_name?: string; username?: string; type: string }; text?: string };
};

export class TelegramError extends Error {}

export class TelegramClient {
  private readonly token: string;
  private readonly fetchFn: typeof fetch;
  private readonly retryPauseMs: number;
  constructor(token: string, fetchFn: typeof fetch = fetch, opts: { retryPauseMs?: number } = {}) {
    this.retryPauseMs = opts.retryPauseMs ?? 2_000;
    if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) throw new TelegramError("TELEGRAM_BOT_TOKEN doesn't look like a bot token from @BotFather");
    this.token = token;
    this.fetchFn = fetchFn;
  }

  /**
   * Calls the Bot API. A network failure (no answer at all) is retried twice with a short pause;
   * an answer from Telegram, even an error, is never retried.
   */
  async call<T>(method: string, params: Record<string, unknown> = {}, timeoutMs = 20_000): Promise<T> {
    let res: Response | undefined;
    let lastNetworkError = "";
    for (let attempt = 0; attempt < 3 && !res; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, this.retryPauseMs * attempt));
      try {
        res = await this.fetchFn(`https://api.telegram.org/bot${this.token}/${method}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(params),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        // Never let the URL (which contains the token) reach an error message: keep only the error kind and code.
        const cause = (e as { cause?: { code?: string } }).cause?.code;
        lastNetworkError = `${(e as Error).name}${cause ? ` ${cause}` : ""}`;
      }
    }
    if (!res) throw new TelegramError(`Telegram ${method} failed after 3 tries: ${lastNetworkError}`);
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string };
    if (!json.ok) throw new TelegramError(`Telegram ${method}: ${json.description ?? `HTTP ${res.status}`}`);
    return json.result as T;
  }

  getUpdates(offset: number | undefined, timeoutSec: number): Promise<Update[]> {
    return this.call<Update[]>("getUpdates", { offset, timeout: timeoutSec, allowed_updates: ["callback_query", "message"] }, (timeoutSec + 10) * 1000);
  }
}

export class TelegramApprover implements Approver {
  readonly via = "Telegram";
  private readonly tg: TelegramClient;
  private readonly ownerId: number;
  private readonly waitMs: number;
  private readonly pollSec: number;
  private readonly now: () => number;

  constructor(tg: TelegramClient, ownerChatId: string | number, opts: { waitMs?: number; pollSec?: number; now?: () => number } = {}) {
    const id = Number(ownerChatId);
    if (!Number.isSafeInteger(id) || id <= 0) throw new TelegramError("TELEGRAM_OWNER_CHAT_ID must be the owner's numeric Telegram id (run telegram:whoami)");
    this.tg = tg;
    this.ownerId = id;
    this.waitMs = opts.waitMs ?? 15 * 60_000;
    this.pollSec = opts.pollSec ?? 25;
    this.now = opts.now ?? Date.now;
  }

  async request(order: PurchaseOrder, summary: string): Promise<Decision> {
    // Start after anything already waiting, so stale presses can't count.
    const pending = await this.tg.getUpdates(-1, 0);
    let offset = pending.length ? pending[pending.length - 1]!.update_id + 1 : undefined;

    const code = randomBytes(6).toString("hex");
    const sent = await this.tg.call<{ message_id: number }>("sendMessage", {
      chat_id: this.ownerId,
      text: `${summary}\n\nPay this order? (No answer in ${Math.round(this.waitMs / 60_000)} min = not paid.)`,
      reply_markup: {
        inline_keyboard: [[
          { text: "✅ Pay", callback_data: `ok:${code}` },
          { text: "❌ Don't pay", callback_data: `no:${code}` },
        ]],
      },
    });

    const deadline = this.now() + this.waitMs;
    while (this.now() < deadline) {
      const wait = Math.max(1, Math.min(this.pollSec, Math.ceil((deadline - this.now()) / 1000)));
      const updates = await this.tg.getUpdates(offset, wait);
      for (const u of updates) {
        offset = u.update_id + 1;
        const cq = u.callback_query;
        if (!cq?.data) continue;
        const [answer, got] = cq.data.split(":");
        const fromOwner = cq.from.id === this.ownerId;
        const thisRequest = got === code && cq.message?.message_id === sent.message_id && (answer === "ok" || answer === "no");
        if (!fromOwner || !thisRequest) {
          await this.tg.call("answerCallbackQuery", { callback_query_id: cq.id, text: fromOwner ? "That request has expired." : "Only the pharmacy owner can approve." }).catch(() => {});
          continue;
        }
        const decision: Decision = {
          decision: answer === "ok" ? "approved" : "declined",
          by: cq.from.username ? `@${cq.from.username}` : String(cq.from.id),
          at: new Date(this.now()).toISOString(),
          via: this.via,
        };
        await this.tg.call("answerCallbackQuery", { callback_query_id: cq.id, text: decision.decision === "approved" ? "Approved. Paying now." : "Not paid." }).catch(() => {});
        await this.tg
          .call("editMessageText", {
            chat_id: this.ownerId,
            message_id: sent.message_id,
            text: `${summary}\n\n${decision.decision === "approved" ? "✅ Approved" : "❌ Declined"} at ${decision.at}`,
          })
          .catch(() => {});
        return decision;
      }
    }
    await this.tg.call("editMessageText", { chat_id: this.ownerId, message_id: sent.message_id, text: `${summary}\n\n⏱ No answer in time: not paid.` }).catch(() => {});
    return { decision: "timeout", at: new Date(this.now()).toISOString(), via: this.via };
  }

  /** Tells the owner what happened after an approved order (best effort). */
  async notify(text: string): Promise<void> {
    await this.tg.call("sendMessage", { chat_id: this.ownerId, text }).catch(() => {});
  }
}

/** Setup helper: who has messaged the bot recently (send it /start first). */
export async function recentChats(tg: TelegramClient): Promise<Array<{ id: number; name: string }>> {
  const updates = await tg.getUpdates(undefined, 0);
  const seen = new Map<number, string>();
  for (const u of updates) {
    const c = u.message?.chat;
    if (c && c.type === "private") seen.set(c.id, c.username ? `@${c.username}` : c.first_name ?? "?");
  }
  return [...seen].map(([id, name]) => ({ id, name }));
}

export type { Update as TelegramUpdate };
