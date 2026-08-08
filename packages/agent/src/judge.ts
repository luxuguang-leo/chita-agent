/**
 * chita /goal judge (v2.1 §2.2 / MiMo-Code / Agent-goal methodology)
 *
 * An independent judge model evaluates whether the task goal was ACTUALLY
 * achieved — guarding against optimistic early-stop (MiMo's /goal, NOOA's
 * premature termination). It is a post-hoc spot-check on `done` (v2.1: judge
 * supplements, not replaces, the done tool gate).
 *
 * Cost anchors (v2.1): judge invoked at most every 10 turns; monthly budget
 * $10-30. Benchmark loop (Agent-goal): run twice, compare — the judge can
 * request a re-run when evidence is missing.
 */

import type { Provider } from "./loop.ts";
import type { ChatMessage } from "./loop.ts";

export type JudgeVerdict = "pass" | "fail" | "uncertain";

export interface JudgeResult {
  verdict: JudgeVerdict;
  reason: string;
  /** Evidence the judge found (or what was missing) */
  evidence: string[];
  /** Tokens used by the judge call */
  tokensUsed: number;
}

export interface JudgeOptions {
  /** Max judge invocations per session (default: every <=10 turns) */
  maxPerSession?: number;
  /** Monthly budget cap in USD (default $10) */
  monthlyBudgetUsd?: number;
}

const DEFAULT_MAX_PER_SESSION = 3;
const DEFAULT_MONTHLY_BUDGET = 10;
const JUDGE_PROMPT = `You are an independent task-completion judge. A coding agent claimed to
finish a task. Evaluate whether the goal was ACTUALLY achieved, based only on
the evidence in the conversation. Be skeptical: an agent saying "done" without
verifiable results is NOT completion.

Reply with a JSON object:
{"verdict": "pass" | "fail" | "uncertain", "reason": "...", "evidence": ["..."]}

- pass: evidence clearly shows the goal met (files written, tests pass, output verified)
- fail: the goal is clearly not met, or the agent stopped prematurely
- uncertain: not enough evidence either way — ask for a re-run with verification`;

/** Budget tracker for judge invocations (cost anchors). */
export class JudgeBudget {
  private invoked = 0;
  private tokensSpent = 0;
  private monthlyUsd: number;
  private maxPerSession: number;

  constructor(opts: JudgeOptions = {}) {
    this.monthlyUsd = opts.monthlyBudgetUsd ?? DEFAULT_MONTHLY_BUDGET;
    this.maxPerSession = opts.maxPerSession ?? DEFAULT_MAX_PER_SESSION;
  }

  /** Can the judge run? Enforces max-per-session + monthly budget. */
  canInvoke(estimatedTokens: number, perMillionUsd = 0.3): boolean {
    if (this.invoked >= this.maxPerSession) return false;
    const cost = (estimatedTokens / 1_000_000) * perMillionUsd;
    return (this.tokensSpent / 1_000_000) * perMillionUsd + cost <= this.monthlyUsd;
  }

  record(tokens: number): void {
    this.invoked++;
    this.tokensSpent += tokens;
  }

  invokedCount(): number {
    return this.invoked;
  }
}

/**
 * Run the judge against a finished conversation. The judge is a separate
 * model call (independent — never the same model that did the work).
 */
export async function runJudge(
  provider: Provider,
  conversation: ChatMessage[],
  goal: string
): Promise<JudgeResult> {
  const judgeMessages: ChatMessage[] = [
    { role: "system", content: JUDGE_PROMPT },
    { role: "user", content: `Task goal: ${goal}\n\nConversation:\n${renderConversation(conversation)}` },
  ];

  let assistantText = "";
  let tokensUsed = 0;
  for await (const ev of provider.chat(judgeMessages)) {
    if (ev.kind === "message" && ev.message?.content) {
      assistantText += ev.message.content;
    }
    if (ev.usage?.tokens) tokensUsed = ev.usage.tokens;
  }

  return parseJudgeResponse(assistantText, tokensUsed);
}

/** Parse the judge's JSON reply (lenient — extract the JSON object). */
export function parseJudgeResponse(text: string, tokensUsed: number): JudgeResult {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) {
    return { verdict: "uncertain", reason: "judge returned no parseable verdict", evidence: [], tokensUsed };
  }
  try {
    const parsed = JSON.parse(m[0]) as { verdict?: string; reason?: string; evidence?: unknown };
    const verdict: JudgeVerdict =
      parsed.verdict === "pass" || parsed.verdict === "fail" ? parsed.verdict : "uncertain";
    return {
      verdict,
      reason: parsed.reason ?? "",
      evidence: Array.isArray(parsed.evidence) ? parsed.evidence.map(String) : [],
      tokensUsed,
    };
  } catch {
    return { verdict: "uncertain", reason: "judge JSON parse failed", evidence: [], tokensUsed };
  }
}

function renderConversation(conversation: ChatMessage[]): string {
  return conversation
    .map((m) => {
      if (m.role === "tool") return `[tool ${m.name ?? ""}] ${m.content.slice(0, 500)}`;
      return `[${m.role}] ${m.content.slice(0, 500)}`;
    })
    .join("\n");
}
