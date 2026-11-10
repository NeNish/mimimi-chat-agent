// One chat turn, end to end:
//
//   message ─► recall (SQLite, ~1ms) ─► model (streams) ──► answer ─► persist ─► note (async)
//                                         │      ▲
//                                         ▼      │
//                                     web_search (parallel fan-out, cached)
//
// The loop is hand-written (~100 lines) rather than a framework agent: it's
// small, every latency decision is visible, and streaming + events are exact.

import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import type { MemoryStore, Source } from "../memory/store.js";
import { recall, renderRecall } from "../memory/recall.js";
import { formatDateTime, formatDay } from "../time.js";
import { NOTE_PROMPT, STATIC_SYSTEM, dynamicSystem } from "./prompt.js";
import { SourceRegistry, WEB_SEARCH_TOOL, runWebSearch, type WebSearchInput } from "./webSearch.js";

export type AgentEvent =
  | { type: "meta"; conversationId: string; title: string }
  | { type: "memory"; timeRefs: { text: string; label: string }[]; items: { askedAt: number; question: string; why: string[] }[] }
  | { type: "search"; queries: string[]; since?: string; topic?: string }
  | { type: "search_done"; results: number; ms: number }
  | { type: "delta"; text: string }
  | { type: "sources"; sources: Source[] }
  | { type: "done"; exchangeId: number; totalMs: number; firstTokenMs: number | null; searchRounds: number }
  | { type: "error"; message: string };

export interface TurnInput {
  message: string;
  conversationId?: string;
  tz: string;
  now?: Date;
  signal?: AbortSignal;
  emit: (e: AgentEvent) => void;
}

const HISTORY_EXCHANGES = 10; // recent turns verbatim; older ones come back via recall
const MAX_ROUNDS = 3; // search rounds before we force an answer

type SearchFn = typeof runWebSearch;

export class Agent {
  private client: Anthropic;
  private search: SearchFn;
  /** `client`/`search` are injectable so the loop can be tested without network. */
  constructor(private store: MemoryStore, deps: { client?: Anthropic; search?: SearchFn } = {}) {
    this.client = deps.client ?? new Anthropic({ apiKey: config.anthropicKey });
    this.search = deps.search ?? runWebSearch;
  }

  async turn({ message, conversationId, tz, now = new Date(), signal, emit }: TurnInput): Promise<void> {
    const t0 = Date.now();
    let firstTokenMs: number | null = null;

    // 1. Conversation bookkeeping.
    let conv = conversationId ? this.store.getConversation(conversationId) : null;
    if (!conv) {
      const title = message.replace(/\s+/g, " ").trim().slice(0, 60);
      conv = this.store.createConversation(conversationId || randomUUID(), title, now.getTime());
    }
    emit({ type: "meta", conversationId: conv.id, title: conv.title });

    // 2. Recall: recent history verbatim + retrieved older/cross-conversation memory.
    const history = this.store.recentInConversation(conv.id, HISTORY_EXCHANGES);
    const mem = recall(this.store, message, { conversationId: conv.id, excludeIds: new Set(history.map((h) => h.id)), now, tz });
    emit({
      type: "memory",
      timeRefs: mem.timeRefs.map((t) => ({ text: t.text, label: t.label })),
      items: mem.items.map((i) => ({ askedAt: i.exchange.askedAt, question: i.exchange.question, why: i.why })),
    });

    const system: Anthropic.TextBlockParam[] = [
      { type: "text", text: STATIC_SYSTEM, cache_control: { type: "ephemeral" } },
      {
        type: "text",
        text: dynamicSystem({ nowLabel: formatDateTime(tz, now), tz, today: formatDay(tz, now), memory: renderRecall(mem, tz, now) }),
      },
    ];

    const messages: Anthropic.MessageParam[] = [];
    for (const h of history) {
      messages.push({ role: "user", content: `[sent ${formatDateTime(tz, h.askedAt)}]\n${h.question}` });
      const cited = h.sources.length ? `\n\n(Sources for the numbers above: ${h.sources.map((s) => `[${s.id}] ${s.url}`).join(" ")})` : "";
      messages.push({ role: "assistant", content: h.answer + cited });
    }
    messages.push({ role: "user", content: message });

    // 3. Model ⇄ search loop, streaming text as it arrives.
    const registry = new SourceRegistry();
    const searches: string[] = [];
    let answer = "";
    let rounds = 0;

    for (let round = 0; round <= MAX_ROUNDS; round++) {
      const finalRound = round === MAX_ROUNDS;
      const stream = this.client.messages.stream(
        {
          model: config.model,
          max_tokens: 2500,
          system,
          tools: [WEB_SEARCH_TOOL],
          tool_choice: finalRound ? { type: "none" } : { type: "auto" },
          messages,
        },
        { signal },
      );
      let sep = answer ? "\n\n" : "";
      stream.on("text", (delta) => {
        if (firstTokenMs === null) firstTokenMs = Date.now() - t0;
        const text = sep + delta;
        sep = "";
        answer += text;
        emit({ type: "delta", text });
      });
      const final = await stream.finalMessage();
      messages.push({ role: "assistant", content: final.content });

      const toolUses = final.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      if (final.stop_reason !== "tool_use" || toolUses.length === 0) break;

      rounds++;
      const results = await Promise.all(
        toolUses.map(async (tu): Promise<Anthropic.ToolResultBlockParam> => {
          const input = tu.input as WebSearchInput;
          const ts = Date.now();
          emit({ type: "search", queries: input.queries ?? [], since: input.since, topic: input.topic });
          try {
            const r = await this.search(config.tavilyKey, input, registry, signal);
            searches.push(...r.queries);
            emit({ type: "search_done", results: registry.all().length, ms: Date.now() - ts });
            return { type: "tool_result", tool_use_id: tu.id, content: r.text };
          } catch (err) {
            return { type: "tool_result", tool_use_id: tu.id, content: `Search error: ${(err as Error).message}`, is_error: true };
          }
        }),
      );
      messages.push({ role: "user", content: results });
    }

    // 4. Persist the exchange — this *is* the long-term memory.
    const sources = registry.cited(answer);
    emit({ type: "sources", sources });
    const exchangeId = this.store.addExchange({
      conversationId: conv.id,
      askedAt: now.getTime(),
      tz,
      question: message,
      answer,
      sources,
      searches,
    });
    emit({ type: "done", exchangeId, totalMs: Date.now() - t0, firstTokenMs, searchRounds: rounds });

    // 5. Off the critical path: a dense, entity-rich note that makes this
    //    exchange easy to recall and re-check later. Failure is harmless.
    void this.writeNote(exchangeId, message, answer, tz, now).catch((e) => console.warn("[note]", e.message));
  }

  private async writeNote(id: number, question: string, answer: string, tz: string, now: Date) {
    const res = await this.client.messages.create({
      model: config.fastModel,
      max_tokens: 160,
      messages: [
        {
          role: "user",
          content: `${NOTE_PROMPT}\n\nDate: ${formatDay(tz, now)}\nUser: ${question.slice(0, 2000)}\nAssistant: ${answer.slice(0, 6000)}`,
        },
      ],
    });
    const note = res.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
    if (note) this.store.setNote(id, note);
  }
}
