/**
 * chita compaction — M1.5 six-section summary (v2.1 §2.4)
 *
 * Pi's six-section compaction schema:
 *   Goal / Constraints & Preferences / Progress(Done|In Progress|Blocked)
 *   / Key Decisions / Next Steps / Critical Context
 *
 * Critical context MUST retain precise file paths, function names, error
 * messages — the summary is for "the next turn can keep working", not chat.
 *
 * M1.5: this module defines the schema + a deterministic extractor (no LLM).
 * The LLM-driven summarizer replaces the extractor once the ai layer lands.
 * The structure is stable either way.
 */

export interface CompactionSummary {
  goal: string;
  constraints: string[];
  progress: { status: "done" | "in-progress" | "blocked"; note: string }[];
  keyDecisions: string[];
  nextSteps: string[];
  criticalContext: string[];
}

export const EMPTY_SUMMARY: CompactionSummary = {
  goal: "",
  constraints: [],
  progress: [],
  keyDecisions: [],
  nextSteps: [],
  criticalContext: [],
};

/** Render a summary to a stable markdown block (input for the LLM next turn). */
export function renderSummary(s: CompactionSummary): string {
  const lines: string[] = [];
  lines.push("# Session Summary (compacted)");
  lines.push("");
  lines.push(`## Goal\n${s.goal || "(not stated)"}`);
  lines.push("");
  lines.push("## Constraints & Preferences");
  for (const c of s.constraints) lines.push(`- ${c}`);
  if (!s.constraints.length) lines.push("- (none)");
  lines.push("");
  lines.push("## Progress");
  for (const p of s.progress) lines.push(`- [${p.status}] ${p.note}`);
  if (!s.progress.length) lines.push("- (none)");
  lines.push("");
  lines.push("## Key Decisions");
  for (const d of s.keyDecisions) lines.push(`- ${d}`);
  if (!s.keyDecisions.length) lines.push("- (none)");
  lines.push("");
  lines.push("## Next Steps");
  for (const n of s.nextSteps) lines.push(`- ${n}`);
  if (!s.nextSteps.length) lines.push("- (none)");
  lines.push("");
  lines.push("## Critical Context");
  for (const c of s.criticalContext) lines.push(`- ${c}`);
  if (!s.criticalContext.length) lines.push("- (none)");
  return lines.join("\n");
}

/**
 * Deterministic extractor (M1.5 interim; LLM summarizer replaces later).
 *
 * Scans conversation messages for:
 * - goal: the first user message (task)
 * - key decisions: assistant "done"/"decide" lines + tool results that
 *   mention decisions
 * - next steps: lines starting with "next"/"下一步"/"接下来"
 * - critical context: file paths, function names, error messages
 *   (regex-extracted, always retained — the summary is for working, not chat)
 */
export function extractSummary(messages: { role: string; content: string }[]): CompactionSummary {
  const s: CompactionSummary = { ...EMPTY_SUMMARY };
  const critical = new Set<string>();
  const decisions: string[] = [];
  const nextSteps: string[] = [];

  for (const m of messages) {
    if (m.role === "user" && !s.goal) {
      s.goal = m.content.slice(0, 200);
      continue;
    }
    if (m.role === "assistant") {
      // next steps
      for (const line of m.content.split("\n")) {
        const t = line.trim();
        if (/^(next|下一步|接下来|then|then\s)/i.test(t)) nextSteps.push(t.slice(0, 120));
        if (/(decided|决定|采纳|rejected|拒绝)/i.test(t) && t.length < 160) decisions.push(t);
      }
      // critical: file paths and function names
      for (const match of m.content.matchAll(/(?:[\w./-]+\.(?:ts|js|tsx|jsx|py|rs|go|json|md|sh|css|html))(?::\d+)?/g)) {
        if (match[0].length > 3) critical.add(match[0]);
      }
      for (const match of m.content.matchAll(/\b(?:function|const|class|export)\s+([A-Za-z_$][\w$]*)/g)) {
        critical.add(match[1]);
      }
    }
    if (m.role === "tool" && m.content) {
      // errors always retained
      if (m.content.includes("ERROR") || m.content.includes("failed") || m.content.includes("error:")) {
        critical.add(m.content.slice(0, 200));
      }
      if (/^\s*(?:error|fail)/i.test(m.content)) critical.add(m.content.slice(0, 200));
    }
  }

  s.keyDecisions = decisions.slice(0, 10);
  s.nextSteps = nextSteps.slice(0, 10);
  s.criticalContext = [...critical].slice(0, 30);
  return s;
}
