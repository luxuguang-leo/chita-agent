/**
 * chita trace schema — 评估驱动的燃料（v2.1 §2.2 / §8）
 *
 * 设计要点：
 * - 每条消息/工具调用全量记录，是 traces 唯一来源
 * - fault-side：失败归因（model/harness/tool/env），判定优先级 env→tool→harness→model
 * - verification_hint：subagent 证据契约（M3），M0 预留字段
 * - redacted：脱敏标记（v2.1 F4：tape 可能吸入密钥）
 * - pinning：MCP/Skills 供应链审计 stub（v2.1 N2，name/version/commit/hash/来源）
 */

/** 失败归因侧（Scale AI fault-side，v2.1 §8） */
export type FaultSide = "model" | "harness" | "tool" | "env" | "unknown";

/** 消息角色（v2.1 §2.1 四类 + system/context 事件） */
export type TraceRole =
  | "user"
  | "assistant"
  | "tool"
  | "reasoning"
  | "system"
  | "context";

/** trace 事件类型 */
export type TraceEventType =
  | "message" // 常规消息（user/assistant/reasoning/system）
  | "tool_call" // 模型请求调用工具
  | "tool_result" // 工具执行结果
  | "judge" // /goal judge 评估（M4）
  | "context_truncated" // context-manager 截断（v2.1 可观测性）
  | "error" // 错误事件
  | "done"; // done 工具调用（v2.1 §2.2 早停硬门）

/** 工具权限（v2.1 §2.3） */
export type Permission = "allow" | "ask" | "deny";

/** MCP/Skills 供应链 pinning stub（v2.1 N2） */
export interface PinningStub {
  /** 资源名（skill 名 / MCP server 名） */
  name: string;
  /** 版本 */
  version?: string;
  /** 来源 commit */
  commit?: string;
  /** 内容哈希 */
  hash?: string;
  /** 来源（npm / github / local / 自研） */
  source: "npm" | "github" | "local" | "builtin" | "unknown";
}

/** 工具调用元数据 */
export interface ToolCallMeta {
  name: string;
  args?: unknown;
  /** 权限裁决（v2.1 §2.3，挂 beforeToolCall hook） */
  permission: Permission;
  /** 超时（ms） */
  timeoutMs?: number;
}

/** 基础 trace 事件 */
export interface TraceEventBase {
  /** 事件序号（单调递增） */
  seq: number;
  type: TraceEventType;
  /** ISO 8601 时间戳 */
  ts: string;
  /** token 估算（M1 4×字符保守估计，M1.5 tokenizer） */
  tokens?: number;
  /** 失败归因（error/judge 事件填） */
  faultSide?: FaultSide;
  /** 脱敏标记：true = 原内容含敏感信息已 scrub（v2.1 F4） */
  redacted?: boolean;
}

/** 消息事件 */
export interface MessageEvent extends TraceEventBase {
  type: "message";
  role: Exclude<TraceRole, "tool">;
  content: string;
}

/** 工具调用事件 */
export interface ToolCallEvent extends TraceEventBase {
  type: "tool_call";
  tool: ToolCallMeta;
}

/** 工具结果事件 */
export interface ToolResultEvent extends TraceEventBase {
  type: "tool_result";
  toolName: string;
  /** 成功与否 */
  ok: boolean;
  /** 输出（可能被截断 4096 字节，v2.1 F4 第一道防线） */
  output?: string;
  /** 截断标记 */
  truncated?: boolean;
  /** 错误信息（ok=false 时） */
  error?: string;
}

/** judge 评估事件（M4） */
export interface JudgeEvent extends TraceEventBase {
  type: "judge";
  verdict: "pass" | "fail" | "uncertain";
  reason?: string;
}

/** 上下文截断事件（v2.1 截断可观测性） */
export interface ContextTruncatedEvent extends TraceEventBase {
  type: "context_truncated";
  /** 丢弃的消息数 */
  droppedMessages: number;
  /** 估算丢弃 token 数 */
  droppedTokens: number;
}

/** 错误事件（v2.1 §2.4 错误分层） */
export interface ErrorEvent extends TraceEventBase {
  type: "error";
  /** 错误分类：4xx 不重试 / 5xx/429 退避 / overflow / malformed */
  category: "auth" | "rate_limit" | "server" | "overflow" | "malformed" | "other";
  /** 是否可重试（4xx 不可，5xx/429 可） */
  retryable: boolean;
  message: string;
}

/** done 事件（v2.1 §2.2 早停硬门） */
export interface DoneEvent extends TraceEventBase {
  type: "done";
  summary?: string;
}

/** 联合 trace 事件 */
export type TraceEvent =
  | MessageEvent
  | ToolCallEvent
  | ToolResultEvent
  | JudgeEvent
  | ContextTruncatedEvent
  | ErrorEvent
  | DoneEvent;

/** 会话元数据（tape 头部，v2.1 §2.7） */
export interface SessionMeta {
  sessionId: string;
  /** 工作目录（按 cwd 分组存储） */
  cwd: string;
  repoRoot?: string;
  model: string;
  provider: string;
  createdAt: string;
  /** 父会话（fork 语义，v2.1 §2.7） */
  parentId?: string;
  /** 引用资源 pinning（MCP/Skills，v2.1 N2） */
  pinnedResources?: PinningStub[];
}

/** trace 文件 = JSONL，每行一个 TraceEvent；首行可为 SessionMeta（以 __meta 标记） */
export interface TraceFile {
  __meta: SessionMeta;
  events: TraceEvent[];
}
