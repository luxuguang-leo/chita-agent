/**
 * chita trace schema — the fuel for eval-driven development (v2.1 §2.2 / §8)
 *
 * Design notes:
 * - Every message and tool call is recorded in full; this is the only source of traces.
 * - fault-side: failure attribution (model/harness/tool/env), priority env→tool→harness→model
 * - verificationHint: subagent evidence contract (M3), reserved at M0
 * - redacted: redaction marker (v2.1 F4: tapes can absorb secrets)
 * - pinning: MCP/Skills supply-chain audit stub (v2.1 N2: name/version/commit/hash/source)
 */

/** Failure attribution side (Scale AI fault-side, v2.1 §8) */
export type FaultSide = "model" | "harness" | "tool" | "env" | "unknown";

/** Message role (v2.1 §2.1 four roles + system/context events) */
export type TraceRole =
  | "user"
  | "assistant"
  | "tool"
  | "reasoning"
  | "system"
  | "context";

/** Trace event types */
export type TraceEventType =
  | "message" // regular message (user/assistant/reasoning/system)
  | "tool_call" // model requested a tool invocation
  | "tool_result" // tool execution result
  | "judge" // /goal judge evaluation (M4)
  | "context_truncated" // context-manager truncation (v2.1 observability)
  | "error" // error event
  | "done" // done tool call (v2.1 §2.2 early-stop hard gate)
  | "usage"; // token usage snapshot (persisted so resume restores the count)

/** Tool permission (v2.1 §2.3) */
export type Permission = "allow" | "ask" | "deny";

/** MCP/Skills supply-chain pinning stub (v2.1 N2) */
export interface PinningStub {
  /** Resource name (skill name / MCP server name) */
  name: string;
  /** Version */
  version?: string;
  /** Source commit */
  commit?: string;
  /** Content hash */
  hash?: string;
  /** Origin (npm / github / local / self-built) */
  source: "npm" | "github" | "local" | "builtin" | "unknown";
}

/** Tool call metadata */
export interface ToolCallMeta {
  name: string;
  args?: unknown;
  /** Permission ruling (v2.1 §2.3, hooked into beforeToolCall) */
  permission: Permission;
  /** Timeout (ms) */
  timeoutMs?: number;
}

/** Base trace event */
export interface TraceEventBase {
  /** Monotonic event sequence */
  seq: number;
  type: TraceEventType;
  /** ISO 8601 timestamp */
  ts: string;
  /** Token estimate (M1: 4× chars conservative; M1.5: tokenizer) */
  tokens?: number;
  /** Failure attribution (filled for error/judge events) */
  faultSide?: FaultSide;
  /** Redaction marker: true = original content contained secrets and was scrubbed (v2.1 F4) */
  redacted?: boolean;
}

/** Message event */
export interface MessageEvent extends TraceEventBase {
  type: "message";
  role: Exclude<TraceRole, "tool">;
  content: string;
}

/** Tool call event */
export interface ToolCallEvent extends TraceEventBase {
  type: "tool_call";
  tool: ToolCallMeta;
  /** Tool call id (paired with ToolResultEvent.callId; required for M1 parallel/retry) */
  callId?: string;
}

/** Tool result event */
export interface ToolResultEvent extends TraceEventBase {
  type: "tool_result";
  toolName: string;
  /** Tool call id (paired with ToolCallEvent.callId; required for M1 parallel/retry) */
  callId?: string;
  /** Success flag */
  ok: boolean;
  /** Output (possibly truncated to 4096 bytes, v2.1 F4 first line of defense) */
  output?: string;
  /** Truncation marker */
  truncated?: boolean;
  /** Error message (when ok=false) */
  error?: string;
  /** Evidence verification hint (v2.1 §8 / M3 subagent evidence contract, reserved at M0):
   *  a single command the main agent can run to verify this result is real
   *  (e.g. "node test.js") */
  verificationHint?: string;
}

/** Judge evaluation event (M4) */
export interface JudgeEvent extends TraceEventBase {
  type: "judge";
  verdict: "pass" | "fail" | "uncertain";
  reason?: string;
}

/** Context truncation event (v2.1 truncation observability) */
export interface ContextTruncatedEvent extends TraceEventBase {
  type: "context_truncated";
  /** Number of dropped messages */
  droppedMessages: number;
  /** Estimated dropped tokens */
  droppedTokens: number;
  /** Whether this was a six-section compaction or a plain truncate (Cursor F5) */
  mode?: "compact" | "truncate";
}

/** Error event (v2.1 §2.4 error layering) */
export interface ErrorEvent extends TraceEventBase {
  type: "error";
  /** Error category: 4xx no-retry / 5xx+429 backoff / overflow / malformed */
  category: "auth" | "rate_limit" | "server" | "timeout" | "overflow" | "malformed" | "other";
  /** Whether retrying makes sense (4xx no, 5xx/429 yes) */
  retryable: boolean;
  message: string;
}

/** done event (v2.1 §2.2 early-stop hard gate) */
export interface DoneEvent extends TraceEventBase {
  type: "done";
  summary?: string;
}

/** Token usage snapshot (cumulative across the session; restore on resume) */
export interface UsageEvent extends TraceEventBase {
  type: "usage";
  total: number;
  input: number;
  output: number;
}

/** Union of trace events */
export type TraceEvent =
  | MessageEvent
  | ToolCallEvent
  | ToolResultEvent
  | JudgeEvent
  | UsageEvent
  | ContextTruncatedEvent
  | ErrorEvent
  | DoneEvent;

/** Session metadata (tape header, v2.1 §2.7) */
export interface SessionMeta {
  sessionId: string;
  /** Working directory (sessions grouped by cwd) */
  cwd: string;
  repoRoot?: string;
  model: string;
  provider: string;
  createdAt: string;
  /** Parent session (fork semantics, v2.1 §2.7) */
  parentId?: string;
  /** Why this branch was taken / what was explored (v2.1 §2.7) */
  branchSummary?: string;
  /** Pinned resource references (MCP/Skills, v2.1 N2) */
  pinnedResources?: PinningStub[];
}

/** M0 uses a single JSON document (__meta + events[]); M1 tape switches to JSONL (one event per line) */
export interface TraceFile {
  __meta: SessionMeta;
  events: TraceEvent[];
}
