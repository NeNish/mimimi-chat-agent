// Exercises the real agent loop with a scripted model and a fake search, so the
// tool round-trip, streaming, citation mapping and persistence are covered offline.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Agent, type AgentEvent } from "../src/agent/agent.js";
import { MemoryStore } from "../src/memory/store.js";
import type { SourceRegistry, WebSearchInput } from "../src/agent/webSearch.js";

function scriptedClient(turns: any[][], seen: any[]) {
  let i = 0;
  return {
    messages: {
      stream(params: any) {
        seen.push(structuredClone(params));
        const content = turns[i++];
        const listeners: ((t: string) => void)[] = [];
        return {
          on(_e: string, fn: (t: string) => void) { listeners.push(fn); return this; },
          async finalMessage() {
            for (const b of content) if (b.type === "text") for (const ch of b.text.match(/.{1,8}/g) ?? []) listeners.forEach((l) => l(ch));
            return { content, stop_reason: content.some((b: any) => b.type === "tool_use") ? "tool_use" : "end_turn" };
          },
        };
      },
      async create() { return { content: [{ type: "text", text: "note: Neon pricing" }] }; },
    },
  } as any;
}

test("search round-trip, streaming, citations and memory persistence", async () => {
  const store = new MemoryStore(":memory:");
  const seen: any[] = [];
  const client = scriptedClient(
    [
      [{ type: "tool_use", id: "t1", name: "web_search", input: { queries: ["Neon pricing 2026", "Supabase pricing 2026"], since: "2026-11-03" } }],
      [{ type: "text", text: "Neon's Launch plan is usage-based [1]; Supabase Pro is flat [2]." }],
    ],
    seen,
  );
  const calls: WebSearchInput[] = [];
  const search = async (_k: string, input: WebSearchInput, reg: SourceRegistry) => {
    calls.push(input);
    reg.idFor({ title: "Neon pricing", url: "https://neon.com/pricing", content: "", score: 1 });
    reg.idFor({ title: "Supabase pricing", url: "https://supabase.com/pricing", content: "", score: 1 });
    return { text: "[1] Neon pricing ...\n[2] Supabase pricing ...", queries: input.queries };
  };
  const agent = new Agent(store, { client, search });
  const events: AgentEvent[] = [];
  await agent.turn({ message: "Compare Neon and Supabase pricing", tz: "Asia/Kolkata", now: new Date("2026-11-10T15:52:00Z"), emit: (e) => events.push(e) });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].queries, ["Neon pricing 2026", "Supabase pricing 2026"]);
  // The second model call must carry the tool result back.
  const last = seen[1].messages.at(-1);
  assert.equal(last.content[0].type, "tool_result");
  // System prompt: static part is cache-marked, dynamic part has the clock.
  assert.ok(seen[0].system[0].cache_control);
  assert.match(seen[0].system[1].text, /Tue, 10 Nov 2026/);

  const text = events.filter((e) => e.type === "delta").map((e: any) => e.text).join("");
  assert.equal(text, "Neon's Launch plan is usage-based [1]; Supabase Pro is flat [2].");
  const done = events.find((e) => e.type === "done") as any;
  assert.equal(done.searchRounds, 1);

  const [ex] = store.recentInConversation((events[0] as any).conversationId, 5);
  assert.equal(ex.answer, text);
  assert.deepEqual(ex.sources.map((s) => s.id), [1, 2]);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(store.recentInConversation(ex.conversationId, 1)[0].note, "note: Neon pricing");
});

test("no search when the model answers directly; history carries timestamps", async () => {
  const store = new MemoryStore(":memory:");
  const seen: any[] = [];
  const client = scriptedClient([[{ type: "text", text: "Hi!" }], [{ type: "text", text: "You said hello." }]], seen);
  const agent = new Agent(store, { client, search: async () => { throw new Error("should not search"); } });
  const ev: AgentEvent[] = [];
  await agent.turn({ message: "hello", tz: "UTC", now: new Date("2026-11-10T10:00:00Z"), emit: (e) => ev.push(e) });
  const id = (ev[0] as any).conversationId;
  await agent.turn({ message: "what did I just say?", conversationId: id, tz: "UTC", now: new Date("2026-11-10T10:05:00Z"), emit: () => {} });
  assert.match(seen[1].messages[0].content, /^\[sent Tue, 10 Nov 2026, 10:00 UTC\]\nhello/);
  assert.equal(store.recentInConversation(id, 10).length, 2);
});
