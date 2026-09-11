/**
 * Trace → conversation reconstruction tests (resume path, cur-109/cur-110).
 *
 * Regression under test: resuming a tape produced a conversation that violated
 * `seedConversation`'s pairing invariant, so chita failed to resume with
 * "seedConversation: orphan tool message". Tapes keep tool results (and, since
 * the fix, tool calls) in append order — these tests pin the rebuilt shape.
 */

import { test, expect } from "bun:test";
import { historyFromEvents } from "./history.ts";
import { AgentLoop, type ChatMessage, type Provider, type StreamEvent } from "./loop.ts";
import type { TraceEvent } from "../../session/src/trace.ts";

/** No events: these tests exercise reconstruction/seeding, not the loop. */
class SilentProvider implements Provider {
  async *chat(_messages: ChatMessage[]): AsyncIterable<StreamEvent> {}
}

function newLoop(): AgentLoop {
  return new AgentLoop({ cwd: "/tmp", provider: new SilentProvider() });
}

let seq = 0;
const TS = "2026-09-12T00:00:00+08:00";

function message(role: "user" | "assistant" | "reasoning" | "system" | "context", content: string): TraceEvent {
  return { seq: ++seq, ts: TS, type: "message", role, content };
}

function toolCall(callId: string, name: string, args?: unknown): TraceEvent {
  return { seq: ++seq, ts: TS, type: "tool_call", tool: { name, args, permission: "allow" }, callId };
}

function toolResult(callId: string | undefined, toolName: string, output: string): TraceEvent {
  return { seq: ++seq, ts: TS, type: "tool_result", toolName, callId, ok: true, output };
}

test("legacy tape: results without declarations are reconstructed, not dropped", () => {
  const history = historyFromEvents([
    message("user", "investigate"),
    toolResult("call_a", "read", "A"),
    toolResult("call_b", "bash", "B"),
    toolResult("call_c", "grep", "C"),
  ]);

  expect(history.map((m) => m.role)).toEqual(["user", "assistant", "tool", "tool", "tool"]);
  expect(history[1].toolCalls?.map((c) => c.id)).toEqual(["call_a", "call_b", "call_c"]);
  expect(history[1].toolCalls?.every((c) => c.args === '{"_resumed":true}')).toBe(true);
  expect(history.filter((m) => m.role === "tool").map((m) => m.content)).toEqual(["A", "B", "C"]);
  expect(() => newLoop().seedConversation(history)).not.toThrow();
});

test("a tool_call after results opens a new declaration (round boundary)", () => {
  const history = historyFromEvents([
    message("user", "go"),
    toolCall("c1", "read"),
    toolResult("c1", "read", "A"),
    toolCall("c2", "bash"),
    toolResult("c2", "bash", "B"),
  ]);

  expect(history.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant", "tool"]);
  expect(history[1].toolCalls?.map((c) => c.id)).toEqual(["c1"]);
  expect(history[3].toolCalls?.map((c) => c.id)).toEqual(["c2"]);
  expect(() => newLoop().seedConversation(history)).not.toThrow();
});

test("assistant text written after tool results still pairs (order approximation)", () => {
  const history = historyFromEvents([
    message("user", "go"),
    toolCall("c1", "read"),
    toolResult("c1", "read", "A"),
    message("assistant", "found it"),
    toolCall("c2", "bash"),
    toolResult("c2", "bash", "B"),
  ]);

  expect(history.filter((m) => m.role === "tool").map((m) => m.toolCallId)).toEqual(["c1", "c2"]);
  expect(() => newLoop().seedConversation(history)).not.toThrow();
});

test("result without callId keeps its content under a fallback id", () => {
  const history = historyFromEvents([message("user", "go"), toolResult(undefined, "bash", "done")]);
  const tool = history[2];

  expect(tool.role).toBe("tool");
  expect(tool.toolCallId).toMatch(/^resumed-\d+$/);
  expect(tool.content).toBe("done");
  expect(() => newLoop().seedConversation(history)).not.toThrow();
});

test("unanswered declarations are pruned (crash mid-tool)", () => {
  const all = historyFromEvents([message("user", "go"), toolCall("c1", "read")]);
  expect(all.map((m) => m.role)).toEqual(["user"]);

  const partial = historyFromEvents([
    message("user", "go"),
    toolCall("c1", "read"),
    toolResult("c1", "read", "A"),
    toolCall("c2", "bash"),
  ]);
  expect(partial.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
  expect(partial[1].toolCalls?.map((c) => c.id)).toEqual(["c1"]);
  expect(() => newLoop().seedConversation(partial)).not.toThrow();
});
test("a declaration cut off from its result is not left dangling (cur-111)", () => {
  // The result was separated from its declaration by a user turn: the
  // declaration must not survive as an unanswered tool_call (the API rejects
  // it), so it is pruned and the result re-declared where it can be paired.
  const history = historyFromEvents([
    toolCall("c1", "read"),
    message("user", "next question"),
    toolResult("c1", "read", "A"),
  ]);

  expect(history.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
  expect(history[1].toolCalls?.map((c) => c.id)).toEqual(["c1"]);
  expect(() => newLoop().seedConversation(history)).not.toThrow();
});

test("non-conversation events and non-API roles are dropped", () => {
  const history = historyFromEvents([
    message("user", "hi"),
    { seq: ++seq, ts: TS, type: "usage", total: 10, input: 8, output: 2 },
    message("reasoning", "thinking..."),
    message("context", "ctx"),
    { seq: ++seq, ts: TS, type: "done", summary: "ok" },
    message("assistant", "here"),
  ]);

  expect(history.map((m) => m.role)).toEqual(["user", "assistant"]);
  expect(history[1].content).toBe("here");
});

test("reconstruction always satisfies the pairing invariant (property)", () => {
  const sequences: TraceEvent[][] = [
    [message("user", "a"), toolCall("c1", "read"), toolResult("c1", "read", "A")],
    [toolResult("c1", "read", "A"), toolResult(undefined, "bash", "B")],
    [message("user", "a"), toolCall("c1", "read")],
    [toolResult("c1", "read", "A"), message("user", "b"), toolResult("c2", "read", "B")],
    [
      message("assistant", "text"),
      toolCall("c1", "read"),
      toolResult("c1", "read", "A"),
      message("assistant", "more"),
    ],
  ];

  for (const events of sequences) {
    const history = historyFromEvents(events);
    expect(() => newLoop().seedConversation(history)).not.toThrow();
    // every declaration must be answered by the tool run right after it
    history.forEach((m, i) => {
      if (m.role !== "assistant" || !m.toolCalls?.length) return;
      expect(history[i + 1]?.role).toBe("tool");
    });
  }
});
