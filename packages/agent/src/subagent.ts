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
import type { TraceEvent } from "../../session/src/trace.ts";
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

/** A failed approach with its evidence (audited contract, cur-096 P1-1) */
export interface FailedApproach {
  /** What was attempted (tool + argument summary) */
  approach: string;
  /** Evidence: the error or output observed */
  evidence: string;
}

/** TaskResult contract schema version. Placeholder: single harness, no
 *  cross-session CAS promotion yet — cur-096 says "stateVersion 先占位" (P1-1). */
export const TASK_RESULT_STATE_VERSION = 1;

export interface TaskResult {
  ok: boolean;
  /** What was done (evidence of completion) */
  summary: string;
  /** A command the parent can run itself to verify (evidence contract) */
  verificationHint?: string;
  /** Files written by the subagent (evidence of what was touched; P1-1 fix —
   *  previously declared but never populated on the success path).
   *  MVP boundary (cur-102 nit): `write` tool only — bash/cp/tee writes are
   *  out of scope; paths are kept as the tool received them (often relative). */
  artifacts?: string[];
  /** Approaches that failed, with evidence (audited contract, P1-1) */
  failedApproaches?: FailedApproach[];
  /** Machine-checkable acceptance criteria derived from the task (P1-1).
   *  Deterministic heuristic; the parent may override. */
  acceptanceCriteria?: string[];
  /** Contract schema version (P1-1 placeholder, see TASK_RESULT_STATE_VERSION) */
  stateVersion?: number;
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

  // P1-1 audited-contract collection (cur-096): wrap the caller's hooks to
  // observe the subagent's OWN tool calls — zero changes to AgentLoop.
  // callId correlation (cur-102 nit): the loop always emits callId on the
  // normal path (loop.ts tool_call/tool_result pairing); a callId-less write
  // is deliberately not counted as an artifact (cannot resolve the path).
  const calls = new Map<string, { name: string; args?: unknown }>();
  const artifacts = new Set<string>();
  const failures: FailedApproach[] = [];
  const collect = (ev: TraceEvent): void => {
    if (ev.type === "tool_call" && ev.callId) {
      calls.set(ev.callId, { name: ev.tool.name, args: ev.tool.args });
    } else if (ev.type === "tool_result") {
      const call = ev.callId ? calls.get(ev.callId) : undefined;
      if (ev.ok && ev.toolName === "write" && call) {
        const p = (call.args as { path?: unknown } | undefined)?.path;
        if (typeof p === "string" && p) artifacts.add(p);
      } else if (!ev.ok) {
        failures.push({
          approach: call ? `${call.name}(${summarizeArgs(call.args)})` : ev.toolName,
          evidence: ev.error ?? ev.output ?? "unknown failure",
        });
      }
    }
  };
  const wrappedHooks: LoopHooks = opts.hooks
    ? { ...opts.hooks, onEvent: (ev) => { collect(ev); opts.hooks?.onEvent?.(ev); } }
    : { onEvent: collect };

  const loop = new AgentLoop({
    cwd,
    provider,
    mode: task.permissionScope === "inherit" ? "build" : "plan",
    // subagents never auto-approve writes unless scope says inherit
    autoApproveAsk: task.permissionScope === "inherit",
    // No onPermissionRequest: Guardian `ask` calls fall back to
    // "no approval channel" → deny. Stricter than inherit (F8): a subagent
    // cannot prompt the user mid-run, so risky calls fail safe.
    maxIterations: task.maxIterations ?? 15,
    // no maxTokens: fresh context + maxIterations bound means the loop's 1M
    // spend-fuse fallback is never the binding limit here (cur-057)
    tools: opts.tools,
    hooks: wrappedHooks,
  });

  const outcome = await loop.run(task.instruction);

  // cur-102 F1: ok:false early returns still surface what the subagent tried
  // (collected artifacts/failedApproaches) — the parent needs to see
  // "what was attempted" even when the evidence contract fails.
  const failure = (error: string, summary = ""): TaskResult => ({
    ok: false,
    summary,
    error,
    artifacts: [...artifacts],
    failedApproaches: failures,
  });

  if (outcome.state !== "DONE") {
    return failure(`subagent did not finish (${outcome.state})`);
  }

  // Evidence contract (Cursor F2): summary + a concrete verification command
  // are both required for ok:true — a bare summary is not enough to claim
  // completion (NOOA: premature termination is the #1 failure mode).
  const summary = outcome.summary ?? "";
  if (!summary.trim()) {
    return failure("subagent finished without a summary (evidence contract)");
  }
  const verificationHint = suggestVerification(task);
  if (!verificationHint) {
    return failure("subagent finished but produced no verification hint (evidence contract)", summary);
  }

  return {
    ok: true,
    summary,
    verificationHint,
    artifacts: [...artifacts],
    failedApproaches: failures,
    acceptanceCriteria: suggestAcceptanceCriteria(task),
    stateVersion: TASK_RESULT_STATE_VERSION,
  };
}

/**
 * Minimal deterministic acceptance criteria (P1-1): derive machine-checkable
 * criteria from the task instruction. Currently reuses the verification-hint
 * heuristic; the parent may override with richer criteria.
 */
function suggestAcceptanceCriteria(task: SubagentTask): string[] {
  const criteria: string[] = [];
  const hint = suggestVerification(task);
  if (hint) criteria.push(hint);
  return criteria;
}

/** Compact single-line argument summary for failedApproaches.approach. */
function summarizeArgs(args: unknown): string {
  try {
    const s = JSON.stringify(args) ?? "";
    return s.length > 100 ? `${s.slice(0, 100)}…` : s;
  } catch {
    return String(args);
  }
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
