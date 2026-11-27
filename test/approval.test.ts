import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, storedDecision, type Approver, type Decision } from "../src/approval/approver.ts";
import { TelegramApprover, TelegramClient, TelegramError } from "../src/approval/telegram.ts";
import { Ledger } from "../src/ledger/ledger.ts";
import type { PurchaseOrder } from "../src/planner.ts";

const TOKEN = "123456:ABCdefGhIJKlmnoPQRstuVWXyz0123456789";
const OWNER = 5550001;
const STRANGER = 5559999;

const order: PurchaseOrder = {
  id: "po_tg_1",
  supplier: { id: "s", name: "Kumasi Distributor", country: "GH", currency: "GHSm", payoutAddress: "0x2222222222222222222222222222222222222222", leadTimeDays: 2 },
  lines: [{ sku: "a", name: "ORS sachet", qty: 8, unitPrice: "2.50", lineTotal: 20n * 10n ** 18n, reason: "" }],
  total: 20n * 10n ** 18n,
};

/** A fake Telegram API. `script` decides what each getUpdates poll returns, given the code in the sent message. */
function fakeTelegram(script: (poll: number, code: string, messageId: number) => object[]) {
  const calls: Array<{ method: string; body: Record<string, any> }> = [];
  let code = "";
  let polls = 0;
  const fetchFn = (async (url: string, init: RequestInit) => {
    const method = url.split("/").pop()!;
    assert.ok(url.includes(`/bot${TOKEN}/`));
    const body = JSON.parse(String(init.body));
    calls.push({ method, body });
    const reply = (result: unknown) => new Response(JSON.stringify({ ok: true, result }), { status: 200 });
    if (method === "sendMessage") {
      const data = body.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data as string | undefined;
      if (data) code = data.split(":")[1]!;
      return reply({ message_id: 77 });
    }
    if (method === "getUpdates") {
      if (body.offset === -1) return reply([{ update_id: 100 }]); // something already waiting
      return reply(script(polls++, code, 77));
    }
    return reply(true);
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

const press = (id: number, from: number, data: string, messageId = 77) => ({ update_id: id, callback_query: { id: `cq${id}`, from: { id: from, username: from === OWNER ? "owner" : "someone" }, data, message: { message_id: messageId, chat: { id: from } } } });

function approver(fetchFn: typeof fetch, waitMs = 60_000) {
  let t = 0;
  return new TelegramApprover(new TelegramClient(TOKEN, fetchFn), OWNER, { waitMs, pollSec: 1, now: () => (t += 1000) });
}

test("the owner pressing Pay approves; the message shows the order and its total", async () => {
  const { calls, fetchFn } = fakeTelegram((poll, code) => (poll === 0 ? [press(101, OWNER, `ok:${code}`)] : []));
  const d = await approver(fetchFn).request(order, "Pilot Pharmacy: restock order po_tg_1\nTotal: 20 GHSm");
  assert.equal(d.decision, "approved");
  assert.equal(d.by, "@owner");
  const sent = calls.find((c) => c.method === "sendMessage")!;
  assert.equal(sent.body.chat_id, OWNER);
  assert.match(sent.body.text, /Total: 20 GHSm/);
  assert.ok(calls.some((c) => c.method === "getUpdates" && c.body.offset === 101), "polling starts after the update that was already waiting");
});

test("Don't pay declines", async () => {
  const { fetchFn } = fakeTelegram((poll, code) => (poll === 0 ? [press(101, OWNER, `no:${code}`)] : []));
  assert.equal((await approver(fetchFn).request(order, "x")).decision, "declined");
});

test("a press from anyone else is ignored, and told only the owner can approve", async () => {
  const { calls, fetchFn } = fakeTelegram((poll, code) => (poll === 0 ? [press(101, STRANGER, `ok:${code}`)] : poll === 1 ? [press(102, OWNER, `no:${code}`)] : []));
  const d = await approver(fetchFn).request(order, "x");
  assert.equal(d.decision, "declined", "the stranger's Pay did not count");
  assert.ok(calls.some((c) => c.method === "answerCallbackQuery" && /Only the pharmacy owner/.test(c.body.text)));
});

test("an old button (wrong code or another message) can't approve a new order", async () => {
  const { fetchFn } = fakeTelegram((poll) => (poll === 0 ? [press(101, OWNER, "ok:deadbeef0000"), press(102, OWNER, "ok:whatever", 12)] : []));
  const d = await approver(fetchFn, 5_000).request(order, "x");
  assert.equal(d.decision, "timeout");
});

test("no answer in time means not paid", async () => {
  const { calls, fetchFn } = fakeTelegram(() => []);
  const d = await approver(fetchFn, 5_000).request(order, "x");
  assert.equal(d.decision, "timeout");
  assert.ok(calls.some((c) => c.method === "editMessageText" && /not paid/.test(c.body.text)));
});

test("a bad token is refused up front, and network errors never include the token", async () => {
  assert.throws(() => new TelegramClient("not-a-token"), TelegramError);
  const failing = (async () => {
    throw new TypeError(`fetch failed for https://api.telegram.org/bot${TOKEN}/getUpdates`);
  }) as unknown as typeof fetch;
  await assert.rejects(new TelegramClient(TOKEN, failing).getUpdates(0, 0), (e: Error) => !e.message.includes(TOKEN));
});

test("decide(): asks once per order; approved and declined are remembered, a timeout asks again", async () => {
  const ledger = new Ledger(":memory:");
  let asked = 0;
  const answers: Decision["decision"][] = ["timeout", "approved"];
  const fake: Approver = { via: "test", request: async () => ({ decision: answers[asked++]!, at: "t", via: "test" }) };
  assert.equal((await decide(ledger, fake, order, "P")).decision, "timeout");
  assert.equal(storedDecision(ledger, order.id), null);
  assert.equal((await decide(ledger, fake, order, "P")).decision, "approved");
  assert.equal((await decide(ledger, fake, order, "P")).decision, "approved");
  assert.equal(asked, 2, "not asked a third time");
});
