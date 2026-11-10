# minimi chat agent

A chat agent with one tool, web search, built to answer fast, cite its sources, and remember **what you asked and when**, across conversations.

> "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?"
> → resolves *last Tuesday* to a date in your timezone, recalls that exchange (question, answer, sources), searches for changes since that date, and tells you what changed and what didn't.

Architecture and trade-offs: **[DESIGN.md](./DESIGN.md)**.

## Run

Requires Node 20.10+.

```bash
npm install
cp .env.example .env      # add ANTHROPIC_API_KEY and TAVILY_API_KEY
npm run dev               # → http://localhost:3000
```

Optional:

```bash
npm run seed   # adds two back-dated demo chats ("Monday": CRM shortlist, "last Tuesday": Postgres hosting)
npm test       # date resolution, recall, and the agent loop (offline, scripted model)
```

Try after seeding:
- *On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?*
- *Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?*
- *What did I ask you on Thursday?* (it should say there was nothing and point to the nearest chat)

## Layout

```
src/
  server.ts            Hono server, SSE streaming endpoint
  agent/agent.ts       the turn: recall → model ⇄ web_search → persist → async note
  agent/webSearch.ts   the one tool: parallel fan-out, `since` filter, cache, source registry
  agent/prompt.ts      cached static prompt + per-turn clock/memory block
  memory/temporal.ts   "last Tuesday" → [start, end) in the user's timezone
  memory/store.ts      SQLite + FTS5: conversations and exchanges
  memory/recall.ts     time-window + BM25 recall, rendered with timestamps
public/                vanilla JS chat UI (no build step)
scripts/seed.ts        demo history
test/                  node:test suites
```

Memory lives in `data/memory.db` (delete it to start fresh).
