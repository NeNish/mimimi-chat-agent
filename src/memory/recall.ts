// Recall = deterministic retrieval of past exchanges, run *before* the model is
// called, in ~1ms. Two signals, merged:
//   1. WHEN — explicit time references resolved to windows ("last Tuesday").
//   2. WHAT — keyword (BM25) match of this message against every past exchange.
// The result is rendered as a dated, citable block in the system prompt. Memory
// is context, not a tool: the model never has to "decide" to remember, and we
// keep the one-tool contract (web search) intact.

import type { Exchange, MemoryStore } from "./store.js";
import { resolveTimeRefs, type TimeRef } from "./temporal.js";
import { formatDateTime, isoDate, relativeDays } from "../time.js";

export interface RecalledItem {
  exchange: Exchange;
  why: string[]; // e.g. ["asked last Tuesday", "topic match"]
}

export interface Recall {
  timeRefs: TimeRef[];
  items: RecalledItem[];
  /** Time windows the user referenced that contain no exchanges. */
  emptyWindows: Array<{ ref: TimeRef; before: Exchange | null; after: Exchange | null }>;
}

export interface RecallOptions {
  conversationId: string;
  /** Exchanges already in the model's chat history; no need to repeat them. */
  excludeIds: Set<number>;
  now: Date;
  tz: string;
  maxItems?: number;
}

export function recall(store: MemoryStore, message: string, o: RecallOptions): Recall {
  const max = o.maxItems ?? 8;
  const timeRefs = resolveTimeRefs(message, o.now, o.tz);
  const found = new Map<number, RecalledItem>();
  const add = (e: Exchange, why: string) => {
    if (o.excludeIds.has(e.id)) return;
    const item = found.get(e.id) ?? { exchange: e, why: [] };
    if (!item.why.includes(why)) item.why.push(why);
    found.set(e.id, item);
  };
  const emptyWindows: Recall["emptyWindows"] = [];

  for (const ref of timeRefs) {
    // "since X" is a change-window for the *web*, not a memory window; the
    // memory the user means is what was discussed *on* X.
    const start = ref.start;
    const end = ref.kind === "since" ? Math.min(ref.end, start + 86_400_000) : ref.end;
    const inWindow = store.inWindow(start, end);
    // A window with many exchanges: keep the ones that match the topic first.
    const topical = inWindow.length > 6 ? store.search(message, 6, { start, end }) : [];
    for (const e of [...topical, ...inWindow].slice(0, 10)) add(e, `asked ${ref.text.trim()}`);
    if (inWindow.length === 0) emptyWindows.push({ ref, ...store.nearest(start, end) });
  }

  for (const e of store.search(message, 6)) add(e, "topic match");

  // Exchanges matching both time and topic first, then chronological.
  const items = [...found.values()]
    .sort((a, b) => b.why.length - a.why.length || a.exchange.askedAt - b.exchange.askedAt)
    .slice(0, max)
    .sort((a, b) => a.exchange.askedAt - b.exchange.askedAt);

  return { timeRefs, items, emptyWindows };
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n).trimEnd() + " …[truncated]" : s);

/** Render recall for the system prompt. Every fact carries its timestamp. */
export function renderRecall(r: Recall, tz: string, now: Date): string {
  const nowMs = now.getTime();
  const lines: string[] = [];

  if (r.timeRefs.length) {
    lines.push("Time references in the user's message, resolved in their timezone:");
    for (const t of r.timeRefs) {
      lines.push(`- "${t.text.trim()}" → ${t.label}${t.kind === "since" ? " (a change window)" : ""}`);
    }
  }
  for (const w of r.emptyWindows) {
    const near = [
      w.before && `closest earlier: ${formatDateTime(tz, w.before.askedAt)} — "${clip(w.before.question, 80)}"`,
      w.after && `closest later: ${formatDateTime(tz, w.after.askedAt)} — "${clip(w.after.question, 80)}"`,
    ].filter(Boolean);
    lines.push(
      `- NO stored exchanges in "${w.ref.text.trim()}" (${w.ref.label}).` + (near.length ? ` ${near.join("; ")}.` : " No history at all yet."),
    );
  }

  if (!r.items.length) {
    if (lines.length) lines.push("", "No relevant past exchanges were found in memory.");
    return lines.join("\n");
  }

  lines.push("", "Relevant past exchanges (from any conversation), oldest first:");
  r.items.forEach(({ exchange: e, why }, i) => {
    const sources = e.sources
      .slice(0, 6)
      .map((s) => `${s.title} <${s.url}>${s.published ? ` (published ${s.published})` : ""}`)
      .join("; ");
    lines.push(
      "",
      `[M${i + 1}] ${formatDateTime(tz, e.askedAt)} (${relativeDays(tz, e.askedAt, nowMs)}; matched: ${why.join(", ")})`,
      `User asked: ${clip(e.question, 600)}`,
      ...(e.note ? [`Memory note: ${e.note}`] : []),
      `You answered: ${clip(e.answer, 1800)}`,
      sources ? `Sources you relied on then: ${sources}` : "Sources you relied on then: none (answered without searching)",
      `To check what changed since then, search with since="${isoDate(tz, e.askedAt)}".`,
    );
  });
  return lines.join("\n").trim();
}
