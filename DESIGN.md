# DESIGN

## How it works

```
user message
   │
   ├─► 1. Recall (SQLite, ~1 ms, no LLM)
   │      • resolve "last Tuesday" / "on 3 Nov" / "since Monday" → exact windows in the user's timezone
   │      • fetch exchanges in those windows + BM25 topic matches across ALL past chats
   │      • render a dated memory block: question, answer, sources used, "since=YYYY-MM-DD" hint
   │      • if a window is empty, say so and name the nearest exchanges
   │
   ├─► 2. One model call (streams) with: cached static prompt + clock + memory + last 10 turns
   │      └─ may call web_search({queries[1..4], since?, topic?, depth?}) → parallel Tavily fan-out,
   │         10-min cache, globally numbered sources → model answers with [n] citations (≤3 rounds)
   │
   ├─► 3. Persist the exchange {question, answer, cited sources, queries, timestamp, tz}
   └─► 4. Async (off the critical path): fast model writes an entity-dense memory note, indexed in FTS
```

~1,000 lines of TypeScript + ~200 of UI JS: `src/memory/*` (temporal resolution, store, recall), `src/agent/*` (loop, tool, prompt), `public/` (vanilla JS UI streaming over SSE).

## Why this way

**Memory is context, not a tool.** The hard examples ("what did I ask on 3 Nov?", "the 5 CRMs we shortlisted Monday") are about *time*. I resolve dates in code before the model runs: it costs no extra round trip, the model can't forget to look, and the brief's one-tool limit holds. Date maths is exactly where LLMs slip ("last Tuesday" said on a Tuesday), so it's deterministic, timezone-correct (DST-safe via `Intl`) and unit-tested.

**The unit of memory is an exchange, not a message.** Each row holds the question, the answer, the sources it relied on, and when it was asked. That's what "is your answer still correct today?" needs: what I said, why I said it, and the date to diff from. Recall hands the model a ready `since="2026-11-03"` for the search tool.

**Honest about gaps.** If the user names a day with no conversation, the memory block says *NO stored exchanges* and lists the nearest ones. That turns a likely made-up answer into "Nothing on Thursday. On Tuesday you asked about…".

**Search is shaped for agents.** `queries` is an array, so a 5-product comparison takes one tool call run in parallel, not five sequential rounds. `since` is a hard publish-date filter (Tavily `start_date`), so "changed since Monday" is enforced by retrieval rather than left to the model. Results carry publish dates and extracted text, and sources are numbered per turn so citations stay stable across rounds and map to UI chips.

**Fast by construction.** One model call decides whether to search, so there's no separate router hop. Text streams token by token, with live status ("Searching: …") before the first token. The static system prompt is prompt-cached. Recall is local. Search defaults to `basic` depth, uses a TTL cache and is capped at 3 rounds before a forced answer. Memory notes are written after the response is sent. The UI shows first-token and total latency on every answer, so speed stays visible.

**Right over fluent.** The prompt asks for primary sources (pricing pages, changelogs), as-of dates on time-sensitive facts, citations only from returned results, explicit *then → now* comparisons, and saying "couldn't verify" instead of guessing.

**Hand-written loop (~100 lines), no framework.** Every latency and context decision is visible, testable (the loop is tested offline with a scripted model) and explainable.

## Considered and rejected

- **`search_memory` as a second tool.** It adds a round trip, the model sometimes skips it, and it breaks the one-tool brief.
- **Embeddings / vector DB.** That's another API key and more latency. Questions about past chats are dominated by dates and named entities, where windows + BM25 + entity-rich notes do well. Vague references ("that thing") are the gap; see below.
- **Stuffing all history into context.** Cost and latency grow every turn, recall degrades in the middle of long contexts, and it doesn't cover other conversations.
- **A planner/router call before answering.** It adds 0.5–1 s to every turn, including the ones that need no search.
- **The provider's built-in server-side web search.** It's simplest, but I'd lose the hard date filter, caching, result shaping and stable source numbering.
- **A page-fetch tool.** It would be a second tool. `depth: advanced` returns denser chunks when exact figures are needed.

## With another week

1. **Evals first.** A scripted dataset of back-dated conversations + follow-ups ("since Monday…"), scored for date resolution, recall hit-rate, citation validity and judged answer quality, plus p50/p95 latency in CI. Tune prompts against numbers, not vibes.
2. **Snapshot evidence at answer time.** Store the key figures and a content hash per source, so "has pricing changed?" becomes a real diff against what we saw, not a re-inference.
3. **Hybrid recall.** Add embeddings next to BM25, plus a cheap query rewrite for vague references ("the database thing from before").
4. **Speculative search.** A tiny classifier starts obvious searches in parallel with the first model call, which cuts a full model hop from search-heavy turns.
5. **Product.** Multi-user auth and per-user stores (Postgres), "watch this answer" re-checks that notify on change, source-quality scoring.
