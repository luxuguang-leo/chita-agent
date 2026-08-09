/**
 * chita agent loop (v2.1 §2.2)
 *
 * State machine: IDLE → THINKING → TOOL_CALL → OBSERVING → THINKING → ... → DONE
 *              + ERROR / CANCELLED / WAITING_USER
 *
 * - done tool hard gate: only a successful done() call transitions to DONE;
 *   pure final text does NOT terminate — the loop injects
 *   "please call done, or continue using tools"
 * - steering: a message inserted between turns ("change direction",
 *   "don't touch that file yet")
 * - follow-up: a task appended when the agent was about to stop
 *   ("run the tests when you finish")
 * - Provider abstraction: chat() streams events; the loop drives it
 */

import { ToolRegistry, ToolContext, ToolResult } from "../../tools/src/index.ts";
import { registerBuiltinTools } from "../../tools/src/builtin.ts";
import type { TraceEvent } from "../../session/src/trace.ts";
import { ContextManager } from "./context.ts";
import { classifyError } from "./errors.ts";

export type LoopState = "IDLE" | "THINKING" | "TOOL_CALL" | "OBSERVING" | "DONE" | "ERROR" | "CANCELLED" | "WAITING_USER";

export type ChatRole = "user" | "assistant" | "tool" | "reasoning" | "system";
export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** Tool call name (role=tool) */
  name?: string;
  /** Tool call id (role=tool; OpenAI requires tool_call_id for tool messages) */
  toolCallId?: string;
  /** Tool calls declared by the assistant (OpenAI assistant message structure) */
  toolCalls?: { id: string; name: string; args: string }[];
}

export interface StreamEvent {
  kind: "message" | "tool_call" | "tool_result" | "done";
  message?: ChatMessage;
  toolName?: string;
  args?: Record<string, unknown>;
  /** Tool call id (OpenAI tool_call_id; required when feeding results back) */
  callId?: string;
  result?: { ok: boolean; output?: string; error?: string };
  summary?: string;
  usage?: { tokens: number };
}

export interface ChatTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface Provider {
  chat(
    messages: ChatMessage[],
    opts?: { signal?: AbortSignal; tools?: ChatTool[] }
  ): AsyncIterable<StreamEvent>;
}

export interface LoopHooks {
  /** Permission/audit interception (v2.1 §2.3) */
  beforeToolCall?(toolName: string, args: Record<string, unknown>, ctx: ToolContext): Promise<boolean>;
  /** Post-execution interception: can rewrite/scrub the result (v2.1 F4 redaction) */
  afterToolCall?(
    toolName: string,
    result: { ok: boolean; output?: string; error?: string }
  ): { ok: boolean; output?: string; error?: string } | void;
  /** Called after each completed turn (for trace recording) */
  onEvent?(event: TraceEvent): void;
  /** Called on every streamed assistant message (UI/trace) */
  onAssistantMessage?(msg: ChatMessage): void;
  /** Called when the loop reaches DONE/ERROR/CANCELLED (M1.5 session_end hook) */
  onSessionEnd?(state: LoopState, summary?: string): void;
}

export type LoopMode = "build" | "plan";

export interface LoopOptions {
  cwd: string;
  provider: Provider;
  tools?: ToolRegistry;
  hooks?: LoopHooks;
  maxIterations?: number;
  maxTokens?: number;
  /** M1 --print dev mode: auto-approve ask-level tools (write/bash) without a prompt.
   *  (v2.1 §2.3; WAITING_USER interactive approval is M1.5+) */
  autoApproveAsk?: boolean;
  /** build: full execution (default). plan: read-only analysis —
   *  write tools forbidden, bash requires explicit approval (opencode build/plan). */
  mode?: LoopMode;
  /** Abort signal: cancels the current turn (Ctrl+C in TUI). */
  signal?: AbortSignal;
}

const DEFAULT_MAX_ITERATIONS = 50;
const DEFAULT_MAX_TOKENS = 1_000_000;

export class AgentLoop {
  state: LoopState = "IDLE";
  private messages: ChatMessage[] = [];
  private steers: string[] = [];
  private followUps: string[] = [];
  private iterations = 0;
  private tokensUsed = 0;
  private opts: LoopOptions;
  private contextManager: ContextManager;

  constructor(opts: LoopOptions) {
    this.opts = opts;
    if (!opts.tools) {
      const registry = new ToolRegistry();
      registerBuiltinTools(registry);
      this.tools = registry;
    } else {
      this.tools = opts.tools;
    }
    this.contextManager = new ContextManager({
      maxTokens: opts.maxTokens,
    });
  }
  private tools: ToolRegistry;

  /** Inject a steering message (between turns). No-op once DONE. */
  steer(text: string): void {
    if (this.state === "DONE" || this.state === "CANCELLED" || this.state === "ERROR") return;
    this.steers.push(text);
  }

  /** Append a follow-up task (when the agent was about to stop). */
  followUp(text: string): void {
    if (this.state === "DONE" || this.state === "CANCELLED" || this.state === "ERROR") return;
    this.followUps.push(text);
  }

  /**
   * run = NEW session: resets messages to [{user: initialTask}] then runs.
   * (TUI must NOT use run for multi-turn — use continue(), cur-032.)
   */
  async run(initialTask: string): Promise<{ state: LoopState; summary?: string }> {
    this.state = "THINKING";
    this.messages = [{ role: "user", content: initialTask }];
    return this.runLoop();
  }

  /**
   * continue = APPEND a turn: pushes the user message onto the EXISTING
   * conversation and runs one more loop (no reset). Multi-turn continuity
   * keeps tool_call/tool pairing and tape consistency (cur-031 blocker).
   */
  async continue(userMessage: string): Promise<{ state: LoopState; summary?: string }> {
    this.messages.push({ role: "user", content: userMessage });
    return this.runLoop();
  }

  /**
   * Refresh the abort signal for the NEXT turn (cur-036: one-shot
   * AbortController pollutes the loop — aborted once, aborted forever).
   * TUI creates a fresh controller per turn and sets it before continue.
   */
  setSignal(signal: AbortSignal): void {
    this.opts.signal = signal;
  }

  /**
   * seed = restore/inject: sets initial messages (resume from tape, tests).
   * Validates tool pairing — an orphan tool message is rejected (cur-032).
   */
  seedConversation(history: ChatMessage[]): void {
    const ok = history.every((m, i) => {
      if (m.role !== "tool") return true;
      // a tool message needs a preceding assistant message with toolCalls
      const prev = history[i - 1];
      return prev?.role === "assistant" && !!prev.toolCalls?.length;
    });
    if (!ok) throw new Error("seedConversation: orphan tool message (no matching assistant toolCalls)");
    this.messages = [...history];
    this.state = "IDLE";
  }

  /** The shared inner loop (run/continue both enter here). */
  private async runLoop(): Promise<{ state: LoopState; summary?: string }> {
    const maxIter = this.opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    const maxTokens = this.opts.maxTokens ?? DEFAULT_MAX_TOKENS;

    while (this.iterations < maxIter && this.tokensUsed < maxTokens) {
      // Drain steering messages first
      if (this.steers.length > 0) {
        const steer = this.steers.shift()!;
        this.messages.push({ role: "system", content: `[steer] ${steer}` });
      }

      this.state = "THINKING";
      let gotDone = false;
      let summary: string | undefined;

      // Context management (v2.1 §2.4): M1.5 uses six-section compaction
      // (falls back to truncation when there's too little to summarize)
      const { messages: kept, report } = this.contextManager.compact(this.messages);
      if (report.truncated) {
        this.messages = kept;
        // observability: system note to the model + trace event (v2.1 §2.4)
        this.messages.push({ role: "system", content: report.note ?? "" });
        this.opts.hooks?.onEvent?.({
          seq: this.iterations,
          type: "context_truncated",
          droppedMessages: report.droppedMessages,
          droppedTokens: report.droppedTokens,
          mode: report.mode ?? "truncate",
          ts: new Date().toISOString(),
        });
        this.contextManager.resetOverflow();
      }

      // Expose registered tools to the provider so the model can call them
      const chatTools: ChatTool[] = this.tools.list().map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      }));

      // Provider call with overflow recovery (v2.1 §2.4, Cursor F4):
      // context overflow -> compact -> retry; >3 overflows -> terminate
      let turnDone = false;
      let pendingAssistant: ChatMessage | null = null;
      while (!turnDone) {
        try {
          for await (const ev of this.opts.provider.chat(this.messages, { signal: this.opts.signal, tools: chatTools })) {
            if (ev.kind === "message" && ev.message) {
              // Streaming fragments: show via hook, accumulate into ONE
              // conversation message (dedup — turn-end message carries full text)
              this.opts.hooks?.onAssistantMessage?.(ev.message);
              if (ev.message.toolCalls && ev.message.toolCalls.length > 0) {
                // turn-end declaration: full assistant message with toolCalls
                pendingAssistant = ev.message;
              } else if (ev.message.content) {
                if (!pendingAssistant) pendingAssistant = { ...ev.message };
                else {
                  const acc: ChatMessage = pendingAssistant;
                  pendingAssistant = { ...acc, content: acc.content + ev.message.content };
                }
              }
            } else if (ev.kind === "tool_call" && ev.toolName) {
              this.state = "TOOL_CALL";
              // flush the assistant message that declared this tool call
              if (pendingAssistant) {
                this.messages.push(pendingAssistant);
                pendingAssistant = null;
              }
              const result = await this.runTool(ev.toolName, ev.args ?? {});
              this.state = "OBSERVING";
              // tool result back to the model as a tool message (OpenAI requires
              // tool_call_id referencing the original tool_calls)
              this.messages.push({
                role: "tool",
                name: ev.toolName,
                toolCallId: ev.callId,
                content: result.ok ? (result.output ?? "") : `ERROR: ${result.error ?? ""}`,
              });
              // done tool hard gate (v2.1 §2.2): a SUCCESSFUL done tool call
              // transitions to DONE — regardless of Provider event kind.
              if (ev.toolName === "done" && result.ok) {
                gotDone = true;
                summary = String(ev.args?.summary ?? "");
                break;
              }
            } else if (ev.kind === "done") {
              gotDone = true;
              summary = ev.summary;
              if (pendingAssistant) {
                this.messages.push(pendingAssistant);
                pendingAssistant = null;
              }
              break;
            }
            if (ev.usage?.tokens) this.tokensUsed += ev.usage.tokens;
          }
          // flush any remaining assistant text (no tools, no done — gate note next)
          if (pendingAssistant) {
            this.messages.push(pendingAssistant);
            pendingAssistant = null;
          }
          turnDone = true;
        } catch (e) {
          // Abort (Ctrl+C in TUI): cancel the turn, propagate as CANCELLED
          if (e instanceof Error && e.name === "AbortError") {
            this.state = "CANCELLED";
            this.opts.hooks?.onSessionEnd?.(this.state);
            return { state: this.state };
          }
          // Classify: only context overflow triggers compact+retry
          const msg = e instanceof Error ? e.message : String(e);
          const classified = classifyError(undefined, msg);
          if (classified.category === "overflow") {
            const { shouldTerminate } = this.contextManager.overflowRecovery();
            if (shouldTerminate) {
              this.state = "ERROR";
              this.opts.hooks?.onSessionEnd?.(this.state);
              return { state: this.state };
            }
            // flush streamed assistant text so compaction has content (F1×F3)
            if (pendingAssistant) {
              this.messages.push(pendingAssistant);
              pendingAssistant = null;
            }
            // compact then retry the same turn; if compaction didn't actually
            // reduce anything, terminate instead of looping on API burn (F3)
            const { messages: compacted, report } = this.contextManager.compact(this.messages);
            if (!report.truncated) {
              this.state = "ERROR";
              this.opts.hooks?.onSessionEnd?.(this.state);
              return { state: this.state };
            }
            this.messages = compacted;
            this.messages.push({ role: "system", content: report.note ?? "" });
            continue;
          }
          // Other errors: report and stop (M2 scope; retry/backoff is M4)
          this.state = "ERROR";
          this.opts.hooks?.onEvent?.({
            seq: this.iterations,
            type: "error",
            category: classified.category,
            retryable: classified.retryable,
            message: msg,
            faultSide: "env",
            ts: new Date().toISOString(),
          });
          return { state: this.state };
        }
      }

      this.iterations++;

      // done tool hard gate: only done() transitions to DONE
      if (gotDone) {
        this.state = "DONE";
        this.opts.hooks?.onSessionEnd?.(this.state, summary);
        return { state: this.state, summary };
      }

      // Pure final text without done: inject the gate message and continue
      if (!gotDone && !this.hasPendingToolCalls()) {
        const followUp = this.followUps.shift();
        if (followUp) {
          this.messages.push({ role: "system", content: `[follow-up] ${followUp}` });
        } else {
          this.messages.push({
            role: "system",
            content:
              "You appear to be done, but you must call the `done` tool with a summary to finish. Continue working or call done.",
          });
        }
      }
    }

    this.state = this.tokensUsed >= maxTokens ? "ERROR" : "DONE";
    if (this.iterations >= maxIter) this.state = "ERROR";
    this.opts.hooks?.onSessionEnd?.(this.state);
    return { state: this.state };
  }

  private hasPendingToolCalls(): boolean {
    const last = this.messages[this.messages.length - 1];
    return last?.role === "tool";
  }  private async runTool(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; output?: string; error?: string }> {
    const ctx: ToolContext = { cwd: this.opts.cwd, permission: "ask", signal: this.opts.signal };
    // Read-only tools default allow; ask stays ask for the hook to decide
    const tool = this.tools.get(name);
    if (tool) ctx.permission = tool.defaultPermission;

    // Plan mode (opencode build/plan): write tools forbidden, bash requires
    // explicit approval — never auto-approved (v2.1 §2.3)
    const WRITE_TOOLS: Record<string, true> = { write: true, bash: true };
    const isWrite = WRITE_TOOLS[name] || (name === "git" && !isReadOnlyGit(args));
    if (this.opts.mode === "plan" && isWrite) {
      return this.emitToolResult(name, { ok: false, error: `blocked by plan mode (read-only analysis): ${name}` });
    }

    // M1 --print dev mode: auto-approve ask-level tools (v2.1 §2.3)
    if (this.opts.autoApproveAsk && ctx.permission === "ask" && this.opts.mode !== "plan") {
      ctx.permission = "allow";
    }

    // Permission hook
    if (this.opts.hooks?.beforeToolCall) {
      const ok = await this.opts.hooks.beforeToolCall(name, args, ctx);
      if (!ok) return this.emitToolResult(name, { ok: false, error: `blocked by beforeToolCall: ${name}` });
    }

    const result = await this.tools.execute(name, args, ctx);

    // afterToolCall hook: scrub/rewrite the result before it reaches the
    // model (v2.1 F4 redaction; audit of sensitive output)
    let finalResult = result;
    if (this.opts.hooks?.afterToolCall) {
      const scrubbed = this.opts.hooks.afterToolCall(name, result);
      if (scrubbed) finalResult = { ...result, ...scrubbed };
    }
    return this.emitToolResult(name, finalResult);
  }

  /** Emit a tool_result trace event and return the result (single choke point) */
  private emitToolResult(name: string, result: ToolResult): ToolResult {
    this.opts.hooks?.onEvent?.({
      seq: this.iterations,
      type: "tool_result",
      toolName: name,
      ok: result.ok,
      output: result.output,
      error: result.error,
      truncated: result.truncated,
      redacted: result.redacted,
      ts: new Date().toISOString(),
    });
    return result;
  }

  /** Current conversation (for resume / trace) */
  getConversation(): ChatMessage[] {
    return this.messages;
  }
}

/** Plan-mode helper: git is read-only when its subcommand is status/diff/log/show (F5). */
function isReadOnlyGit(args: Record<string, unknown>): boolean {
  const sub = String(args.args ?? "").trim();
  return /^(status|diff|log|show)\b/.test(sub) && !/[;&|`$()<>]/.test(sub);
}
