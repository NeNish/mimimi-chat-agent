// Thin Tavily client. Chosen because it returns LLM-ready extracted page text
// (not just 160-char snippets), exposes publish dates, and supports a hard
// start_date filter — which is what "has anything changed since Monday?" needs.

export interface SearchParams {
  query: string;
  topic?: "general" | "news";
  depth?: "basic" | "advanced";
  timeRange?: "day" | "week" | "month" | "year";
  startDate?: string; // YYYY-MM-DD
  maxResults?: number;
}

export interface SearchHit {
  title: string;
  url: string;
  content: string;
  published?: string;
  score: number;
}

/** Tavily returns RFC-1123 dates for news and ISO-ish for others; normalise to YYYY-MM-DD. */
function normaliseDate(v: unknown): string | undefined {
  if (!v) return undefined;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString().slice(0, 10);
}

export async function tavilySearch(apiKey: string, p: SearchParams, signal?: AbortSignal): Promise<SearchHit[]> {
  const body: Record<string, unknown> = {
    query: p.query,
    topic: p.topic ?? "general",
    search_depth: p.depth ?? "basic",
    max_results: p.maxResults ?? 6,
    include_answer: false, // we want evidence, not someone else's summary
    include_raw_content: false,
  };
  // Tavily rejects time_range together with start_date; the explicit date wins.
  if (p.startDate) body.start_date = p.startDate;
  else if (p.timeRange) body.time_range = p.timeRange;
  if (p.depth === "advanced") body.chunks_per_source = 3;

  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Tavily ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as { results?: any[] };
  return (json.results ?? []).map((r) => ({
    title: String(r.title ?? r.url),
    url: String(r.url),
    content: String(r.content ?? ""),
    published: normaliseDate(r.published_date),
    score: Number(r.score ?? 0),
  }));
}
