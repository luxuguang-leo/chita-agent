/**
 * chita session tree (v2.1 §2.7, Pi session-tree semantics)
 *
 * Sessions form a tree via parentId. fork() creates a child that inherits
 * the parent's tape prefix; branch_summary records WHY the branch was taken
 * and what happened there, so leaving the branch can bring conclusions back
 * to the mainline (Pi: "summarize into context and carry it back to the mainline").
 *
 * Layout: ~/.chita/agent/sessions/--<cwd>/*.jsonl (tape) + tree metadata in
 * each tape's __meta header.
 */

import { existsSync, readdirSync, readFileSync, openSync, writeSync, closeSync, statSync } from "node:fs";
import { join } from "node:path";
import { tapePaths, cwdKey, SESSIONS_ROOT, Tape, liveHolderPid } from "./tape.ts";
import type { SessionMeta } from "./trace.ts";

export interface BranchInfo {
  sessionId: string;
  parentId: string;
  /** Why this branch was taken / what was explored (set when leaving) */
  branchSummary: string;
  createdAt: string;
}

export interface SessionNode {
  sessionId: string;
  parentId?: string;
  branchSummary?: string;
  createdAt?: string;
  children: SessionNode[];
}

/**
 * Fork with branch metadata: creates a child tape, records parentId + a
 * summary of why we branched (for later merge-back). Meta is written as the
 * FIRST line (readSessionMeta reads line 1), so the child tape is rebuilt as
 * meta line + inherited events.
 */
export function forkWithSummary(
  parent: Tape,
  childId: string,
  reason: string,
  meta: Omit<SessionMeta, "sessionId" | "parentId">
): Tape {
  const child = parent.fork(childId);
  const parentId = parent.readMeta()?.sessionId ?? "";
  const fullMeta: SessionMeta = {
    ...meta,
    sessionId: childId,
    parentId,
    branchSummary: reason,
  };
  const events = child.readAll();
  child.close(); // release lock before reopening
  const fd = openSync(child.paths.tape, "w");
  writeSync(fd, JSON.stringify({ __meta: fullMeta }) + "\n");
  for (const ev of events) writeSync(fd, JSON.stringify(ev) + "\n");
  closeSync(fd);
  return Tape.open(meta.cwd, childId, parent.sessionsRoot);
}

/** Read a session's meta header (parentId + branchSummary) */
export function readSessionMeta(cwd: string, sessionId: string, root = SESSIONS_ROOT): SessionMeta | null {
  const { tape } = tapePaths(cwd, sessionId, root);
  if (!existsSync(tape)) return null;
  const first = readFileSync(tape, "utf-8").split("\n")[0];
  if (!first.trim()) return null;
  try {
    const obj = JSON.parse(first);
    return obj.__meta ?? null;
  } catch {
    return null;
  }
}

/** List all sessions for a cwd (tree building input) */
export function listSessions(cwd: string, root = SESSIONS_ROOT): { sessionId: string; meta: SessionMeta | null }[] {
  const dir = join(root, cwdKey(cwd));
  if (!existsSync(dir)) return [];
  const result: { sessionId: string; meta: SessionMeta | null }[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".jsonl") || f.startsWith(".")) continue;
    const sessionId = f.slice(0, -".jsonl".length);
    result.push({ sessionId, meta: readSessionMeta(cwd, sessionId, root) });
  }
  return result;
}

/** Build the session tree for a cwd (root = sessions with no parentId) */
export function buildSessionTree(cwd: string, root = SESSIONS_ROOT): SessionNode[] {
  const sessions = listSessions(cwd, root);
  const byId = new Map<string, SessionNode>();
  for (const s of sessions) {
    byId.set(s.sessionId, {
      sessionId: s.sessionId,
      parentId: s.meta?.parentId,
      branchSummary: s.meta?.branchSummary,
      createdAt: s.meta?.createdAt,
      children: [],
    });
  }
  const roots: SessionNode[] = [];
  for (const node of byId.values()) {
    if (node.parentId && byId.has(node.parentId)) {
      byId.get(node.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

/**
 * Record the conclusion of a branch back to its parent (Pi: "carry the branch summary back to the mainline").
 * Appends a system message with the branch summary to the PARENT's tape.
 */
export function mergeBranchBack(cwd: string, childId: string, parentId: string, conclusion: string, root = SESSIONS_ROOT): void {
  const parent = readSessionMeta(cwd, parentId, root);
  if (!parent) throw new Error(`parent session ${parentId} not found`);
  const { tape } = tapePaths(cwd, parentId, root);
  // Append-only: add a branch-conclusion line (marked, not a regular event)
  const line = JSON.stringify({
    __branch_conclusion: { childId, conclusion, at: new Date().toISOString() },
  });
  const fd = openSync(tape, "a");
  writeSync(fd, line + "\n");
  closeSync(fd);
}

/** Collapse whitespace + truncate to a one-line topic. Empty when the text is
 *  blank or a slash command (a `/help`/`/new` first line is not a topic —
 *  cursor finding #3). */
export function summarizeTopic(text: string, max = 60): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t || t.startsWith("/")) return "";
  return t.length > max ? t.slice(0, max) + "…" : t;
}

/** First real user message (not a slash command) in a tape — lazy fallback
 *  for legacy sessions without a persisted topic. Reads line-by-line and
 *  stops at the first match (never the whole tape). */
function firstUserMessage(cwd: string, sessionId: string, root = SESSIONS_ROOT): string {
  const { tape } = tapePaths(cwd, sessionId, root);
  if (!existsSync(tape)) return "";
  try {
    for (const line of readFileSync(tape, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line) as { __meta?: unknown; type?: string; role?: string; content?: string };
        if (obj.__meta) continue;
        if (obj.type === "message" && obj.role === "user") {
          const t = summarizeTopic(obj.content ?? "");
          if (t) return t;
        }
      } catch {
        // skip malformed line
      }
    }
  } catch {
    return "";
  }
  return "";
}

/** One-line topic for a session (for listing): meta.topic → branchSummary →
 *  first real user message (legacy fallback). */
export function sessionTopic(cwd: string, sessionId: string, root = SESSIONS_ROOT): string {
  const meta = readSessionMeta(cwd, sessionId, root);
  if (meta?.topic) return meta.topic;
  if (meta?.branchSummary) return meta.branchSummary;
  return firstUserMessage(cwd, sessionId, root);
}

export interface SessionEntry {
  sessionId: string;
  topic: string;
  createdAt?: string;
  /** Tape mtime (last activity) as ISO — drives the picker sort. */
  lastActiveAt?: string;
  /** True when another live chita holds the session lock. */
  locked: boolean;
}

/** Sessions for a cwd, newest-activity first, with topic + lock status. */
export function listRecentSessions(cwd: string, limit = 20, root = SESSIONS_ROOT): SessionEntry[] {
  const dir = join(root, cwdKey(cwd));
  if (!existsSync(dir)) return [];
  const entries: SessionEntry[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".jsonl")) continue;
    const sessionId = f.slice(0, -".jsonl".length);
    const { tape } = tapePaths(cwd, sessionId, root);
    let lastActiveAt: string | undefined;
    try {
      lastActiveAt = new Date(statSync(tape).mtimeMs).toISOString();
    } catch {
      // unreadable tape — skip
    }
    entries.push({
      sessionId,
      topic: sessionTopic(cwd, sessionId, root),
      createdAt: readSessionMeta(cwd, sessionId, root)?.createdAt,
      lastActiveAt,
      locked: liveHolderPid(cwd, sessionId, root) !== null,
    });
  }
  entries.sort((a, b) => (b.lastActiveAt ?? "").localeCompare(a.lastActiveAt ?? ""));
  return entries.slice(0, limit);
}

/** Human age label for a timestamp (shared by the TUI + the CLI picker). */
export function formatAge(iso?: string): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}
