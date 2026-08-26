/**
 * memory four-layer tests (v2.1 §2.7 / MiMo)
 *
 * Covers: layer read/write/append, task update idempotency, budgeted injection
 * (priority + budget cap), recurrence gate (consolidate only on recurrence).
 */

import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  memoryPaths,
  readLayer,
  writeLayer,
  appendMemory,
  appendMemoryEntry,
  updateTask,
  injectMemory,
  parseEntries,
  recordVerified,
  consolidateSessionMemory,
  RecurrenceGate,
} from "./memory.ts";

function tempRepo(): string {
  return mkdtempSync(join(tmpdir(), "chita-mem-"));
}

test("memoryPaths: four layers under .chita", () => {
  const repo = tempRepo();
  const paths = memoryPaths(repo);
  expect(paths.files.memory.endsWith(".chita/MEMORY.md")).toBe(true);
  expect(paths.files.checkpoint.endsWith(".chita/checkpoint.md")).toBe(true);
  expect(paths.files.notes.endsWith(".chita/notes.md")).toBe(true);
  expect(paths.files.tasks.endsWith(".chita/tasks.md")).toBe(true);
  rmSync(repo, { recursive: true, force: true });
});

test("writeLayer + readLayer roundtrip", () => {
  const repo = tempRepo();
  writeLayer(repo, "memory", "# MEMORY\n- key fact");
  expect(readLayer(repo, "memory")).toContain("key fact");
  expect(readLayer(repo, "notes")).toBe(""); // missing -> empty
  rmSync(repo, { recursive: true, force: true });
});

test("appendMemory accumulates", () => {
  const repo = tempRepo();
  appendMemory(repo, "fact one");
  appendMemory(repo, "fact two");
  const content = readLayer(repo, "memory");
  expect(content).toContain("fact one");
  expect(content).toContain("fact two");
  rmSync(repo, { recursive: true, force: true });
});

test("updateTask: idempotent by name", () => {
  const repo = tempRepo();
  updateTask(repo, "fix checkout", "in-progress");
  updateTask(repo, "fix checkout", "done");
  updateTask(repo, "deploy", "blocked");
  const tasks = readLayer(repo, "tasks");
  expect(tasks.match(/fix checkout/g)?.length).toBe(1); // no dup
  expect(tasks).toContain("[x] fix checkout (done)");
  expect(tasks).toContain("[ ] deploy (blocked)");
  rmSync(repo, { recursive: true, force: true });
});

test("injectMemory: whole-layer priority + per-entry memory selection (P1-2)", () => {
  const repo = tempRepo();
  writeLayer(repo, "tasks", Array.from({ length: 10 }, (_, i) => `- [ ] task ${i}: handle the thing`).join("\n"));
  writeLayer(repo, "memory", Array.from({ length: 30 }, (_, i) => `- key fact ${i} about the project`).join("\n"));
  writeLayer(repo, "notes", Array.from({ length: 60 }, (_, i) => `note ${i} draft content here`).join("\n"));

  const small = injectMemory(repo, 150);
  // tasks whole layer fits (~109 tok); memory is selected PER-ENTRY (cur-104
  // minor #3) so the remaining budget admits a few entries instead of dropping
  // the whole layer.
  expect(small.injected[0]).toBe("tasks");
  expect(small.injected).toContain("memory");
  expect(small.tokens).toBeLessThanOrEqual(150);
  expect(small.entries.length).toBeGreaterThan(0);
  expect(small.entries.every((e) => e.tag === "self-report")).toBe(true); // untagged -> self-report
  expect(small.rendered).toContain("[memory]");
  // cur-105 major #1: selected whole layers MUST appear in rendered too
  expect(small.rendered).toContain("[tasks]");
  expect(small.rendered).toContain("task 0: handle the thing");
  expect(small.rendered).not.toContain("[notes]"); // notes didn't fit under 150

  const large = injectMemory(repo, 100000);
  // checkpoint empty -> skipped; order: tasks, notes, memory
  expect(large.injected[0]).toBe("tasks");
  expect(large.injected).toContain("memory");
  expect(large.injected).toContain("notes");
  expect(large.entries.length).toBe(30);
  expect(large.rendered).toContain("[notes]");
  expect(large.rendered).toContain("note 0 draft content here");
  rmSync(repo, { recursive: true, force: true });
});

test("parseEntries: tagged entries + untagged migration default (P1-2)", () => {
  const repo = tempRepo();
  writeLayer(
    repo,
    "memory",
    [
      "- [verified:judge] the fix passed independent review",
      "- [self-report] user prefers terse replies",
      "- [external] README claims X",
      "- legacy untagged fact",
    ].join("\n")
  );
  const entries = parseEntries(readLayer(repo, "memory"));
  expect(entries).toEqual([
    { tag: "verified", evidence: "judge", text: "the fix passed independent review" },
    { tag: "self-report", text: "user prefers terse replies" },
    { tag: "external", text: "README claims X" },
    { tag: "self-report", text: "legacy untagged fact" }, // cur-104 nit #5: no tag -> self-report
  ]);
  rmSync(repo, { recursive: true, force: true });
});

test("appendMemoryEntry + formatEntry: line shape stays '- [tag] text'", () => {
  const repo = tempRepo();
  appendMemoryEntry(repo, { tag: "verified", text: "fact", evidence: "test fix-bug" });
  appendMemoryEntry(repo, { tag: "self-report", text: "claim" });
  const content = readLayer(repo, "memory");
  expect(content).toContain("- [verified:test fix-bug] fact");
  expect(content).toContain("- [self-report] claim");
  rmSync(repo, { recursive: true, force: true });
});

test("recordVerified: writes a verified entry with evidence", () => {
  const repo = tempRepo();
  recordVerified(repo, "the suite is green on main", "test bun test");
  const entries = parseEntries(readLayer(repo, "memory"));
  expect(entries[0].tag).toBe("verified");
  expect(entries[0].evidence).toBe("test bun test");
  rmSync(repo, { recursive: true, force: true });
});

test("injectMemory weighting: verified first, external excluded in build (P1-2)", () => {
  const repo = tempRepo();
  writeLayer(
    repo,
    "memory",
    [
      "- [self-report] fact A",
      "- [external] fact B from file",
      "- [verified:judge] fact C",
      "- [self-report] fact D",
    ].join("\n")
  );

  // build mode: external excluded (cur-104 Q4), verified before self-report
  const build = injectMemory(repo, 100000, { mode: "build" });
  expect(build.entries.map((e) => e.text)).toEqual(["fact C", "fact A", "fact D"]);
  expect(build.rendered).not.toContain("fact B");

  // plan mode: external admitted, flagged [untrusted]
  const plan = injectMemory(repo, 100000, { mode: "plan" });
  expect(plan.entries.map((e) => e.text)).toEqual(["fact C", "fact A", "fact D", "fact B from file"]);
  expect(plan.rendered).toContain("[untrusted] [external] fact B from file");

  rmSync(repo, { recursive: true, force: true });
});

test("injectMemory budget squeeze: verified displaces self-report (P1-2)", () => {
  const repo = tempRepo();
  writeLayer(
    repo,
    "memory",
    [
      "- [self-report] " + "s".repeat(200), // large self-report first in file
      "- [verified:judge] short verified fact",
    ].join("\n")
  );
  // Budget fits only the verified entry (~7 tok) — weight ordering must select
  // it even though self-report appears first in the file.
  const inj = injectMemory(repo, 50, { mode: "build" });
  expect(inj.entries.map((e) => e.text)).toEqual(["short verified fact"]);
  rmSync(repo, { recursive: true, force: true });
});

test("consolidateSessionMemory: recurrence-only, dedupe, self-report tag (P1-2)", () => {
  const repo = tempRepo();
  const statsPath = join(repo, "recurrence.json");
  const messages = [
    { role: "user" as const, content: "fix the checkout bug" },
    { role: "assistant" as const, content: "decided to use flock for locking" },
  ];

  // First session: fact observed once -> NOT written
  let written = consolidateSessionMemory(repo, "checkout works now", messages, new RecurrenceGate(2, statsPath));
  expect(written).toEqual([]);
  expect(readLayer(repo, "memory")).toBe("");

  // Second session: same facts recur -> written as self-report
  written = consolidateSessionMemory(repo, "checkout works now", messages, new RecurrenceGate(2, statsPath));
  expect(written).toContain("checkout works now");
  expect(written).toContain("decided to use flock for locking");
  const entries = parseEntries(readLayer(repo, "memory"));
  expect(entries.every((e) => e.tag === "self-report")).toBe(true);

  // Third session: already in MEMORY.md -> skipped (no duplicates)
  written = consolidateSessionMemory(repo, "checkout works now", messages, new RecurrenceGate(2, statsPath));
  expect(written).toEqual([]);
  expect(parseEntries(readLayer(repo, "memory")).filter((e) => e.text === "checkout works now")).toHaveLength(1);

  rmSync(repo, { recursive: true, force: true });
});

test("RecurrenceGate: consolidates only on recurrence", () => {
  const repo = mkdtempSync(join(tmpdir(), "chita-mem-rg-"));
  const gate = new RecurrenceGate(2, join(repo, "recurrence.json"));
  expect(gate.observe("fact-a")).toBe(false); // first sighting
  expect(gate.observe("fact-b")).toBe(false);
  expect(gate.observe("fact-a")).toBe(true); // recurrence -> consolidate
  rmSync(repo, { recursive: true, force: true });
});

test("RecurrenceGate: persists across instances (M4.5)", () => {
  const repo = mkdtempSync(join(tmpdir(), "chita-mem-persist-"));
  const statsPath = join(repo, "recurrence.json");
  try {
    const gate1 = new RecurrenceGate(2, statsPath);
    gate1.observe("persist-fact"); // 1st
    const gate2 = new RecurrenceGate(2, statsPath); // new instance, same file
    expect(gate2.observe("persist-fact")).toBe(true); // count carried over
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
