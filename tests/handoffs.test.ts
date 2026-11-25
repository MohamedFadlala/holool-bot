import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WASocket } from "@whiskeysockets/baileys";
import { Settings } from "../src/config/settings";
import { SYSTEM_PROMPT, SYSTEM_PROMPT_VERSION } from "../src/config/system-prompt";

const directory = mkdtempSync(join(tmpdir(), "holool-handoffs-"));
Settings.DATABASE_PATH = join(directory, "test.db");
const { getConnection, initDb } = require("../src/storage/database") as typeof import("../src/storage/database");
const { handoffInstructions, HANDOFF_RECIPIENTS, isInternalContact, parseHandoffReply, phoneFromJid, sendHandoff } =
    require("../src/whatsapp/handoffs") as typeof import("../src/whatsapp/handoffs");
const config = require("../src/admin/config") as typeof import("../src/admin/config");
initDb();
const db = getConnection();
after(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
});

const consent = "نعم أرسل طلبي للمبيعات";
const history = [{ role: "user" as const, content: consent }];
const action = { recipient: "sales" as const, summary: "عميل يريد عرضاً لصيدلية واحدة. الاتصال والوقت غير معروفين.", consentEvidence: consent };
function socket(send: (jid: string, content: { text: string }) => Promise<unknown>) {
    return { sendMessage: send } as Pick<WASocket, "sendMessage">;
}

test("structured responses validate recipients and consent and fail closed", () => {
    assert.deepEqual(parseHandoffReply(JSON.stringify({ reply: "كيف أساعدك؟", handoff: null }), history),
        { reply: "كيف أساعدك؟", handoff: null });
    assert.deepEqual(parseHandoffReply("```json\n" + JSON.stringify({ reply: "", handoff: action }) + "\n```", history).handoff, action);
    for (const invalid of [
        "أرسلت طلبك", "{}", '{"reply":"","handoff":null}',
        JSON.stringify({ reply: "", handoff: { ...action, recipient: "249111111111" } }),
        JSON.stringify({ reply: "", handoff: { ...action, recipient: "__proto__" } }),
        JSON.stringify({ reply: "", handoff: { ...action, consentEvidence: "invented consent" } }),
        JSON.stringify({ reply: "", handoff: { ...action, summary: " " } })
    ]) assert.throws(() => parseHandoffReply(invalid, history));
    assert.throws(() => parseHandoffReply(JSON.stringify({ reply: "", handoff: action }),
        [{ role: "assistant", content: consent }]));
});

test("phone context never treats LIDs as phone numbers and staff are excluded", () => {
    assert.equal(phoneFromJid("249912345678@s.whatsapp.net"), "+249912345678");
    assert.equal(phoneFromJid("249912345678:12@s.whatsapp.net"), "+249912345678");
    assert.equal(phoneFromJid("123456789012345@lid"), undefined);
    assert.equal(isInternalContact("123456789@lid", "249967965493@s.whatsapp.net"), true);
    assert.equal(isInternalContact("249900652302@s.whatsapp.net"), true);
    assert.equal(isInternalContact("249912345678@s.whatsapp.net"), false);
    assert.match(handoffInstructions("phone-context"), /unavailable/);
});

test("sends sales summary to allowlisted number and persists success before confirming", async () => {
    let calls = 0;
    const transport = socket(async (jid, content) => {
        calls++;
        assert.equal(jid, HANDOFF_RECIPIENTS.sales.phone + "@s.whatsapp.net");
        assert.match(content.text, /طلب متابعة/);
        assert.ok(content.text.includes(action.summary));
        assert.equal((db.prepare("SELECT status FROM whatsapp_handoffs WHERE chat_id = ?").get("sales-chat") as any).status, "pending");
        return { key: { id: "wa-sales-1" } };
    });
    assert.match(await sendHandoff(transport, "sales-chat", "source-1", action), /تم إرسال طلبك/);
    const stored = db.prepare("SELECT status, whatsapp_message_id FROM whatsapp_handoffs WHERE chat_id = ?").get("sales-chat");
    assert.deepEqual(stored, { status: "sent", whatsapp_message_id: "wa-sales-1" });
    // Message replay, and identical content with another source ID, cannot resend.
    await sendHandoff(transport, "sales-chat", "source-1", { ...action, summary: "changed model wording" });
    await sendHandoff(transport, "sales-chat", "source-2", action);
    assert.equal(calls, 1);
    assert.match(handoffInstructions("sales-chat"), /"status":"sent"/);
});

test("engineering goes directly to the lead engineer, with English confirmation", async () => {
    const result = await sendHandoff(socket(async jid => {
        assert.equal(jid, "249967965493@s.whatsapp.net");
        return { key: { id: "wa-engineer-1" } };
    }), "engineer-chat", "source-3", { ...action, recipient: "engineer" }, () => true, true);
    assert.match(result, /sent to lead engineer Mohamed Fadlallah/);
});

test("failed or unconfirmed sends never claim success and are not retried on replay", async () => {
    for (const kind of ["throws", "no-id"] as const) {
        let calls = 0;
        const transport = socket(async () => {
            calls++;
            if (kind === "throws") throw new Error("network timeout");
            return { key: {} };
        });
        const reply = await sendHandoff(transport, kind, "failure-source", action);
        assert.match(reply, /لم أتمكن من تأكيد/);
        assert.match(reply, /https:\/\/wa.me\/249900652302/);
        assert.equal((db.prepare("SELECT status FROM whatsapp_handoffs WHERE chat_id = ?").get(kind) as any).status, "failed");
        await sendHandoff(transport, kind, "failure-source", action);
        assert.equal(calls, 1);
    }
});

test("concurrent attempts reserve once and uncertain pending sends survive reconnects", async () => {
    let release!: (value: unknown) => void;
    let calls = 0;
    const transport = socket(async () => {
        calls++;
        return new Promise(resolve => { release = resolve; });
    });
    const sending = sendHandoff(transport, "concurrent-chat", "same-source", action);
    const duplicate = await sendHandoff(transport, "concurrent-chat", "same-source", action);
    assert.match(duplicate, /لم أتمكن من تأكيد/);
    assert.equal(calls, 1);
    release({ key: { id: "concurrent-id" } });
    await sending;
    db.prepare("UPDATE whatsapp_handoffs SET status = 'pending' WHERE chat_id = ?").run("concurrent-chat");
    assert.match(await sendHandoff(transport, "concurrent-chat", "later-source", action), /لم أتمكن من تأكيد/);
    assert.equal(calls, 1);
});

test("inactive sessions and missing source IDs never send", async () => {
    const transport = socket(async () => { throw new Error("must not send"); });
    await sendHandoff(transport, "inactive", "source", action, () => false);
    await sendHandoff(transport, "missing-source", "", action);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM whatsapp_handoffs WHERE chat_id IN ('inactive', 'missing-source')").get() as any).count, 0);
});

test("prompt migration replaces old saved instructions once and preserves later edits", () => {
    db.exec("CREATE TABLE IF NOT EXISTS holool_settings (name TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const write = db.prepare("INSERT OR REPLACE INTO holool_settings (name, value) VALUES (?, ?)");
    write.run("prompt", JSON.stringify("old prompt with prices"));
    write.run("promptRevision", "4");
    config.loadSettings();
    assert.equal(config.systemPrompt, SYSTEM_PROMPT);
    assert.equal(config.systemPromptRevision, 5);
    assert.ok(config.systemPrompt.includes("حامد، الرئيس التنفيذي"));
    assert.ok(!config.systemPrompt.includes("حميد"));
    assert.equal(JSON.parse((db.prepare("SELECT value FROM holool_settings WHERE name = 'bundledPromptVersion'").get() as any).value), SYSTEM_PROMPT_VERSION);
    config.savePrompt("later dashboard edit");
    config.loadSettings();
    assert.equal(config.systemPrompt, "later dashboard edit");
    assert.equal(config.systemPromptRevision, 6);
});

test("incoming customer messages generate and send handoffs before the customer confirmation", async t => {
    const { handleIncomingMessage } = require("../src/whatsapp/handlers") as typeof import("../src/whatsapp/handlers");
    const { messageBuffer } = require("../src/whatsapp/message-buffer") as typeof import("../src/whatsapp/message-buffer");
    const { OpenRouterProvider } = require("../src/providers/openrouter") as typeof import("../src/providers/openrouter");
    config.savePrompt(SYSTEM_PROMPT);
    Settings.AI_PROVIDER = "openrouter";
    let flush: (() => Promise<void>) | undefined;
    t.mock.method(messageBuffer, "push", (jid, text, msg, sock, onComplete) => {
        flush = () => onComplete(jid, text, msg, sock);
    });
    let mode: "sales" | "engineer" | "ordinary" | "invalid" = "sales";
    t.mock.method(OpenRouterProvider.prototype, "chat", async messages => {
        assert.ok(messages[0].content.includes(SYSTEM_PROMPT));
        assert.ok(messages[0].content.includes("Visible WhatsApp phone: +249912345678"));
        if (mode === "invalid") return "malformed response";
        return JSON.stringify(mode === "ordinary" ? { reply: "كيف أساعدك؟", handoff: null } :
            { reply: "", handoff: { ...action, recipient: mode } });
    });
    for (const current of ["sales", "engineer", "ordinary", "invalid"] as const) {
        mode = current;
        flush = undefined;
        const sends: { jid: string; text: string }[] = [];
        const customer = `integration-${current}@lid`;
        const transport = {
            readMessages: async () => {},
            sendPresenceUpdate: async () => {},
            sendMessage: async (jid: string, content: { text: string }) => {
                sends.push({ jid, text: content.text });
                return { key: { id: `sent-${sends.length}` } };
            }
        } as unknown as WASocket;
        await handleIncomingMessage(transport, {
            key: { remoteJid: customer, remoteJidAlt: "249912345678@s.whatsapp.net", id: `incoming-${current}` },
            message: { conversation: consent }, pushName: "Test customer"
        }, "test");
        assert.ok(flush);
        await flush();
        if (current === "sales" || current === "engineer") {
            assert.equal(sends.length, 2);
            assert.equal(sends[0].jid, HANDOFF_RECIPIENTS[current].phone + "@s.whatsapp.net");
            assert.equal(sends[1].jid, customer);
            assert.match(sends[1].text, /تم إرسال طلبك/);
        } else {
            assert.equal(sends.length, 1);
            assert.equal(sends[0].jid, customer);
            assert.ok(!sends[0].text.includes('"handoff"'));
        }
        const saved = db.prepare("SELECT content FROM chat_history WHERE user_id = ? AND role = 'assistant'").get(customer) as { content: string };
        assert.equal(saved.content, sends.at(-1)!.text);
    }
    // Staff and groups never enter the generation/handoff path.
    for (const remoteJid of ["249900652302@s.whatsapp.net", "249967965493@s.whatsapp.net", "12345@g.us"]) {
        flush = undefined;
        await handleIncomingMessage({} as WASocket, { key: { remoteJid }, message: { conversation: consent } }, "test");
        assert.equal(flush, undefined);
    }
});

test("wrapped messages and metadata-first text still produce replies when receipts or presence fail", async t => {
    const { handleIncomingMessage } = require("../src/whatsapp/handlers") as typeof import("../src/whatsapp/handlers");
    const { messageBuffer } = require("../src/whatsapp/message-buffer") as typeof import("../src/whatsapp/message-buffer");
    const { OpenRouterProvider } = require("../src/providers/openrouter") as typeof import("../src/providers/openrouter");
    const { botActivity } = require("../src/whatsapp/activity") as typeof import("../src/whatsapp/activity");
    let flush: (() => Promise<void>) | undefined;
    t.mock.method(messageBuffer, "push", (jid, text, msg, sock, onComplete) => {
        assert.equal(text, "مرحبا");
        flush = () => onComplete(jid, text, msg, sock);
    });
    t.mock.method(OpenRouterProvider.prototype, "chat", async () => JSON.stringify({ reply: "مرحباً بك", handoff: null }));
    Settings.AI_PROVIDER = "openrouter";
    const variants = [
        { messageContextInfo: {}, conversation: "مرحبا" },
        { messageContextInfo: {}, extendedTextMessage: { text: "مرحبا" } },
        { ephemeralMessage: { message: { conversation: "مرحبا" } } },
        { viewOnceMessageV2: { message: { extendedTextMessage: { text: "مرحبا" } } } }
    ];
    for (const [index, message] of variants.entries()) {
        flush = undefined;
        const sends: string[] = [];
        const session = "message-format-" + index;
        const transport = {
            readMessages: async () => { throw new Error("receipt failed"); },
            sendPresenceUpdate: async () => { throw new Error("presence failed"); },
            sendMessage: async (_jid: string, content: { text: string }) => {
                sends.push(content.text);
                return { key: { id: "reply-" + index } };
            }
        } as unknown as WASocket;
        await handleIncomingMessage(transport, {
            key: { remoteJid: `24991234000${index}@s.whatsapp.net`, id: "format-" + index }, message
        }, session);
        assert.ok(flush, "a supported message must enter the reply buffer");
        assert.equal(botActivity.get(session).state, "received");
        await flush();
        assert.deepEqual(sends, ["مرحباً بك"]);
        assert.equal(botActivity.get(session).state, "replied");
        assert.ok(botActivity.get(session).lastReceivedAt);
        assert.ok(botActivity.get(session).lastReplyAt);
    }
});

test("processing diagnostics distinguish provider failure from a successful reply", async t => {
    const { handleIncomingMessage } = require("../src/whatsapp/handlers") as typeof import("../src/whatsapp/handlers");
    const { messageBuffer } = require("../src/whatsapp/message-buffer") as typeof import("../src/whatsapp/message-buffer");
    const { OpenRouterProvider } = require("../src/providers/openrouter") as typeof import("../src/providers/openrouter");
    const { botActivity } = require("../src/whatsapp/activity") as typeof import("../src/whatsapp/activity");
    let flush!: () => Promise<void>;
    t.mock.method(messageBuffer, "push", (jid, text, msg, sock, onComplete) => { flush = () => onComplete(jid, text, msg, sock); });
    t.mock.method(OpenRouterProvider.prototype, "chat", async () => { throw new Error("provider failed"); });
    const transport = {
        readMessages: async () => {}, sendPresenceUpdate: async () => {},
        sendMessage: async () => ({ key: { id: "fallback-submitted" } })
    } as unknown as WASocket;
    await handleIncomingMessage(transport, {
        key: { remoteJid: "249912340999@s.whatsapp.net", id: "provider-error" }, message: { conversation: "hello" }
    }, "provider-failure");
    await flush();
    assert.equal(botActivity.get("provider-failure").state, "error");
    assert.match(botActivity.get("provider-failure").message!, /AI provider/);
    assert.equal(botActivity.get("provider-failure").lastReplyAt, undefined);
    botActivity.reset("provider-failure");
    assert.equal(botActivity.get("provider-failure").state, "unverified");
});

test("a cached connected flag never overrides a closed socket and linked number is exposed", () => {
    const { SessionManager } = require("../src/whatsapp/session-manager") as typeof import("../src/whatsapp/session-manager");
    const manager = new SessionManager();
    const internals = manager as any;
    internals.statuses.set("test", { state: "connected" });
    assert.equal(manager.getStatus("test").state, "error");
    internals.sessions.set("test", { ws: { isOpen: false }, user: { id: "249123212060:5@s.whatsapp.net" } });
    assert.equal(manager.getStatus("test").state, "error");
    assert.equal(manager.getLinkedPhone("test"), "+249123212060");
    internals.sessions.get("test").ws.isOpen = true;
    assert.equal(manager.getStatus("test").state, "connected");
});
