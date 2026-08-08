/**
 * chita context-manager — M1 truncation version (v2.1 §2.4)
 *
 * M1 scope: estimateTokens + threshold truncation + overflowRecovery.
 * (M1.5 adds six-section compaction: Goal/Constraints/Progress/Decisions/Next/Critical.)
 *
 * Truncation invariants (v2.1):
 * - tool_call/tool_result pairs are dropped or kept together
 * - truncation is observable: emit "[context truncated: dropped N messages / ~K tokens]"
 *   system note + tape context.truncated event (silent loss is worse than overflow)
 * - overflow > 3 times in one session -> terminate the task
 */

import type { ChatMessage } from "../../agent/src/loop.ts";
import { extractSummary, renderSummary } from "./compact.ts";

export interface ContextManagerOptions {
  /** Token budget cap for the conversation (default <1M per v2.1 §2.2) */
  maxTokens?: number;
  /** Ratio (0-1) of maxTokens at which truncation triggers (default 0.9) */
  thresholdRatio?: number;
}

export interface TruncationReport {
  truncated: boolean;
  droppedMessages: number;
  droppedTokens: number;
  note: string | null;
  /** compact (six-section summary) vs truncate (plain drop) — Cursor F5 */
  mode?: "compact" | "truncate";
}

const MAX_TOKENS_DEFAULT = 1_000_000;
const THRESHOLD_RATIO_DEFAULT = 0.9;

/**
 * Token estimation (v2.1 §2.1):
 * - M1: 4× chars conservative (CJK ~1.5) — safe upper bound, no deps
 * - M1.5: gpt-tokenizer (cl100k_base) when installed; falls back to 4×
 */
let tokenizer: ((text: string) => number[]) | null = null;
try {
  // gpt-tokenizer is pure JS (audit-friendly); optional dep — absent in M1
  const mod = await import("gpt-tokenizer");
  if (typeof mod.encode === "function") tokenizer = mod.encode as (text: string) => number[];
} catch {
  tokenizer = null;
}

export function estimateTokens(text: string): number {
  if (tokenizer) {
    try {
      return tokenizer(text).length;
    } catch {
      // fall through to heuristic
    }
  }
  // Heuristic: CJK ~1.5 tokens/char, ASCII ~4 chars/token (conservative)
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (/[\u4e00-\u9fff]/.test(ch)) cjk++;
    else other++;
  }
  return Math.ceil(cjk / 1.5 + other / 4);
}

export function estimateMessagesTokens(messages: ChatMessage[]): number {
  let total = 0;
  for (const m of messages) total += estimateTokens(m.content);
  return total;
}

export class ContextManager {
  private maxTokens: number;
  private threshold: number;
  private overflowCount = 0;
  private overflowLimit = 3;

  constructor(opts: ContextManagerOptions = {}) {
    this.maxTokens = opts.maxTokens ?? MAX_TOKENS_DEFAULT;
    this.threshold = Math.floor(this.maxTokens * (opts.thresholdRatio ?? THRESHOLD_RATIO_DEFAULT));
  }

  /**
   * Truncate the message list if it exceeds the threshold.
   * Drops oldest messages; tool_call/tool_result pairs kept or dropped together.
   * Returns a report for observability (system note + tape event).
   */
  truncate(messages: ChatMessage[]): { messages: ChatMessage[]; report: TruncationReport } {
    const total = estimateMessagesTokens(messages);
    if (total <= this.threshold) {
      return { messages, report: { truncated: false, droppedMessages: 0, droppedTokens: 0, note: null, mode: "truncate" } };
    }

    // Drop from the front, keeping the first (user task) message always
    let kept = messages.slice(0, 1);
    let rest = messages.slice(1);
    let droppedTokens = 0;
    let droppedMessages = 0;

    while (rest.length > 0 && estimateMessagesTokens([...kept, ...rest]) > this.threshold) {
      const [head, ...tail] = rest;
      // Pair invariant: if head is a tool_result, drop its tool_call pair too
      // (tool_call/tool_result must be kept or dropped together — v2.1 §2.4)
      if (head.role === "tool") {
        // find the matching tool_call earlier in rest and drop both
        const callIdx = rest.findIndex((m) => m.role === "assistant" && m.content.includes(head.name ?? ""));
        if (callIdx > -1 && callIdx < 20) {
          // only if nearby (avoid dropping huge swaths)
          droppedTokens += estimateTokens(rest[callIdx].content);
          droppedMessages++;
          rest = rest.filter((_, i) => i !== callIdx);
        }
        droppedTokens += estimateTokens(head.content);
        droppedMessages++;
        rest = tail;
        continue;
      }
      droppedTokens += estimateTokens(head.content);
      droppedMessages++;
      rest = tail;
    }

    const result = [...kept, ...rest];
    const note = `[context truncated: dropped ${droppedMessages} messages / ~${droppedTokens} tokens]`;
    return {
      messages: result,
      report: { truncated: true, droppedMessages, droppedTokens, note, mode: "truncate" },
    };
  }

  /**
   * M1.5 compaction: replace the oldest messages with a six-section summary
   * (Goal/Constraints/Progress/Decisions/Next/Critical) instead of dropping
   * them. The summary keeps working context (file paths, errors) while
   * collapsing conversational bulk. Falls back to truncate if there are too
   * few messages to summarize (nothing but the task + summary itself).
   */
  compact(messages: ChatMessage[]): { messages: ChatMessage[]; report: TruncationReport } {
    const total = estimateMessagesTokens(messages);
    if (total <= this.threshold) {
      return { messages, report: { truncated: false, droppedMessages: 0, droppedTokens: 0, note: null, mode: "compact" } };
    }

    // Keep: task (first user msg) + newest messages within a budget
    // Summarize: everything in between
    const keptCount = Math.min(8, messages.length - 2); // task + summary + newest few
    const oldest = messages.slice(0, 1); // user task — always kept verbatim
    let cutIdx = Math.max(2, messages.length - keptCount);

    // Pair invariant (v2.1 §2.4, Cursor F2): newest must not start with an
    // orphan tool_result — pull its matching assistant call forward.
    let newest = messages.slice(cutIdx);
    while (newest.length > 0 && newest[0].role === "tool" && cutIdx > 2) {
      cutIdx--;
      newest = messages.slice(cutIdx);
    }

    const summarizeMe = messages.slice(1, cutIdx);

    if (summarizeMe.length < 2) {
      // not enough to summarize meaningfully — fall back to truncate
      return this.truncate(messages);
    }

    const summary = extractSummary(summarizeMe);
    const summaryBlock = renderSummary(summary);

    const result: ChatMessage[] = [
      ...oldest,
      { role: "system", content: summaryBlock } as ChatMessage,
      ...newest,
    ];
    const droppedTokens = total - estimateMessagesTokens(result);
    const note = `[context compacted: summarized ${summarizeMe.length} messages / saved ~${droppedTokens} tokens]`;
    return {
      messages: result,
      report: {
        truncated: true,
        droppedMessages: summarizeMe.length,
        droppedTokens: Math.max(0, droppedTokens),
        note,
        mode: "compact",
      },
    };
  }

  /**
   * Overflow recovery: called on context overflow error.
   * Counts occurrences; returns false when the task must terminate (overflow > 3).
   */
  overflowRecovery(): { shouldTerminate: boolean; remaining: number } {
    this.overflowCount++;
    const remaining = this.overflowLimit - this.overflowCount;
    return { shouldTerminate: remaining < 0, remaining };
  }

  /** Reset overflow counter after a successful compaction/truncation */
  resetOverflow(): void {
    this.overflowCount = 0;
  }

  currentOverflowCount(): number {
    return this.overflowCount;
  }
}
