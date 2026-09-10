import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

// Bot token comes from the environment (set in mcp.json). Never hardcode it.
const TELEGRAM_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_TOKEN || "").trim();
if (!TELEGRAM_TOKEN) {
    console.error("❌ Missing TELEGRAM_BOT_TOKEN — add it to the env block in mcp.json.");
    process.exit(1);
}

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

// Split long text into chunks under maxLen, preferring line/space boundaries.
// Callers can pass a smaller budget (e.g. to reserve room for a header that
// will be prepended to the first chunk).
function splitMessage(text, maxLen = MAX_MSG_LEN) {
    const chunks = [];
    let rest = text;
    while (rest.length > maxLen) {
        let cut = rest.lastIndexOf("\n", maxLen);
        if (cut < maxLen * 0.5) cut = rest.lastIndexOf(" ", maxLen);
        if (cut < maxLen * 0.5) cut = maxLen;
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
        body: JSON.stringify({ chat_id: chatId, ...payload }),
        // A hung network must not wedge a tool call forever.
        signal: AbortSignal.timeout(10000)
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
const POLL_INTERVAL_MS = 1500;  // gap between consecutive polls (after a response)
// True long-polling: ask Telegram to hold the connection open up to N seconds
// waiting for a new update (Bot API max is 50). Compared with timeout=0 +
// client-side sleep this cuts idle request volume ~15x AND improves reply
// latency — we are notified the instant a message arrives.
const LONG_POLL_TIMEOUT_S = 25;
// The getUpdates fetch must outlive the server-side hold, or we would abort a
// legitimately in-flight long poll. Add margin for network latency.
const FETCH_TIMEOUT_S = LONG_POLL_TIMEOUT_S + 10;
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

// Loop guards — small local models can get stuck calling these tools in a
// tight loop. The guards make the server itself say "stop" instead of
// silently serving the loop.
const ASK_COOLDOWN_MS = 30000; // re-asking a question that just timed out
const lastAsk = { question: null, at: 0, timedOut: false };
const emptyRetrieves = { count: 0, since: 0 };

const CHAT_SET = new Set(CHAT_IDS);

// HARD rate limit — a genuine safety net on top of the soft (prompt-text)
// loop guards. Small models can ignore "STOP" text and keep calling; this
// returns a real MCP error once a tool is called too often in a rolling
// window, so even a model that reads none of the guard text gets blocked
// server-side. Limits are set well above legitimate use (a model checking
// for a reply a few times, a retry loop with short sleeps) but far below a
// true runaway (hundreds of calls with no delay).
const RATE_WINDOW_MS = 60000;
const RATE_LIMITS = {
    retrieve_messages: 30,
    wait_for_reply: 10,
    send_message: 40,
    send_telegram_notification: 40,
};
const _rateCalls = {}; // toolName -> timestamps within the current window
function rateLimited(tool) {
    const limit = RATE_LIMITS[tool];
    if (!limit) return false;
    const now = Date.now();
    const calls = (_rateCalls[tool] = (_rateCalls[tool] || []).filter((t) => now - t < RATE_WINDOW_MS));
    if (calls.length >= limit) return true; // over limit — refuse (don't record)
    calls.push(now);
    return false;
}

// True once main() confirms this instance holds the poll lock.
let IS_POLLER = false;
const STANDBY_NOTE =
    "⚠️ This instance is in STANDBY — another instance is the one polling Telegram, and the user's reply is in THAT instance's queue, not this one's. Do not treat an empty result here as 'the user didn't reply.' If you see this, the toolkit has multiple live instances; restart LM Studio so a single instance owns the connection.";

// ============================================================
//  SINGLE-INSTANCE LOCK
// ============================================================
// LM Studio can leave old MCP bridge workers (and their server
// instances) running across restarts. Every live instance polls
// the same bot token, and Telegram delivers each update to EVERY
// instance — so N instances = N acks per message + N model loops.
// Only the instance holding this lock may poll; the others go to
// standby (they still serve tool calls from their own queues).
// The lock is keyed per API base + token + chat id, so offline/mock tests are
// unaffected.
// IMPORTANT: derive the filename from a SHA-256 HASH of that identity, not a
// base64url encoding of it — base64url is a reversible encoding, so it would
// leak ~24 bytes of the raw bot token into a world-listable tmpdir filename.
const LOCK_ID = crypto
    .createHash("sha256")
    .update(`${API_BASE}|${TELEGRAM_TOKEN}|${CHAT_IDS.join(",")}`)
    .digest("hex")
    .slice(0, 32);
const LOCK_FILE = path.join(os.tmpdir(), `headsup-telegram-${LOCK_ID}.lock`);

function isProcessAlive(pid) {
    try { process.kill(pid, 0); return true; } catch { return false; }
}

function acquireLock() {
    try {
        const fd = fs.openSync(LOCK_FILE, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
        fs.writeSync(fd, String(process.pid));
        fs.closeSync(fd);
        return true; // this instance is the poller
    } catch (e) {
        if (e.code !== "EEXIST") throw e;
        let ownerPid = 0;
        try { ownerPid = Number(fs.readFileSync(LOCK_FILE, "utf8").trim()); } catch {}
        if (ownerPid && ownerPid !== process.pid && isProcessAlive(ownerPid)) {
            return false; // live owner — standby
        }
        try { fs.unlinkSync(LOCK_FILE); } catch {} // stale lock — steal
        return acquireLock();
    }
}

function releaseLockIfOurs() {
    try {
        const pid = Number(fs.readFileSync(LOCK_FILE, "utf8").trim());
        if (pid === process.pid) fs.unlinkSync(LOCK_FILE);
    } catch {}
}

function handleIncoming(msg) {
    const text = (msg.text || msg.caption || "").trim();
    const entry = {
        text: text || "[non-text message]",
        chat_id: msg.chat?.id,
        time: new Date((msg.date || Math.floor(Date.now() / 1000)) * 1000).toISOString()
    };
    log(`inbound: ${entry.chat_id} -> ${text ? JSON.stringify(text) : "[non-text]"} (instance ${process.pid})`);

    incoming.recent.push(entry);
    if (incoming.recent.length > MAX_BUFFERED) incoming.recent.shift();

    if (!text) return; // don't queue stickers/photos/etc. as answers

    // A reply goes to exactly ONE consumer: a blocking wait_for_reply caller
    // if one is active, otherwise the pending queue for retrieve_messages.
    // NOTE: no auto-ack here on purpose — sending a bot reply in response to
    // the user's message created a feedback loop with chatty models (their
    // steering messages each triggered a bot message, which triggered another
    // model turn, ...). The model sees the reply in the tool result anyway.
    const i = incoming.waiters.findIndex((w) => !w.consumed);
    if (i !== -1) {
        const waiter = incoming.waiters[i];
        waiter.consumed = true;
        const msgs = [{ ...entry, waitedMs: Date.now() - waiter.startedAt }];
        removeWaiter(waiter);
        waiter.resolve(msgs);
        log(`delivered to waiting caller (waited ${Math.round(msgs[0].waitedMs / 1000)}s)`);
    } else {
        incoming.pending.push(entry);
        log(`${incoming.pending.length} message(s) pending for the model`);
    }
}

function getUpdatesUrl(offset, limit, timeoutSecs = 0) {
    const params = new URLSearchParams();
    // timeout>0 => true long-polling (server holds the connection). timeout=0
    // is used when draining the backlog (anchor) where we want instant answers.
    params.set("timeout", String(timeoutSecs));
    params.set("allowed_updates", JSON.stringify(["message"]));
    if (offset !== null) params.set("offset", String(offset));
    if (limit) params.set("limit", String(limit));
    return `${API_BASE}/bot${TELEGRAM_TOKEN}/getUpdates?${params.toString()}`;
}

async function fetchUpdates(url, timeoutSecs = FETCH_TIMEOUT_S) {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutSecs * 1000) });
    if (!res.ok) {
        let detail = `HTTP ${res.status}`;
        try { detail = (await res.json()).description || detail; } catch {}
        throw new Error(detail);
    }
    return (await res.json()).result || [];
}

// IMPORTANT: real Telegram getUpdates is INCLUSIVE — it returns updates with
// update_id >= offset (verified live: offset=N returns N). So after seeing id N
// the next request MUST use offset N+1. Using offset=N re-delivers the last
// update on every poll (that was the root cause of the /start flood).

// Discard the entire pre-existing backlog WITHOUT processing it (messages from
// before this server started are not replies). Loops until getUpdates is empty,
// so it works even when the backlog is larger than one 100-update page.
async function anchorToNow() {
    let offset = 0;
    let maxId = 0;
    for (let guard = 0; guard < 1000; guard++) {
        const result = await fetchUpdates(getUpdatesUrl(offset, 100));
        if (result.length === 0) break;
        for (const u of result) maxId = Math.max(maxId, u.update_id);
        offset = maxId + 1;
    }
    return maxId; // first real poll will use offset maxId + 1
}

async function pollOnce() {
    if (incoming.lastUpdateId === null) {
        incoming.lastUpdateId = await anchorToNow();
    }
    // Long-poll: Telegram holds the connection up to LONG_POLL_TIMEOUT_S.
    const result = await fetchUpdates(
        getUpdatesUrl(incoming.lastUpdateId + 1, 100, LONG_POLL_TIMEOUT_S)
    );
    for (const u of result) {
        incoming.lastUpdateId = Math.max(incoming.lastUpdateId, u.update_id);
        if (!u.message) continue;
        // NOTE: chat.id arrives as a JSON number; CHAT_SET holds strings from env.
        const chatId = String(u.message.chat?.id);
        if (CHAT_SET.has(chatId)) {
            handleIncoming(u.message);
        } else {
            // Don't drop unconfigured chats silently — a mistyped
            // TELEGRAM_CHAT_ID or a lost chat would otherwise be total silence
            // with zero diagnostic trail.
            log(`dropped inbound from unconfigured chat ${chatId} (update ${u.update_id}) — check TELEGRAM_CHAT_ID`);
        }
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
                    log(`fatal: ${e.message} (invalid bot token) — stopping poller and releasing lock`);
                    releaseLockIfOurs(); // don't hold the lock while dead
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
    })().catch((err) => {
        // Unexpected fatal error in the poll loop (the inner try/catch handles
        // expected failures). Surface it and release the lock instead of
        // leaving an unhandled promise rejection.
        log(`poll loop crashed: ${err?.stack || err}`);
        releaseLockIfOurs();
    });
}

function takePending() {
    const msgs = incoming.pending;
    incoming.pending = [];
    return msgs;
}

function removeWaiter(waiter) {
    waiter.consumed = true;
    const i = incoming.waiters.indexOf(waiter);
    if (i !== -1) incoming.waiters.splice(i, 1);
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
        return `⏱️ No reply after ${timeoutS}s. STOP HERE: do not continue the task, do not ask this question again, and do not send any further messages to the bot. End your response and wait — the user will answer in LM Studio when ready.`;
    }
    return "❌ No reply received.";
}

const server = new Server({ name: "telegram-notifier", version: "2.4.0" }, { capabilities: { tools: {} } });

// A stdio MCP server must die with its client. Without this, the poll loop
// keeps the process alive forever after LM Studio drops the connection —
// that is exactly how zombie pollers accumulate (each one re-receives every
// user message and re-acks it).
server.onclose = () => {
    releaseLockIfOurs();
    process.exit(0);
};

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
        description: "Send a plain message to the user on Telegram (no notification header). Use this to ask the user a question or give them an update. Do NOT send several messages in a row without first receiving the user's reply. Read their reply with the retrieve_messages or wait_for_reply tool.",
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
        description: "Fetch messages the user has sent on Telegram since your last call to this tool (or since the server started). Returns all of them, or a notice that there are no new messages. If there are no new messages, do NOT call this tool again — end your response and wait for the user to reply in LM Studio.",
        inputSchema: {
            type: "object",
            properties: {},
            required: []
        }
    },
    {
        name: "wait_for_reply",
        description: "Ask the user a question on Telegram and wait for their reply. Blocks up to 55 seconds (default 45). If the user replies, continue with their answer. If it times out, STOP: do not continue the task, do not ask the same question again — end your response and wait for the user to reply in LM Studio.",
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

    // Hard rate limit (safety net beyond the soft text guards).
    if (rateLimited(name)) {
        return textResult(
            `🛑 HARD LIMIT: ${name} was called ${RATE_LIMITS[name]} times in the last minute, so the server is now refusing it. STOP calling tools — end your response and wait for the user in LM Studio.`,
            true
        );
    }

    // ---------- send_telegram_notification ----------
    if (name === "send_telegram_notification") {
        const { message, type = "success", title, silent = false } = args;
        if (!message || typeof message !== "string") {
            return textResult("❌ 'message' is required and must be a string.", true);
        }

        const style = NOTIF_TYPES[type] || NOTIF_TYPES.success;
        // Emoji + bold title as a header line. It is prepended to the FIRST
        // chunk (not sent as its own message) so the notification arrives as a
        // single bubble: bold header on top, body right underneath.
        const header = `*${style.emoji} ${title || style.title}*`;
        const headerSep = "\n\n";
        // Reserve room for the header in the first chunk so the combined
        // message never exceeds the Telegram limit.
        const firstBudget = Math.max(100, MAX_MSG_LEN - header.length - headerSep.length);
        const chunks = splitMessage(message, firstBudget);
        chunks[0] = header + headerSep + chunks[0];
        const bodies = chunks;
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
        if (msgs.length > 0) {
            emptyRetrieves.count = 0;
            return textResult(formatMessages(msgs));
        }
        // Standby instance: an empty queue here is NOT proof of no reply — the
        // reply may be sitting in the active (polling) instance's queue.
        if (!IS_POLLER) {
            return textResult(STANDBY_NOTE, true);
        }
        // Circuit breaker: repeated empty polls in a short window
        const now = Date.now();
        if (now - emptyRetrieves.since > 10000) { emptyRetrieves.count = 0; emptyRetrieves.since = now; }
        emptyRetrieves.count++;
        if (emptyRetrieves.count >= 3) {
            return textResult("🛑 STOP: you have checked for replies 3 times in a row with nothing new. Do NOT call retrieve_messages again and do not continue the task. End your response and wait for the user to reply in LM Studio — their reply will still be here when you next check.");
        }
        return textResult("📭 No new messages from the user yet. Do NOT call this tool again immediately. If you need an answer before continuing, use wait_for_reply once — otherwise end your response and wait for the user in LM Studio.");
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
            lastAsk.question = question.trim();
            lastAsk.at = Date.now();
            lastAsk.timedOut = false;
            const msgs = takePending();
            return textResult(formatWaitResult(msgs, false, timeoutS));
        }

        // Loop guard: this exact question just timed out — don't spam the user
        // with the same question in a tight loop.
        const now = Date.now();
        if (lastAsk.timedOut && lastAsk.question === question.trim() && now - lastAsk.at < ASK_COOLDOWN_MS) {
            return textResult(`⚠️ You already asked this same question ${Math.round((now - lastAsk.at) / 1000)}s ago and the user did not answer. STOP: do not ask it again and do not continue the task. End your response and wait for the user to reply in LM Studio.`, true);
        }

        // Standby instance: it cannot capture the reply (that happens in the
        // active/polling instance). Send the question so the user sees it, then
        // report clearly instead of blocking on a queue that will stay empty.
        if (!IS_POLLER) {
            const sfail = [];
            for (const chatId of CHAT_IDS) {
                for (const chunk of splitMessage(question)) {
                    try { await sendTelegram(chatId, { text: chunk }); }
                    catch (e) { sfail.push(`chat ${chatId}: ${e.message}`); break; }
                }
            }
            if (sfail.length > 0) {
                return textResult(`❌ Could not deliver the question (${sfail.join("; ")}).`, true);
            }
            return textResult(`✅ Question sent to the user, but ${STANDBY_NOTE}`, true);
        }

        // Register the waiter BEFORE sending the question, so a reply that
        // arrives while we are still sending is captured (not lost to a
        // spurious "timed out"). If the send fails we cancel the waiter.
        //
        // The waiter must be FULLY FORMED (resolve assigned) before it is
        // pushed: handleIncoming can fire during the awaits below and calls
        // waiter.resolve(). A null resolve would throw there and the user's
        // reply would be silently dropped.
        const waiter = {};
        waiter.startedAt = Date.now();
        waiter.consumed = false;
        const waitPromise = new Promise((resolve) => {
            waiter.resolve = resolve;
            const t = setTimeout(() => {
                if (!waiter.consumed) {
                    removeWaiter(waiter);
                    resolve([]); // timed out
                }
            }, timeoutS * 1000);
            t.unref?.();
        });
        incoming.waiters.push(waiter);

        // Send the question to all chats
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
            removeWaiter(waiter);
            return textResult(`❌ Could not deliver the question (${failures.join("; ")}). The user never saw it, so do not wait.`, true);
        }

        // A reply may have arrived while we were sending — serve it now.
        if (incoming.pending.length > 0) {
            const msgs = takePending();
            removeWaiter(waiter);
            lastAsk.question = question.trim();
            lastAsk.at = Date.now();
            lastAsk.timedOut = false;
            return textResult(formatWaitResult(msgs, false, timeoutS));
        }

        // Block until the next inbound message arrives or the timeout expires
        // (waiter + timeout were set up before the send, above).
        const result = await waitPromise;

        lastAsk.question = question.trim();
        lastAsk.at = Date.now();
        lastAsk.timedOut = result.length === 0;

        if (result.length > 0) {
            return textResult(formatWaitResult(result, false, timeoutS));
        }
        return textResult(formatWaitResult([], true, timeoutS));
    }

    // Unknown tool
    return textResult(`❌ Unknown tool: ${name}`, true);
});

async function main() {
    IS_POLLER = acquireLock();
    if (IS_POLLER) {
        log("acquired poll lock — this instance polls Telegram");
        startPolling(); // start capturing inbound Telegram messages (non-blocking)
    } else {
        log("another instance is already polling — STANDBY (no polling)");
    }
    const transport = new StdioServerTransport();
    await server.connect(transport);
}
main().catch((err) => {
    // Fatal startup errors (e.g. transport connect failure) must not leave an
    // unhandled rejection or a held lock.
    console.error("[telegram-notifier] fatal:", err?.stack || err);
    releaseLockIfOurs();
    process.exit(1);
});
