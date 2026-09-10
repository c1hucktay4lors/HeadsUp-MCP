# HeadsUp — Telegram for your local model

Give your AI a line to your phone. It pings you on Telegram when a task finishes — and you can **reply from your phone** to steer it mid-task, without touching the computer.

It's a small MCP server for [LM Studio](https://lmstudio.ai/): one Node process, four tools, no cloud.

## What you get

- **Notifications** — a push on your phone when the AI finishes something, with a ✅ / ℹ️ / ⚠️ / ❌ header
- **Two-way** — the AI can ask you a question on Telegram and wait for your answer, so you can decide from anywhere

## Setup

You'll need [Node.js](https://nodejs.org/), [LM Studio](https://lmstudio.ai/), and a Telegram account.

### 1. Create a bot

1. In Telegram, message **@BotFather**
2. Send `/newbot` and follow the prompts
3. Copy the **API token** it gives you

### 2. Get your chat ID

1. Message **@userinfobot** in Telegram
2. Copy the **Id** number from its reply

### 3. Start the bot

Search for your bot in Telegram and tap **Start** — the bot can't message you until you do.

### 4. Install

From the folder that contains `index.js`:

```bash
npm install
```

### 5. Configure

Add this to LM Studio's MCP settings (`mcp.json`). Replace the path, chat ID, and token with your own:

```json
{
  "mcpServers": {
    "telegram-notifier": {
      "command": "node",
      "args": ["/path/to/HeadsUp-MCP/index.js"],
      "env": {
        "TELEGRAM_CHAT_ID": "YOUR_CHAT_ID",
        "TELEGRAM_BOT_TOKEN": "YOUR_BOT_TOKEN"
      }
    }
  }
}
```

- **Token missing?** The server logs a clear error and exits — nothing fails silently.
- **More than one device?** Put several chat IDs in, comma-separated — `"TELEGRAM_CHAT_ID": "123456, 789012"` — and every notification goes to all of them.

### 6. Restart LM Studio

Fully quit and reopen it so it loads the new server.

## Using it

Just ask:

> *"Write a Python script to sort a list. Ping me on Telegram when you're done."*

You'll get a push the moment it finishes.

### Notification options

The `send_telegram_notification` tool takes:

| Parameter   | Required | What it does |
|-------------|----------|--------------|
| `message`   | ✅       | The body — a short summary of what happened |
| `type`      | —        | `success` (✅, default), `info` (ℹ️), `warning` (⚠️), `error` (❌) — sets the header |
| `title`     | —        | A custom bold title above the message (e.g. the task name) |
| `silent`    | —        | `true` = no sound |

Long messages split themselves to fit Telegram's limits, and if your text trips up Telegram's Markdown the message is retried plain instead of failing.

### Asking you back

The bot can also **ask** and **wait**:

| Tool              | What it does |
|-------------------|--------------|
| `send_message`    | Sends a plain message to your phone (no header) |
| `retrieve_messages` | Non-blocking — grab everything you've sent since the last check |
| `wait_for_reply`  | Asks a question and **waits up to 55s** for your reply, then carries on |

For example:

> *"Which database should I use for this?"*
> → the AI asks on your phone: *"SQLite or Postgres?"*
> → you tap **SQLite** from wherever you are
> → the AI keeps going with SQLite

A couple of things worth knowing:

- Replies are kept **in memory for the current conversation** — if LM Studio restarts, the queue clears (your messages are still in your Telegram history, obviously).
- It's guarded against runaway loops — the bot won't keep asking or re-asking on its own.

## Testing

```bash
npm test            # offline end-to-end suite (mocked Bot API — nothing touches your phone)
node e2e-test.mjs   # LIVE test: really sends to your phone — set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID first
```

## Sharing it

Hand someone `index.js`, `package.json`, and this README. They run `npm install`, grab their own chat ID from @userinfobot, start the bot, and drop their chat ID and token into their `mcp.json`. Everyone uses their own token — nothing is ever hardcoded.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `chat not found` | You haven't tapped **Start** on the bot yet |
| `Missing TELEGRAM_CHAT_ID` or `Missing TELEGRAM_BOT_TOKEN` | Check the `env` block in `mcp.json` |
| `MODULE_NOT_FOUND` | Make sure the path in `args` is absolute and correct |
| `401 Unauthorized` | The bot token is invalid — regenerate it in @BotFather |

## License

[MIT](LICENSE)
