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
  updateTask,
  injectMemory,
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

test("injectMemory: priority order + budget cap", () => {
  const repo = tempRepo();
  writeLayer(repo, "tasks", Array.from({ length: 10 }, (_, i) => `- [ ] task ${i}: handle the thing`).join("\n"));
  writeLayer(repo, "memory", Array.from({ length: 30 }, (_, i) => `- key fact ${i} about the project`).join("\n"));
  writeLayer(repo, "notes", Array.from({ length: 60 }, (_, i) => `note ${i} draft content here`).join("\n"));

  const small = injectMemory(repo, 150);
  expect(small.injected).toEqual(["tasks"]); // tasks (109 tok) fits, memory (401) doesn't
  expect(small.tokens).toBeLessThanOrEqual(150);

  const large = injectMemory(repo, 100000);
  // checkpoint empty -> skipped; order: tasks, notes, memory
  expect(large.injected[0]).toBe("tasks");
  expect(large.injected).toContain("memory");
  expect(large.injected).toContain("notes");
  rmSync(repo, { recursive: true, force: true });
});

test("RecurrenceGate: consolidates only on recurrence", () => {
  const gate = new RecurrenceGate(2);
  expect(gate.observe("fact-a")).toBe(false); // first sighting
  expect(gate.observe("fact-b")).toBe(false);
  expect(gate.observe("fact-a")).toBe(true); // recurrence -> consolidate
});

test("RecurrenceGate: persists across instances (M4.5)", () => {
  const repo = mkdtempSync(join(tmpdir(), "chita-mem-persist-"));
  const oldHome = process.env.HOME;
  process.env.HOME = repo;
  try {
    const gate1 = new RecurrenceGate(2);
    gate1.observe("persist-fact"); // 1st
    const gate2 = new RecurrenceGate(2); // new instance, same HOME
    expect(gate2.observe("persist-fact")).toBe(true); // count carried over
  } finally {
    process.env.HOME = oldHome;
    rmSync(repo, { recursive: true, force: true });
  }
});
