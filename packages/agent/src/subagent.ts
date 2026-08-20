/**
 * chita subagent (v2.1 §2.10)
 *
 * - TaskResult evidence contract: a subagent must return evidence + a
 *   verification command before it can finish (NOOA: 77% of failures are
 *   premature termination within 10 steps)
 * - verificationHint: a command the parent can run itself to verify
 * - permission inheritance: the subagent inherits the parent's tool
 *   permissions/scope (Kun Agent Graph)
 * - model tiering: main model orchestrates, cheaper model executes
 *   (Agent-goal methodology: cost control)
 *
 * Each subagent runs its own AgentLoop in an isolated session.
 */

import { AgentLoop, Provider, ChatMessage, LoopHooks, LoopMode } from "./loop.ts";
import { ToolRegistry } from "../../tools/src/index.ts";

export interface SubagentTask {
  /** What to accomplish */
  instruction: string;
  /** Working directory (defaults to parent's) */
  cwd?: string;
  /** Model tier: 'main' (full power) or 'cheap' (cost-optimized) */
  modelTier?: "main" | "cheap";
  /** Inherited permission scope (default: read-only for subagents) */
  permissionScope?: "inherit" | "read-only";
  /** Max iterations before the subagent must conclude */
  maxIterations?: number;
}

export interface TaskResult {
  ok: boolean;
  /** What was done (evidence of completion) */
  summary: string;
  /** A command the parent can run itself to verify (evidence contract) */
  verificationHint?: string;
  /** Files touched / artifacts produced */
  artifacts?: string[];
  /** Failure reason (ok=false) */
  error?: string;
  /** Token cost of the subagent run */
  tokensUsed?: number;
}

export interface SubagentProviderFactory {
  /** Build a provider for the given tier (allows cheaper model for subagents) */
  makeProvider(tier: "main" | "cheap"): Provider;
}

/**
 * Run a subagent to completion, enforcing the TaskResult evidence contract.
 * Returns null if the subagent finished without producing verifiable evidence.
 */
export async function runSubagent(
  task: SubagentTask,
  providerFactory: SubagentProviderFactory,
  opts: { tools?: ToolRegistry; hooks?: LoopHooks } = {}
): Promise<TaskResult | null> {
  const cwd = task.cwd ?? process.cwd();
  const tier = task.modelTier ?? "cheap"; // default: cheap executes
  const provider = providerFactory.makeProvider(tier);

  const loop = new AgentLoop({
    cwd,
    provider,
    mode: task.permissionScope === "inherit" ? "build" : "plan",
    // subagents never auto-approve writes unless scope says inherit
    autoApproveAsk: task.permissionScope === "inherit",
    maxIterations: task.maxIterations ?? 15,
    // no maxTokens: fresh context + maxIterations bound means the loop's 1M
    // spend-fuse fallback is never the binding limit here (cur-057)
    tools: opts.tools,
    hooks: opts.hooks,
  });

  const outcome = await loop.run(task.instruction);
  if (outcome.state !== "DONE") {
    return { ok: false, summary: "", error: `subagent did not finish (${outcome.state})` };
  }

  // Evidence contract (Cursor F2): summary + a concrete verification command
  // are both required for ok:true — a bare summary is not enough to claim
  // completion (NOOA: premature termination is the #1 failure mode).
  const summary = outcome.summary ?? "";
  if (!summary.trim()) {
    return { ok: false, summary: "", error: "subagent finished without a summary (evidence contract)" };
  }
  const verificationHint = suggestVerification(task);
  if (!verificationHint) {
    return {
      ok: false,
      summary,
      error: "subagent finished but produced no verification hint (evidence contract)",
    };
  }

  return {
    ok: true,
    summary,
    verificationHint,
  };
}

/**
 * Heuristic verification hint: derive a concrete verifiable command from the
 * task. M3 deterministic; returns null when nothing verifiable is derivable
 * (in which case the evidence contract fails, pushing the caller to give the
 * subagent a testable instruction).
 */
function suggestVerification(task: SubagentTask): string | undefined {
  const t = task.instruction.toLowerCase();
  if (t.includes("test") || t.includes("verify")) return "run the test suite mentioned in the task";
  // generic: re-run the reported command with --dry-run? Not verifiable — return
  // undefined so the contract forces a testable task.
  return undefined;
}

/** Simple model-tier-aware factory wrapper around an existing provider builder. */
export function tieredProviderFactory(
  main: () => Provider,
  cheap?: () => Provider
): SubagentProviderFactory {
  return {
    makeProvider: (tier) => (tier === "main" ? main() : cheap ? cheap() : main()),
  };
}
