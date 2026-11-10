import assert from "node:assert/strict";
import { test } from "node:test";
import { recall, renderRecall } from "../src/memory/recall.js";
import { MemoryStore, ftsQuery } from "../src/memory/store.js";
import { resolveTimeRefs } from "../src/memory/temporal.js";
import { isoDate } from "../src/time.js";

// Tuesday 10 Nov 2026, 21:22 in Kolkata.
const NOW = new Date("2026-11-10T15:52:00Z");
const IST = "Asia/Kolkata";
const LA = "America/Los_Angeles";

const one = (text: string, tz = IST) => {
  const refs = resolveTimeRefs(text, NOW, tz);
  assert.equal(refs.length, 1, `expected one ref in "${text}", got ${JSON.stringify(refs)}`);
  return { ...refs[0], day: isoDate(tz, refs[0].start), lastDay: isoDate(tz, refs[0].end - 1) };
};

test("explicit date", () => {
  const r = one("What did I ask you on 3 November? Is your answer still correct today?".split("?")[0]);
  assert.equal(r.day, "2026-11-03");
  assert.equal(r.lastDay, "2026-11-03");
});

test("'last Tuesday' said on a Tuesday is a week ago, not today", () => {
  assert.equal(one("Last Tuesday I asked you about Postgres hosting").day, "2026-11-03");
});

test("bare weekday refers to the past", () => {
  assert.equal(one("On Monday we shortlisted 5 CRM tools").day, "2026-11-09");
  assert.equal(one("what did we discuss on Friday").day, "2026-11-06");
});

test("relative days and today", () => {
  assert.equal(one("what did I ask yesterday").day, "2026-11-09");
  assert.equal(one("3 days ago you told me").day, "2026-11-07");
  const t = one("what did I ask earlier today");
  assert.equal(t.day, "2026-11-10");
  assert.equal(t.end, NOW.getTime());
});

test("week and month ranges", () => {
  const w = one("last week we talked about CRMs");
  assert.equal(w.day, "2026-11-02"); // Monday
  assert.equal(w.lastDay, "2026-11-08"); // Sunday
  const m = one("in October I asked about pricing");
  assert.equal(m.day, "2026-10-01");
  assert.equal(m.lastDay, "2026-10-31");
});

test("'since' becomes a change window up to now", () => {
  const s = one("has anything changed since Monday");
  assert.equal(s.kind, "since");
  assert.equal(s.day, "2026-11-09");
  assert.equal(s.end, NOW.getTime());
});

test("timezone decides which day it is", () => {
  // 15:52 UTC is still the morning of Tue 10 Nov in LA; yesterday = Mon 9 Nov there too,
  // but day boundaries are LA midnights.
  const r = resolveTimeRefs("yesterday", NOW, LA)[0];
  assert.equal(isoDate(LA, r.start), "2026-11-09");
  assert.equal(new Date(r.start).toISOString(), "2026-11-09T08:00:00.000Z");
});

test("no time reference → nothing", () => {
  assert.deepEqual(resolveTimeRefs("compare Neon and Supabase pricing", NOW, IST), []);
});

test("fts query ignores filler and is injection-safe", () => {
  assert.equal(ftsQuery("what did I ask you?"), null);
  assert.equal(ftsQuery('Postgres "hosting" OR'), '"postgres"* OR "hosting"*');
});

function seeded() {
  const s = new MemoryStore(":memory:");
  const at = (iso: string) => new Date(iso).getTime();
  s.createConversation("a", "crm", at("2026-11-09T05:30:00Z"));
  s.addExchange({ conversationId: "a", askedAt: at("2026-11-09T05:30:00Z"), tz: IST, question: "Shortlist 5 CRM tools for a 20-person sales team", answer: "HubSpot, Pipedrive, Salesforce, Zoho CRM, Close", sources: [{ id: 1, title: "Pipedrive pricing", url: "https://pipedrive.com/pricing" }], searches: [] });
  s.createConversation("b", "pg", at("2026-11-03T09:30:00Z"));
  s.addExchange({ conversationId: "b", askedAt: at("2026-11-03T09:30:00Z"), tz: IST, question: "What does managed Postgres hosting cost?", answer: "Neon, Supabase, RDS…", sources: [], searches: [] });
  s.createConversation("c", "node", at("2026-11-10T10:00:00Z"));
  s.addExchange({ conversationId: "c", askedAt: at("2026-11-10T10:00:00Z"), tz: IST, question: "Latest Node.js LTS?", answer: "Node 24", sources: [], searches: [] });
  return s;
}

const ctx = { conversationId: "new", excludeIds: new Set<number>(), now: NOW, tz: IST };

test("recall by date finds the exchange from another conversation", () => {
  const r = recall(seeded(), "What did I ask you on 3 November? Is your answer still correct today?", ctx);
  assert.ok(r.items.some((i) => i.exchange.question.includes("Postgres")));
  assert.ok(renderRecall(r, IST, NOW).includes('since="2026-11-03"'));
});

test("recall by weekday + topic ranks the double match", () => {
  const r = recall(seeded(), "On Monday we shortlisted 5 CRM tools. Has any of them changed pricing since?", ctx);
  assert.equal(r.items[0].exchange.conversationId, "a");
  assert.ok(r.items[0].why.length >= 2);
});

test("recall by topic alone", () => {
  const r = recall(seeded(), "has postgres hosting pricing moved?", ctx);
  assert.equal(r.items[0]?.exchange.conversationId, "b");
});

test("empty window is reported honestly with the nearest neighbours", () => {
  const r = recall(seeded(), "what did I ask you on Thursday?", ctx);
  assert.equal(r.emptyWindows.length, 1);
  const text = renderRecall(r, IST, NOW);
  assert.match(text, /NO stored exchanges/);
  assert.match(text, /closest earlier: .*Postgres/);
});

test("exchanges already in the chat window are not repeated", () => {
  const s = seeded();
  const r = recall(s, "CRM pricing", { ...ctx, excludeIds: new Set([1]) });
  assert.ok(!r.items.some((i) => i.exchange.id === 1));
});
