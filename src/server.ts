import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import fs from "node:fs";
import { createRequire } from "node:module";
import { Agent } from "./agent/agent.js";
import { config, missingKeys } from "./config.js";
import { MemoryStore } from "./memory/store.js";
import { isValidTimeZone } from "./time.js";

const store = new MemoryStore(config.dbPath);
const agent = new Agent(store);
const app = new Hono();

app.get("/api/health", (c) => c.json({ ok: true, missingKeys: missingKeys(), model: config.model, exchanges: store.count() }));

app.get("/api/conversations", (c) => c.json(store.listConversations()));

app.get("/api/conversations/:id", (c) => {
  const conv = store.getConversation(c.req.param("id"));
  if (!conv) return c.json({ error: "not found" }, 404);
  return c.json({ ...conv, exchanges: store.recentInConversation(conv.id, 500) });
});

app.post("/api/chat", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) return c.json({ error: "message is required" }, 400);
  if (message.length > 20_000) return c.json({ error: "message too long" }, 413);
  const tz = isValidTimeZone(body.tz) ? body.tz : "UTC";
  const conversationId = typeof body.conversationId === "string" ? body.conversationId : undefined;

  return streamSSE(c, async (sse) => {
    const missing = missingKeys();
    if (missing.length) {
      await sse.writeSSE({ event: "error", data: JSON.stringify({ message: `Missing ${missing.join(", ")} in .env` }) });
      return;
    }
    // Events are produced synchronously by the agent; chain writes to keep order.
    let chain = Promise.resolve();
    const emit = (e: { type: string }) => {
      chain = chain.then(() => sse.writeSSE({ event: e.type, data: JSON.stringify(e) }));
    };
    try {
      await agent.turn({ message, conversationId, tz, signal: c.req.raw.signal, emit });
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      console.error("[turn]", msg);
      emit({ type: "error", message: msg } as any);
    }
    await chain;
  });
});

// Frontend: static files plus the markdown renderer straight from node_modules.
const require = createRequire(import.meta.url);
const markedPath = require.resolve("marked").replace(/lib[\\/].*$/, "lib/marked.esm.js");
app.get("/vendor/marked.js", (c) => {
  c.header("Content-Type", "text/javascript");
  return c.body(fs.readFileSync(markedPath, "utf8"));
});
app.use("/*", serveStatic({ root: "./public" }));

serve({ fetch: app.fetch, port: config.port }, ({ port }) => {
  const missing = missingKeys();
  console.log(`\n  Chat agent running → http://localhost:${port}`);
  console.log(`  model=${config.model}  memory=${config.dbPath} (${store.count()} exchanges)`);
  if (missing.length) console.warn(`  ⚠ Missing ${missing.join(", ")} — copy .env.example to .env and fill it in.\n`);
});
