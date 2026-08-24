/**
 * subagent tests (v2.1 §2.10)
 *
 * Covers: evidence contract (summary required), verification hint suggestion,
 * model tier routing (cheap vs main), permission scope (read-only default),
 * P1-1 audited contract (artifacts / failedApproaches / acceptanceCriteria /
 * stateVersion).
 */

import { test, expect } from "bun:test";
import { runSubagent, tieredProviderFactory, SubagentProviderFactory } from "./subagent.ts";
import { Provider, StreamEvent, ChatMessage } from "./loop.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Provider that finishes with a summary after N turns. */
function finishingProvider(summary: string): Provider {
  return {
    async *chat(_m: ChatMessage[]): AsyncIterable<StreamEvent> {
      await new Promise((r) => setTimeout(r, 1));
      yield { kind: "done", summary };
    },
  };
}

/** Provider that drives a scripted tool-call sequence then finishes. */
function scriptedProvider(events: StreamEvent[]): Provider {
  return {
    async *chat(): AsyncIterable<StreamEvent> {
      await new Promise((r) => setTimeout(r, 1));
      yield* events;
    },
  };
}

function factory(summary: string, log: string[]): SubagentProviderFactory {
  return {
    makeProvider: (tier) => {
      log.push(tier);
      return finishingProvider(summary);
    },
  };
}

test("subagent: returns TaskResult with summary on DONE", async () => {
  const log: string[] = [];
  const result = await runSubagent(
    { instruction: "investigate the bug and run the tests", cwd: "/tmp" },
    factory("found the root cause", log)
  );
  expect(result?.ok).toBe(true);
  expect(result?.summary).toBe("found the root cause");
  // P1-1: no tool calls -> no artifacts, no failed approaches, version stamped
  expect(result?.artifacts).toEqual([]);
  expect(result?.failedApproaches).toEqual([]);
  expect(result?.stateVersion).toBe(1);
});

test("subagent: default tier is cheap (cost control)", async () => {
  const log: string[] = [];
  await runSubagent({ instruction: "do something and run the tests", cwd: "/tmp" }, factory("done", log));
  expect(log).toEqual(["cheap"]);
});

test("subagent: explicit main tier routes to main provider", async () => {
  const log: string[] = [];
  await runSubagent(
    { instruction: "do something and run the tests", cwd: "/tmp", modelTier: "main" },
    factory("done", log)
  );
  expect(log).toEqual(["main"]);
});

test("subagent: non-DONE outcome -> ok:false with error", async () => {
  const stalled: Provider = {
    async *chat(_m: ChatMessage[]): AsyncIterable<StreamEvent> {
      await new Promise((r) => setTimeout(r, 1));
      yield { kind: "message", message: { role: "assistant", content: "stalled forever" } };
    },
  };
  const result = await runSubagent(
    { instruction: "never finish", cwd: "/tmp", maxIterations: 2 },
    { makeProvider: () => stalled }
  );
  expect(result?.ok).toBe(false);
  expect(result?.error).toContain("did not finish");
});

test("subagent: verification hint suggested for test-related tasks", async () => {
  const result = await runSubagent(
    { instruction: "fix the bug and run the tests", cwd: "/tmp" },
    factory("fixed", [])
  );
  expect(result?.verificationHint).toContain("test");
});

test("tieredProviderFactory: routes main/cheap correctly", () => {
  const main = () => finishingProvider("main");
  const cheap = () => finishingProvider("cheap");
  const f = tieredProviderFactory(main, cheap);
  expect(f.makeProvider("main")).toBeDefined();
  expect(f.makeProvider("cheap")).toBeDefined();
});

test("subagent: evidence contract fails without verification hint", async () => {
  // Task with no test/verify keyword -> no hint derivable -> ok:false
  const result = await runSubagent(
    { instruction: "just describe the code", cwd: "/tmp" },
    factory("described", [])
  );
  expect(result?.ok).toBe(false);
  expect(result?.error).toContain("verification hint");
});

/* ------------------------- P1-1 audited contract ------------------------- */

test("subagent: successful write calls populate artifacts (P1-1)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chita-sub-"));
  const provider = scriptedProvider([
    { kind: "tool_call", toolName: "write", args: { path: "out.txt", content: "hi" }, callId: "c1" },
    { kind: "done", summary: "wrote the file" },
  ]);
  const result = await runSubagent(
    { instruction: "write the file and verify with tests", cwd: dir, permissionScope: "inherit" },
    { makeProvider: () => provider }
  );
  expect(result?.ok).toBe(true);
  expect(result?.artifacts).toEqual(["out.txt"]);
  expect(result?.failedApproaches).toEqual([]);
});

test("subagent: denied write (plan mode) is a failedApproach, not an artifact (P1-1)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chita-sub-"));
  const provider = scriptedProvider([
    { kind: "tool_call", toolName: "write", args: { path: "out.txt", content: "x" }, callId: "c1" },
    { kind: "done", summary: "analyzed" },
  ]);
  // default permissionScope -> plan mode -> write blocked
  const result = await runSubagent(
    { instruction: "analyze the code and verify with tests", cwd: dir },
    { makeProvider: () => provider }
  );
  expect(result?.ok).toBe(true);
  expect(result?.artifacts).toEqual([]);
  expect(result?.failedApproaches).toHaveLength(1);
  expect(result?.failedApproaches?.[0].approach).toContain("write");
  expect(result?.failedApproaches?.[0].evidence).toContain("blocked by plan mode");
});

test("subagent: acceptanceCriteria derived and stateVersion stamped (P1-1)", async () => {
  const result = await runSubagent(
    { instruction: "fix the bug and run the tests", cwd: "/tmp" },
    factory("fixed", [])
  );
  expect(result?.ok).toBe(true);
  expect(result?.acceptanceCriteria).toEqual(["run the test suite mentioned in the task"]);
  expect(result?.stateVersion).toBe(1);
});

test("subagent: caller onEvent still fires through the P1-1 hooks wrapper", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chita-sub-"));
  const seen: string[] = [];
  const provider = scriptedProvider([
    { kind: "tool_call", toolName: "write", args: { path: "out.txt", content: "hi" }, callId: "c1" },
    { kind: "done", summary: "wrote the file" },
  ]);
  const result = await runSubagent(
    { instruction: "write the file and verify with tests", cwd: dir, permissionScope: "inherit" },
    { makeProvider: () => provider },
    { hooks: { onEvent: (ev) => seen.push(ev.type) } }
  );
  expect(result?.ok).toBe(true);
  expect(seen).toContain("tool_call");
  expect(seen).toContain("tool_result");
});

test("subagent: multiple writes collected, duplicates deduped (cur-102)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chita-sub-"));
  const provider = scriptedProvider([
    { kind: "tool_call", toolName: "write", args: { path: "a.txt", content: "1" }, callId: "c1" },
    { kind: "tool_call", toolName: "write", args: { path: "b.txt", content: "2" }, callId: "c2" },
    { kind: "tool_call", toolName: "write", args: { path: "a.txt", content: "3" }, callId: "c3" },
    { kind: "done", summary: "wrote files" },
  ]);
  const result = await runSubagent(
    { instruction: "write files and verify with tests", cwd: dir, permissionScope: "inherit" },
    { makeProvider: () => provider }
  );
  expect(result?.ok).toBe(true);
  expect(result?.artifacts).toEqual(["a.txt", "b.txt"]);
});

test("subagent: write without callId is not an artifact (documented limitation, cur-102)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chita-sub-"));
  const provider = scriptedProvider([
    { kind: "tool_call", toolName: "write", args: { path: "a.txt", content: "1" } }, // no callId
    { kind: "done", summary: "wrote" },
  ]);
  const result = await runSubagent(
    { instruction: "write the file and verify with tests", cwd: dir, permissionScope: "inherit" },
    { makeProvider: () => provider }
  );
  expect(result?.ok).toBe(true);
  expect(result?.artifacts).toEqual([]);
});

test("subagent: ok:false early return still surfaces collected failures (cur-102 F1)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chita-sub-"));
  const provider = scriptedProvider([
    { kind: "tool_call", toolName: "write", args: { path: "out.txt", content: "x" }, callId: "c1" },
    { kind: "done", summary: "described" },
  ]);
  // no test/verify keyword -> no verification hint -> evidence contract fails
  const result = await runSubagent(
    { instruction: "just describe the code", cwd: dir },
    { makeProvider: () => provider }
  );
  expect(result?.ok).toBe(false);
  expect(result?.error).toContain("verification hint");
  expect(result?.failedApproaches).toHaveLength(1);
  expect(result?.failedApproaches?.[0].evidence).toContain("blocked by plan mode");
});
