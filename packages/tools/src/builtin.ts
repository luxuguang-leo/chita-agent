/**
 * chita builtin tools (M1 scope, v2.1 §2.3)
 *
 * read / write / bash / grep / ls / glob — the minimal coding loop set.
 * git: read-only (status/diff/log) per decision #5; web lands M2.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execSync, execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { Tool, ToolContext, ToolResult, truncateOutput } from "./index.ts";

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
  description: "Run a shell command (timeout + output truncation).",
  parameters: {
    type: "object",
    properties: { command: { type: "string" }, timeoutMs: { type: "number" } },
    required: ["command"],
  },
  defaultPermission: "ask",
  execute(args, ctx: ToolContext): ToolResult {
    // NOTE: runs in ctx.cwd directly. A temporary sandbox dir (isolated tmp
    // workspace) is a M1.5 item — v2.1 §2.3 (Cursor F7).
    const command = String(args.command ?? "");
    const timeoutMs = Number(args.timeoutMs ?? 10000);
    if (!command) return { ok: false, error: "command required" };
    // abort check before execution (T2; mid-command interrupt needs async
    // spawn, T3)
    if (ctx.signal?.aborted) return { ok: false, error: "aborted before execution" };
    try {
      const out = execSync(command, {
        cwd: ctx.cwd,
        timeout: timeoutMs,
        encoding: "utf-8",
        shell: "/bin/bash",
        stdio: ["ignore", "pipe", "pipe"],
      });
      const { output, truncated } = truncateOutput(out);
      return { ok: true, output, truncated };
    } catch (e: unknown) {
      const err = e as { stdout?: string; stderr?: string; message?: string; status?: number };
      const detail = (err.stdout ?? "") + (err.stderr ?? "");
      const { output, truncated } = truncateOutput(detail || err.message || "command failed");
      return { ok: false, error: output, truncated, verificationHint: "re-run command with --max-time to verify" };
    }
  },
};

export const grepTool: Tool = {
  name: "grep",
  description: "Search files by regex (returns matching lines with file:line).",
  parameters: {
    type: "object",
    properties: { pattern: { type: "string" }, path: { type: "string" } },
    required: ["pattern"],
  },
  defaultPermission: "allow",
  execute(args, ctx: ToolContext): ToolResult {
    const pattern = String(args.pattern ?? "");
    const path = String(args.path ?? ".");
    if (!pattern) return { ok: false, error: "pattern required" };
    try {
      const out = execSync(`grep -rn "${pattern.replace(/"/g, '\\"')}" "${path}"`, {
        cwd: ctx.cwd,
        timeout: 10000,
        encoding: "utf-8",
        shell: "/bin/bash",
        stdio: ["ignore", "pipe", "pipe"],
      });
      const { output, truncated } = truncateOutput(out);
      return { ok: true, output, truncated };
    } catch (e: unknown) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      // grep exit 1 = no matches (not an error)
      if (err.status === 1) return { ok: true, output: "(no matches)" };
      return { ok: false, error: String(err.stderr ?? err) };
    }
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
  execute(args, ctx: ToolContext): ToolResult {
    const path = String(args.path ?? ".");
    try {
      const out = execSync(`ls -la "${path}"`, {
        cwd: ctx.cwd,
        timeout: 5000,
        encoding: "utf-8",
        shell: "/bin/bash",
      });
      const { output, truncated } = truncateOutput(out);
      return { ok: true, output, truncated };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
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
  execute(args, ctx: ToolContext): ToolResult {
    const pattern = String(args.pattern ?? "");
    if (!pattern) return { ok: false, error: "pattern required" };
    try {
      const out = execSync(`ls -d ${pattern} 2>/dev/null || true`, {
        cwd: ctx.cwd,
        timeout: 5000,
        encoding: "utf-8",
        shell: "/bin/bash",
      });
      return { ok: true, output: out.trim() || "(no matches)" };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
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
  execute(args, ctx: ToolContext): ToolResult {
    const sub = String(args.args ?? "").trim();

    // Read-only guard (v2.1 decision #5). Reject:
    // - shell metacharacters (no shell is used — execFileSync argv, but keep
    //   the guard for defense in depth)
    // - write subcommands (commit/push/add/rm/reset/checkout/branch)
    if (/[;&|`$()<>]/.test(sub)) {
      return { ok: false, error: `git args contain shell metacharacters (blocked): ${sub}` };
    }
    if (!/^(status|diff|log|show)\b/.test(sub)) {
      return { ok: false, error: `git write ops go through bash in M1; allowed: status/diff/log/show (got: ${sub})` };
    }
    // branch removed from M1 whitelist (Cursor F4: branch -D is destructive)
    try {
      // argv array via shell-style tokenizer (handles quoted paths; no shell
      // interpolation — Cursor F7: split(' ') broke quoted paths)
      const argv = tokenizeArgs(sub);
      const out = execFileSync("git", argv, {
        cwd: ctx.cwd,
        timeout: 10000,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      const { output, truncated } = truncateOutput(out);
      return { ok: true, output, truncated };
    } catch (e: unknown) {
      const err = e as { stdout?: string; stderr?: string };
      return { ok: false, error: String(err.stderr ?? err) };
    }
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
 * interpolation — safe for execFileSync argv (Cursor F7).
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
