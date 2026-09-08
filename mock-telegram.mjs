// Minimal Telegram Bot API mock for offline testing of index.js.
// Implements just enough: sendMessage, getUpdates (offset/limit), deleteWebhook,
// plus a test-control endpoint to push fake user messages into the update queue.
import http from "node:http";

const state = {
    updates: [], // { update_id, message: { chat:{id}, text, date } }
    nextId: 1,
    sent: []     // recorded sendMessage bodies
};

function json(res, code, obj) {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(obj));
}

function handler(req, res) {
    const url = new URL(req.url, "http://localhost");
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
        const p = url.pathname;

        if (p.endsWith("/sendMessage")) {
            state.sent.push(body ? JSON.parse(body) : null);
            return json(res, 200, { ok: true, result: { message_id: state.sent.length } });
        }
        if (p.endsWith("/getUpdates")) {
            const offset = Number(url.searchParams.get("offset") || 0);
            const limit = Number(url.searchParams.get("limit") || 100);
            const result = state.updates.filter((u) => u.update_id > offset).slice(0, limit);
            return json(res, 200, { ok: true, result });
        }
        if (p.endsWith("/deleteWebhook")) {
            return json(res, 200, { ok: true, result: true });
        }
        // Test control: enqueue a fake user message
        if (p === "/__test/message" && req.method === "POST") {
            const m = body ? JSON.parse(body) : {};
            state.updates.push({
                update_id: state.nextId++,
                message: {
                    chat: { id: Number(m.chat_id || 111) },
                    text: m.text ?? "",
                    date: Math.floor(Date.now() / 1000)
                }
            });
            return json(res, 200, { ok: true });
        }
        return json(res, 404, { ok: false, description: `no route: ${p}` });
    });
}

export function startMock(port = 0) {
    const server = http.createServer(handler);
    return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => resolve({ server, port: server.address().port }));
    });
}

export { state };
