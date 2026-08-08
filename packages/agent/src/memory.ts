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
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { estimateTokens } from "./context.ts";

export type MemoryLayer = "memory" | "checkpoint" | "notes" | "tasks";

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
  const line = `- ${entry}\n`;
  writeFileSync(memoryPaths(repoRoot).files.memory, existing + line);
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

export interface MemoryInjection {
  /** Layers actually injected (order = priority) */
  injected: MemoryLayer[];
  /** Total estimated tokens */
  tokens: number;
}

const LAYER_PRIORITY: MemoryLayer[] = ["tasks", "checkpoint", "notes", "memory"];

/**
 * Budgeted injection (MiMo): inject memory layers up to a token budget,
 * most important first. Returns what was included.
 */
export function injectMemory(repoRoot: string, budgetTokens: number): MemoryInjection {
  const injected: MemoryLayer[] = [];
  let tokens = 0;
  for (const layer of LAYER_PRIORITY) {
    const content = readLayer(repoRoot, layer);
    if (!content.trim()) continue;
    const t = estimateTokens(content);
    if (tokens + t > budgetTokens) break; // budget exhausted
    tokens += t;
    injected.push(layer);
  }
  return { injected, tokens };
}

/**
 * Write-trigger (RecMem): only consolidate MEMORY.md when a fact recurs.
 * Simple recurrence tracker: same fact seen `threshold` times -> append.
 */
export class RecurrenceGate {
  private seen = new Map<string, number>();
  constructor(private threshold = 2) {}

  /** Record a fact; returns true when it should be consolidated (>= threshold). */
  observe(fact: string): boolean {
    const n = (this.seen.get(fact) ?? 0) + 1;
    this.seen.set(fact, n);
    return n >= this.threshold;
  }
}
