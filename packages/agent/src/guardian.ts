/**
 * chita Guardian static rules (M-next, v2.1 §8.2 — cur-093/cur-094)
 *
 * Pure-function risk classification table, evaluated BEFORE the existing
 * beforeToolCall hook. Output stays on the three-level permission ladder
 * (allow|ask|deny) so the rest of the pipeline is unchanged.
 *
 * Scope (cur-093): four categories only — destructive / credential / exfil /
 * weaken. Deliberately NOT in scope: LLM classification, fine-grained egress
 * policy (false-positive heavy, not MVP).
 *
 * Out-of-workspace write coverage (F4): the `isOutsideWorkspace` gate applies
 * to the write TOOL's `path` arg, `echo/tee` to absolute paths in bash, and
 * write/bash `path` args — NOT generic shell redirection (`cat x > ../out`,
 * `cp a /tmp/b`, `python -c 'open("/etc/...")'`). Those need sandbox-level
 * enforcement (deferred, OS sandbox), not a regex table.
 * Known gaps (cur-097): `echo foo 2>&1 > /etc/passwd` (the `&` cuts the
 * match) and `printf`/`dd` variants are not caught — documented, not fixed
 * in MVP.
 *
 * Three-branch semantics (cur-094):
 *   classify == deny  → always blocked (ignores autoApproveAsk)
 *   classify == ask   → always WAITING_USER (ignores autoApproveAsk)
 *   classify == allow / no match → existing autoApproveAsk path
 */

import type { Permission } from "../../session/src/trace.ts";
import { resolve } from "node:path";

export type GuardianCategory = "destructive" | "credential" | "exfil" | "weaken" | "none";

export interface GuardianVerdict {
  permission: Permission;
  reason: string;
  category: GuardianCategory;
}

export interface GuardianContext {
  cwd: string;
  mode: "build" | "plan";
}

/** Read-side tool: default allow; classification still applies (credential reads). */
const READ_TOOLS = new Set(["read", "grep", "ls", "glob"]);

/* ------------------------------------------------------------------ *
 * Destructive: rm -rf / force git rewrites / writes outside workspace
 * ------------------------------------------------------------------ */
const DESTRUCTIVE_BASH = [
  // rm -rf / rm -fr / rm -fR / rm -r -f: short-option run must contain BOTH
  // r and f in ANY order (bare `rm -f file` deletes one file — not
  // destructive, cur-097)
  { re: /\brm\s+(?:-\w*\s*)*-(?=[a-zA-Z]*[rR])[a-zA-Z]*[fF]\b/, hint: "rm recursive+force delete (r then f)" },
  { re: /\brm\s+(?:-\w*\s*)*-(?=[a-zA-Z]*[fF])[a-zA-Z]*[rR]\b/, hint: "rm recursive+force delete (f then r)" },
  { re: /\brm\s+-\w*[rR]\w*\s+-\w*[fF]\w*\b/, hint: "rm -r -f separate options" },
  { re: /\brm\s+--recursive\b[^;|&]*--force\b/, hint: "rm --recursive --force delete" },
  { re: /\brm\s+--force\b[^;|&]*--recursive\b/, hint: "rm --force --recursive delete" },
  { re: /\brm\s+-\w*\s+--force\b/, hint: "rm -r --force delete" },
  { re: /\brm\s+--recursive\b[^;|&]*-f\b/, hint: "rm --recursive -f mixed delete" },
  { re: /\brm\s+-\w*[fF]\w*\s+--recursive\b/, hint: "rm -f --recursive mixed delete" },
  { re: /\brm\s+--force\b[^;|&]*-\w*[rR]\w*\b/, hint: "rm --force -r mixed delete" },
  { re: /\bgit\s+push\b[^;|&]*\s--force(?:-with-lease)?\b/, hint: "git push --force history rewrite" },
  { re: /\bgit\s+push\b[^;|&]*\s-f\b/, hint: "git push -f history rewrite" },
  { re: /\bgit\s+reset\s+--hard\b/, hint: "git reset --hard discards work" },
  { re: /\bgit\s+clean\s+(-[a-z]*\s*)*-\s*[a-z]*f[a-z]*\b/, hint: "git clean -f deletes untracked files" },
];

/** Write targets outside the workspace root (expand ~ and resolve symlinks-free
 *  normalized path; F1: string concatenation allowed ../ traversal through
 *  cwd=/proj + path=../secret → /proj/../secret still "starts with" /proj/). */
function isOutsideWorkspace(path: string, cwd: string): boolean {
  if (!path) return false;
  const expanded = path.startsWith("~") ? path.replace(/^~/, process.env.HOME ?? "") : path;
  const abs = resolve(cwd, expanded); // resolves ../ and //; no I/O, pure normalization
  const normCwd = resolve(cwd);
  return !(abs === normCwd || abs.startsWith(normCwd + "/"));
}

/* ------------------------------------------------------------------ *
 * Credential probing: reads of secret-bearing paths
 * ------------------------------------------------------------------ */
const CREDENTIAL_PATH = /(^|\/)(\.env(\.\w+)?|\.ssh\/|\.aws\/|\.gpg\/|\.gnupg\/|\.pki\/|id_rsa|id_ed25519|\.pem$|credentials(\/|$)|\.netrc|\.chita\/\.env|\.hermes\/\.env)/;

/** bash commands that read credential paths (cat/less/head/tail on them). */
const CREDENTIAL_BASH = [
  { re: /\b(cat|less|more|head|tail|type|strings)\s+[^;&|]*(\.env|\.ssh\/|\.aws\/|id_rsa|id_ed25519|\.pem|credentials(\/|$)|\.netrc)/, hint: "reading credential-bearing file" },
  { re: /\b(cp|scp|rsync)\s+[^;&|]*(\.env|\.ssh\/|\.aws\/|id_rsa|id_ed25519|\.pem|credentials(\/|$)|\.netrc)/, hint: "copying credential-bearing file" },
];

/* ------------------------------------------------------------------ *
 * Exfil: curl/wget with payload-bearing flags
 * ------------------------------------------------------------------ */
const EXFIL_BASH = [
  { re: /\b(curl|wget|http|websocat)\s+[^;&|]*(--data|-d\s|--form|-F\s|-T\s|--upload-file|-X\s+(POST|PUT|PATCH))/, hint: "network egress with a payload" },
  { re: /\b(curl|wget|http)\s+[^;&|]*\$\{?[A-Z_]+(TOKEN|KEY|SECRET|PASS|AUTH|CRED)/, hint: "network egress referencing a secret env var" },
  // F6: bare curl GET (no payload, no secret ref) passes by design — MVP
  // does not flag query strings, -G --data, or literal Bearer tokens.
];

/* ------------------------------------------------------------------ *
 * Persistent weakening: crontab / launch agents / shell rc
 * ------------------------------------------------------------------ */
const WEAKEN_BASH = [
  { re: /\bcrontab\b/, hint: "modifying crontab (persistent)" },
  { re: /\blaunchctl\b|\bLaunchAgents\b/, hint: "modifying launchd agents (persistent)" },
  { re: /~\/\.(zshrc|bashrc|bash_profile|profile|config)\b/, hint: "modifying shell rc (persistent)" },
  { re: /\bchmod\s+[-+0-9rwx]*[0-7]{3}\s+\/(etc|usr|var|bin|sbin)\b/, hint: "chmod on system dir (persistent weakening)" },
];

/**
 * Classify a tool call against the static risk table.
 * Pure: no I/O, no state — deterministic and unit-testable.
 */
export function classify(tool: string, args: Record<string, unknown>, ctx: GuardianContext): GuardianVerdict {
  const command = typeof args.command === "string" ? args.command : "";
  const path = typeof args.path === "string" ? args.path : "";
  const pattern = typeof args.pattern === "string" ? args.pattern : "";
  const cwd = ctx.cwd;
  const isPlan = ctx.mode === "plan";
  const deny = (reason: string, category: GuardianCategory): GuardianVerdict =>
    ({ permission: isPlan ? "deny" : "ask", reason, category });
  const ask = (reason: string, category: GuardianCategory): GuardianVerdict =>
    ({ permission: "ask", reason, category });
  const allow = (): GuardianVerdict => ({ permission: "allow", reason: "", category: "none" });

  // --- destructive ---
  if (tool === "bash" && command) {
    for (const r of DESTRUCTIVE_BASH) {
      if (r.re.test(command)) return deny(`guardian[destructive]: ${r.hint}`, "destructive");
    }
  }
  // write outside the workspace (destructive by scope, not by force flag)
  if ((tool === "write" || tool === "bash") && path && isOutsideWorkspace(path, cwd)) {
    return deny(`guardian[destructive]: writing outside workspace root (${path})`, "destructive");
  }
  // F2: absolute-path stdout redirect, but NOT fd sinks (2>/dev/null,
  // >/dev/null) — those are stderr/stdout sinks, not workspace escapes.
  // Implicit stdout `> /abs` (preceded by non-digit) plus explicit fd 1
  // `1>/abs` (cur-097): both are workspace escapes.
  if (tool === "bash" && command && /(^|[;&|]\s*)(echo|printf|cat)\b[^;|&]*[^0-9]>(?!\s*\/dev\/null\b)\s*\//.test(command)) {
    return deny("guardian[destructive]: redirecting to absolute path", "destructive");
  }
  if (tool === "bash" && command && /(^|[;&|]\s*)(echo|printf|cat)\b[^;|&]*[0-9]>(?!\s*\/dev\/null\b)\s*\//.test(command)) {
    return deny("guardian[destructive]: fd redirect to absolute path", "destructive");
  }
  if (tool === "bash" && command && /(^|[;&|]\s*)tee\s+\//.test(command)) {
    return deny("guardian[destructive]: tee to absolute path", "destructive");
  }

  // --- credential ---
  if (READ_TOOLS.has(tool) && path && CREDENTIAL_PATH.test(path)) {
    return deny(`guardian[credential]: reading credential-bearing path (${path})`, "credential");
  }
  if (tool === "bash" && command) {
    for (const r of CREDENTIAL_BASH) {
      if (r.re.test(command)) return deny(`guardian[credential]: ${r.hint}`, "credential");
    }
  }

  // --- exfil ---
  if (tool === "bash" && command) {
    for (const r of EXFIL_BASH) {
      if (r.re.test(command)) return ask(`guardian[exfil]: ${r.hint}`, "exfil");
    }
  }

  // --- weaken ---
  if (tool === "bash" && command) {
    for (const r of WEAKEN_BASH) {
      if (r.re.test(command)) return ask(`guardian[weaken]: ${r.hint}`, "weaken");
    }
  }

  return allow();
}

/** Category label for UI/tape (Chinese, matches v2.1 §8). */
export function categoryLabel(c: GuardianCategory): string {
  switch (c) {
    case "destructive": return "破坏性动作";
    case "credential": return "凭据探测";
    case "exfil": return "数据外泄";
    case "weaken": return "持久弱化";
    default: return "";
  }
}
