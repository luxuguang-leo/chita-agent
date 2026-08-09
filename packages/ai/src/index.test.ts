/**
 * ai layer tests — OpenAI-compatible streaming with a mock server
 *
 * Spins up a local Bun.serve endpoint that speaks SSE, verifying:
 * - assistant text streams as message events
 * - tool_calls accumulate deltas into a single call with parsed args
 * - usage arrives as a done event AFTER tool calls
 * - malformed tool args don't crash (raw string surfaced)
 */

import { test, expect } from "bun:test";
import { OpenAICompatibleProvider, toOpenAIMessages } from "./index.ts";
import type { ChatMessage } from "../../agent/src/loop.ts";

interface MockCase {
  chunks: object[];
  /** extra SSE events appended after data chunks */
  extra?: string;
}

function startMockServer(scenario: MockCase): { url: string; stop: () => void; requests: string[] } {
  const requests: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      requests.push(req.url);
      const body = `data: ${JSON.stringify(scenario.chunks[0])}\n\n`;
      const rest = scenario.chunks
        .slice(1)
        .map((c) => `data: ${JSON.stringify(c)}\n\n`)
        .join("");
      const tail = scenario.extra ?? "data: [DONE]\n\n";
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(body + rest + tail));
          controller.close();
        },
      });
      return new Response(stream, {
        headers: { "Content-Type": "text/event-stream" },
      });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true), requests };
}

function makeProvider(url: string): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({ baseUrl: url, apiKey: "test-key", model: "mock-model" });
}

test("toOpenAIMessages maps roles correctly", () => {
  const msgs: ChatMessage[] = [
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
    { role: "tool", name: "read", toolCallId: "call_123", content: "file content" },
  ];
  const out = toOpenAIMessages(msgs);
  expect(out[0]).toEqual({ role: "user", content: "hi" });
  expect(out[2]).toEqual({ role: "tool", tool_call_id: "call_123", content: "file content" });
});

test("streams assistant text as message events", async () => {
  const { url, stop } = startMockServer({
    chunks: [
      { id: "1", choices: [{ index: 0, delta: { role: "assistant", content: "Hel" } }] },
      { id: "2", choices: [{ index: 0, delta: { content: "lo" } }] },
    ],
  });
  try {
    const p = makeProvider(url);
    const events = [];
    for await (const ev of p.chat([{ role: "user", content: "hi" }])) {
      events.push(ev);
    }
    expect(events.length).toBe(2);
    expect(events[0].kind).toBe("message");
    expect(events[0].message?.content).toBe("Hel");
    expect(events[1].message?.content).toBe("lo");
  } finally {
    stop();
  }
});

test("tool_calls accumulate deltas and parse args", async () => {
  const { url, stop } = startMockServer({
    chunks: [
      {
        id: "1",
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read", arguments: "{\"path\":" } }] },
          },
        ],
      },
      {
        id: "2",
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { arguments: "\"src/main.js\"}" } }] },
          },
        ],
      },
    ],
    extra: "data: {\"id\":\"3\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}],\"usage\":{\"total_tokens\":42}}\n\ndata: [DONE]\n\n",
  });
  try {
    const p = makeProvider(url);
    const events = [];
    for await (const ev of p.chat([{ role: "user", content: "read it" }])) {
      events.push(ev);
    }
    const toolCall = events.find((e) => e.kind === "tool_call");
    expect(toolCall).toBeDefined();
    expect(toolCall!.toolName).toBe("read");
    expect(toolCall!.args).toEqual({ path: "src/main.js" });

    // No done event after tool calls — the loop runs the tool and continues
    // (fix: usage after tool_calls must not emit done, or the toolchain dies)
    const doneEvent = events.find((e) => e.kind === "done");
    expect(doneEvent).toBeUndefined();
  } finally {
    stop();
  }
});

test("malformed tool args surface without crashing", async () => {
  const { url, stop } = startMockServer({
    chunks: [
      {
        id: "1",
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { name: "bash", arguments: "{broken json" } }] },
          },
        ],
      },
    ],
    extra: "data: [DONE]\n\n",
  });
  try {
    const p = makeProvider(url);
    const events = [];
    for await (const ev of p.chat([{ role: "user", content: "run" }])) {
      events.push(ev);
    }
    const toolCall = events.find((e) => e.kind === "tool_call");
    expect(toolCall).toBeDefined();
    expect(toolCall!.toolName).toBe("bash");
  } finally {
    stop();
  }
});

test("non-200 response throws", async () => {
  const server = Bun.serve({
    port: 0,
    fetch() {
      return new Response("unauthorized", { status: 401 });
    },
  });
  const p = makeProvider(`http://127.0.0.1:${server.port}`);
  try {
    let threw = false;
    try {
      for await (const _ of p.chat([{ role: "user", content: "hi" }])) {
        /* noop */
      }
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  } finally {
    server.stop(true);
  }
});

test("usage emitted even with tool calls (cur-045 token stats)", async () => {
  const { url, stop } = startMockServer({
    chunks: [
      {
        id: "1",
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { name: "read", arguments: "{}" } }] },
          },
        ],
      },
    ],
    extra: "data: {\"id\":\"2\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}],\"usage\":{\"total_tokens\":77}}\n\ndata: [DONE]\n\n",
  });
  try {
    const p = makeProvider(url);
    const events = [];
    for await (const ev of p.chat([{ role: "user", content: "read" }])) {
      events.push(ev);
    }
    const usageEv = events.find((e) => e.kind === "usage");
    expect(usageEv).toBeDefined();
    expect(usageEv!.usage?.tokens).toBe(77);
    // done must NOT fire after tool calls (toolchain continues)
    expect(events.find((e) => e.kind === "done")).toBeUndefined();
  } finally {
    stop();
  }
});
