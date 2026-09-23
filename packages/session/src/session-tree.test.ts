/**
 * session tree tests (v2.1 §2.7, Pi session-tree semantics)
 *
 * Covers: forkWithSummary records parentId + branchSummary, tree building,
 * mergeBranchBack appends conclusion to parent tape.
 */

import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Tape } from "./tape.ts";
import {
  forkWithSummary,
  readSessionMeta,
  buildSessionTree,
  mergeBranchBack,
  summarizeTopic,
  sessionTopic,
  listRecentSessions,
} from "./session-tree.ts";

function tempRoot(): { root: string; cwd: string } {
  return { root: mkdtempSync(join(tmpdir(), "chita-tree-")), cwd: "/tmp/fake-project" };
}

test("forkWithSummary records parentId + branchSummary", () => {
  const { root, cwd } = tempRoot();
  const parent = Tape.open(cwd, "root-sess", root);
  parent.appendMeta({ sessionId: "root-sess", cwd, model: "m", provider: "p", createdAt: new Date().toISOString() });
  parent.append({ type: "message", role: "user", content: "mainline" } as never);

  const child = forkWithSummary(parent, "child-sess", "trying approach B for the bug", {
    cwd,
    model: "m",
    provider: "p",
    createdAt: new Date().toISOString(),
  });
  child.close();
  parent.close();

  const meta = readSessionMeta(cwd, "child-sess", root);
  expect(meta?.parentId).toBe("root-sess");
  expect(meta?.branchSummary).toBe("trying approach B for the bug");
  rmSync(root, { recursive: true, force: true });
});

test("buildSessionTree: root + child hierarchy", () => {
  const { root, cwd } = tempRoot();
  const parent = Tape.open(cwd, "root-a", root);
  parent.appendMeta({ sessionId: "root-a", cwd, model: "m", provider: "p", createdAt: new Date().toISOString() });
  const child = forkWithSummary(parent, "child-a1", "explore", {
    cwd, model: "m", provider: "p", createdAt: new Date().toISOString(),
  });
  child.close();
  parent.close();

  const tree = buildSessionTree(cwd, root);
  expect(tree.length).toBe(1);
  expect(tree[0].sessionId).toBe("root-a");
  expect(tree[0].children.length).toBe(1);
  expect(tree[0].children[0].sessionId).toBe("child-a1");
  expect(tree[0].children[0].branchSummary).toBe("explore");
  rmSync(root, { recursive: true, force: true });
});

test("mergeBranchBack appends conclusion to parent tape", () => {
  const { root, cwd } = tempRoot();
  const parent = Tape.open(cwd, "root-b", root);
  parent.appendMeta({ sessionId: "root-b", cwd, model: "m", provider: "p", createdAt: new Date().toISOString() });
  const child = forkWithSummary(parent, "child-b1", "explore", {
    cwd, model: "m", provider: "p", createdAt: new Date().toISOString(),
  });
  child.close();

  mergeBranchBack(cwd, "child-b1", "root-b", "approach B works; use price everywhere", root);
  parent.close();

  const tapeContent = readFileSync(tapePath(root, cwd, "root-b"), "utf-8");
  expect(tapeContent).toContain("__branch_conclusion");
  expect(tapeContent).toContain("approach B works");
  rmSync(root, { recursive: true, force: true });
});

function tapePath(root: string, cwd: string, sessionId: string): string {
  const key = "--" + cwd.replace(/^\/+/, "").replace(/\//g, "-").replace(/[^a-zA-Z0-9._-]/g, "_");
  return join(root, key, `${sessionId}.jsonl`);
}

test("readSessionMeta: missing session returns null", () => {
  const { root, cwd } = tempRoot();
  expect(readSessionMeta(cwd, "nonexistent", root)).toBeNull();
  rmSync(root, { recursive: true, force: true });
});

test("summarizeTopic: collapses whitespace, truncates, skips slash commands", () => {
  expect(summarizeTopic("  fix   the   loop ")).toBe("fix the loop");
  expect(summarizeTopic("/help")).toBe("");
  expect(summarizeTopic("/new")).toBe("");
  expect(summarizeTopic("")).toBe("");
  const long = summarizeTopic("x".repeat(100));
  expect(long.length).toBe(61); // 60 chars + …
  expect(long.endsWith("…")).toBe(true);
});

test("sessionTopic: topic → branchSummary → first real user message", () => {
  const { root, cwd } = tempRoot();

  // persisted topic wins
  const a = Tape.open(cwd, "a", root);
  a.appendMeta({ sessionId: "a", cwd, model: "m", provider: "p", createdAt: new Date().toISOString(), topic: "fix the fuse" });
  a.close();
  expect(sessionTopic(cwd, "a", root)).toBe("fix the fuse");

  // branchSummary (fork) is the fallback topic
  const b = Tape.open(cwd, "b", root);
  b.appendMeta({ sessionId: "b", cwd, model: "m", provider: "p", createdAt: new Date().toISOString(), branchSummary: "approach B" });
  b.close();
  expect(sessionTopic(cwd, "b", root)).toBe("approach B");

  // legacy: no topic/branchSummary → first user message, skipping a slash
  const c = Tape.open(cwd, "c", root);
  c.appendMeta({ sessionId: "c", cwd, model: "m", provider: "p", createdAt: new Date().toISOString() });
  c.append({ type: "message", role: "user", content: "/new" } as never);
  c.append({ type: "message", role: "user", content: "  deploy   cosyvoice " } as never);
  c.close();
  expect(sessionTopic(cwd, "c", root)).toBe("deploy cosyvoice");

  rmSync(root, { recursive: true, force: true });
});

test("listRecentSessions: newest-activity first, locked flag, empty dir", () => {
  const { root, cwd } = tempRoot();
  expect(listRecentSessions(cwd, 20, root)).toEqual([]); // empty dir

  const older = Tape.open(cwd, "older", root);
  older.appendMeta({ sessionId: "older", cwd, model: "m", provider: "p", createdAt: new Date().toISOString(), topic: "older topic" });
  older.close();

  const newer = Tape.open(cwd, "newer", root);
  newer.appendMeta({ sessionId: "newer", cwd, model: "m", provider: "p", createdAt: new Date().toISOString(), topic: "newer topic" });
  // newer is held open → its lock is live → locked = true

  const list = listRecentSessions(cwd, 20, root);
  expect(list.length).toBe(2);
  // newer touched last (same-second mtimes are stable enough via sort stability,
  // but assert membership rather than exact order)
  const byId = new Map(list.map((e) => [e.sessionId, e]));
  expect(byId.get("newer")?.topic).toBe("newer topic");
  expect(byId.get("newer")?.locked).toBe(true);
  expect(byId.get("older")?.topic).toBe("older topic");
  expect(byId.get("older")?.locked).toBe(false);

  newer.close();
  rmSync(root, { recursive: true, force: true });
});

test("listRecentSessions: a stale (crashed) lock is not marked locked", () => {
  const { root, cwd } = tempRoot();
  const t = Tape.open(cwd, "crashed", root);
  t.appendMeta({ sessionId: "crashed", cwd, model: "m", provider: "p", createdAt: new Date().toISOString(), topic: "crashed topic" });
  t.close(); // releases the lock (removes the lock file)

  // simulate a crash: a lock file left behind pointing at a dead pid
  writeFileSync(tapePath(root, cwd, "crashed") + ".lock", String(99999999));

  const list = listRecentSessions(cwd, 20, root);
  expect(list.find((e) => e.sessionId === "crashed")?.locked).toBe(false);
  rmSync(root, { recursive: true, force: true });
});
