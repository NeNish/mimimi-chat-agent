// Turns phrases like "last Tuesday", "on 3 November", "since Monday", "last week"
// into concrete [start, end) UTC windows in the user's timezone.
//
// Why deterministic code and not the LLM? Date arithmetic is exactly the thing
// models get subtly wrong ("last Tuesday" on a Tuesday), it costs zero latency,
// and it is unit-testable. The model still sees the original phrase and the
// resolved dates, so it can reason about ambiguity in its answer.

import * as chrono from "chrono-node";
import { DAY_MS, formatDay, localMidnight, localYmd, startOfLocalDay, tzOffsetMinutes } from "../time.js";

export interface TimeRef {
  /** The phrase as the user wrote it. */
  text: string;
  /** "on" = the user means that window; "since" = from that point until now. */
  kind: "on" | "since";
  start: number;
  end: number;
  /** Human label of the resolved window, e.g. "Tue, 3 Nov 2026". */
  label: string;
}

const SINCE_RE = /\b(since|after|from)\s*$/i;

function dayRange(tz: string, at: Date): [number, number] {
  const s = startOfLocalDay(tz, at);
  return [s, startOfLocalDay(tz, new Date(s + DAY_MS + 3_600_000))];
}

function label(tz: string, start: number, end: number): string {
  const last = end - 1;
  const a = formatDay(tz, start);
  const b = formatDay(tz, last);
  return a === b ? a : `${a} – ${b}`;
}

interface Span {
  index: number;
  length: number;
}
const overlaps = (a: Span, b: Span) => a.index < b.index + b.length && b.index < a.index + a.length;

export function resolveTimeRefs(text: string, now: Date, tz: string): TimeRef[] {
  const refs: TimeRef[] = [];
  const taken: Span[] = [];
  const nowMs = now.getTime();
  const today = localYmd(tz, now);
  const todayStart = localMidnight(tz, today.y, today.m, today.d);
  const mondayOffset = (today.weekday + 6) % 7; // days since this week's Monday

  const push = (match: string, index: number, start: number, end: number) => {
    const before = text.slice(Math.max(0, index - 12), index);
    const kind = SINCE_RE.test(before) ? "since" : "on";
    const e = kind === "since" ? nowMs : Math.min(end, nowMs);
    refs.push({ text: match, kind, start, end: e, label: kind === "since" ? `${formatDay(tz, start)} → now` : label(tz, start, e) });
    taken.push({ index, length: match.length });
  };

  // 1. Ranges chrono handles poorly (it collapses "last week" to a single instant).
  const special: Array<[RegExp, () => [number, number]]> = [
    [/\b(?:in the |over the )?(?:past|last) (?:7|seven) days\b/gi, () => [nowMs - 7 * DAY_MS, nowMs]],
    [/\b(?:the )?past week\b/gi, () => [nowMs - 7 * DAY_MS, nowMs]],
    [/\blast week\b/gi, () => {
      const thisMon = localMidnight(tz, today.y, today.m, today.d - mondayOffset);
      return [localMidnight(tz, today.y, today.m, today.d - mondayOffset - 7), thisMon];
    }],
    [/\bthis week\b/gi, () => [localMidnight(tz, today.y, today.m, today.d - mondayOffset), nowMs]],
    [/\blast month\b/gi, () => [localMidnight(tz, today.y, today.m - 1, 1), localMidnight(tz, today.y, today.m, 1)]],
    [/\bthis month\b/gi, () => [localMidnight(tz, today.y, today.m, 1), nowMs]],
    [/\b(?:earlier )?today\b|\bthis (?:morning|afternoon|evening)\b|\bearlier\b(?! than)/gi, () => [todayStart, nowMs]],
  ];
  for (const [re, range] of special) {
    for (const m of text.matchAll(re)) {
      const span = { index: m.index!, length: m[0].length };
      if (taken.some((t) => overlaps(t, span))) continue;
      const [s, e] = range();
      push(m[0], m.index!, s, e);
    }
  }

  // 2. Everything else via chrono, interpreted in the user's timezone.
  const results = chrono.parse(text, { instant: now, timezone: tzOffsetMinutes(tz, now) });
  for (const r of results) {
    const span = { index: r.index, length: r.text.length };
    if (taken.some((t) => overlaps(t, span))) continue;

    let at = r.start.date();
    const c = (k: Parameters<typeof r.start.isCertain>[0]) => r.start.isCertain(k);

    // Memory questions are about the past: "on Friday" said on a Tuesday means
    // last Friday, "on 20 December" said in November means last December.
    if (at.getTime() > nowMs) {
      if (c("weekday") && !c("day")) at = new Date(at.getTime() - 7 * DAY_MS);
      else if (!c("year")) {
        const shifted = new Date(at);
        shifted.setUTCFullYear(shifted.getUTCFullYear() - 1);
        at = shifted;
      }
    }
    if (at.getTime() > nowMs) continue; // genuinely about the future: not a memory reference

    let start: number;
    let end: number;
    if (c("day") || c("weekday") || !c("month")) {
      [start, end] = dayRange(tz, at);
    } else {
      // Month without a day, e.g. "in October".
      const { y, m } = localYmd(tz, at);
      start = localMidnight(tz, y, m, 1);
      end = localMidnight(tz, y, m + 1, 1);
    }
    if (r.end) end = Math.max(end, dayRange(tz, r.end.date())[1]);
    push(r.text, r.index, start, end);
  }

  return refs.sort((a, b) => a.start - b.start);
}
