/**
 * chita ai layer — Provider abstraction (v2.1 §2.1)
 *
 * Unified message structure + streaming + tool calls + usage.
 * M1: OpenAI-compatible protocol (DeepSeek/Kimi/GLM/Ollama all speak it).
 * Anthropic protocol lands M1.5.
 *
 * StreamEvent mirrors the agent loop's expectation:
 *   message / tool_call / tool_result / done (+ usage)
 */

import type { ChatMessage, StreamEvent, ChatTool } from "../../agent/src/loop.ts";

export interface ProviderConfig {
  /** Base URL of an OpenAI-compatible endpoint */
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Max tokens per response */
  maxTokens?: number;
}

export interface OpenAIStreamChunk {
  id: string;
  choices: {
    index: number;
    delta: {
      role?: string;
      content?: string | null;
      tool_calls?: {
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
    finish_reason?: string | null;
  }[];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

/** Map internal ChatMessage to OpenAI wire format */
export function toOpenAIMessages(messages: ChatMessage[]): Record<string, unknown>[] {
  return messages.map((m) => {
    if (m.role === "tool") {
      return { role: "tool", tool_call_id: m.toolCallId ?? "", content: m.content };
    }
    const base: Record<string, unknown> = { role: m.role, content: m.content };
    // assistant tool_calls declaration -> OpenAI tool_calls array
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      base.tool_calls = m.toolCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: tc.args },
      }));
    }
    return base;
  });
}

export class OpenAICompatibleProvider {
  private cfg: ProviderConfig;

  constructor(cfg: ProviderConfig) {
    this.cfg = cfg;
  }

  /**
   * Stream chat completions from an OpenAI-compatible endpoint.
   * Yields: message (assistant text), tool_call, done, usage.
   */
  async *chat(messages: ChatMessage[], opts?: { signal?: AbortSignal; tools?: ChatTool[] }): AsyncIterable<StreamEvent> {
    const body: Record<string, unknown> = {
      model: this.cfg.model,
      messages: toOpenAIMessages(messages),
      stream: true,
      max_tokens: this.cfg.maxTokens ?? 4096,
    };
    // Tools as OpenAI function-calling format (DeepSeek/Kimi/GLM/Ollama all support it)
    if (opts?.tools && opts.tools.length > 0) {
      body.tools = opts.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      body.tool_choice = "auto";
    }

    const res = await fetch(`${this.cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.cfg.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: opts?.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`chat request failed: ${res.status} ${text.slice(0, 200)}`);
    }
    if (!res.body) throw new Error("no response body");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let assistantContent = "";
    let toolCalls = new Map<number, { id: string; name: string; args: string }>();
    let done = false;
    let usage: OpenAIStreamChunk["usage"];

    try {
      while (true) {
        const { done: streamDone, value } = await reader.read();
        if (streamDone) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE lines: "data: {json}"
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const payload = trimmed.slice(5).trim();
          if (payload === "[DONE]") {
            done = true;
            break;
          }
          let chunk: OpenAIStreamChunk;
          try {
            chunk = JSON.parse(payload) as OpenAIStreamChunk;
          } catch {
            continue;
          }
          for (const choice of chunk.choices ?? []) {
            const delta = choice.delta ?? {};
            if (delta.content) {
              assistantContent += delta.content;
              yield { kind: "message", message: { role: "assistant", content: delta.content } };
            }
            for (const tc of delta.tool_calls ?? []) {
              const cur = toolCalls.get(tc.index) ?? { id: tc.id ?? "", name: "", args: "" };
              if (tc.id) cur.id = tc.id;
              if (tc.function?.name) cur.name += tc.function.name;
              if (tc.function?.arguments) cur.args += tc.function.arguments;
              toolCalls.set(tc.index, cur);
            }
          }
          if (chunk.usage) {
            usage = chunk.usage;
          }
        }
        if (done) break;
      }
    } finally {
      reader.releaseLock();
    }

    // Emit tool calls after the stream completes (assistant finished, tool calls requested)
    if (toolCalls.size > 0) {
      // 1) the assistant message declaring tool_calls (OpenAI requires it in
      //    the conversation before the tool results reference call ids)
      const declared = [...toolCalls.values()].map((tc) => ({
        id: tc.id,
        name: tc.name,
        args: tc.args,
      }));
      if (assistantContent || declared.length > 0) {
        yield {
          kind: "message",
          message: { role: "assistant", content: assistantContent, toolCalls: declared },
        };
      }
      // 2) per-call events for the loop to execute
      for (const tc of toolCalls.values()) {
        if (tc.name) {
          let args: Record<string, unknown> = {};
          try {
            args = tc.args ? (JSON.parse(tc.args) as Record<string, unknown>) : {};
          } catch {
            // malformed args: pass raw string; loop/registry will surface it
          }
          yield { kind: "tool_call", toolName: tc.name, args, callId: tc.id };
        }
      }
    }
    // Emit usage unconditionally (cur-045: token stats broke when tool calls
    // suppressed the done-with-usage path; loop accumulates ev.usage regardless
    // of kind)
    if (usage) {
      yield {
        kind: "usage",
        usage: {
          tokens: usage.total_tokens,
          input: usage.prompt_tokens ?? 0,
          output: usage.completion_tokens ?? 0,
        },
      };
    }

    // Final: emit done ONLY when there were no tool calls. If the model
    // requested tools, the loop executes them and feeds results back for the
    // next turn — emitting done here would terminate mid-toolchain (real
    // DeepSeek run exposed this: tool result never reached the model).
    if (toolCalls.size === 0) {
      if (usage) {
        yield {
          kind: "done",
          summary: assistantContent,
          usage: {
            tokens: usage.total_tokens,
            input: usage.prompt_tokens ?? 0,
            output: usage.completion_tokens ?? 0,
          },
        };
      } else {
        // Stream ended without [DONE] and no tool calls: plain final message.
        // The loop's done-hard-gate injects the gate note.
        return;
      }
    }
  }
}
