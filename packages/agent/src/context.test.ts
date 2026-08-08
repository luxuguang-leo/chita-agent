/**
 * context-manager tests (v2.1 §2.4 M1 truncation version)
 *
 * Covers: token estimation, threshold truncation, pair invariant
 * (tool_call/tool_result kept or dropped together), observability note,
 * overflow termination (>3).
 */

import { test, expect } from "bun:test";
import { ContextManager, estimateTokens } from "./context.ts";
import type { ChatMessage } from "./loop.ts";

test("estimateTokens: 4x chars for ASCII, ~1.5x for CJK", () => {
  // "hello world" = 11 ASCII chars -> ~3 tokens (11/4 = 2.75 -> 3)
  expect(estimateTokens("hello world")).toBe(3);
  // Chinese chars count individually (~1.5 per char): 4 chars -> ceil(4/1.5)=3
  const cn = "你好世界";
  expect(estimateTokens(cn)).toBe(3);
  // empty
  expect(estimateTokens("")).toBe(0);
});

test("truncate: below threshold is a no-op", () => {
  const cm = new ContextManager({ maxTokens: 1000, thresholdRatio: 0.9 }); // threshold 900
  const messages: ChatMessage[] = [
    { role: "user", content: "task" },
    { role: "assistant", content: "x".repeat(100) },
  ];
  const { report } = cm.truncate(messages);
  expect(report.truncated).toBe(false);
});

test("truncate: drops oldest messages, keeps the first user task", () => {
  // threshold 90: 10 messages of 40 chars each (~10 tokens each = 100 > 90)
  const cm = new ContextManager({ maxTokens: 100, thresholdRatio: 0.9 }); // threshold 90
  const messages: ChatMessage[] = [
    { role: "user", content: "KEEP_ME" },
    ...Array.from({ length: 10 }, (_, i) => ({
      role: "assistant" as const,
      content: `message number ${i} `.repeat(5), // ~100 chars ~25 tokens
    })),
  ];
  const { messages: kept, report } = cm.truncate(messages);
  expect(report.truncated).toBe(true);
  expect(kept[0].content).toBe("KEEP_ME"); // first user message always kept
  expect(kept.length).toBeLessThan(messages.length);
  expect(report.note).toContain("[context truncated: dropped");
});

test("truncate: tool_call/tool_result pairs kept or dropped together", () => {
  const cm = new ContextManager({ maxTokens: 100, thresholdRatio: 0.9 });
  const messages: ChatMessage[] = [
    { role: "user", content: "task" },
    { role: "assistant", content: "let me call read" },
    { role: "tool", name: "read", content: "file content ".repeat(30) }, // ~360 chars ~90 tokens
    { role: "assistant", content: "done" },
  ];
  const { messages: kept, report } = cm.truncate(messages);
  expect(report.truncated).toBe(true);
  // The tool message and its pair must both be gone (or both present)
  const hasTool = kept.some((m) => m.role === "tool");
  const hasCall = kept.some((m) => m.role === "assistant" && m.content.includes("let me call read"));
  expect(hasTool).toBe(hasCall);
});

test("overflowRecovery: terminates after 3", () => {
  const cm = new ContextManager();
  expect(cm.overflowRecovery().shouldTerminate).toBe(false); // 1
  expect(cm.overflowRecovery().shouldTerminate).toBe(false); // 2
  expect(cm.overflowRecovery().shouldTerminate).toBe(false); // 3
  expect(cm.overflowRecovery().shouldTerminate).toBe(true); // 4 -> terminate
});

test("resetOverflow: clears counter", () => {
  const cm = new ContextManager();
  cm.overflowRecovery();
  cm.overflowRecovery();
  expect(cm.currentOverflowCount()).toBe(2);
  cm.resetOverflow();
  expect(cm.currentOverflowCount()).toBe(0);
});
