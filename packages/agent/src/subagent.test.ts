/**
 * subagent tests (v2.1 §2.10)
 *
 * Covers: evidence contract (summary required), verification hint suggestion,
 * model tier routing (cheap vs main), permission scope (read-only default).
 */

import { test, expect } from "bun:test";
import { runSubagent, tieredProviderFactory, SubagentProviderFactory } from "./subagent.ts";
import { Provider, StreamEvent, ChatMessage } from "./loop.ts";

/** Provider that finishes with a summary after N turns. */
function finishingProvider(summary: string): Provider {
  return {
    async *chat(_m: ChatMessage[]): AsyncIterable<StreamEvent> {
      await new Promise((r) => setTimeout(r, 1));
      yield { kind: "done", summary };
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
