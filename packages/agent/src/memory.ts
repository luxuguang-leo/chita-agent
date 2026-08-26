/**
 * chita memory four-layer (v2.1 §2.7 / MiMo-Code, P1-8)
 *
 * Layers:
 * - MEMORY.md: cross-session business state (agent-maintained, repo-root shared)
 * - checkpoint.md: session snapshot (resume point)
 * - notes.md: drafts / scratch
 * - tasks.md: progress tracker
 *
 * Budgeted injection (MiMo): token budget + importance ordering — memory is
 * injected into context up to a budget, most important first.
 *
 * Writing timing (RecMem): don't extract memory on every interaction;
 * recurrence >= threshold triggers consolidation (cost -87%).
 *
 * Source marking (P1-2, AgentPoison principle, cur-104): MEMORY.md entries
 * carry a source tag — verified (independent evidence) / self-report (agent
 * claims, no check) / external (files/other agents, highest risk). Injection
 * weights by tag: verified first, self-report last, external excluded in
 * build mode (plan mode only, prefixed [untrusted]). Recurrence is a write
 * TRIGGER, not verification — repeated self-reports never upgrade to
 * verified (cur-104 Notes).
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { estimateTokens } from "./context.ts";
import { extractSummary } from "./compact.ts";
import type { ChatMessage } from "./loop.ts";

export type MemoryLayer = "memory" | "checkpoint" | "notes" | "tasks";
export type MemoryTag = "verified" | "self-report" | "external";
/** Injection mode: build excludes external entries; plan admits them at low weight. */
export type MemoryMode = "build" | "plan";

export interface MemoryPaths {
  root: string;
  files: Record<MemoryLayer, string>;
}

/** Resolve the four memory files for a repo root. */
export function memoryPaths(repoRoot: string): MemoryPaths {
  const root = join(repoRoot, ".chita");
  return {
    root,
    files: {
      memory: join(root, "MEMORY.md"),
      checkpoint: join(root, "checkpoint.md"),
      notes: join(root, "notes.md"),
      tasks: join(root, "tasks.md"),
    },
  };
}

/** Ensure the .chita memory dir exists. */
export function ensureMemoryDir(repoRoot: string): void {
  mkdirSync(memoryPaths(repoRoot).root, { recursive: true });
}

/** Read a memory layer (empty string if missing). */
export function readLayer(repoRoot: string, layer: MemoryLayer): string {
  const p = memoryPaths(repoRoot).files[layer];
  if (!existsSync(p)) return "";
  return readFileSync(p, "utf-8");
}

/** Write a memory layer (append-only for MEMORY.md via `append`, overwrite for others). */
export function writeLayer(repoRoot: string, layer: MemoryLayer, content: string): void {
  ensureMemoryDir(repoRoot);
  writeFileSync(memoryPaths(repoRoot).files[layer], content);
}

/** Append to MEMORY.md (business state accumulates). */
export function appendMemory(repoRoot: string, entry: string): void {
  ensureMemoryDir(repoRoot);
  const existing = readLayer(repoRoot, "memory");
  const sep = existing && !existing.endsWith("\n") ? "\n" : "";
  const line = `- ${entry}\n`;
  writeFileSync(memoryPaths(repoRoot).files.memory, existing + sep + line);
}

/** Update a task's status in tasks.md (idempotent by task name). */
export function updateTask(repoRoot: string, task: string, status: "done" | "in-progress" | "blocked"): void {
  ensureMemoryDir(repoRoot);
  const existing = readLayer(repoRoot, "tasks");
  const lines = existing.split("\n").filter((l) => l.trim());
  const idx = lines.findIndex((l) => l.startsWith(`- [ ] ${task}`) || l.startsWith(`- [x] ${task}`));
  const marker = status === "done" ? "[x]" : "[ ]";
  const entry = `- ${marker} ${task} (${status})`;
  if (idx >= 0) lines[idx] = entry;
  else lines.push(entry);
  writeFileSync(memoryPaths(repoRoot).files.tasks, lines.join("\n") + "\n");
}

// --- P1-2 source marking (cur-104) --------------------------------------------------

/** A tagged memory entry. Evidence is an inline ref for verified entries. */
export interface MemoryEntry {
  tag: MemoryTag;
  /** Fact text (no leading dash/tag) */
  text: string;
  /** Inline evidence ref for verified entries, e.g. "judge" / "test fix-bug" */
  evidence?: string;
}

/** Line grammar: "- [verified:judge] text" / "- [self-report] text" / "- [external] text". */
const TAG_RE = /^-\s*\[(verified|self-report|external)(?::([^\]]*))?\]\s*(.*)$/;

/** Format a tagged entry (no leading "- "; appendMemory adds it — compatible
 *  with the existing "- ${entry}" line shape, cur-104 nit #5). */
export function formatEntry(entry: MemoryEntry): string {
  const tag = entry.evidence ? `[${entry.tag}:${entry.evidence}]` : `[${entry.tag}]`;
  return `${tag} ${entry.text}`;
}

/** Parse MEMORY.md content into tagged entries; untagged lines default to
 *  self-report (conservative migration, no schema change — cur-104 nit #5). */
export function parseEntries(content: string): MemoryEntry[] {
  const out: MemoryEntry[] = [];
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(TAG_RE);
    if (m) {
      out.push({ tag: m[1] as MemoryTag, evidence: m[2]?.trim() || undefined, text: m[3].trim() });
    } else {
      out.push({ tag: "self-report", text: line.replace(/^-\s*/, "").trim() });
    }
  }
  return out;
}

/** Append a tagged entry to MEMORY.md (append-only, audit-friendly). */
export function appendMemoryEntry(repoRoot: string, entry: MemoryEntry): void {
  appendMemory(repoRoot, formatEntry(entry));
}

/** Record a verified fact. Independent evidence is REQUIRED — callers write
 *  this only after running a subagent's verificationHint successfully or
 *  after judge/eval confirmation (cur-104 Q6). */
export function recordVerified(repoRoot: string, text: string, evidence: string): void {
  appendMemoryEntry(repoRoot, { tag: "verified", text, evidence });
}

// --- Injection ----------------------------------------------------------------------

export interface MemoryInjection {
  /** Layers actually injected (order = priority) */
  injected: MemoryLayer[];
  /** Total estimated tokens */
  tokens: number;
  /** Selected memory entries in weight order (verified → self-report → external) */
  entries: MemoryEntry[];
  /** Rendered markdown block ready to inject as a system message ("" when empty) */
  rendered: string;
}

const LAYER_PRIORITY: MemoryLayer[] = ["tasks", "checkpoint", "notes", "memory"];
/** Default injection budget (tokens) — cur-104 Q2: 512–800, configurable. */
export const DEFAULT_MEMORY_BUDGET = 800;

const TAG_WEIGHT: Record<MemoryTag, number> = { verified: 0, "self-report": 1, external: 2 };

/**
 * Budgeted injection (MiMo + P1-2): whole layers (tasks/checkpoint/notes) fit
 * as a unit in priority order; MEMORY.md is selected PER-ENTRY by tag weight —
 * verified first, self-report next, external only in plan mode. An oversized
 * whole layer is SKIPPED (not a hard stop) so smaller lower-priority content
 * can still fit (Cursor F3); oversized memory entries are skipped individually
 * (cur-104 minor #3 — whole-layer skip made tag weighting a no-op).
 * `rendered` carries EVERYTHING selected (whole layers as [layer] sections +
 * the tagged memory block) — the loop injects exactly this (cur-105 major #1:
 * tokens/rendered must agree, no silent layer loss). Budget counts the ACTUAL
 * rendered text (section headers, "- " prefixes, [untrusted] flags) so the
 * system block never exceeds budgetTokens (cur-105 minor #1).
 */
export function injectMemory(
  repoRoot: string,
  budgetTokens: number = DEFAULT_MEMORY_BUDGET,
  opts: { mode?: MemoryMode } = {}
): MemoryInjection {
  const mode = opts.mode ?? "build";
  const injected: MemoryLayer[] = [];
  const entries: MemoryEntry[] = [];
  const sections: string[] = [];
  let tokens = 0;

  const charge = (t: number): boolean => {
    if (tokens + t > budgetTokens) return false;
    tokens += t;
    return true;
  };

  for (const layer of LAYER_PRIORITY) {
    const content = readLayer(repoRoot, layer);
    if (!content.trim()) continue;
    if (layer === "memory") {
      // Per-entry selection with EXACT rendered-line accounting: header tokens
      // charged once when the first entry is picked (cur-105 minor #1).
      const header = "[memory] (source-tagged; only verified entries are independently checked)";
      const headerT = estimateTokens(header);
      const lines: string[] = [];
      let first = true;
      const parsed = parseEntries(content).sort((a, b) => TAG_WEIGHT[a.tag] - TAG_WEIGHT[b.tag]);
      for (const entry of parsed) {
        if (entry.tag === "external" && mode !== "plan") continue; // excluded in build (cur-104 Q4)
        const line = `- ${entry.tag === "external" ? "[untrusted] " : ""}${formatEntry(entry)}`;
        const extra = first ? headerT : 0;
        if (!charge(estimateTokens(line) + extra)) continue;
        if (first) first = false;
        entries.push(entry);
        lines.push(line);
      }
      if (lines.length) {
        injected.push("memory");
        sections.push([header, ...lines].join("\n"));
      }
    } else {
      // Whole layer: fit the exact section text (header + body) (cur-105 minor #1)
      const section = `[${layer}]\n${content.trimEnd()}`;
      if (charge(estimateTokens(section))) {
        injected.push(layer);
        sections.push(section);
      }
    }
  }

  return { injected, tokens, entries, rendered: sections.join("\n\n") };
}

// --- Consolidation (DONE-only write path) -------------------------------------------

/**
 * Candidate facts from a finished session: done-summary sentences + compact
 * extractor decisions/critical-context lines (paths/errors). cur-104 minor #1:
 * extractSummary is a heuristic, not an authoritative decision list — the done
 * summary is the primary source; Decisions/Next are candidates. All still pass
 * the RecurrenceGate before writing.
 */
export function extractMemoryCandidates(summary: string | undefined, messages: ChatMessage[]): string[] {
  const out: string[] = [];
  if (summary?.trim()) {
    // cur-105 minor #2: `.` + whitespace splits English sentences without
    // fragmenting version numbers ("v2.1" / "0.1.0" have no following space).
    for (const s of summary.split(/[。；;]\s*|\.\s+/)) {
      const t = s.trim();
      if (t && t.length <= 200) out.push(t);
    }
  }
  const compacted = extractSummary(messages);
  for (const d of compacted.keyDecisions) if (d.length <= 200) out.push(d);
  for (const c of compacted.criticalContext) if (c.length <= 200) out.push(c);
  return [...new Set(out)];
}

/**
 * Consolidate a finished session into MEMORY.md (RecMem): only facts that
 * recur (>= threshold, persisted across sessions) are written — all as
 * self-report (unverified agent claims; verified requires independent
 * evidence, see recordVerified). Facts already in MEMORY.md are skipped.
 * DONE-only: callers must NOT invoke this on ERROR/CANCELLED (cur-104 Q1).
 * Returns the facts written.
 */
export function consolidateSessionMemory(
  repoRoot: string,
  summary: string | undefined,
  messages: ChatMessage[],
  gate?: RecurrenceGate
): string[] {
  const existing = new Set(parseEntries(readLayer(repoRoot, "memory")).map((e) => e.text));
  const g = gate ?? new RecurrenceGate();
  const written: string[] = [];
  for (const fact of extractMemoryCandidates(summary, messages)) {
    if (existing.has(fact)) continue;
    if (g.observe(fact)) {
      appendMemoryEntry(repoRoot, { tag: "self-report", text: fact });
      written.push(fact);
    }
  }
  return written;
}

// --- Recurrence gate ----------------------------------------------------------------

/**
 * Write-trigger (RecMem): only consolidate MEMORY.md when a fact recurs.
 * Recurrence counts are PERSISTED (~/.chita/stats/recurrence.json) so the
 * threshold survives process restarts (M4.5 hardening; was in-memory in M4).
 *
 * P1-2 (cur-104 Notes): recurrence is a write TRIGGER, NOT verification —
 * observing the same fact N times never promotes it to `verified`.
 */
export class RecurrenceGate {
  private seen: Map<string, number>;
  private statsPath: string;
  private threshold: number;

  constructor(threshold = 2, statsPath?: string) {
    this.threshold = threshold;
    this.statsPath = statsPath ?? `${process.env.HOME}/.chita/stats/recurrence.json`;
    this.seen = this.load();
  }

  private load(): Map<string, number> {
    try {
      const raw = readFileSync(this.statsPath, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, number>;
      return new Map(Object.entries(parsed));
    } catch {
      return new Map();
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.statsPath), { recursive: true });
      writeFileSync(this.statsPath, JSON.stringify(Object.fromEntries(this.seen)));
    } catch {
      // best effort
    }
  }

  /** Record a fact; returns true when it should be consolidated (>= threshold). */
  observe(fact: string): boolean {
    const n = (this.seen.get(fact) ?? 0) + 1;
    this.seen.set(fact, n);
    this.save();
    return n >= this.threshold;
  }
}
