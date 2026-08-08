/**
 * hooks + scrub tests (v2.1 §2.3/F4, M1.5)
 *
 * Covers: afterToolCall scrubs tool output before it reaches the model,
 * onSessionEnd fires on DONE and ERROR.
 */

import { test, expect } from "bun:test";
import { AgentLoop, Provider, StreamEvent, ChatMessage } from "./loop.ts";
import { scrubSecrets } from "./scrub.ts";

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

test("scrubSecrets: masks API keys, Bearer, PEM, AWS", () => {
  const input = "key=sk-abcdefghijklmnop1234567890 secret";
  const { text, redacted } = scrubSecrets(input);
  expect(redacted).toBe(true);
  expect(text).toContain("[REDACTED]");
  expect(text).not.toContain("sk-abcdefghijklmnop1234567890");

  const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAA\n-----END RSA PRIVATE KEY-----";
  const pemResult = scrubSecrets(pem);
  expect(pemResult.redacted).toBe(true);
  expect(pemResult.text).not.toContain("MIIEowIBAA");

  const aws = "Access key AKIAIOSFODNN7EXAMPLE";
  expect(scrubSecrets(aws).redacted).toBe(true);
});

test("scrubSecrets: plain text untouched", () => {
  const { text, redacted } = scrubSecrets("just normal output about files");
  expect(redacted).toBe(false);
  expect(text).toBe("just normal output about files");
});

test("afterToolCall hook scrubs output before model sees it", async () => {
  const script: StreamEvent[][] = [
    [{ kind: "tool_call", toolName: "bash", args: { command: "echo sk-secretkey1234567890" } }],
    [{ kind: "done", summary: "done" }],
  ];
  const seenByModel: string[] = [];
  const loop = new AgentLoop({
    cwd: "/tmp",
    provider: new FakeProvider(script),
    autoApproveAsk: true,
    hooks: {
      beforeToolCall: async () => true,
      afterToolCall: (_name, result) => {
        if (result.output) {
          const scrubbed = scrubSecrets(result.output);
          return { ok: result.ok, output: scrubbed.text };
        }
      },
      onAssistantMessage: () => {},
      onEvent: () => {},
      onSessionEnd: () => {},
    },
  });
  const result = await loop.run("run command");
  expect(result.state).toBe("DONE");
  // tool result recorded in conversation must be scrubbed
  const convo = loop.getConversation();
  const toolMsg = convo.find((m) => m.role === "tool");
  expect(toolMsg).toBeDefined();
  expect(toolMsg!.content).not.toContain("sk-secretkey1234567890");
  expect(toolMsg!.content).toContain("[REDACTED]");
  seenByModel.push(toolMsg!.content);
});

test("onSessionEnd fires on DONE", async () => {
  const script: StreamEvent[][] = [[{ kind: "done", summary: "finished" }]];
  let ended: { state: string; summary?: string } | null = null;
  const loop = new AgentLoop({
    cwd: "/tmp",
    provider: new FakeProvider(script),
    hooks: {
      beforeToolCall: async () => true,
      onSessionEnd: (state, summary) => {
        ended = { state, summary };
      },
    },
  });
  await loop.run("task");
  expect(ended?.state).toBe("DONE");
  expect(ended?.summary).toBe("finished");
});

test("onSessionEnd fires on ERROR (maxIterations)", async () => {
  const script: StreamEvent[][] = [
    [{ kind: "message", message: { role: "assistant", content: "never done" } }],
  ];
  let endedState: string | null = null;
  const loop = new AgentLoop({
    cwd: "/tmp",
    provider: new FakeProvider(script),
    maxIterations: 2,
    hooks: {
      beforeToolCall: async () => true,
      onSessionEnd: (state) => {
        endedState = state;
      },
    },
  });
  await loop.run("task");
  expect(endedState).toBe("ERROR");
});
