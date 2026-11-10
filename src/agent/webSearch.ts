// The agent's one tool. Design choices:
//  - `queries` is an array: the model fans out 1–4 queries in ONE tool call and
//    we run them in parallel. One round-trip instead of four is the single
//    biggest latency win for comparison questions ("5 CRM tools").
//  - `since` maps to a hard publish-date filter, so "changed since Monday" is a
//    retrieval constraint, not a hope.
//  - Results are numbered against a per-turn source registry, so citations [n]
//    stay stable across multiple search rounds and map 1:1 to the UI.

import type Anthropic from "@anthropic-ai/sdk";
import { tavilySearch, type SearchHit, type SearchParams } from "../search/tavily.js";
import type { Source } from "../memory/store.js";

export const WEB_SEARCH_TOOL: Anthropic.Tool = {
  name: "web_search",
  description:
    "Search the live web. Pass several queries at once when the question has several parts or entities " +
    "(e.g. one query per product); they run in parallel. Results include extracted page text and publish dates. " +
    "Use `since` (YYYY-MM-DD) for 'what changed since X' questions, `topic: news` for announcements/launches, " +
    "and `depth: advanced` only when you need exact figures (pricing tables, specs) the basic results lack.",
  input_schema: {
    type: "object",
    properties: {
      queries: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        maxItems: 4,
        description: "1–4 specific, keyword-style queries. Include product names, and the year for time-sensitive facts.",
      },
      topic: { type: "string", enum: ["general", "news"], description: "Default general." },
      since: { type: "string", description: "Only results published on/after this date, YYYY-MM-DD." },
      recency: { type: "string", enum: ["day", "week", "month", "year"], description: "Relative recency filter (ignored if `since` is set)." },
      depth: { type: "string", enum: ["basic", "advanced"], description: "Default basic (fast)." },
    },
    required: ["queries"],
  },
};

export interface WebSearchInput {
  queries: string[];
  topic?: "general" | "news";
  since?: string;
  recency?: "day" | "week" | "month" | "year";
  depth?: "basic" | "advanced";
}

// Small in-process cache: identical searches within 10 minutes (follow-ups,
// retries, two users asking the same thing) are free and instant.
const CACHE_TTL_MS = 10 * 60_000;
const cache = new Map<string, { at: number; hits: SearchHit[] }>();

async function cachedSearch(apiKey: string, p: SearchParams, signal?: AbortSignal): Promise<SearchHit[]> {
  const key = JSON.stringify(p);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.hits;
  const hits = await tavilySearch(apiKey, p, signal);
  cache.set(key, { at: Date.now(), hits });
  if (cache.size > 300) cache.delete(cache.keys().next().value!);
  return hits;
}

export class SourceRegistry {
  private byUrl = new Map<string, Source>();
  idFor(h: SearchHit): number {
    const url = h.url.replace(/#.*$/, "");
    let s = this.byUrl.get(url);
    if (!s) {
      s = { id: this.byUrl.size + 1, title: h.title, url, published: h.published };
      this.byUrl.set(url, s);
    }
    return s.id;
  }
  all(): Source[] {
    return [...this.byUrl.values()];
  }
  /** Only the sources the answer actually cites (falls back to all if it cites none). */
  cited(answer: string): Source[] {
    const ids = new Set([...answer.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])));
    const cited = this.all().filter((s) => ids.has(s.id));
    return cited.length ? cited : this.all().slice(0, 8);
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function runWebSearch(
  apiKey: string,
  input: WebSearchInput,
  registry: SourceRegistry,
  signal?: AbortSignal,
): Promise<{ text: string; queries: string[] }> {
  const queries = (Array.isArray(input.queries) ? input.queries : [String(input.queries)])
    .map((q) => String(q).trim())
    .filter(Boolean)
    .slice(0, 4);
  if (!queries.length) return { text: "Error: no queries given.", queries };

  const base: Omit<SearchParams, "query"> = {
    topic: input.topic === "news" ? "news" : "general",
    depth: input.depth === "advanced" ? "advanced" : "basic",
    startDate: input.since && DATE_RE.test(input.since) ? input.since : undefined,
    timeRange: input.recency,
    maxResults: 6,
  };

  const settled = await Promise.allSettled(
    queries.map((query) => cachedSearch(apiKey, { ...base, query }, AbortSignal.any([AbortSignal.timeout(12_000), ...(signal ? [signal] : [])]))),
  );

  const seen = new Set<number>();
  const blocks = settled.map((r, i) => {
    const q = queries[i];
    if (r.status === "rejected") return `### Query: ${q}\nSearch failed: ${String(r.reason?.message ?? r.reason)}`;
    if (!r.value.length) return `### Query: ${q}\nNo results${base.startDate ? ` published since ${base.startDate}` : ""}.`;
    const items = r.value.map((h) => {
      const id = registry.idFor(h);
      if (seen.has(id)) return `[${id}] (duplicate of a result above)`;
      seen.add(id);
      const host = new URL(h.url).hostname.replace(/^www\./, "");
      return `[${id}] ${h.title} — ${host}${h.published ? ` — published ${h.published}` : " — publish date unknown"}\n${h.content.slice(0, 1500)}`;
    });
    return `### Query: ${q}\n${items.join("\n\n")}`;
  });

  return { text: blocks.join("\n\n"), queries };
}
