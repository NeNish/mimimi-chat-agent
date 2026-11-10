// Persistent memory. The unit of memory is an *exchange*: one user message, the
// answer we gave, the sources we relied on, and when it happened. Storing the
// exchange (not loose messages) is what lets us answer "what did I ask on 3 Nov
// and is your answer still right?" — we have the question, the answer, the
// evidence, and the timestamp in one row.

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export interface Source {
  id: number;
  title: string;
  url: string;
  published?: string;
}

export interface Exchange {
  id: number;
  conversationId: string;
  askedAt: number;
  tz: string;
  question: string;
  answer: string;
  sources: Source[];
  searches: string[];
  note: string | null;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

interface ExchangeRow {
  id: number;
  conversation_id: string;
  asked_at: number;
  tz: string;
  question: string;
  answer: string;
  sources: string;
  searches: string;
  note: string | null;
}

const toExchange = (r: ExchangeRow): Exchange => ({
  id: r.id,
  conversationId: r.conversation_id,
  askedAt: r.asked_at,
  tz: r.tz,
  question: r.question,
  answer: r.answer,
  sources: JSON.parse(r.sources),
  searches: JSON.parse(r.searches),
  note: r.note,
});

const STOPWORDS = new Set(
  ("a an and are as at be been but by can could did do does for from had has have how i if in into is it its " +
    "me my of on or our so than that the their them then there these they this to was we were what when where " +
    "which who why will with would you your yours about any anything since still today yesterday ask asked tell " +
    "said say again last week month monday tuesday wednesday thursday friday saturday sunday january february " +
    "march april may june july august september october november december changed change correct right now " +
    "answer question us please thanks hey hi also just some more most").split(" "),
);

/** Turn a chat message into a forgiving FTS5 OR-query of its content words. */
export function ftsQuery(text: string): string | null {
  const words = [...new Set(text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}.+#-]*/gu) ?? [])]
    .map((w) => w.replace(/[.\-]+$/, ""))
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w) && !/^\d+$/.test(w));
  if (!words.length) return null;
  // Prefix match ("postgre*" hits "postgres"/"postgresql"); quote to neutralise FTS syntax.
  return words.slice(0, 12).map((w) => `"${w.replace(/"/g, "")}"*`).join(" OR ");
}

export class MemoryStore {
  readonly db: Database.Database;

  constructor(file: string) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS exchanges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id TEXT NOT NULL REFERENCES conversations(id),
        asked_at INTEGER NOT NULL,
        tz TEXT NOT NULL,
        question TEXT NOT NULL,
        answer TEXT NOT NULL,
        sources TEXT NOT NULL DEFAULT '[]',
        searches TEXT NOT NULL DEFAULT '[]',
        note TEXT
      );
      CREATE INDEX IF NOT EXISTS exchanges_asked_at ON exchanges(asked_at);
      CREATE INDEX IF NOT EXISTS exchanges_conv ON exchanges(conversation_id, asked_at);

      CREATE VIRTUAL TABLE IF NOT EXISTS exchanges_fts USING fts5(
        question, answer, note, content='exchanges', content_rowid='id', tokenize='porter unicode61'
      );
      CREATE TRIGGER IF NOT EXISTS exchanges_ai AFTER INSERT ON exchanges BEGIN
        INSERT INTO exchanges_fts(rowid, question, answer, note) VALUES (new.id, new.question, new.answer, coalesce(new.note, ''));
      END;
      CREATE TRIGGER IF NOT EXISTS exchanges_au AFTER UPDATE ON exchanges BEGIN
        INSERT INTO exchanges_fts(exchanges_fts, rowid, question, answer, note) VALUES ('delete', old.id, old.question, old.answer, coalesce(old.note, ''));
        INSERT INTO exchanges_fts(rowid, question, answer, note) VALUES (new.id, new.question, new.answer, coalesce(new.note, ''));
      END;
    `);
  }

  createConversation(id: string, title: string, at: number): Conversation {
    this.db.prepare("INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)").run(id, title, at, at);
    return { id, title, createdAt: at, updatedAt: at };
  }

  getConversation(id: string): Conversation | null {
    const r = this.db.prepare("SELECT * FROM conversations WHERE id = ?").get(id) as any;
    return r ? { id: r.id, title: r.title, createdAt: r.created_at, updatedAt: r.updated_at } : null;
  }

  listConversations(): Conversation[] {
    return (this.db.prepare("SELECT * FROM conversations ORDER BY updated_at DESC LIMIT 100").all() as any[]).map((r) => ({
      id: r.id,
      title: r.title,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  addExchange(e: Omit<Exchange, "id" | "note">): number {
    const tx = this.db.transaction(() => {
      const { lastInsertRowid } = this.db
        .prepare(
          "INSERT INTO exchanges (conversation_id, asked_at, tz, question, answer, sources, searches) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(e.conversationId, e.askedAt, e.tz, e.question, e.answer, JSON.stringify(e.sources), JSON.stringify(e.searches));
      this.db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(e.askedAt, e.conversationId);
      return Number(lastInsertRowid);
    });
    return tx();
  }

  setNote(id: number, note: string) {
    this.db.prepare("UPDATE exchanges SET note = ? WHERE id = ?").run(note, id);
  }

  /** Last `limit` exchanges of a conversation, oldest first. */
  recentInConversation(conversationId: string, limit: number): Exchange[] {
    const rows = this.db
      .prepare("SELECT * FROM exchanges WHERE conversation_id = ? ORDER BY asked_at DESC, id DESC LIMIT ?")
      .all(conversationId, limit) as ExchangeRow[];
    return rows.reverse().map(toExchange);
  }

  inWindow(start: number, end: number, limit = 25): Exchange[] {
    return (
      this.db.prepare("SELECT * FROM exchanges WHERE asked_at >= ? AND asked_at < ? ORDER BY asked_at LIMIT ?").all(start, end, limit) as ExchangeRow[]
    ).map(toExchange);
  }

  /** Closest exchanges before and after a window — used to say "nothing on Monday, but on Tuesday you asked…". */
  nearest(start: number, end: number): { before: Exchange | null; after: Exchange | null } {
    const b = this.db.prepare("SELECT * FROM exchanges WHERE asked_at < ? ORDER BY asked_at DESC LIMIT 1").get(start) as ExchangeRow | undefined;
    const a = this.db.prepare("SELECT * FROM exchanges WHERE asked_at >= ? ORDER BY asked_at LIMIT 1").get(end) as ExchangeRow | undefined;
    return { before: b ? toExchange(b) : null, after: a ? toExchange(a) : null };
  }

  /** Keyword recall across all conversations, BM25-ranked (question matches weigh most). */
  search(text: string, limit = 5, window?: { start: number; end: number }): Exchange[] {
    const q = ftsQuery(text);
    if (!q) return [];
    const timeClause = window ? "AND e.asked_at >= @start AND e.asked_at < @end" : "";
    const rows = this.db
      .prepare(
        `SELECT e.* FROM exchanges_fts f JOIN exchanges e ON e.id = f.rowid
         WHERE exchanges_fts MATCH @q ${timeClause}
         ORDER BY bm25(exchanges_fts, 4.0, 1.0, 2.0) LIMIT @limit`,
      )
      .all({ q, limit, ...(window ?? {}) }) as ExchangeRow[];
    return rows.map(toExchange);
  }

  count(): number {
    return (this.db.prepare("SELECT count(*) AS n FROM exchanges").get() as { n: number }).n;
  }
}
