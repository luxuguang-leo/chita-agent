/**
 * agent loop tests — state machine + done hard gate + steer/follow-up
 *
 * Uses a scripted FakeProvider (no network) to drive deterministic scenarios.
 */

import { test, expect } from "bun:test";
import { AgentLoop, Provider, StreamEvent, ChatMessage } from "./loop.ts";
import { ToolRegistry } from "../../tools/src/index.ts";
import { registerBuiltinTools } from "../../tools/src/builtin.ts";

/** Scripted provider: replays a fixed sequence of stream events per turn */
class FakeProvider implements Provider {
  private remaining: StreamEvent[][];
  constructor(script: () => StreamEvent[][]) {
    this.remaining = script();
  }
  async *chat(messages: ChatMessage[]): AsyncIterable<StreamEvent> {
    const turn = this.remaining.shift();
    if (!turn) {
      yield { kind: "message", message: { role: "assistant", content: "stalled" } };
      return;
    }
    for (const ev of turn) {
      // yield to the event loop between events so external steer() can land
      await new Promise((r) => setTimeout(r, 1));
      yield ev;
    }
  }
}

function makeLoop(script: () => StreamEvent[][]): { loop: AgentLoop; calls: string[] } {
  const calls: string[] = [];
  const hooks = {
    beforeToolCall: async (name: string) => {
      calls.push(name);
      return true;
    },
  };
  const loop = new AgentLoop({ cwd: "/tmp", provider: new FakeProvider(script), hooks });
  return { loop, calls };
}

test("done tool hard gate: done() call transitions to DONE", async () => {
  // Turn 1: model says final text without done -> loop injects gate message
  // Turn 2: model calls done -> DONE
  const script = [
    [{ kind: "message", message: { role: "assistant", content: "I think I'm done" } }],
    [{ kind: "done", summary: "task complete" }],
  ];
  const { loop } = makeLoop(() => script);
  const result = await loop.run("do something");
  expect(result.state).toBe("DONE");
  expect(result.summary).toBe("task complete");
});

test("steering message injected between turns", async () => {
  const script = [
    [{ kind: "message", message: { role: "assistant", content: "planning..." } }],
    [{ kind: "message", message: { role: "assistant", content: "adjusted" } }],
    [{ kind: "done", summary: "ok" }],
  ];
  // Inject the steer right after the first assistant message (turn boundary)
  let steered = false;
  const hooks = {
    beforeToolCall: async () => true,
    onAssistantMessage: (msg: ChatMessage) => {
      if (!steered && msg.content === "planning...") {
        steered = true;
      }
    },
  };
  const loop = new AgentLoop({
    cwd: "/tmp",
    provider: new FakeProvider(() => script),
    hooks,
  });
  const runPromise = loop.run("task");
  // steer before the second turn drains (synchronously after first turn)
  setTimeout(() => loop.steer("don't touch package.json"), 1);
  const result = await runPromise;
  expect(result.state).toBe("DONE");
  const convo = loop.getConversation();
  expect(convo.some((m) => m.content.includes("[steer]"))).toBe(true);
});

test("tool call executes through registry with permission hook", async () => {
  const toolCalls: string[] = [];
  const script = [
    [
      { kind: "tool_call", toolName: "read", args: { path: "package.json" } },
      { kind: "message", message: { role: "assistant", content: "read it" } },
    ],
    [{ kind: "done", summary: "done" }],
  ];
  const { loop, calls } = makeLoop(() => script);
  // capture tool executions via hooks
  const result = await loop.run("read package.json");
  expect(result.state).toBe("DONE");
  expect(calls.includes("read")).toBe(true);
  toolCalls.push(...calls);
  expect(toolCalls.length).toBeGreaterThan(0);
});

test("maxIterations cap stops runaway loop", async () => {
  const script = [[{ kind: "message", message: { role: "assistant", content: "never done" } }]];
  const loop = new AgentLoop({
    cwd: "/tmp",
    provider: new FakeProvider(() => script),
    maxIterations: 3,
  });
  const result = await loop.run("loop forever");
  expect(result.state).toBe("ERROR");
});

test("builtin tools registered by default", () => {
  const registry = new ToolRegistry();
  registerBuiltinTools(registry);
  const names = registry.list().map((t) => t.name);
  expect(names).toContain("read");
  expect(names).toContain("write");
  expect(names).toContain("bash");
  expect(names).toContain("grep");
  expect(names).toContain("ls");
  expect(names).toContain("glob");
  expect(names).toContain("git");
  expect(names).toContain("done");
});
