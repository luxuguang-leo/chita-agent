/**
 * chita session tree (v2.1 §2.7, Pi session-tree semantics)
 *
 * Sessions form a tree via parentId. fork() creates a child that inherits
 * the parent's tape prefix; branch_summary records WHY the branch was taken
 * and what happened there, so leaving the branch can bring conclusions back
 * to the mainline (Pi: "总结成上下文再带回主线").
 *
 * Layout: ~/.chita/agent/sessions/--<cwd>/*.jsonl (tape) + tree metadata in
 * each tape's __meta header.
 */

import { existsSync, readdirSync, readFileSync, openSync, writeSync, closeSync } from "node:fs";
import { join } from "node:path";
import { tapePaths, cwdKey, SESSIONS_ROOT, Tape } from "./tape.ts";
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
 * Record the conclusion of a branch back to its parent (Pi: "分支总结带回主线").
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
