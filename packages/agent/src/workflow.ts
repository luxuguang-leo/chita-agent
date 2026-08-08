/**
 * chita deterministic workflows (v2.1 §2.6, MiMo-Code workflows)
 *
 * Fixed stage sequence + bounded retries — deterministic agent orchestration
 * for pipeline tasks (podcast release, migration follow-ups). NOT a generic
 * orchestration engine (v2.1 stance: keep hooks deep, workflows as templates).
 *
 * Each stage runs a task through the agent loop; failure retries with bounded
 * backoff; the workflow stops at the first stage that exhausts retries.
 */

import { AgentLoop, Provider } from "./loop.ts";
import type { LoopHooks } from "./loop.ts";
import { ToolRegistry } from "../../tools/src/index.ts";

export interface WorkflowStage {
  name: string;
  /** Task instruction for this stage */
  task: string;
  /** Max retries before the stage fails (bounded — no infinite loops) */
  maxRetries?: number;
}

export interface WorkflowResult {
  name: string;
  stages: {
    name: string;
    ok: boolean;
    summary?: string;
    attempts: number;
    error?: string;
  }[];
  allOk: boolean;
}

export interface WorkflowOptions {
  cwd: string;
  provider: Provider;
  tools?: ToolRegistry;
  hooks?: LoopHooks;
  maxIterations?: number;
  /** Backoff base between retries (ms); default 1000 */
  backoffMs?: number;
}

const DEFAULT_RETRIES = 2;

/** Run a workflow: fixed stage sequence, bounded retries, stop on failure. */
export async function runWorkflow(
  name: string,
  stages: WorkflowStage[],
  opts: WorkflowOptions
): Promise<WorkflowResult> {
  const results: WorkflowResult["stages"] = [];

  for (const stage of stages) {
    const maxRetries = stage.maxRetries ?? DEFAULT_RETRIES;
    let attempts = 0;
    let lastOutcome: { state: string; summary?: string } | null = null;

    while (attempts <= maxRetries) {
      attempts++;
      const loop = new AgentLoop({
        cwd: opts.cwd,
        provider: opts.provider,
        tools: opts.tools,
        hooks: opts.hooks,
        maxIterations: opts.maxIterations ?? 20,
        autoApproveAsk: true, // workflows run pipelines — allow write
      });
      lastOutcome = await loop.run(stage.task);

      if (lastOutcome.state === "DONE") {
        results.push({
          name: stage.name,
          ok: true,
          summary: lastOutcome.summary,
          attempts,
        });
        break;
      }
      // bounded backoff before retry
      if (attempts <= maxRetries) {
        const backoff = (opts.backoffMs ?? 1000) * 2 ** (attempts - 1);
        await new Promise((r) => setTimeout(r, Math.min(backoff, 5000)));
      }
    }

    if (!results[results.length - 1]?.ok) {
      results.push({
        name: stage.name,
        ok: false,
        attempts,
        error: `stage failed after ${attempts} attempts (${lastOutcome?.state})`,
      });
      break; // stop at first failing stage
    }
  }

  return { name, stages: results, allOk: results.every((s) => s.ok) };
}

/** Predefined template: the MiMo-style spec -> verify -> finalize pipeline. */
export function specPipeline(
  opts: { spec: string; verifyCommand?: string }
): WorkflowStage[] {
  return [
    { name: "implement", task: `Implement the following spec:\n${opts.spec}`, maxRetries: 2 },
    {
      name: "verify",
      task: opts.verifyCommand
        ? `Verify the implementation: run "${opts.verifyCommand}" and report the result. Fix issues found.`
        : "Verify the implementation compiles and behaves correctly. Fix issues found.",
      maxRetries: 2,
    },
    { name: "finalize", task: "Summarize what was implemented, what was verified, and any remaining notes.", maxRetries: 1 },
  ];
}
