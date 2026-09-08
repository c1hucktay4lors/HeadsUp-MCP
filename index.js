import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

// --- HARDCODED BOT TOKEN ---
const TELEGRAM_TOKEN = "8625063884:AAF4GGBGbzBKWmnNL-VKFFCckB5NqfjaK3s";
// ---------------------------
// API base is normally https://api.telegram.org — overridable via env for
// testing (mock Bot API) or proxying.
const API_BASE = (process.env.TELEGRAM_API_BASE || "https://api.telegram.org").replace(/\/+$/, "");

// Chat ID(s) pulled from mcp.json — multiple supported, comma-separated
const CHAT_IDS = (process.env.TELEGRAM_CHAT_ID || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
if (CHAT_IDS.length === 0) {
    console.error("❌ Missing TELEGRAM_CHAT_ID in mcp.json");
    process.exit(1);
}

// Notification styles
const NOTIF_TYPES = {
    success: { emoji: "✅", title: "Task Complete" },
    info:    { emoji: "ℹ️",  title: "Info" },
    warning: { emoji: "⚠️",  title: "Warning" },
    error:   { emoji: "❌",  title: "Error" }
};

// Telegram hard limit is 4096 chars per message
const MAX_MSG_LEN = 4000;

// Split long text into chunks under MAX_MSG_LEN, preferring line/space boundaries
function splitMessage(text) {
    const chunks = [];
    let rest = text;
    while (rest.length > MAX_MSG_LEN) {
        let cut = rest.lastIndexOf("\n", MAX_MSG_LEN);
        if (cut < MAX_MSG_LEN * 0.5) cut = rest.lastIndexOf(" ", MAX_MSG_LEN);
        if (cut < MAX_MSG_LEN * 0.5) cut = MAX_MSG_LEN;
        chunks.push(rest.slice(0, cut));
        rest = rest.slice(cut).replace(/^\s+/, "");
    }
    if (rest) chunks.push(rest);
    return chunks;
}

async function sendTelegram(chatId, payload) {
    const res = await fetch(`${API_BASE}/bot${TELEGRAM_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, ...payload })
    });
    if (!res.ok) {
        let detail = `HTTP ${res.status}`;
        try { detail = (await res.json()).description || detail; } catch {}
        throw new Error(detail);
    }
}

// ============================================================
//  INBOUND: receive replies from the user via Telegram
// ============================================================
// Long-poll getUpdates in a background loop, buffer messages in
// memory, and expose them to the model via retrieve_messages /
// wait_for_reply. (stdout must stay clean for MCP stdio, so all
// logging goes to stderr.)
const LOG_PREFIX = "[telegram-notifier]";
const log = (msg) => console.error(LOG_PREFIX, msg);

const MAX_BUFFERED = 50;        // keep recent inbound messages in memory
const POLL_INTERVAL_MS = 1500;  // how often we check for new updates
// NOTE: MCP clients (incl. LM Studio / the SDK) time out tool requests at
// ~60s, so a blocking wait must stay well under that. The model can simply
// call wait_for_reply again — a reply that arrived meanwhile is returned
// instantly, so nothing is lost.
const DEFAULT_TIMEOUT_S = 45;   // wait_for_reply default
const MAX_TIMEOUT_S = 55;       // hard cap: must stay under the ~60s client timeout

const incoming = {
    pending: [],          // replies the model hasn't read yet
    recent: [],           // ring buffer of the last MAX_BUFFERED inbound messages
    waiters: [],          // { resolve, deadline } for blocking wait_for_reply calls
    lastUpdateId: null    // offset for getUpdates
};

const CHAT_SET = new Set(CHAT_IDS);

function handleIncoming(msg) {
    const text = (msg.text || msg.caption || "").trim();
    const entry = {
        text: text || "[non-text message]",
        chat_id: msg.chat?.id,
        time: new Date((msg.date || Math.floor(Date.now() / 1000)) * 1000).toISOString()
    };
    log(`inbound: ${entry.chat_id} -> ${text ? JSON.stringify(text) : "[non-text]"}`);

    incoming.recent.push(entry);
    if (incoming.recent.length > MAX_BUFFERED) incoming.recent.shift();

    if (!text) return; // don't queue stickers/photos/etc. as answers

    // A reply goes to exactly ONE consumer: a blocking wait_for_reply caller
    // if one is active, otherwise the pending queue for retrieve_messages.
    const i = incoming.waiters.findIndex((w) => !w.consumed);
    if (i !== -1) {
        const waiter = incoming.waiters[i];
        incoming.waiters.splice(i, 1);
        const msgs = [{ ...entry, waitedMs: Date.now() - waiter.startedAt }];
        waiter.resolve(msgs);
        log(`delivered to waiting caller (waited ${Math.round(msgs[0].waitedMs / 1000)}s)`);
    } else {
        incoming.pending.push(entry);
        log(`${incoming.pending.length} message(s) pending for the model`);
    }

    // Let the user know the reply reached the AI (best effort, non-fatal)
    sendTelegram(entry.chat_id, { text: "👍 Got it — I'll pass this to the AI." })
        .catch((e) => log(`ack failed: ${e.message}`));
}

async function pollOnce() {
    let url = `${API_BASE}/bot${TELEGRAM_TOKEN}/getUpdates?timeout=0&allowed_updates=["message"]`;
    let processMsgs = true;
    if (incoming.lastUpdateId === null) {
        // First poll: anchor the offset to "now" without processing the stale
        // backlog (messages from before this server started are not replies).
        url += "&limit=100";
        processMsgs = false;
    } else {
        url += `&offset=${incoming.lastUpdateId}`; // getUpdates returns ids strictly greater
    }

    const res = await fetch(url);
    if (!res.ok) {
        let detail = `HTTP ${res.status}`;
        try { detail = (await res.json()).description || detail; } catch {}
        throw new Error(detail);
    }

    const data = await res.json();
    if (incoming.lastUpdateId === null && data.result.length === 0) {
        // No history at all (fresh bot) — anchor at 0 and start processing.
        incoming.lastUpdateId = 0;
    }
    for (const u of data.result) {
        incoming.lastUpdateId = Math.max(incoming.lastUpdateId ?? 0, u.update_id);
        // NOTE: chat.id arrives as a JSON number; CHAT_SET holds strings from env.
        if (processMsgs && u.message && CHAT_SET.has(String(u.message.chat?.id))) handleIncoming(u.message);
    }
}

function startPolling() {
    (async () => {
        let consecutiveErrors = 0;
        for (;;) {
            try {
                await pollOnce();
                consecutiveErrors = 0;
            } catch (e) {
                consecutiveErrors++;
                if (/401/.test(e.message)) {
                    log(`fatal: ${e.message} (invalid bot token) — stopping poller`);
                    return;
                }
                if (/409/.test(e.message)) {
                    log("conflict: a webhook is set for this bot — clearing it");
                    try { await fetch(`${API_BASE}/bot${TELEGRAM_TOKEN}/deleteWebhook`); } catch {}
                }
                log(`poll error (${consecutiveErrors} in a row): ${e.message}`);
                await new Promise((r) => setTimeout(r, 5000));
            }
            await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        }
    })();
}

function takePending() {
    const msgs = incoming.pending;
    incoming.pending = [];
    return msgs;
}

function formatMessages(msgs) {
    const lines = msgs.map((m, i) =>
        `[${i + 1}] (${new Date(m.time).toLocaleString()}) ${m.text}`);
    return `📬 ${msgs.length} message(s) from the user:\n${lines.join("\n")}`;
}

function formatWaitResult(msgs, timedOut, timeoutS) {
    if (msgs.length > 0) {
        return `📬 User replied after ~${msgs[0].waitedMs ? Math.round(msgs[0].waitedMs / 1000) : 0}s:\n${msgs.map((m) => m.text).join("\n---\n")}`;
    }
    if (timedOut) {
        return `⏱️ Timed out after ${timeoutS}s — the user did not reply. Continue the task with your best judgement instead of waiting further.`;
    }
    return "❌ No reply received.";
}

const server = new Server({ name: "telegram-notifier", version: "2.1.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{
        name: "send_telegram_notification",
        description: "Call this tool ONLY when you have completely finished generating your final response to notify the user via Telegram. Pick the type that fits: 'success' for completed work (default), 'info' for status updates, 'warning' for issues that need attention but aren't fatal, 'error' for failures.",
        inputSchema: {
            type: "object",
            properties: {
                message: { type: "string", description: "The notification body — a brief summary of what happened." },
                type: { type: "string", enum: ["success", "info", "warning", "error"], description: "Notification type. Defaults to 'success'." },
                title: { type: "string", description: "Optional custom title shown in bold above the message (e.g. the task name). Defaults to the type label." },
                silent: { type: "boolean", description: "Set true for low-priority notifications that should not make a sound. Defaults to false." }
            },
            required: ["message"]
        }
    },
    {
        name: "send_message",
        description: "Send a plain message to the user on Telegram (no notification header). Use this to ask the user a question or give them an update. The user can reply in Telegram, and you can read their reply with the retrieve_messages or wait_for_reply tool.",
        inputSchema: {
            type: "object",
            properties: {
                message: { type: "string", description: "The message text to send to the user." }
            },
            required: ["message"]
        }
    },
    {
        name: "retrieve_messages",
        description: "Fetch messages the user has sent on Telegram since your last call to this tool (or since the server started). Returns all of them, or a notice that there are no new messages yet. If the user has not replied yet, you may call it again after doing other work.",
        inputSchema: {
            type: "object",
            properties: {},
            required: []
        }
    },
    {
        name: "wait_for_reply",
        description: "Ask the user a question on Telegram and wait for their reply. Blocks up to 55 seconds (default 45). If it times out, just call it again — any reply that arrived meanwhile is returned immediately. Use this whenever you need an answer from the user before continuing.",
        inputSchema: {
            type: "object",
            properties: {
                question: { type: "string", description: "The question to send to the user on Telegram (only sent if no reply is already waiting)." },
                timeout_seconds: { type: "number", description: "How long to wait for a reply, in seconds (max 55). Defaults to 45." }
            },
            required: ["question"]
        }
    }]
}));

function textResult(text, isError = false) {
    return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    // ---------- send_telegram_notification ----------
    if (name === "send_telegram_notification") {
        const { message, type = "success", title, silent = false } = args;
        if (!message || typeof message !== "string") {
            return textResult("❌ 'message' is required and must be a string.", true);
        }

        const style = NOTIF_TYPES[type] || NOTIF_TYPES.success;
        const header = `*${style.title}*`;
        const chunks = splitMessage(message);

        // First chunk gets the bold title, the rest are plain continuations
        const bodies = [header, ...chunks];
        const payload = (text, withParse) => ({
            text,
            ...(silent ? { disable_notification: true } : {}),
            ...(withParse ? { parse_mode: "Markdown" } : {})
        });

        const failures = [];
        for (const chatId of CHAT_IDS) {
            try {
                for (let i = 0; i < bodies.length; i++) {
                    try {
                        await sendTelegram(chatId, payload(bodies[i], i === 0));
                    } catch (e) {
                        // Markdown can 400 on special characters — retry that chunk plain
                        if (i === 0 && /parse/i.test(e.message)) await sendTelegram(chatId, payload(bodies[i], false));
                        else throw e;
                    }
                }
            } catch (error) {
                failures.push(`chat ${chatId}: ${error.message}`);
            }
        }

        if (failures.length > 0) {
            return textResult(`❌ Failed to send: ${failures.join("; ")}`, true);
        }
        return textResult(`✅ Telegram notification sent to ${CHAT_IDS.length} chat(s).${silent ? " (silent)" : ""}`);
    }

    // ---------- send_message ----------
    if (name === "send_message") {
        const { message } = args;
        if (!message || typeof message !== "string") {
            return textResult("❌ 'message' is required and must be a string.", true);
        }

        const failures = [];
        for (const chatId of CHAT_IDS) {
            for (const chunk of splitMessage(message)) {
                try {
                    await sendTelegram(chatId, { text: chunk });
                } catch (e) {
                    failures.push(`chat ${chatId}: ${e.message}`);
                    break;
                }
            }
        }
        if (failures.length > 0) {
            return textResult(`❌ Failed to send: ${failures.join("; ")}`, true);
        }
        return textResult(`✅ Message sent to ${CHAT_IDS.length} chat(s). If the user replies in Telegram, read it with retrieve_messages or wait_for_reply.`);
    }

    // ---------- retrieve_messages ----------
    if (name === "retrieve_messages") {
        const msgs = takePending();
        if (msgs.length === 0) {
            return textResult("📭 No new messages from the user yet. If you asked them something, call retrieve_messages again later — or use wait_for_reply to block until they answer.");
        }
        return textResult(formatMessages(msgs));
    }

    // ---------- wait_for_reply ----------
    if (name === "wait_for_reply") {
        const { question, timeout_seconds = DEFAULT_TIMEOUT_S } = args;
        if (!question || typeof question !== "string") {
            return textResult("❌ 'question' is required and must be a string.", true);
        }
        const timeoutS = Math.min(Math.max(Math.round(Number(timeout_seconds) || DEFAULT_TIMEOUT_S), 5), MAX_TIMEOUT_S);

        // A reply may already be waiting (e.g. it arrived right after a
        // previous timed-out call) — hand it over without re-asking.
        if (incoming.pending.length > 0) {
            const msgs = takePending();
            return textResult(formatWaitResult(msgs, false, timeoutS));
        }

        // Send the question to all chats first
        const failures = [];
        for (const chatId of CHAT_IDS) {
            for (const chunk of splitMessage(question)) {
                try {
                    await sendTelegram(chatId, { text: chunk });
                } catch (e) {
                    failures.push(`chat ${chatId}: ${e.message}`);
                    break;
                }
            }
        }
        if (failures.length > 0) {
            return textResult(`❌ Could not deliver the question (${failures.join("; ")}). The user never saw it, so do not wait.`, true);
        }

        // Block until the next inbound message arrives or the timeout expires
        const waiter = { resolve: null, startedAt: Date.now(), consumed: false };
        incoming.waiters.push(waiter);

        const result = await new Promise((resolve) => {
            waiter.resolve = resolve;
            setTimeout(() => {
                if (!waiter.consumed) {
                    waiter.consumed = true;
                    const i = incoming.waiters.indexOf(waiter);
                    if (i !== -1) incoming.waiters.splice(i, 1);
                    resolve([]); // timed out
                }
            }, timeoutS * 1000).unref?.();
        });

        if (result.length > 0) {
            return textResult(formatWaitResult(result, false, timeoutS));
        }
        return textResult(formatWaitResult([], true, timeoutS));
    }

    // Unknown tool
    return textResult(`❌ Unknown tool: ${name}`, true);
});

async function main() {
    startPolling(); // start capturing inbound Telegram messages (non-blocking)
    const transport = new StdioServerTransport();
    await server.connect(transport);
}
main();
