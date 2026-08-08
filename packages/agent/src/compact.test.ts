/**
 * compaction tests (v2.1 §2.4 six-section schema, M1.5)
 *
 * Covers: empty summary render, goal extraction, next-steps detection,
 * critical-context retention (file paths, function names, errors).
 */

import { test, expect } from "bun:test";
import { extractSummary, renderSummary, EMPTY_SUMMARY } from "./compact.ts";

test("empty summary renders a stable block", () => {
  const out = renderSummary(EMPTY_SUMMARY);
  expect(out).toContain("# Session Summary (compacted)");
  expect(out).toContain("## Goal");
  expect(out).toContain("## Critical Context");
  expect(out).toContain("(none)");
});

test("goal comes from the first user message", () => {
  const s = extractSummary([
    { role: "user", content: "Fix the bug in the checkout flow" },
    { role: "assistant", content: "Let me look" },
  ]);
  expect(s.goal).toContain("Fix the bug");
});

test("next steps detected from explicit markers", () => {
  const s = extractSummary([
    { role: "user", content: "task" },
    { role: "assistant", content: "Next: run the tests\n下一步: verify deploy" },
  ]);
  expect(s.nextSteps.length).toBeGreaterThan(0);
  expect(s.nextSteps.some((n) => n.includes("run the tests"))).toBe(true);
});

test("critical context retains file paths and function names", () => {
  const s = extractSummary([
    { role: "user", content: "task" },
    {
      role: "assistant",
      content: "Found the bug in src/adapter.py:2508 in function fetch_channel",
    },
  ]);
  expect(s.criticalContext.some((c) => c.includes("src/adapter.py"))).toBe(true);
  expect(s.criticalContext.some((c) => c.includes("fetch_channel"))).toBe(true);
});

test("tool errors always retained", () => {
  const s = extractSummary([
    { role: "user", content: "task" },
    { role: "tool", content: "ERROR: bash command failed with exit 2" },
  ]);
  expect(s.criticalContext.some((c) => c.includes("ERROR"))).toBe(true);
});

test("summary is deterministic and bounded", () => {
  const msgs = Array.from({ length: 50 }, (_, i) => ({
    role: (i % 2 === 0 ? "assistant" : "tool") as string,
    content: `message ${i} with src/file${i}.ts and function fn${i}`,
  }));
  msgs.unshift({ role: "user", content: "do a big task" });
  const s = extractSummary(msgs);
  expect(s.criticalContext.length).toBeLessThanOrEqual(30);
  const rendered = renderSummary(s);
  expect(rendered.length).toBeLessThan(3000);
});
