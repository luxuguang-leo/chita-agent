/**
 * build/plan dual-mode tests (v2.1 §2.3, opencode build/plan)
 *
 * plan: read-only — write/bash/git blocked, read/grep/ls allowed
 * build: full execution — autoApproveAsk can approve write/bash
 */

import { test, expect } from "bun:test";
import { AgentLoop, Provider, StreamEvent, ChatMessage } from "./loop.ts";

class FakeProvider implements Provider {
  private remaining: StreamEvent[][];
  constructor(script: StreamEvent[][]) {
    this.remaining = script;
  }
  async *chat(_m: ChatMessage[]): AsyncIterable<StreamEvent> {
    const turn = this.remaining.shift();
    if (!turn) {
      yield { kind: "message", message: { role: "assistant", content: "stalled" } };
      return;
    }
    for (const ev of turn) {
      await new Promise((r) => setTimeout(r, 1));
      yield ev;
    }
  }
}

function scriptWith(toolName: string, args: Record<string, unknown>): StreamEvent[][] {
  return [
    [{ kind: "tool_call", toolName, args }],
    [{ kind: "done", summary: "done" }],
  ];
}

test("plan mode: write tool blocked", async () => {
  const blocked: string[] = [];
  const loop = new AgentLoop({
    cwd: "/tmp",
    provider: new FakeProvider(scriptWith("write", { path: "x.txt", content: "y" })),
    mode: "plan",
    hooks: {
      beforeToolCall: async () => true,
      onEvent: (ev) => {
        if (ev.type === "tool_result" && !ev.ok) blocked.push(ev.toolName);
      },
    },
  });
  const result = await loop.run("analyze");
  expect(result.state).toBe("DONE");
  expect(blocked).toContain("write");
});

test("plan mode: bash tool blocked", async () => {
  const blocked: string[] = [];
  const loop = new AgentLoop({
    cwd: "/tmp",
    provider: new FakeProvider(scriptWith("bash", { command: "rm -rf x" })),
    mode: "plan",
    hooks: {
      beforeToolCall: async () => true,
      onEvent: (ev) => {
        if (ev.type === "tool_result" && !ev.ok) blocked.push(ev.toolName);
      },
    },
  });
  await loop.run("analyze");
  expect(blocked).toContain("bash");
});

test("plan mode: read tool still works", async () => {
  const calls: string[] = [];
  const loop = new AgentLoop({
    cwd: "/tmp",
    provider: new FakeProvider(scriptWith("read", { path: "a.txt" })),
    mode: "plan",
    hooks: {
      beforeToolCall: async (name: string) => {
        calls.push(name);
        return true;
      },
    },
  });
  const result = await loop.run("analyze");
  expect(result.state).toBe("DONE");
  expect(calls).toContain("read");
});

test("build mode: autoApproveAsk approves write", async () => {
  const results: string[] = [];
  const loop = new AgentLoop({
    cwd: "/tmp",
    provider: new FakeProvider(scriptWith("write", { path: "x.txt", content: "y" })),
    autoApproveAsk: true,
    mode: "build",
    hooks: {
      beforeToolCall: async () => true,
      onEvent: (ev) => {
        if (ev.type === "tool_result") results.push(ev.ok ? "ok" : "denied");
      },
    },
  });
  await loop.run("write it");
  expect(results).toContain("ok");
});

test("plan mode: autoApproveAsk does NOT override plan restriction", async () => {
  const results: string[] = [];
  const loop = new AgentLoop({
    cwd: "/tmp",
    provider: new FakeProvider(scriptWith("bash", { command: "echo hi" })),
    autoApproveAsk: true,
    mode: "plan",
    hooks: {
      beforeToolCall: async () => true,
      onEvent: (ev) => {
        if (ev.type === "tool_result") results.push(ev.ok ? "ok" : "denied");
      },
    },
  });
  await loop.run("analyze");
  expect(results).toContain("denied"); // plan beats autoApprove
});
