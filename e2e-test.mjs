// LIVE end-to-end test: talks to index.js over real MCP stdio against the
// REAL Telegram Bot API. This DOES send a message to your phone (the
// wait_for_reply question) — reply to it from Telegram to prove the full
// two-way loop.
//
// Requires TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID — set them in the
// environment, or put them in a `.env` file next to this script. Nothing is
// hardcoded here (no token, no chat ID) so the file is safe to share.
//
// Run: node e2e-test.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load a local .env (KEY=VALUE lines) if present, without overriding vars
// already set in the environment.
try {
    const envFile = path.join(__dirname, ".env");
    if (fs.existsSync(envFile)) {
        for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
            const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
            if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
        }
    }
} catch {}

const TOKEN = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
const CHAT = (process.env.TELEGRAM_CHAT_ID || "").trim();
if (!TOKEN || !CHAT) {
    console.error("❌ e2e-test.mjs needs TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID.");
    console.error("   Set them in the environment, or in a .env file next to this script.");
    console.error("   (This is the LIVE test — it really sends a message to your phone.)");
    process.exit(1);
}

const client = new Client({ name: "e2e-harness", version: "1.0.0" }, { capabilities: {} });
const transport = new StdioClientTransport({
    command: "node",
    args: [path.join(__dirname, "index.js")],
    env: { ...process.env, TELEGRAM_CHAT_ID: CHAT, TELEGRAM_BOT_TOKEN: TOKEN },
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

// 3. wait_for_reply — delivered to the configured chat; reply from your phone.
const t0 = Date.now();
say(
    `wait_for_reply (45s window) — elapsed ${((Date.now() - t0) / 1000).toFixed(1)}s`,
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
