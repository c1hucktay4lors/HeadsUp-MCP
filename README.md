RENAME INDEX.TXT TO INDEX.JS. HAD TO CHANGE IT SO I COULD EMAIL IT TO YOU

-Max

# Telegram Notifier MCP Toolkit

A lightweight MCP server for [LM Studio](https://lmstudio.ai/) that gives the AI a two-way line to your phone: it sends you Telegram notifications when it finishes a task — **and it can read your replies back**, so you can answer questions mid-task without touching the computer.

## How It Works

- **Bot Token** → set via `TELEGRAM_BOT_TOKEN` in `mcp.json` (created once via @BotFather; never hardcoded)
- **Chat ID(s)** → configured per-user in `mcp.json` (multiple supported, comma-separated)
- The AI automatically calls the `send_telegram_notification` tool when it finishes your prompt
- Notifications come in four flavors: ✅ success, ℹ️ info, ⚠️ warning, ❌ error
- A background long-poll loop (`getUpdates`, every 1.5s) captures anything **you** send the bot, and the AI reads it back with `retrieve_messages` / `wait_for_reply`

## Prerequisites

- [Node.js](https://nodejs.org/) (`sudo pacman -S nodejs npm` on Arch)
- [LM Studio](https://lmstudio.ai/) with MCP support
- A Telegram account

## Setup

### 1. Create Your Telegram Bot

1. Open Telegram, search for **@BotFather**
2. Send `/newbot` and follow the prompts
3. Copy the **API Token** it gives you

### 2. Get Your Chat ID

1. Search for **@userinfobot** on Telegram and start it
2. Copy the **Id** number from its reply

### 3. Start the Bot

1. Search for your new bot's username in Telegram
2. Click **Start** (required before the bot can message you)

### 4. Install (from where index.js is)

```bash
npm init -y
npm pkg set type="module"
npm install @modelcontextprotocol/sdk
```

### 5. Configure

**`mcp.json`** (LM Studio MCP settings) — set your Chat ID **and** bot token in the `env` block (the token is read from the environment, never hardcoded):

```json
{
  "mcpServers": {
    "telegram-notifier": {
      "command": "node",
      "args": ["/home/YOUR_USER/Projects/HeadsUp_mcp/HeadsUp_MCP/index.js"],
      "env": {
        "TELEGRAM_CHAT_ID": "YOUR_CHAT_ID",
        "TELEGRAM_BOT_TOKEN": "123456789:ABCdefGHIjklMNOpqrsTUVwxyz"
      }
    }
  }
}
```

> If `TELEGRAM_BOT_TOKEN` is missing the server logs a clear error to stderr and exits.

> **Multiple devices?** Put several chat IDs in the same value, comma-separated:
> `"TELEGRAM_CHAT_ID": "123456789,987654321"` — every notification goes to all of them.

### 6. Restart LM Studio

Fully quit and reopen LM Studio so it loads the MCP server.

## Usage

Just ask the model to notify you when done:

> *"Write a Python script to sort a list. Send me a Telegram notification when you're finished."*

The AI will generate the code, then call the tool. You'll get a push notification on your phone.

### Notification Options

The `send_telegram_notification` tool accepts:

| Parameter  | Required | Description |
|------------|----------|-------------|
| `message`  | ✅       | The notification body — a brief summary of what happened |
| `type`     | —        | `success` (✅, default), `info` (ℹ️), `warning` (⚠️), or `error` (❌). Sets the emoji and default title |
| `title`    | —        | Custom bold title shown above the message (e.g. the task name). Defaults to the type label |
| `silent`   | —        | Set `true` for low-priority notifications that shouldn't make a sound |

Extras that just work:

- **Long messages** are automatically split into multiple Telegram messages (4096-char limit)
- **Formatting is safe** — if your text breaks Telegram's Markdown parser, the message is retried plain instead of failing
- **Multiple recipients** — all chat IDs in `TELEGRAM_CHAT_ID` get a copy

Example calls the AI might make:

```json
{ "message": "Sorted the list. Script saved to sort_list.py.", "type": "success" }
{ "message": "Tests finished: 12 passed, 1 skipped.", "type": "info", "title": "Test Run", "silent": true }
{ "message": "npm install failed — registry unreachable, check your network.", "type": "error" }
```

## Two-Way: Replying to the AI

Besides notifications, the bot now **listens** for your messages and hands them to the model.

| Tool              | What it does |
|-------------------|--------------|
| `send_message`    | Sends a plain message to your phone (no notification header). The AI uses it to ask you questions |
| `retrieve_messages` | Returns everything you've sent since the last call (or "no new messages"). Your original idea — non-blocking, call it whenever |
| `wait_for_reply`  | Asks a question on Telegram and **blocks until you answer** (up to 55s). One round-trip instead of polling |

Example flow:

> *"Which database should I use for this project?"*
> → AI calls `wait_for_reply("Which DB do you prefer — SQLite or Postgres?")`
> → You get a push, type **SQLite** on your phone
> → The tool returns `📬 User replied after ~3s: SQLite` straight into the model's context
> → AI continues with SQLite

Notes:

- `wait_for_reply` is capped at **55s** because MCP clients (LM Studio, the SDK) time out tool calls at ~60s. A reply that arrives while it waits is returned instantly; a reply that arrives right after a timeout is served instantly on the next call, so nothing is lost.
- **Loop safety (learned the hard way):** small local models can get stuck calling these tools in a tight loop, and the bot used to auto-ack every user message — which fed the loop back to life. Now:
  - the bot **never** sends an automatic "got it" reply to your messages;
  - `wait_for_reply` refuses to re-send a question that just timed out (30s cooldown, identical questions only);
  - `retrieve_messages` trips a circuit breaker (🛑) after 3 consecutive empty checks;
  - all of these tell the model to **stop and wait for you in LM Studio** rather than keep going.
- **Single-instance lock:** LM Studio can leave old MCP server instances running across restarts; since every instance would otherwise poll the same bot token and re-receive every message, only the first live instance polls — the rest sit in standby. The server also exits when its LM Studio connection closes (no more zombie pollers).
- Messages are held **in memory only**: they belong to the model's current conversation. If LM Studio restarts, the queue is gone (your messages stay in your Telegram history, of course).
- Replies from other chats/devices are ignored unless their chat ID is in `TELEGRAM_CHAT_ID`.

## Testing

```bash
npm test            # offline end-to-end suite (mock Bot API — no phone, no real Telegram)
node e2e-test.mjs   # live test against the real bot — reply to your phone to finish the loop
```

## Sharing With Others

Give them `index.js` and `package.json`. They:

1. Run `npm install`
2. Get their own Chat ID from @userinfobot
3. Start the bot in Telegram
4. Add their Chat ID to their own `mcp.json`

Each person sets their own `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in their `mcp.json` — the token is never hardcoded in the source.

## Troubleshooting

| Error | Fix |
|---|---|
| `chat not found` | You haven't sent `/start` to the bot yet |
| `Missing TELEGRAM_CHAT_ID` | Check `mcp.json` has the `env` block |
| `MODULE_NOT_FOUND` | Verify the path in `args` is absolute and correct |
| `401 Unauthorized` | Bot token is invalid — revoke and regenerate via @BotFather |

## License

MIT
