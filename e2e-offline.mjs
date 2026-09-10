// Offline end-to-end test: real index.js over MCP stdio against a mock Bot API.
// Covers: tool surface, wait_for_reply resolution, NO auto-ack (loop safety),
// pending-early-return, retrieve_messages, loop guards (cooldown + circuit
// breaker), and the single-instance lock (2nd instance goes standby).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startMock, state } from "./mock-telegram.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${extra ? " — " + extra : ""}`); }
};

const { server: mock, port } = await startMock();
const API_BASE = `http://127.0.0.1:${port}`;
const CHAT = "111";
const pushUserMsg = async (text) => {
    const r = await fetch(`${API_BASE}/__test/message`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: CHAT, text })
    });
    if (!r.ok) throw new Error("push failed " + r.status);
};
const resetMock = () => { state.updates.length = 0; state.sent.length = 0; state.nextId = 1; state.maxSeenOffset = 0; };
const makeClient = async () => {
    const transport = new StdioClientTransport({
        command: "node", args: ["index.js"],
        env: { ...process.env, TELEGRAM_CHAT_ID: CHAT, TELEGRAM_API_BASE: API_BASE, TELEGRAM_BOT_TOKEN: "mock-token" },
        stderr: "inherit"
    });
    const client = new Client({ name: "offline-e2e", version: "1.0.0" }, { capabilities: {} });
    await client.connect(transport);
    return { client, transport };
};
const text = (r) => (r.content || []).map((c) => c.text).join("\n");

const { client, transport } = await makeClient();

// --- 1. Tool surface ---
const names = (await client.listTools()).tools.map((t) => t.name).sort();
check("exposes exactly the 4 tools",
    JSON.stringify(names) === JSON.stringify(["retrieve_messages", "send_message", "send_telegram_notification", "wait_for_reply"]),
    names.join(","));

// --- 2. wait_for_reply: question sent, reply arrives -> resolves with text ---
resetMock();
const waitPromise = client.callTool({
    name: "wait_for_reply",
    arguments: { question: "What color is the sky? (e2e)", timeout_seconds: 25 }
});
await sleep(1200); // let it send the question + start blocking
check("question was delivered to the user",
    state.sent.some((s) => s?.text?.includes("What color is the sky?")),
    JSON.stringify(state.sent.map((s) => s?.text)));

const sentBeforeReply = state.sent.length;
await pushUserMsg("It is blue.");
const waitResult = await waitPromise;
const wt = text(waitResult);
check("wait_for_reply resolved with the user's reply", wt.includes("It is blue."), wt);
check("wait_for_reply is not flagged as error", waitResult.isError !== true);
await sleep(400);
check("NO auto-ack sent (loop safety: bot must not reply to the user's reply)",
    state.sent.length === sentBeforeReply, JSON.stringify(state.sent.map((s) => s?.text)));

// --- 3. The consumed reply must NOT reappear in retrieve_messages ---
const after = text(await client.callTool({ name: "retrieve_messages", arguments: {} }));
check("reply consumed by wait_for_reply does not leak into retrieve_messages",
    !after.includes("It is blue."), after);

// --- 4. wait_for_reply early-return: pending reply served WITHOUT re-asking ---
// Push a reply, wait until the poller has consumed it from the mock queue
// (observable via state.updates), so it is guaranteed to be in the server's
// pending queue when we call wait_for_reply.
const sentBeforeEarly = state.sent.length;
await pushUserMsg("early reply");
const earlyReplyId = state.updates[state.updates.length - 1].update_id;
let consumed = false;
for (let i = 0; i < 20 && !consumed; i++) {
    await sleep(300);
    consumed = state.maxSeenOffset >= earlyReplyId; // server polled past this update id
}
check("precondition: poller consumed the reply into its pending queue", consumed);
const tEarly = Date.now();
const early = await client.callTool({
    name: "wait_for_reply",
    arguments: { question: "SHOULD NOT BE SENT (reply already waiting)", timeout_seconds: 12 }
});
const et = text(early);
const earlyMs = Date.now() - tEarly;
check("wait_for_reply returns the waiting reply", et.includes("early reply"), et);
check("…instantly (early-return, not a fresh wait)", earlyMs < 1500, `${earlyMs}ms`);
check("…without sending a new question to the user",
    state.sent.length === sentBeforeEarly && !state.sent.some((s) => s?.text?.includes("SHOULD NOT BE SENT")),
    JSON.stringify(state.sent.map((s) => s?.text)));

// --- 5. retrieve_messages queue path ---
await pushUserMsg("hello from queue");
const helloId = state.updates[state.updates.length - 1].update_id;
let helloSeen = false;
for (let i = 0; i < 30 && !helloSeen; i++) { await sleep(300); helloSeen = state.maxSeenOffset >= helloId; }
check("precondition: poller consumed 'hello from queue'", helloSeen);
const q = text(await client.callTool({ name: "retrieve_messages", arguments: {} }));
check("retrieve_messages returns the queued reply", q.includes("hello from queue"), q);
const q2 = text(await client.callTool({ name: "retrieve_messages", arguments: {} }));
check("retrieve_messages empty after consuming",
    q2.includes("No new messages") || q2.includes("🛑 STOP"), q2);

// --- 6. Loop guard: retrieve circuit breaker fires on repeated empty polls ---
// (3 consecutive empty polls inside the 10s window => the 3rd MUST be 🛑)
const e1 = text(await client.callTool({ name: "retrieve_messages", arguments: {} }));
await sleep(500);
const e2 = text(await client.callTool({ name: "retrieve_messages", arguments: {} }));
await sleep(500);
const e3 = text(await client.callTool({ name: "retrieve_messages", arguments: {} }));
check("retrieve circuit breaker fires (🛑 STOP) on repeated empty polls",
    e3.includes("🛑 STOP") && !e3.includes("No new messages"), e3);

// --- 7. Loop guard: re-asking a timed-out question is blocked ---
resetMock();
const t0 = Date.now();
const to = await client.callTool({
    name: "wait_for_reply",
    arguments: { question: "unique-timed-out-question", timeout_seconds: 6 }
});
const secs = (Date.now() - t0) / 1000;
check("timeout path returns STOP guidance (not a crash)", text(to).includes("No reply after"), text(to));
check("timeout respected ~6s (got " + secs.toFixed(1) + "s)", secs >= 5.5 && secs < 12);
const askCountAfterTimeout = state.sent.filter((s) => s?.text === "unique-timed-out-question").length;
const reask = await client.callTool({
    name: "wait_for_reply",
    arguments: { question: "unique-timed-out-question", timeout_seconds: 5 }
});
const askCountAfterReask = state.sent.filter((s) => s?.text === "unique-timed-out-question").length;
check("re-ask of timed-out question is blocked (⚠️ guard)",
    reask.isError === true && text(reask).includes("⚠️"), text(reask));
check("blocked re-ask did NOT send another question to the user",
    askCountAfterReask === askCountAfterTimeout, `sent ${askCountAfterReask}x vs ${askCountAfterTimeout}x`);

// --- 8. Legitimate flow still works: NEW question after a timeout is allowed ---
const sentBeforeNew = state.sent.filter((s) => s?.text === "different-question").length;
const newQ = await client.callTool({
    name: "wait_for_reply",
    arguments: { question: "different-question", timeout_seconds: 6 }
});
const sentAfterNew = state.sent.filter((s) => s?.text === "different-question").length;
check("a DIFFERENT question is still delivered (guard only blocks identical re-asks)",
    sentAfterNew === sentBeforeNew + 1 && text(newQ).includes("No reply after"), text(newQ));

await transport.close();

// --- 9. Single-instance lock: 2nd instance must go STANDBY (no polling) ---
resetMock();
const A = await makeClient();
await sleep(1500); // let A take the lock + do its anchor poll
const B = await makeClient();
await sleep(1500);
await pushUserMsg("who-am-i");
await sleep(3000); // poller(s) should have run
const aRes = text(await A.client.callTool({ name: "retrieve_messages", arguments: {} }));
const bRes = text(await B.client.callTool({ name: "retrieve_messages", arguments: {} }));
check("exactly ONE instance captured the message (single poller)",
    aRes.includes("who-am-i") !== bRes.includes("who-am-i"),
    `A: ${aRes.slice(0, 60)} | B: ${bRes.slice(0, 60)}`);
const other = aRes.includes("who-am-i") ? bRes : aRes;
check("the other instance does NOT report the message (no double consumption)",
    !other.includes("who-am-i") && (other.includes("No new messages") || other.includes("STANDBY")),
    other.slice(0, 80));

await A.transport.close();
await B.transport.close();

// --- 10. REGRESSION: a single update must NOT be re-delivered across polls ---
// Root cause of the /start flood: real getUpdates is INCLUSIVE (offset=N
// returns N). The old code used offset=lastUpdateId, so the last-seen update
// was re-queued on EVERY poll. This test would have caught it.
resetMock();
const C = await makeClient();
await sleep(1500); // anchor + first poll
await pushUserMsg("flood-test");
let first = "";
for (let i = 0; i < 20; i++) {
    first = text(await C.client.callTool({ name: "retrieve_messages", arguments: {} }));
    if (first.includes("flood-test")) break;
    await sleep(300);
}
check("message captured on first retrieve", first.includes("flood-test"), first.slice(0, 80));
check("…exactly once (no intra-call duplication)",
    (first.match(/flood-test/g) || []).length === 1, first.slice(0, 80));
await sleep(4000); // let several more poll cycles run with NO new messages
const second = text(await C.client.callTool({ name: "retrieve_messages", arguments: {} }));
check("same update NOT re-queued on later polls (flood regression)",
    !second.includes("flood-test"), second.slice(0, 100));

await C.transport.close();

// --- 11. send_telegram_notification: emoji present + ONE bubble ---
// Regression guard for the "style.emoji defined but never sent" and
// "title sent as a separate message" bugs (v2.4 fixes).
resetMock();
const D = await makeClient();
await sleep(1500); // let D anchor + settle the lock
const n1 = await D.client.callTool({
    name: "send_telegram_notification",
    arguments: { message: "The list was sorted correctly.", type: "success", title: "Sort Task" }
});
check("notification reported success", n1.isError !== true, text(n1));
check("notification is ONE message (no separate title bubble)",
    state.sent.length === 1, JSON.stringify(state.sent.map((s) => s?.text)));
const nBody = state.sent[0]?.text || "";
check("notification contains the type emoji", nBody.includes("✅"), JSON.stringify(nBody));
check("notification contains the custom title", nBody.includes("Sort Task"), JSON.stringify(nBody));
check("title and body are in the SAME message",
    nBody.includes("Sort Task") && nBody.includes("sorted correctly"), JSON.stringify(nBody));

// --- 12. Long notification splits, header rides chunk 1, all under the limit ---
state.sent.length = 0;
const longBody = "word ".repeat(1500).trim(); // ~7500 chars -> multiple chunks
const n2 = await D.client.callTool({
    name: "send_telegram_notification",
    arguments: { message: longBody, type: "error" }
});
check("long notification reported success", n2.isError !== true, text(n2));
check("long notification split into >1 message", state.sent.length >= 2, `sent ${state.sent.length}`);
check("first chunk carries the header (❌)", (state.sent[0]?.text || "").includes("❌"),
    JSON.stringify((state.sent[0]?.text || "").slice(0, 60)));
check("every chunk stays under the 4096 Telegram limit",
    state.sent.every((s) => (s?.text || "").length <= 4096),
    state.sent.map((s) => (s?.text || "").length).join(","));

// --- 13. HARD rate limit: a runaway tool loop gets a real server-side error ---
// (soft guards are prompt-text; this is the belt-and-suspenders that fires
// even if the model ignores them)
await D.client.callTool({ name: "retrieve_messages", arguments: {} }); // drain
let hitHard = false;
for (let i = 0; i < 40; i++) {
    const r = await D.client.callTool({ name: "retrieve_messages", arguments: {} });
    if (text(r).includes("HARD LIMIT")) { hitHard = true; break; }
}
check("hard rate limit fires (real error, not just text)", hitHard);
if (hitHard) {
    const r = await D.client.callTool({ name: "retrieve_messages", arguments: {} });
    check("rate-limited call is flagged isError", r.isError === true);
}

await D.transport.close();
mock.close();
console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
