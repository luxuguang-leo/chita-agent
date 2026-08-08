/**
 * workflow tests (v2.1 §2.6 deterministic orchestration)
 *
 * Covers: all stages succeed, first-failing stage stops the workflow,
 * bounded retries recover, spec pipeline template.
 */

import { test, expect } from "bun:test";
import { runWorkflow, specPipeline, WorkflowStage } from "./workflow.ts";
import { Provider, StreamEvent, ChatMessage } from "./loop.ts";

/** Provider that throws the first K calls then succeeds (bounded-retry recovery). */
class FlakyProvider implements Provider {
  private failuresLeft: number;
  constructor(failures: number) {
    this.failuresLeft = failures;
  }
  async *chat(_m: ChatMessage[]): AsyncIterable<StreamEvent> {
    if (this.failuresLeft > 0) {
      this.failuresLeft--;
      throw new Error("api exploded");
    }
    await new Promise((r) => setTimeout(r, 1));
    yield { kind: "done", summary: "stage done" };
  }
}

function okProvider(): Provider {
  return {
    async *chat(_m: ChatMessage[]): AsyncIterable<StreamEvent> {
      await new Promise((r) => setTimeout(r, 1));
      yield { kind: "done", summary: "ok" };
    },
  };
}

test("workflow: all stages succeed", async () => {
  const stages: WorkflowStage[] = [
    { name: "a", task: "do a" },
    { name: "b", task: "do b" },
    { name: "c", task: "do c" },
  ];
  const result = await runWorkflow("wf", stages, { cwd: "/tmp", provider: okProvider() });
  expect(result.allOk).toBe(true);
  expect(result.stages.map((s) => s.name)).toEqual(["a", "b", "c"]);
});

test("workflow: first failing stage stops the workflow", async () => {
  const stages: WorkflowStage[] = [
    { name: "bad", task: "always fail", maxRetries: 1 },
    { name: "never", task: "should not run" },
  ];
  const neverProvider: Provider = {
    async *chat(_m: ChatMessage[]): AsyncIterable<StreamEvent> {
      await new Promise((r) => setTimeout(r, 1));
      yield { kind: "message", message: { role: "assistant", content: "stalled" } };
    },
  };
  const result = await runWorkflow("wf", stages, { cwd: "/tmp", provider: neverProvider });
  expect(result.allOk).toBe(false);
  expect(result.stages.length).toBe(1);
  expect(result.stages[0].name).toBe("bad");
  expect(result.stages[0].ok).toBe(false);
});

test("workflow: bounded retries recover", async () => {
  const stages: WorkflowStage[] = [{ name: "flaky", task: "retry me", maxRetries: 3 }];
  const result = await runWorkflow("wf", stages, {
    cwd: "/tmp",
    provider: new FlakyProvider(2), // fails twice, succeeds third
    backoffMs: 1, // fast retries in test
  });
  expect(result.allOk).toBe(true);
  expect(result.stages[0].attempts).toBe(3);
});

test("workflow: retries exhausted -> stage fails", async () => {
  const stages: WorkflowStage[] = [{ name: "never-ok", task: "fail", maxRetries: 1 }];
  const alwaysFail: Provider = {
    async *chat(_m: ChatMessage[]): AsyncIterable<StreamEvent> {
      await new Promise((r) => setTimeout(r, 1));
      yield { kind: "message", message: { role: "assistant", content: "stalled" } };
    },
  };
  const result = await runWorkflow("wf", stages, { cwd: "/tmp", provider: alwaysFail, backoffMs: 1 });
  expect(result.allOk).toBe(false);
  expect(result.stages[0].attempts).toBe(2); // 1 initial + 1 retry (maxRetries=1)
});

test("specPipeline: implement -> verify -> finalize template", () => {
  const stages = specPipeline({ spec: "add a login page", verifyCommand: "npm test" });
  expect(stages.map((s) => s.name)).toEqual(["implement", "verify", "finalize"]);
  expect(stages[0].task).toContain("add a login page");
  expect(stages[1].task).toContain("npm test");
});
