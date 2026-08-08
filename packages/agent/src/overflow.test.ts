/**
 * overflow recovery wiring tests (v2.1 §2.4, Cursor F4)
 *
 * - provider throws context-overflow -> loop compacts + retries
 * - >3 overflows -> loop terminates with ERROR
 * - non-overflow errors -> ERROR with faultSide=env trace
 */

import { test, expect } from "bun:test";
import { AgentLoop, Provider, StreamEvent, ChatMessage } from "./loop.ts";

/** Provider that throws overflow N times then succeeds */
class OverflowProvider implements Provider {
  private throwsLeft: number;
  constructor(throws: number) {
    this.throwsLeft = throws;
  }
  async *chat(_m: ChatMessage[]): AsyncIterable<StreamEvent> {
    if (this.throwsLeft > 0) {
      this.throwsLeft--;
      throw new Error("This model's maximum context length is 200000 tokens");
    }
    await new Promise((r) => setTimeout(r, 1));
    yield { kind: "done", summary: "recovered" };
  }
}

test("overflow: compact + retry recovers", async () => {
  const loop = new AgentLoop({ cwd: "/tmp", provider: new OverflowProvider(2) });
  const result = await loop.run("task");
  expect(result.state).toBe("DONE");
  expect(result.summary).toBe("recovered");
});

test("overflow: >3 terminates with ERROR", async () => {
  const loop = new AgentLoop({ cwd: "/tmp", provider: new OverflowProvider(10) });
  const result = await loop.run("task");
  expect(result.state).toBe("ERROR");
});

test("non-overflow provider error -> ERROR with faultSide env", async () => {
  const provider: Provider = {
    async *chat(): AsyncIterable<StreamEvent> {
      throw new Error("connection refused");
    },
  };
  const errors: { category: string; faultSide?: string }[] = [];
  const loop = new AgentLoop({
    cwd: "/tmp",
    provider,
    hooks: {
      beforeToolCall: async () => true,
      onEvent: (ev) => {
        if (ev.type === "error") errors.push({ category: ev.category, faultSide: ev.faultSide });
      },
    },
  });
  const result = await loop.run("task");
  expect(result.state).toBe("ERROR");
  expect(errors.length).toBe(1);
  expect(errors[0].category).toBe("timeout");
  expect(errors[0].faultSide).toBe("env");
});
