/**
 * continue/seed API tests (T1 前置, cur-031 blocker / cur-032)
 *
 * - continue: appends a turn WITHOUT resetting messages; history preserved
 * - continue: tool_call/tool pairing stays intact across turns
 * - seed: restores history; orphan tool message rejected
 * - run vs continue: run resets, continue doesn't (dual-entry drift guard)
 */

import { test, expect } from "bun:test";
import { AgentLoop, Provider, StreamEvent, ChatMessage } from "./loop.ts";

class FakeProvider implements Provider {
  private script: StreamEvent[][];
  constructor(script: StreamEvent[][]) {
    this.script = script;
  }
  async *chat(_m: ChatMessage[]): AsyncIterable<StreamEvent> {
    const turn = this.script.shift();
    if (!turn) {
      yield { kind: "done", summary: "fallback" };
      return;
    }
    for (const ev of turn) {
      await new Promise((r) => setTimeout(r, 1));
      yield ev;
    }
  }
}

test("continue: appends turn without resetting messages", async () => {
  const loop = new AgentLoop({
    cwd: "/tmp",
    provider: new FakeProvider([
      [{ kind: "done", summary: "first turn done" }],
      [{ kind: "done", summary: "second turn done" }],
    ]),
  });
  const r1 = await loop.run("task one");
  expect(r1.summary).toBe("first turn done");
  const firstCount = loop.getConversation().length;

  const r2 = await loop.continue("task two");
  expect(r2.summary).toBe("second turn done");
  // messages grew, not reset
  expect(loop.getConversation().length).toBeGreaterThan(firstCount);
  // the original task is still there (history preserved)
  expect(loop.getConversation().some((m) => m.content === "task one")).toBe(true);
});

test("continue: tool pairing preserved across turns", async () => {
  const loop = new AgentLoop({
    cwd: "/tmp",
    provider: new FakeProvider([
      // assistant declares toolCalls, then the loop executes the tool
      [
        {
          kind: "message",
          message: {
            role: "assistant",
            content: "reading",
            toolCalls: [{ id: "c1", name: "read", args: "{\"path\":\"a.txt\"}" }],
          },
        },
        { kind: "tool_call", toolName: "read", args: { path: "a.txt" }, callId: "c1" },
      ],
      [{ kind: "done", summary: "after tool" }],
      [{ kind: "done", summary: "third" }],
    ]),
  });
  await loop.run("read the file");
  // after tool call, loop injects the gate -> second provider turn resolves
  const afterTool = loop.getConversation();
  const toolIdx = afterTool.findIndex((m) => m.role === "tool");
  expect(toolIdx).toBeGreaterThan(-1);
  // assistant toolCalls declaration precedes the tool result
  const prev = afterTool[toolIdx - 1];
  expect(prev.role).toBe("assistant");
  expect(prev.toolCalls?.length).toBeGreaterThan(0);

  await loop.continue("now summarize");
  const final = loop.getConversation();
  // the earlier tool result is still in history
  expect(final.some((m) => m.role === "tool")).toBe(true);
});

test("seedConversation: restores history for resume", async () => {
  const loop = new AgentLoop({ cwd: "/tmp", provider: new FakeProvider([]) });
  loop.seedConversation([
    { role: "user", content: "old task" },
    { role: "assistant", content: "old reply", toolCalls: [{ id: "c1", name: "read", args: "{}" }] },
    { role: "tool", name: "read", toolCallId: "c1", content: "file" },
    { role: "user", content: "follow-up" },
  ]);
  expect(loop.getConversation().length).toBe(4);
  expect(loop.getConversation()[0].content).toBe("old task");
});

test("seedConversation: rejects orphan tool message (cur-032)", () => {
  const loop = new AgentLoop({ cwd: "/tmp", provider: new FakeProvider([]) });
  // tool message without a preceding assistant toolCalls declaration
  expect(() =>
    loop.seedConversation([
      { role: "user", content: "task" },
      { role: "tool", name: "read", toolCallId: "c1", content: "file" },
    ])
  ).toThrow(/orphan tool/);
});

test("run resets, continue doesn't (dual-entry drift guard, cur-032)", async () => {
  const loop = new AgentLoop({
    cwd: "/tmp",
    provider: new FakeProvider([
      [{ kind: "done", summary: "a" }],
      [{ kind: "done", summary: "b" }],
      [{ kind: "done", summary: "c" }],
    ]),
  });
  await loop.run("first");
  const afterFirst = loop.getConversation().length;
  await loop.continue("second");
  expect(loop.getConversation().length).toBeGreaterThan(afterFirst);

  await loop.run("fresh"); // run RESETS
  const afterRun = loop.getConversation();
  expect(afterRun.length).toBe(1); // only the fresh task
  expect(afterRun[0].content).toBe("fresh");
});

test("continue: abort signal cancels the turn (CANCELLED)", async () => {
  // provider yields forever but checks the abort signal (like fetch does);
  // abort after first event -> loop sees AbortError -> CANCELLED
  const abort = new AbortController();
  const endless: Provider = {
    async *chat(_m: ChatMessage[], opts) {
      while (true) {
        if (opts?.signal?.aborted) throw new DOMException("aborted", "AbortError");
        yield { kind: "message", message: { role: "assistant", content: "tick" } };
        await new Promise((r) => setTimeout(r, 1));
      }
    },
  };
  const loop = new AgentLoop({ cwd: "/tmp", provider: endless, signal: abort.signal });
  const p = loop.continue("task");
  setTimeout(() => abort.abort(), 20);
  const result = await p;
  expect(result.state).toBe("CANCELLED");
});

test("abort: cancelled turn does NOT poison next continue (cur-036)", async () => {
  // turn 1: endless provider + abort -> CANCELLED
  // turn 2: fresh signal via setSignal -> continues fine
  let calls = 0;
  const provider: Provider = {
    async *chat(_m: ChatMessage[], opts) {
      calls++;
      if (calls === 1) {
        // first turn: yield once, then wait for abort (checking signal)
        while (true) {
          if (opts?.signal?.aborted) throw new DOMException("aborted", "AbortError");
          yield { kind: "message", message: { role: "assistant", content: "tick" } };
          await new Promise((r) => setTimeout(r, 1));
        }
      }
      yield { kind: "done", summary: "recovered" };
    },
  };
  const loop = new AgentLoop({ cwd: "/tmp", provider });

  // turn 1: abort mid-run
  const c1 = new AbortController();
  loop.setSignal(c1.signal);
  const p1 = loop.continue("first");
  setTimeout(() => c1.abort(), 20);
  expect((await p1).state).toBe("CANCELLED");

  // turn 2: fresh signal — must NOT be immediately aborted
  const c2 = new AbortController();
  loop.setSignal(c2.signal);
  const r2 = await loop.continue("second");
  expect(r2.state).toBe("DONE");
  expect(r2.summary).toBe("recovered");
});
