/**
 * chita evals scaling (v2.1 §8, M4 — kimi P1-2)
 *
 * - grader taxonomy: code-based (deterministic verifier) / model-based (LLM
 *   judge) / human (manual review) — a case declares its grader
 * - cost dimension: record tokens/cost/latency per eval run (cost+accuracy
 *   joint optimization, "ai-agents-that-matter")
 * - holdout: a subset of cases is NEVER used for iteration reference
 *   (anti-overfit — "evaluation quicksand")
 * - failure taxonomy: each failure classified to model/harness/tool/env
 *   (Model-or-Harness-ScaleAI) so "fix the model or the harness" stops being
 *   a guess
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { EvalCase } from "./index.ts";

export type GraderKind = "code" | "model" | "human";
export type FailureCategory = "model" | "harness" | "tool" | "env" | "grader" | "unknown";

/** Per-case eval metadata (declared in case dir evals.yaml/meta). */
export interface EvalMeta {
  grader: GraderKind;
  /** Whether this case is holdout (never used for iteration reference) */
  holdout: boolean;
  /** Capability under test (e.g. "read", "edit", "test") */
  capability?: string;
}

export interface ScaledEvalResult {
  caseId: string;
  passed: boolean;
  /** Token cost of the run (usage from provider) */
  tokensUsed?: number;
  /** Wall time of the agent run (ms) */
  latencyMs?: number;
  /** Failure attribution (Model-or-Harness-ScaleAI taxonomy) */
  failureCategory?: FailureCategory;
  grader: GraderKind;
  /** True for holdout cases (excluded from iteration reference) */
  isHoldout: boolean;
}

const DEFAULT_META: EvalMeta = { grader: "code", holdout: false };

/** Parse evals.yaml/meta from a case dir (lenient, YAML-ish). */
export function parseEvalMeta(caseDir: string): EvalMeta {
  const metaPath = join(caseDir, "meta.yaml");
  try {
    const raw = readFileSync(metaPath, "utf-8");
    const meta: EvalMeta = { ...DEFAULT_META };
    for (const line of raw.split("\n")) {
      const idx = line.indexOf(":");
      if (idx === -1) continue;
      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim();
      if (key === "grader" && (value === "code" || value === "model" || value === "human")) {
        meta.grader = value;
      }
      if (key === "holdout" && (value === "true" || value === "false")) {
        meta.holdout = value === "true";
      }
      if (key === "capability" && value) meta.capability = value;
    }
    return meta;
  } catch {
    return { ...DEFAULT_META };
  }
}

/**
 * Split cases into holdout (never for iteration) and train (for iteration).
 * Holdout cases are tracked but their results never feed improvement loops.
 */
export function splitHoldout(cases: EvalCase[]): { train: EvalCase[]; holdout: EvalCase[] } {
  const train: EvalCase[] = [];
  const holdout: EvalCase[] = [];
  for (const c of cases) {
    const meta = parseEvalMeta(c.dir);
    if (meta.holdout) holdout.push(c);
    else train.push(c);
  }
  return { train, holdout };
}

/** Classify a failure to a taxonomy category (Model-or-Harness-ScaleAI). */
export function classifyFailure(
  verifierExit: number,
  agentError?: string,
  toolErrors?: string[]
): FailureCategory {
  if (verifierExit === 0) return "unknown"; // passed, nothing to classify
  if (agentError) {
    const e = agentError.toLowerCase();
    if (e.includes("permission") || e.includes("blocked") || e.includes("mode")) return "harness";
    if (e.includes("did not finish") || e.includes("error")) return "harness";
  }
  if (toolErrors && toolErrors.length > 0) {
    const t = toolErrors.join(" ").toLowerCase();
    if (t.includes("not found") || t.includes("econnreset") || t.includes("timeout")) return "env";
    if (t.includes("unknown tool") || t.includes("schema")) return "tool";
    return "tool";
  }
  // verifier failed after a DONE agent run: could be model (did wrong thing)
  // or grader (verifier too strict) — default to model, reviewer confirms
  return "model";
}

/** Compute cost from tokens (rough $/1M, configurable per provider). */
export function estimateCost(tokens: number, perMillionUsd = 0.3): number {
  return (tokens / 1_000_000) * perMillionUsd;
}
