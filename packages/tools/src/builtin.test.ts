/**
 * builtin tool security tests (v2.1 §2.3 / Cursor F4)
 *
 * Covers: git read-only guard rejects shell metacharacters and write
 * subcommands; argv execution means no shell interpolation; write/bash
 * permission defaults.
 */

import { test, expect } from "bun:test";
import { ToolRegistry } from "./index.ts";
import { registerBuiltinTools, gitTool, tokenizeArgs, spawnToResult, shellToolShape } from "./builtin.ts";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

function makeRegistry(): ToolRegistry {
  const r = new ToolRegistry();
  registerBuiltinTools(r);
  return r;
}

test("write tool: absolute path is NOT nested under cwd (join→resolve fix)", async () => {
  const registry = makeRegistry();
  const repo = mkdtempSync(join(tmpdir(), "chita-write-abs-"));
  const absFile = join(repo, "docs", "out.md");
  const r = await registry.execute(
    "write",
    { path: absFile, content: "hello" },
    { cwd: repo, permission: "allow" }
  );
  expect(r.ok).toBe(true);
  // 内容真的写到了绝对路径本身（不是嵌套在 cwd 下）
  expect(readFileSync(absFile, "utf-8")).toBe("hello");
  // 没有嵌套的 Users/... 假路径（旧 join() bug 的产物）
  expect(existsSync(join(repo, "Users"))).toBe(false);
  rmSync(repo, { recursive: true, force: true });
});

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

test("grep: exit 1 returns '(no matches)' via argv (no shell)", async () => {
  const registry = makeRegistry();
  const dir = mkdtempSync(join(tmpdir(), "chita-grep-"));
  const result = await registry.execute(
    "grep",
    { pattern: "zzz-no-such-pattern-zzz", path: dir },
    { cwd: dir, permission: "allow" }
  );
  expect(result.ok).toBe(true);
  expect(result.output).toBe("(no matches)");
});

test("grep: finds matches via argv (no shell escaping of the pattern)", async () => {
  const registry = makeRegistry();
  const dir = mkdtempSync(join(tmpdir(), "chita-grep-"));
  writeFileSync(join(dir, "a.txt"), "hello world\n");
  const result = await registry.execute(
    "grep",
    { pattern: "hello", path: dir },
    { cwd: dir, permission: "allow" }
  );
  expect(result.ok).toBe(true);
  expect(result.output).toContain("hello");
});

test("grep: pattern with a quote stays literal via argv", async () => {
  const registry = makeRegistry();
  const dir = mkdtempSync(join(tmpdir(), "chita-grep-"));
  writeFileSync(join(dir, "a.txt"), "it's a test\n");
  const result = await registry.execute(
    "grep",
    { pattern: "it's", path: dir },
    { cwd: dir, permission: "allow" }
  );
  expect(result.ok).toBe(true);
  expect(result.output).toContain("it's");
});

test("ls: async lists directory entries", async () => {
  const registry = makeRegistry();
  const dir = mkdtempSync(join(tmpdir(), "chita-ls-"));
  writeFileSync(join(dir, "probe.txt"), "x");
  const result = await registry.execute("ls", { path: dir }, { cwd: dir, permission: "allow" });
  expect(result.ok).toBe(true);
  expect(result.output).toContain("probe.txt");
});

test("glob: async returns matches and '(no matches)' fallback", async () => {
  const registry = makeRegistry();
  const dir = mkdtempSync(join(tmpdir(), "chita-glob-"));
  writeFileSync(join(dir, "a.ts"), "x");
  const hit = await registry.execute("glob", { pattern: "*.ts" }, { cwd: dir, permission: "allow" });
  expect(hit.ok).toBe(true);
  expect(hit.output).toContain("a.ts");
  const miss = await registry.execute("glob", { pattern: "*.py" }, { cwd: dir, permission: "allow" });
  expect(miss.ok).toBe(true);
  expect(miss.output).toBe("(no matches)");
});

test("git: async status streams stdout via ctx.onOutput", async () => {
  const repo = mkdtempSync(join(tmpdir(), "chita-git-"));
  execSync("git init -q", { cwd: repo });
  writeFileSync(join(repo, "a.txt"), "x");
  execSync('git config user.email "t@t.local" && git config user.name t && git add -A && git commit -qm init', { cwd: repo });

  const registry = makeRegistry();
  const chunks: string[] = [];
  writeFileSync(join(repo, "a.txt"), "y");
  const result = await registry.execute(
    "git",
    { args: "status --porcelain" },
    { cwd: repo, permission: "allow", onOutput: (c) => chunks.push(c) }
  );
  expect(result.ok).toBe(true);
  expect(result.output).toContain("a.txt");
  expect(chunks.length).toBeGreaterThan(0);
});

test("git: show of a binary blob returns '(binary file)' (P2.1 detectBinary)", async () => {
  const repo = mkdtempSync(join(tmpdir(), "chita-git-bin-"));
  execSync("git init -q", { cwd: repo });
  execSync('git config user.email "t@t.local" && git config user.name t', { cwd: repo });
  writeFileSync(join(repo, "blob.bin"), Buffer.from([0, 1, 2, 3, 0, 255]));
  execSync("git add -A && git commit -qm init", { cwd: repo });

  const registry = makeRegistry();
  const result = await registry.execute(
    "git",
    { args: "show HEAD:blob.bin" },
    { cwd: repo, permission: "allow" }
  );
  expect(result.ok).toBe(true);
  expect(result.output).toBe("(binary file)");
});

test("git: log --color=always output is ANSI-cleaned (P2.1 sanitizeTail)", async () => {
  const repo = mkdtempSync(join(tmpdir(), "chita-git-"));
  execSync("git init -q", { cwd: repo });
  writeFileSync(join(repo, "a.txt"), "x");
  execSync('git config user.email "t@t.local" && git config user.name t && git add -A && git commit -qm init', { cwd: repo });

  const registry = makeRegistry();
  const result = await registry.execute(
    "git",
    { args: "log --oneline --color=always" },
    { cwd: repo, permission: "allow" }
  );
  expect(result.ok).toBe(true);
  expect(result.output).toContain("init");
  expect(result.output).not.toContain("\x1b[");
});

test("shellToolShape: timeout keeps partial stdout out of error (grep/git parity)", async () => {
  const result = await spawnToResult(
    ["/bin/bash", "-c", "echo progress; sleep 60"],
    { cwd: "/tmp", timeoutMs: 200 },
    shellToolShape(200, () => ({ ok: true, output: "unused" }))
  );
  expect(result.ok).toBe(false);
  expect(result.error).toContain("timed out after 200ms");
  expect(result.output).toContain("progress");
});

test("shellToolShape: abort mid-run returns interrupted", async () => {
  const abort = new AbortController();
  const p = spawnToResult(
    ["/bin/bash", "-c", "sleep 60"],
    { cwd: "/tmp", timeoutMs: 60000, signal: abort.signal },
    shellToolShape(60000, () => ({ ok: true, output: "unused" }))
  );
  setTimeout(() => abort.abort(), 200);
  const result = await p;
  expect(result.ok).toBe(false);
  expect(result.error).toBe("interrupted");
});
