/**
 * session tree tests (v2.1 §2.7, Pi session-tree semantics)
 *
 * Covers: forkWithSummary records parentId + branchSummary, tree building,
 * mergeBranchBack appends conclusion to parent tape.
 */

import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Tape } from "./tape.ts";
import { forkWithSummary, readSessionMeta, buildSessionTree, mergeBranchBack } from "./session-tree.ts";

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
