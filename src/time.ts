// Timezone-aware helpers. Everything is stored as UTC epoch ms; the user's IANA
// timezone is applied only when we (a) resolve "Monday" to a day boundary and
// (b) render timestamps back to the model/user. No date library: Intl is enough.

export const DAY_MS = 86_400_000;

/** Offset of `tz` from UTC, in minutes, at `at` (DST-correct). */
export function tzOffsetMinutes(tz: string, at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60_000);
}

/** Local calendar date (Y, M0, D) of an instant in `tz`. */
export function localYmd(tz: string, at: Date): { y: number; m: number; d: number; weekday: number } {
  const local = new Date(at.getTime() + tzOffsetMinutes(tz, at) * 60_000);
  return { y: local.getUTCFullYear(), m: local.getUTCMonth(), d: local.getUTCDate(), weekday: local.getUTCDay() };
}

/** UTC instant of local midnight for a local calendar date in `tz`. */
export function localMidnight(tz: string, y: number, m: number, d: number): number {
  const guess = Date.UTC(y, m, d);
  // Two passes handle the (rare) case where the offset differs across the guess.
  let t = guess - tzOffsetMinutes(tz, new Date(guess)) * 60_000;
  t = guess - tzOffsetMinutes(tz, new Date(t)) * 60_000;
  return t;
}

export function startOfLocalDay(tz: string, at: Date): number {
  const { y, m, d } = localYmd(tz, at);
  return localMidnight(tz, y, m, d);
}

/** YYYY-MM-DD in the user's timezone (what the search API expects). */
export function isoDate(tz: string, at: Date | number): string {
  const { y, m, d } = localYmd(tz, new Date(at));
  return `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function formatDay(tz: string, at: Date | number): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(at));
}

export function formatDateTime(tz: string, at: Date | number): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  }).format(new Date(at));
}

/** "today", "yesterday", "6 days ago", "3 weeks ago" — counted in local calendar days. */
export function relativeDays(tz: string, then: number, now: number): string {
  const days = Math.round((startOfLocalDay(tz, new Date(now)) - startOfLocalDay(tz, new Date(then))) / DAY_MS);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  return `${Math.round(days / 30)} months ago`;
}

export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
