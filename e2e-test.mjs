// End-to-end test: talks to index.js over real MCP stdio, using a FAKE chat id
// (so nothing is sent to Max's phone for the send-tests... except the question
// we WANT him to see — see note below). Run: node e2e-test.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const FAKE_CHAT = "8619390204"; // real chat id so the question reaches the phone

const client = new Client({ name: "e2e-harness", version: "1.0.0" }, { capabilities: {} });
const transport = new StdioClientTransport({
    command: "node",
    args: ["index.js"],
    env: { ...process.env, TELEGRAM_CHAT_ID: FAKE_CHAT },
    stderr: "inherit"
});
await client.connect(transport);

const say = (label, r) => {
    const text = (r.content || []).map((c) => c.text).join("\n");
    console.log(`\n=== ${label} ===\n${text}\n(isError: ${r.isError === true})`);
};

// 1. Tool list
const tools = await client.listTools();
console.log("=== TOOLS ===\n" + tools.tools.map((t) => t.name).join(", "));

// 2. retrieve_messages with nothing pending
say("retrieve_messages (empty)", await client.callTool({ name: "retrieve_messages", arguments: {} }));

// 3. wait_for_reply — this one IS delivered to the configured chat, so the
//    user can answer it to prove the full loop.
const t0 = Date.now();
say(
    `wait_for_reply (90s window) — elapsed ${((Date.now() - t0) / 1000).toFixed(1)}s`,
    await client.callTool({
        name: "wait_for_reply",
        arguments: { question: "🧪 e2e-test — reply 'ping' to me to prove you can reach the model.", timeout_seconds: 45 }
    })
);

// 4. retrieve_messages after wait consumed the reply
say("retrieve_messages (after wait)", await client.callTool({ name: "retrieve_messages", arguments: {} }));

await transport.close();
console.log("\nHARNESS DONE");
process.exit(0);
