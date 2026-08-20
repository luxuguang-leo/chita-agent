/**
 * chita evals runner (v2.1 §8, M1)
 *
 * Modes:
 * - verify-only: run each case's verifier against the current env state
 *   (M0 behavior; the 3 fix-bug cases fail until fixed — that's the point)
 * - run: execute the case instruction through a Provider (agent), then run
 *   the verifier against the resulting env state (M1: with a real LLM; the
 *   runner itself is provider-agnostic)
 *
 * A case passes only when its verifier exits 0 after the agent's run.
 */

import { readdirSync, existsSync, readFileSync, mkdtempSync, cpSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { AgentLoop, Provider, ChatMessage, LoopHooks } from "@chita/agent/src/loop.ts";

export interface EvalCase {
  id: string;
  dir: string;
  instruction: string;
  hasVerifier: boolean;
}

export interface EvalResult {
  id: string;
  verifierExit: number | null;
  passed: boolean;
  error?: string;
}

export function discoverCases(root: string): EvalCase[] {
  const cases: EvalCase[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    const instructionPath = join(dir, "instruction.md");
    const verifierPath = join(dir, "verifier", "check.ts");
    if (!existsSync(instructionPath)) continue;
    cases.push({
      id: entry.name,
      dir,
      instruction: readFileSync(instructionPath, "utf-8"),
      hasVerifier: existsSync(verifierPath),
    });
  }
  return cases.sort((a, b) => a.id.localeCompare(b.id));
}

/** Run a single case's verifier. Returns exit code (0 = pass). */
export function runVerifier(c: EvalCase): { exit: number; output: string } {
  const verifierPath = join(c.dir, "verifier", "check.ts");
  if (!c.hasVerifier) return { exit: 1, output: "no verifier" };
  try {
    const output = execSync(`bun ${verifierPath}`, {
      timeout: 30000,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { exit: 0, output };
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { exit: err.status ?? 1, output: String(err.stdout ?? "") + String(err.stderr ?? "") };
  }
}

export interface RunOptions {
  root: string;
  provider?: Provider;
  only?: string; // comma-separated case ids
  maxIterations?: number;
  /** Loop hooks (e.g. afterToolCall scrub) applied per case run */
  hooks?: LoopHooks;
}

/**
 * Run all cases. With a provider: execute the instruction through the agent,
 * then verify. Without a provider: verify-only against current env state.
 *
 * Run mode isolates each case in a fresh tmpdir (copied fixture) — the agent
 * may modify files; the original fixture stays pristine (Cursor F2 / M0 README
 * isolation contract). Verification runs against the tmpdir copy.
 */
export async function runEvals(opts: RunOptions): Promise<EvalResult[]> {
  const cases = discoverCases(opts.root).filter((c) => !opts.only || opts.only.split(",").includes(c.id));
  const results: EvalResult[] = [];

  for (const c of cases) {
    if (opts.provider) {
      // Fresh tmpdir copy: fixture isolation (agent can modify, original untouched)
      const tmp = mkdtempSync(join(tmpdir(), "chita-eval-"));
      try {
        cpSync(c.dir, tmp, { recursive: true });
        const loop = new AgentLoop({
          cwd: tmp,
          provider: opts.provider,
          maxIterations: opts.maxIterations ?? 20,
          // no maxTokens: fresh fixture context + maxIterations bound (1M fallback not binding, cur-057)
          autoApproveAsk: true, // eval runs are sandboxed fixtures — allow write/bash
          hooks: opts.hooks,
        });
        const outcome = await loop.run(c.instruction);
        if (outcome.state !== "DONE") {
          results.push({ id: c.id, verifierExit: null, passed: false, error: `agent did not finish (${outcome.state})` });
          continue;
        }
        // verify against the tmpdir copy (agent artifacts live there)
        const verifierPath = join(tmp, "verifier", "check.ts");
        const { exit } = runVerifierAt(verifierPath);
        results.push({ id: c.id, verifierExit: exit, passed: exit === 0 });
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    } else {
      const { exit } = runVerifier(c);
      results.push({ id: c.id, verifierExit: exit, passed: exit === 0 });
    }
  }
  return results;
}

/** Run a verifier by explicit path (tmpdir copy has different import.meta.dir) */
function runVerifierAt(verifierPath: string): { exit: number; output: string } {
  try {
    const output = execSync(`bun ${verifierPath}`, {
      timeout: 30000,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { exit: 0, output };
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { exit: err.status ?? 1, output: String(err.stdout ?? "") + String(err.stderr ?? "") };
  }
}

/** Print a compact summary table. */
export function summarize(results: EvalResult[]): void {
  const passed = results.filter((r) => r.passed).length;
  for (const r of results) {
    const mark = r.passed ? "PASS" : "FAIL";
    console.log(`${mark}  ${r.id}${r.error ? `  (${r.error})` : ""}`);
  }
  console.log(`\n${passed}/${results.length} passed`);
}
