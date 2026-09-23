/**
 * builtin tool security tests (v2.1 §2.3 / Cursor F4)
 *
 * Covers: git read-only guard rejects shell metacharacters and write
 * subcommands; argv execution means no shell interpolation; write/bash
 * permission defaults.
 */

import { test, expect } from "bun:test";
import { ToolRegistry } from "./index.ts";
import { registerBuiltinTools, gitTool, tokenizeArgs } from "./builtin.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

function makeRegistry(): ToolRegistry {
  const r = new ToolRegistry();
  registerBuiltinTools(r);
  return r;
}

test("git tool rejects shell metacharacters", async () => {
  const registry = makeRegistry();
  const result = await registry.execute(
    "git",
    { args: "status; git commit -am x" },
    { cwd: "/tmp", permission: "allow" }
  );
  expect(result.ok).toBe(false);
  expect(result.error).toContain("shell metacharacters");
});

test("git tool rejects write subcommands", async () => {
  const registry = makeRegistry();
  const r1 = await registry.execute("git", { args: "commit -am x" }, { cwd: "/tmp", permission: "allow" });
  expect(r1.ok).toBe(false);
  const r2 = await registry.execute("git", { args: "push" }, { cwd: "/tmp", permission: "allow" });
  expect(r2.ok).toBe(false);
  // branch removed from whitelist (branch -D destructive)
  const r3 = await registry.execute("git", { args: "branch -D main" }, { cwd: "/tmp", permission: "allow" });
  expect(r3.ok).toBe(false);
});

test("git status works via argv (no shell)", async () => {
  const repo = mkdtempSync(join(tmpdir(), "chita-git-"));
  execSync("git init -q", { cwd: repo });
  writeFileSync(join(repo, "a.txt"), "x");
  execSync('git config user.email "t@t.local" && git config user.name t && git add -A && git commit -qm init', { cwd: repo });

  const registry = makeRegistry();
  const result = await registry.execute("git", { args: "status --porcelain" }, { cwd: repo, permission: "allow" });
  expect(result.ok).toBe(true);
  // a clean repo shows nothing; add a change to verify output
  writeFileSync(join(repo, "a.txt"), "y");
  const dirty = await registry.execute("git", { args: "status --porcelain" }, { cwd: repo, permission: "allow" });
  expect(dirty.ok).toBe(true);
  expect(dirty.output).toContain("a.txt");
});

test("write tool requires ask permission (denied without autoApprove)", async () => {
  const registry = makeRegistry();
  const result = await registry.execute(
    "write",
    { path: "x.txt", content: "hello" },
    { cwd: "/tmp", permission: "ask" }
  );
  // M1 without autoApprove: ask-level write is denied (no interactive prompt)
  expect(result.ok).toBe(false);
});

test("read tool default permission is allow", () => {
  expect(gitTool.defaultPermission).toBe("allow");
});

test("tokenizeArgs: splits whitespace, respects quotes", () => {
  expect(tokenizeArgs("status --porcelain")).toEqual(["status", "--porcelain"]);
  expect(tokenizeArgs('diff "my file.txt"')).toEqual(["diff", "my file.txt"]);
  expect(tokenizeArgs("log --oneline 'quoted path'")).toEqual(["log", "--oneline", "quoted path"]);
  expect(tokenizeArgs("")).toEqual([]);
  expect(tokenizeArgs("  spaced  out  ")).toEqual(["spaced", "out"]);
});

test("bash tool: aborted signal skips execution (T2 tool abort)", async () => {
  const registry = makeRegistry();
  const abort = new AbortController();
  abort.abort();
  const result = await registry.execute(
    "bash",
    { command: "echo should-not-run" },
    { cwd: "/tmp", permission: "allow", signal: abort.signal }
  );
  expect(result.ok).toBe(false);
  expect(result.error).toContain("aborted");
});

test("bash tool: non-aborted signal runs normally", async () => {
  const registry = makeRegistry();
  const result = await registry.execute(
    "bash",
    { command: "echo ok" },
    { cwd: "/tmp", permission: "allow", signal: new AbortController().signal }
  );
  expect(result.ok).toBe(true);
});

test("bash tool: timeout reports a clear error and keeps partial stdout out of error", async () => {
  // 2026-09-19 session: a compound `echo "===" ; curl …` killed at the tool's
  // timeout dumped partial stdout into error -> "error: … api.github.com -> 200".
  const registry = makeRegistry();
  const result = await registry.execute(
    "bash",
    { command: 'echo "=== start ===" ; sleep 5', timeoutMs: 300 },
    { cwd: "/tmp", permission: "allow" }
  );
  expect(result.ok).toBe(false);
  expect(result.error).toContain("timed out after 300ms");
  expect(result.error).not.toContain("=== start ===");
  expect(result.output).toContain("=== start ===");
});

test("bash tool: non-zero exit keeps stderr in error (not a timeout)", async () => {
  const registry = makeRegistry();
  const result = await registry.execute(
    "bash",
    { command: "echo boom >&2 ; exit 1" },
    { cwd: "/tmp", permission: "allow" }
  );
  expect(result.ok).toBe(false);
  expect(result.error).toContain("boom");
  expect(result.error).not.toContain("timed out");
});

test("bash tool: streams stdout chunks via ctx.onOutput (T3 async spawn)", async () => {
  const registry = makeRegistry();
  const chunks: string[] = [];
  const result = await registry.execute(
    "bash",
    { command: "for i in 1 2 3; do echo $i; sleep 0.05; done" },
    { cwd: "/tmp", permission: "allow", onOutput: (c) => chunks.push(c) }
  );
  expect(result.ok).toBe(true);
  // live chunks arrived (not a single post-hoc dump)
  expect(chunks.length).toBeGreaterThan(0);
  const live = chunks.join("");
  expect(live).toContain("1");
  expect(live).toContain("3");
  // final result still carries the full (truncated-to-4096) output
  expect(result.output).toContain("1");
});

test("bash tool: mid-run abort kills the process group and returns interrupted", async () => {
  const registry = makeRegistry();
  const abort = new AbortController();
  const p = registry.execute(
    "bash",
    { command: "sleep 60" },
    { cwd: "/tmp", permission: "allow", signal: abort.signal }
  );
  // abort well into the run; resolution only happens on close (process dead),
  // so a flake-free assertion of the kill
  setTimeout(() => abort.abort(), 200);
  const result = await p;
  expect(result.ok).toBe(false);
  expect(result.error).toContain("interrupted");
});
