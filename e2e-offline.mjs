// Offline end-to-end test: real index.js over MCP stdio against a mock Bot API.
// Proves: tool surface, wait_for_reply resolution, ack, retrieve_messages,
// send_message, and the no-double-consume rule — no live human needed.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startMock, state } from "./mock-telegram.mjs";

const { server: mock, port } = await startMock();
const API_BASE = `http://127.0.0.1:${port}`;
const CHAT = "111";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pushUserMsg = async (text) => {
    const r = await fetch(`${API_BASE}/__test/message`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: CHAT, text })
    });
    if (!r.ok) throw new Error("push failed " + r.status);
};

const transport = new StdioClientTransport({
    command: "node",
    args: ["index.js"],
    env: { ...process.env, TELEGRAM_CHAT_ID: CHAT, TELEGRAM_API_BASE: API_BASE },
    stderr: "inherit"
});
const client = new Client({ name: "offline-e2e", version: "1.0.0" }, { capabilities: {} });
await client.connect(transport);

let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
    if (cond) { pass++; console.log(`  ✅ ${name}`); }
    else { fail++; console.log(`  ❌ ${name}${extra ? " — " + extra : ""}`); }
};
const text = (r) => (r.content || []).map((c) => c.text).join("\n");

// --- 1. Tool surface ---
const names = (await client.listTools()).tools.map((t) => t.name).sort();
check("exposes exactly the 4 tools",
    JSON.stringify(names) === JSON.stringify(["retrieve_messages", "send_message", "send_telegram_notification", "wait_for_reply"]),
    names.join(","));

// --- 2. wait_for_reply: question sent, then reply arrives -> resolves with text ---
state.sent.length = 0;
const waitPromise = client.callTool({
    name: "wait_for_reply",
    arguments: { question: "What color is the sky? (e2e)", timeout_seconds: 25 }
});
await sleep(1200); // let it send the question + start blocking
check("question was delivered to the user",
    state.sent.some((s) => s?.text?.includes("What color is the sky?")),
    JSON.stringify(state.sent.map((s) => s?.text)));

await pushUserMsg("It is blue.");
const waitResult = await waitPromise;
const wt = text(waitResult);
check("wait_for_reply resolved with the user's reply", wt.includes("It is blue."), wt);
check("wait_for_reply is not flagged as error", waitResult.isError !== true);
await sleep(400);
check("ack ('👍 Got it') was sent back to the user",
    state.sent.some((s) => s?.text?.includes("Got it")), JSON.stringify(state.sent.map((s) => s?.text)));

// --- 3. The consumed reply must NOT reappear in retrieve_messages (no double-delivery) ---
const after = text(await client.callTool({ name: "retrieve_messages", arguments: {} }));
check("reply consumed by wait_for_reply does not leak into retrieve_messages",
    !after.includes("It is blue."), after);

// --- 4. retrieve_messages: reply with no active waiter goes to the pending queue ---
await pushUserMsg("hello from queue");
await sleep(4000); // a couple of poll intervals (1.5s each) for safety
const q = text(await client.callTool({ name: "retrieve_messages", arguments: {} }));
check("retrieve_messages returns the queued reply", q.includes("hello from queue"), q);

const q2 = text(await client.callTool({ name: "retrieve_messages", arguments: {} }));
check("retrieve_messages is empty after consuming", q2.includes("No new messages"), q2);

// --- 5. send_message plain delivery ---
state.sent.length = 0;
const sm = await client.callTool({ name: "send_message", arguments: { message: "plain hello" } });
check("send_message succeeds", sm.isError !== true && text(sm).includes("Message sent"), text(sm));
check("send_message delivered without notification header",
    state.sent.some((s) => s?.text === "plain hello"), JSON.stringify(state.sent.map((s) => s?.text)));

// --- 6. wait_for_reply timeout path (short) returns a clean timeout notice ---
const t0 = Date.now();
const to = await client.callTool({ name: "wait_for_reply", arguments: { question: "nobody will answer", timeout_seconds: 6 } });
const secs = (Date.now() - t0) / 1000;
check("timeout path returns notice (not a crash)", text(to).includes("Timed out"), text(to));
check("timeout respected ~6s (got " + secs.toFixed(1) + "s)", secs >= 5.5 && secs < 12);

await transport.close();
mock.close();
console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
