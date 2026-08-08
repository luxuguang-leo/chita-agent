/**
 * context-manager compaction tests (v2.1 §2.4 M1.5)
 *
 * Covers: compact replaces middle messages with a six-section summary,
 * task + newest messages kept verbatim, fallback to truncate when too few,
 * report note mentions "compacted".
 */

import { test, expect } from "bun:test";
import { ContextManager, estimateTokens } from "./context.ts";
import type { ChatMessage } from "./loop.ts";

function longConversation(n = 30): ChatMessage[] {
  return [
    { role: "user", content: "MAIN_TASK_FIX_THE_BUG" },
    ...Array.from({ length: n }, (_, i) => ({
      role: (i % 2 === 0 ? "assistant" : "tool") as "assistant" | "tool",
      name: i % 2 === 1 ? `tool${i}` : undefined,
      content:
        i % 2 === 1
          ? `tool output ${i}: src/file${i}.ts modified, error at line ${i}`
          : `assistant thinking about step ${i} deciding to edit src/file${i}.ts next`,
    })),
  ];
}

test("compact: task + newest kept, middle summarized", () => {
  const cm = new ContextManager({ maxTokens: 500, thresholdRatio: 0.9 }); // threshold 450
  const messages = longConversation(30);
  const { messages: kept, report } = cm.compact(messages);

  expect(report.truncated).toBe(true);
  expect(report.note).toContain("compacted");
  // task always kept
  expect(kept[0].content).toBe("MAIN_TASK_FIX_THE_BUG");
  // newest messages kept (last ones still there)
  const lastContent = messages[messages.length - 1].content;
  expect(kept.some((m) => m.content === lastContent)).toBe(true);
  // a summary block was injected
  expect(kept.some((m) => m.role === "system" && m.content.includes("# Session Summary"))).toBe(true);
  // total tokens reduced below threshold
  expect(estimateTokens(kept.map((m) => m.content).join(""))).toBeLessThan(450);
});

test("compact: critical context retained in summary (file paths)", () => {
  const cm = new ContextManager({ maxTokens: 300, thresholdRatio: 0.9 });
  const messages = longConversation(20);
  const { messages: kept } = cm.compact(messages);
  const summaryBlock = kept.find((m) => m.role === "system" && m.content.includes("# Session Summary"));
  expect(summaryBlock).toBeDefined();
  // file paths from the summarized middle appear in the summary
  expect(summaryBlock!.content).toMatch(/src\/file\d+\.ts/);
});

test("compact: falls back to truncate when too few messages", () => {
  const cm = new ContextManager({ maxTokens: 100, thresholdRatio: 0.9 }); // threshold 90
  const messages: ChatMessage[] = [
    { role: "user", content: "task" },
    { role: "assistant", content: "x".repeat(200) }, // big
    { role: "tool", content: "y".repeat(200) },
  ];
  const { messages: kept, report } = cm.compact(messages);
  expect(report.truncated).toBe(true);
  // no summary injected (too few messages to summarize)
  expect(kept.some((m) => m.content.includes("# Session Summary"))).toBe(false);
});

test("compact: below threshold is a no-op", () => {
  const cm = new ContextManager({ maxTokens: 10000, thresholdRatio: 0.9 });
  const messages = longConversation(5);
  const { report } = cm.compact(messages);
  expect(report.truncated).toBe(false);
});
