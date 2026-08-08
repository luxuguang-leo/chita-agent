/**
 * chita skill sedimentation (v2.1 §2.6 / hermes P1-1 / Self-Learning Context Layer)
 *
 * M3 scope: manual + template start. After a successful session, extract key
 * experience from the trace and generate a SKILL.md draft in a PENDING state.
 * A human (or later auto-approval) reviews and activates it. Metric (M3):
 * sedimentation trigger rate (successful traces -> skill) >= 30%.
 *
 * Safety (Hermes memory-v2 lessons): drafts are never auto-activated; they
 * land in ~/.chita/skills-pending/ with a review marker.
 */

import { mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { TraceEvent } from "../../session/src/trace.ts";

export interface SedimentDraft {
  name: string;
  description: string;
  body: string;
  /** Source session id */
  fromSession: string;
  /** Suggested tags */
  tags: string[];
}

export const PENDING_SKILLS_DIR = `${process.env.HOME}/.chita/skills-pending`;
export const SKILLS_DIR = `${process.env.HOME}/.chita/skills`;

/** Render a SKILL.md from a draft (Agent Skills spec format). */
export function renderSkillMd(draft: SedimentDraft): string {
  const tags = draft.tags.map((t) => `    - ${t}`).join("\n");
  return `---
name: ${draft.name}
description: ${draft.description}
version: 0.1.0
status: pending
metadata:
  chita:
    tags:
${tags}
    source_session: ${draft.fromSession}
---

${draft.body}
`;
}

/**
 * Write a draft as a PENDING skill (never auto-activated).
 * Returns the written path.
 */
export function writePendingSkill(draft: SedimentDraft): string {
  mkdirSync(PENDING_SKILLS_DIR, { recursive: true });
  const path = join(PENDING_SKILLS_DIR, draft.name, "SKILL.md");
  mkdirSync(join(PENDING_SKILLS_DIR, draft.name), { recursive: true });
  writeFileSync(path, renderSkillMd(draft));
  return path;
}

/** List pending skills (awaiting review). */
export function listPendingSkills(): string[] {
  if (!existsSync(PENDING_SKILLS_DIR)) return [];
  return readdirSync(PENDING_SKILLS_DIR)
    .filter((d) => existsSync(join(PENDING_SKILLS_DIR, d, "SKILL.md")))
    .sort();
}

/**
 * Activate a pending skill: move it into the active skills dir (review passed).
 * M3: explicit review — this is the "human approves" step.
 * Removes the pending copy and flips status: pending -> active (Cursor F4).
 */
export function activateSkill(name: string): string {
  const pending = join(PENDING_SKILLS_DIR, name, "SKILL.md");
  if (!existsSync(pending)) throw new Error(`pending skill not found: ${name}`);
  mkdirSync(join(SKILLS_DIR, name), { recursive: true });
  const dest = join(SKILLS_DIR, name, "SKILL.md");
  let content = readFileSync(pending, "utf-8");
  content = content.replace(/^status: pending$/m, "status: active");
  writeFileSync(dest, content);
  // remove the pending copy (reviewed and activated)
  rmSync(join(PENDING_SKILLS_DIR, name), { recursive: true, force: true });
  return dest;
}

/**
 * Extract a sediment suggestion from a successful session's trace.
 * M3 heuristic (deterministic, no LLM): if the session used a distinctive
 * tool sequence (>= 3 tool calls) with all-success results, suggest a skill
 * that captures the workflow. Returns null when there's nothing to suggest.
 */
export function suggestFromTrace(sessionId: string, events: TraceEvent[]): SedimentDraft | null {
  const toolCalls = events.filter((e): e is Extract<TraceEvent, { type: "tool_call" }> => e.type === "tool_call");
  const results = events.filter((e): e is Extract<TraceEvent, { type: "tool_result" }> => e.type === "tool_result");

  if (toolCalls.length < 3) return null; // not enough structure to sediment
  const allOk = results.every((r) => r.ok);
  if (!allOk) return null; // only successful sessions sediment

  const sequence = [...new Set(toolCalls.map((t) => t.tool.name))];
  const name = `trace-${sessionId.slice(-6)}`;
  return {
    name,
    description: `Automatically extracted workflow from session ${sessionId}: ${sequence.join(" -> ")}.`,
    body: `## Workflow\n\nExtracted from a successful session.\n\n1. ${sequence.map((t) => `Use \`${t}\``).join("\n2. ")}\n\n## Review\n\nVerify this captures a reusable pattern before activating.`,
    fromSession: sessionId,
    tags: [...sequence, "trace-extracted"],
  };
}
