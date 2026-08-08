/**
 * chita SqliteIndex — index layer over the JSONL tape (v2.1 §2.7)
 *
 * The tape is the single source of truth; SQLite is only a query index
 * (sessions/messages/tool_calls + FTS5). Using bun:sqlite (N3 verdict:
 * better-sqlite3 × Bun compile panics; bun:sqlite works).
 */

import { Database } from "bun:sqlite";
import { join, dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { SESSIONS_ROOT } from "./tape.ts";
import type { TraceEvent } from "./trace.ts";

export interface IndexedEvent {
  seq: number;
  type: string;
  role: string | null;
  content: string | null;
  toolName: string | null;
  faultSide: string | null;
  ts: string;
}

export class SqliteIndex {
  private db: Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath, { create: true });
    this.migrate();
  }

  /** Default per-cwd index path: ~/.chita/agent/sessions/--<cwd>/index.db */
  static forCwd(cwd: string): SqliteIndex {
    const key = "--" + cwd.replace(/\//g, "-").replace(/[^a-zA-Z0-9._-]/g, "_");
    const dir = join(SESSIONS_ROOT, key);
    const { mkdirSync } = require("node:fs");
    mkdirSync(dir, { recursive: true });
    return new SqliteIndex(join(dir, "index.db"));
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        seq INTEGER PRIMARY KEY,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        role TEXT,
        content TEXT,
        tool_name TEXT,
        fault_side TEXT,
        ts TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(content, seq);
      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
      CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(ts);
    `);
  }

  /** Index a batch of events for one session (idempotent by seq) */
  indexEvents(sessionId: string, events: TraceEvent[]): void {
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO messages (seq, session_id, type, role, content, tool_name, fault_side, ts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertFts = this.db.prepare(
      `INSERT OR IGNORE INTO messages_fts (content, seq) VALUES (?, ?)`
    );
    this.db.transaction(() => {
      for (const ev of events) {
        const row = toRow(ev);
        insert.run(row.seq, sessionId, row.type, row.role, row.content, row.toolName, row.faultSide, row.ts);
        if (row.content) insertFts.run(row.content, row.seq);
      }
    })();
  }

  /** FTS5 full-text search across messages (Hermes benchmark: 5-80ms) */
  search(query: string, limit = 20): IndexedEvent[] {
    const rows = this.db
      .query(
        `SELECT m.* FROM messages_fts f JOIN messages m ON m.seq = f.seq
         WHERE messages_fts MATCH ? ORDER BY m.ts DESC LIMIT ?`
      )
      .all(query, limit) as unknown as IndexedEvent[];
    return rows;
  }

  /** Recent sessions (for resume listing) */
  recentSessions(limit = 10): { sessionId: string; lastTs: string }[] {
    const rows = this.db
      .query(
        `SELECT session_id AS sessionId, MAX(ts) as lastTs FROM messages
         GROUP BY session_id ORDER BY lastTs DESC LIMIT ?`
      )
      .all(limit) as unknown as { sessionId: string; lastTs: string }[];
    return rows;
  }

  close(): void {
    this.db.close();
  }
}

function toRow(ev: TraceEvent): IndexedEvent {
  const base = {
    seq: ev.seq,
    type: ev.type,
    ts: ev.ts,
    faultSide: ev.faultSide ?? null,
  };
  switch (ev.type) {
    case "message":
      return { ...base, role: ev.role, content: ev.content, toolName: null };
    case "tool_call":
      return { ...base, role: "tool", content: null, toolName: ev.tool.name };
    case "tool_result":
      return { ...base, role: "tool", content: ev.output ?? ev.error ?? null, toolName: ev.toolName };
    case "error":
      return { ...base, role: null, content: ev.message, toolName: null };
    case "done":
      return { ...base, role: null, content: ev.summary ?? null, toolName: null };
    default:
      return { ...base, role: null, content: null, toolName: null };
  }
}
