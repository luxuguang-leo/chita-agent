/**
 * chita builtin tools (M1 scope, v2.1 §2.3)
 *
 * read / write / bash / grep / ls / glob — the minimal coding loop set.
 * git: read-only (status/diff/log) per decision #5; web lands M2.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { Tool, ToolContext, ToolResult, truncateOutput } from "./index.ts";
import { sanitizeTail } from "./sanitize.ts";

export const readTool: Tool = {
  name: "read",
  description: "Read a file (UTF-8).",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  defaultPermission: "allow",
  execute(args, ctx: ToolContext): ToolResult {
    const path = String(args.path ?? "");
    if (!path) return { ok: false, error: "path required" };
    try {
      const content = readFileSync(join(ctx.cwd, path), "utf-8");
      const { output, truncated } = truncateOutput(content);
      return { ok: true, output, truncated };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  },
};

export const writeTool: Tool = {
  name: "write",
  description: "Write a file (creates parent dirs).",
  parameters: {
    type: "object",
    properties: { path: { type: "string" }, content: { type: "string" } },
    required: ["path", "content"],
  },
  defaultPermission: "ask",
  execute(args, ctx: ToolContext): ToolResult {
    const path = String(args.path ?? "");
    const content = String(args.content ?? "");
    if (!path) return { ok: false, error: "path required" };
    try {
      const full = join(ctx.cwd, path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
      return { ok: true, output: `wrote ${path} (${content.length} bytes)` };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  },
};

export const bashTool: Tool = {
  name: "bash",
  description: "Run a shell command (default 60s timeout — pass timeoutMs to raise for long downloads/network calls; output is truncated).",
  parameters: {
    type: "object",
    properties: { command: { type: "string" }, timeoutMs: { type: "number" } },
    required: ["command"],
  },
  defaultPermission: "ask",
  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    // NOTE: runs in ctx.cwd directly. A temporary sandbox dir (isolated tmp
    // workspace) is a M1.5 item — v2.1 §2.3 (Cursor F7).
    const command = String(args.command ?? "");
    const timeoutMs = Number(args.timeoutMs ?? 60000);
    if (!command) return { ok: false, error: "command required" };
    // abort check before execution (T2); mid-command interrupt is handled by
    // spawnToResult's process-group kill (async spawn, T3)
    if (ctx.signal?.aborted) return { ok: false, error: "aborted before execution" };
    return runShell(command, {
      cwd: ctx.cwd,
      timeoutMs,
      signal: ctx.signal,
      onOutput: ctx.onOutput,
    });
  },
};

/** Bounded tail for live stdout/stderr accumulation (aligns execSync's
 *  default maxBuffer; cursor Q6 — key is "bounded", never unbounded +=). */
const MAX_BUF = 1024 * 1024;
/** SIGTERM → grace → SIGKILL so stubborn children can't survive (cursor #1). */
const KILL_GRACE_MS = 300;
/** Fixed timeouts for the shell tools (P2 async exec). */
const GREP_TIMEOUT_MS = 10000;
const LS_TIMEOUT_MS = 5000;
const GLOB_TIMEOUT_MS = 5000;
const GIT_TIMEOUT_MS = 10000;

/** Exit shaping for spawnToResult: maps (code, stdout, stderr, killed,
 *  timedOut) to a ToolResult. Spawn failures (ENOENT etc.) do NOT go through
 *  shape — the core returns a unified error on child "error" (P2 finding #1). */
type ExitShape = (r: {
  code: number | null;
  stdout: string;
  stderr: string;
  killed: boolean;
  timedOut: boolean;
  /** stdout was a binary dump (detectBinary) — git show <blob> etc. */
  binary: boolean;
}) => ToolResult;

/**
 * Async spawn core (P2): argv 直传（无 shell）、detached 进程组、timeout
 * SIGKILL、abort SIGTERM→grace→SIGKILL、1MB 有界尾、TextDecoder flush、
 * onOutput 流式。退出时把 (code, stdout, stderr, killed, timedOut) 交给
 * shape 塑形；spawn "error"（ENOENT 等）走核心统一错误、不调 shape。
 */
export function spawnToResult(
  argv: string[],
  opts: {
    cwd: string;
    timeoutMs: number;
    signal?: AbortSignal;
    onOutput?: (chunk: string) => void;
    /** Stop early + mark binary when a stdout chunk contains NUL (P2.1). */
    detectBinary?: boolean;
  },
  shape: ExitShape
): Promise<ToolResult> {
  return new Promise((resolve) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32", // own process group for group-kill
    });
    const stdoutDec = new TextDecoder("utf-8");
    const stderrDec = new TextDecoder("utf-8");
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let killed = false;
    let binary = false;

    const append = (text: string, to: "stdout" | "stderr"): void => {
      if (!text) return; // decoder flush may yield "" — skip empty chunks
      if (to === "stdout") {
        // P2.1 binary detection: a NUL in stdout means a binary dump (git show
        // <blob>). Kill early + stop buffering instead of pumping a large blob
        // into the 1MB tail (cursor P2.1: first-chunk trigger, any NUL).
        if (opts.detectBinary && text.includes("\0")) {
          binary = true;
          killGroup("SIGKILL");
          return;
        }
        if (binary) return; // already binary — drop the rest
        stdout += text;
        if (stdout.length > MAX_BUF) stdout = stdout.slice(stdout.length - MAX_BUF);
        opts.onOutput?.(text);
      } else {
        stderr += text;
        if (stderr.length > MAX_BUF) stderr = stderr.slice(stderr.length - MAX_BUF);
      }
    };

    let timer: ReturnType<typeof setTimeout>;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (r: ToolResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve(r);
    };

    const killGroup = (sig: NodeJS.Signals): void => {
      try {
        if (process.platform !== "win32" && child.pid != null) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        // already dead
      }
    };

    const onAbort = (): void => {
      if (settled) return;
      killed = true;
      killGroup("SIGTERM");
      // grace, then SIGKILL (cursor finding #1) — finish happens on close
      graceTimer = setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS);
    };
    opts.signal?.addEventListener("abort", onAbort);

    timer = setTimeout(() => {
      timedOut = true;
      killGroup("SIGKILL");
    }, opts.timeoutMs);

    child.stdout.on("data", (b: Buffer) => append(stdoutDec.decode(b, { stream: true }), "stdout"));
    child.stderr.on("data", (b: Buffer) => append(stderrDec.decode(b, { stream: true }), "stderr"));
    // spawn failure (ENOENT etc.): unified error, NOT shape (P2 finding #1)
    child.on("error", (e) => finish({ ok: false, error: String(e) }));
    child.on("close", (code) => {
      // flush decoder tails (cursor finding #3): a chunk ending mid-code-point
      // would otherwise drop the final partial character
      try {
        append(stdoutDec.decode(), "stdout");
      } catch {
        // decoder already flushed
      }
      try {
        append(stderrDec.decode(), "stderr");
      } catch {
        // decoder already flushed
      }
      finish(shape({ code, stdout, stderr, killed, timedOut, binary }));
    });
  });
}

/** bash's exit shaping — P0's four branches moved verbatim (behavior unchanged). */
function bashShape(timeoutMs: number): ExitShape {
  return (r) => {
    if (r.killed) {
      // explicit interrupt outranks timeout when both fire in the same frame
      const partial = truncateOutput(r.stdout);
      return { ok: false, output: partial.output || undefined, truncated: partial.truncated, error: "interrupted" };
    }
    if (r.timedOut) {
      // Timeout vs non-zero exit: partial stdout is PROGRESS, not the error
      // (a compound `echo "===" ; curl …` killed mid-run must not read
      // "error: === … -> 200").
      const partial = truncateOutput(r.stdout || r.stderr);
      return {
        ok: false,
        output: partial.output || undefined,
        truncated: partial.truncated,
        error: `command timed out after ${timeoutMs}ms — raise the timeoutMs arg if this run needs longer (curl/wget --max-time won't help: the tool kills first)`,
      };
    }
    if (r.code !== 0) {
      const detail = truncateOutput(r.stdout + r.stderr || "command failed");
      return { ok: false, error: detail.output, truncated: detail.truncated, verificationHint: "command exited non-zero — inspect the output above" };
    }
    const out = truncateOutput(r.stdout);
    return { ok: true, output: out.output, truncated: out.truncated };
  };
}

/** Shared shape for the read-only shell tools: interrupt/timeout are uniform
 *  across grep/ls/glob/git, then onExit maps the exit code (grep's exit-1 =
 *  no-matches, git's stderr-on-failure). */
export function shellToolShape(
  timeoutMs: number,
  onExit: (code: number | null, stdout: string, stderr: string) => ToolResult
): ExitShape {
  return (r) => {
    if (r.killed) return { ok: false, error: "interrupted" };
    if (r.timedOut) {
      // keep partial stdout as PROGRESS (grep/git large-output parity with
      // bashShape) — not the error
      const partial = truncateOutput(r.stdout || r.stderr);
      return { ok: false, output: partial.output || undefined, truncated: partial.truncated, error: `command timed out after ${timeoutMs}ms` };
    }
    return onExit(r.code, r.stdout, r.stderr);
  };
}

/** git's exit shaping: binary detection first (show <blob> dumps raw bytes),
 *  then shellToolShape's exit mapping with ANSI stripped from stdout (P2.1). */
function gitShape(timeoutMs: number): ExitShape {
  const base = shellToolShape(timeoutMs, (code, stdout, stderr) => {
    if (code !== 0) return { ok: false, error: stderr || "git failed" };
    const out = truncateOutput(sanitizeTail(stdout));
    return { ok: true, output: out.output, truncated: out.truncated };
  });
  return (r) => {
    if (r.killed) return { ok: false, error: "interrupted" }; // explicit interrupt outranks binary
    if (r.binary) return { ok: true, output: "(binary file)" };
    return base(r);
  };
}

/** Run a shell command via async spawn (T3/P0: replaces the execSync that
 *  froze the TUI event loop). */
function runShell(
  command: string,
  opts: { cwd: string; timeoutMs: number; signal?: AbortSignal; onOutput?: (chunk: string) => void }
): Promise<ToolResult> {
  return spawnToResult(["/bin/bash", "-c", command], opts, bashShape(opts.timeoutMs));
}

export const grepTool: Tool = {
  name: "grep",
  description: "Search files by regex (returns matching lines with file:line).",
  parameters: {
    type: "object",
    properties: { pattern: { type: "string" }, path: { type: "string" } },
    required: ["pattern"],
  },
  defaultPermission: "allow",
  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    const pattern = String(args.pattern ?? "");
    const path = String(args.path ?? ".");
    if (!pattern) return { ok: false, error: "pattern required" };
    if (ctx.signal?.aborted) return { ok: false, error: "aborted before execution" };
    // argv (no shell): the pattern goes verbatim — no quote-escaping hack,
    // and shell metacharacters in the pattern stay literal (P2 §4).
    return spawnToResult(
      ["grep", "-rn", pattern, path],
      { cwd: ctx.cwd, timeoutMs: GREP_TIMEOUT_MS, signal: ctx.signal, onOutput: ctx.onOutput },
      shellToolShape(GREP_TIMEOUT_MS, (code, stdout, stderr) => {
        if (code === 1) return { ok: true, output: "(no matches)" }; // grep exit 1 = no matches
        if (code !== 0) return { ok: false, error: stderr || "grep failed" };
        const out = truncateOutput(stdout);
        return { ok: true, output: out.output, truncated: out.truncated };
      })
    );
  },
};

export const lsTool: Tool = {
  name: "ls",
  description: "List directory entries.",
  parameters: {
    type: "object",
    properties: { path: { type: "string" } },
  },
  defaultPermission: "allow",
  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    const path = String(args.path ?? ".");
    if (ctx.signal?.aborted) return { ok: false, error: "aborted before execution" };
    return spawnToResult(
      ["ls", "-la", path],
      { cwd: ctx.cwd, timeoutMs: LS_TIMEOUT_MS, signal: ctx.signal, onOutput: ctx.onOutput },
      shellToolShape(LS_TIMEOUT_MS, (code, stdout, stderr) => {
        if (code !== 0) return { ok: false, error: stderr || "ls failed" };
        const out = truncateOutput(stdout);
        return { ok: true, output: out.output, truncated: out.truncated };
      })
    );
  },
};

export const globTool: Tool = {
  name: "glob",
  description: "Glob files by pattern (relative to cwd).",
  parameters: {
    type: "object",
    properties: { pattern: { type: "string" } },
    required: ["pattern"],
  },
  defaultPermission: "allow",
  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    const pattern = String(args.pattern ?? "");
    if (!pattern) return { ok: false, error: "pattern required" };
    if (ctx.signal?.aborted) return { ok: false, error: "aborted before execution" };
    // glob expansion is done by the SHELL (`ls -d *.ts`): argv would pass
    // `*.ts` to ls as a literal. Keep shell-based (P2 §4); `|| true` forces
    // exit 0 and `2>/dev/null` drops the "no such file" stderr.
    return spawnToResult(
      ["/bin/bash", "-c", `ls -d ${pattern} 2>/dev/null || true`],
      { cwd: ctx.cwd, timeoutMs: GLOB_TIMEOUT_MS, signal: ctx.signal, onOutput: ctx.onOutput },
      shellToolShape(GLOB_TIMEOUT_MS, (code, stdout) => {
        if (code !== 0) return { ok: false, error: "glob failed" };
        const trimmed = stdout.trim();
        if (!trimmed) return { ok: true, output: "(no matches)" };
        const out = truncateOutput(trimmed);
        return { ok: true, output: out.output, truncated: out.truncated };
      })
    );
  },
};

export const gitTool: Tool = {
  name: "git",
  description: "Read-only git operations: status / diff / log / show (decision #5: writes go through bash + permission).",
  parameters: {
    type: "object",
    properties: { args: { type: "string" } },
    required: ["args"],
  },
  defaultPermission: "allow",
  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    const sub = String(args.args ?? "").trim();

    // Read-only guard (v2.1 decision #5). Reject:
    // - shell metacharacters (no shell is used — spawn argv, but keep
    //   the guard for defense in depth)
    // - write subcommands (commit/push/add/rm/reset/checkout/branch)
    if (/[;&|`$()<>]/.test(sub)) {
      return { ok: false, error: `git args contain shell metacharacters (blocked): ${sub}` };
    }
    if (!/^(status|diff|log|show)\b/.test(sub)) {
      return { ok: false, error: `git write ops go through bash in M1; allowed: status/diff/log/show (got: ${sub})` };
    }
    // branch removed from M1 whitelist (Cursor F4: branch -D is destructive)
    if (ctx.signal?.aborted) return { ok: false, error: "aborted before execution" };
    // argv via shell-style tokenizer (handles quoted paths; no shell
    // interpolation — Cursor F7: split(' ') broke quoted paths)
    const argv = tokenizeArgs(sub);
    return spawnToResult(
      ["git", ...argv],
      { cwd: ctx.cwd, timeoutMs: GIT_TIMEOUT_MS, signal: ctx.signal, onOutput: ctx.onOutput, detectBinary: true },
      gitShape(GIT_TIMEOUT_MS)
    );
  },
};

export const doneTool: Tool = {
  name: "done",
  description:
    "Declare the task complete. The loop only transitions to DONE when this tool is called (v2.1 §2.2 early-stop hard gate).",
  parameters: {
    type: "object",
    properties: { summary: { type: "string" } },
  },
  defaultPermission: "allow",
  execute(args): ToolResult {
    return { ok: true, output: `done: ${String(args.summary ?? "")}` };
  },
};

/** Register the full M1 builtin set */
export function registerBuiltinTools(registry: { register(t: Tool): void }): void {
  registry.register(readTool);
  registry.register(writeTool);
  registry.register(bashTool);
  registry.register(grepTool);
  registry.register(lsTool);
  registry.register(globTool);
  registry.register(gitTool);
  registry.register(doneTool);
}

/**
 * Minimal shell-style argv tokenizer: splits on whitespace but respects
 * single and double quotes (for paths with spaces). No expansion, no
 * interpolation — safe for spawn argv (Cursor F7).
 */
export function tokenizeArgs(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inSingle) {
      if (ch === "'") inSingle = false;
      else current += ch;
      continue;
    }
    if (inDouble) {
      if (ch === '"') inDouble = false;
      else current += ch;
      continue;
    }
    if (ch === "'") inSingle = true;
    else if (ch === '"') inDouble = true;
    else if (ch === " " || ch === "\t") {
      if (current) {
        args.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current) args.push(current);
  return args;
}
