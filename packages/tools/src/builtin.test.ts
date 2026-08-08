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
