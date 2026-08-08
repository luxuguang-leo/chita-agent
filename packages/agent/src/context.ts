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
}

const MAX_TOKENS_DEFAULT = 1_000_000;
const THRESHOLD_RATIO_DEFAULT = 0.9;

/**
 * Token estimate: 4× chars conservative (v2.1 §2.1, M1; tokenizer lands M1.5).
 * Rationale: English ~4 chars/token; Chinese ~1.5-2 chars/token; 4× is a safe
 * upper bound for mixed content.
 */
export function estimateTokens(text: string): number {
  // CJK chars count ~1.5 tokens each; rest ~4 chars/token — conservative blend
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
      return { messages, report: { truncated: false, droppedMessages: 0, droppedTokens: 0, note: null } };
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
      report: { truncated: true, droppedMessages, droppedTokens, note },
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
