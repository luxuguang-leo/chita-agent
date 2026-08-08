/**
 * chita tool system (v2.1 §2.3)
 *
 * - Tool interface: name/description/parameters + execute(args, ctx)
 * - Permission levels: allow / ask / deny
 * - beforeToolCall hook: the single place permission/audit hooks into
 *   (Pi's verdict: "permission policy belongs at beforeToolCall, not as a
 *   post-hoc fix after the model answers")
 * - ctx carries a sandbox hook (reserved; real sandbox lands M4+)
 */

import type { Permission } from "../../session/src/trace.ts";

export interface ToolContext {
  /** Working directory for the tool execution */
  cwd: string;
  /** Permission decision for this call (filled by beforeToolCall) */
  permission: Permission;
  /** Reserved sandbox hook (M4+; no-op today) */
  sandbox?: { id: string };
  /** Abort signal (user interrupt / budget cap) */
  signal?: AbortSignal;
}

export interface ToolResult {
  ok: boolean;
  /** Output text (may be truncated to 4096 bytes — first line of defense, v2.1 F4) */
  output?: string;
  /** Truncation marker */
  truncated?: boolean;
  /** Error message (ok=false) */
  error?: string;
  /** Evidence verification hint (M3 subagent contract) */
  verificationHint?: string;
  /** Secrets were scrubbed from output (v2.1 F4; written back to trace) */
  redacted?: boolean;
}

export interface Tool {
  name: string;
  description: string;
  /** JSON Schema for arguments */
  parameters: Record<string, unknown>;
  /** Default permission: ask for write/bash, allow for read */
  defaultPermission: Permission;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> | ToolResult;
}

/** Result of a beforeToolCall hook */
export type ToolCallVerdict = { allow: true } | { allow: false; reason: string };

/** Hook: permission + audit + scrub (v2.1 §2.3, M1: before_tool_call only) */
export interface ToolCallHooks {
  beforeToolCall?(tool: Tool, args: Record<string, unknown>, ctx: ToolContext): ToolCallVerdict | Promise<ToolCallVerdict>;
}

/** Tool registry: name -> Tool with permission enforcement */
export class ToolRegistry {
  private tools = new Map<string, Tool>();
  private hooks: ToolCallHooks;

  constructor(hooks: ToolCallHooks = {}) {
    this.hooks = hooks;
  }

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  /**
   * Execute a tool with permission enforcement:
   * 1. resolve tool
   * 2. run beforeToolCall hook (can block)
   * 3. enforce permission (allow/ask/deny; M1: ask resolves to deny unless auto-approved)
   * 4. execute
   */
  async execute(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) return { ok: false, error: `unknown tool: ${name}` };

    // beforeToolCall hook: audit/block (Pi's recommended interception point)
    if (this.hooks.beforeToolCall) {
      const verdict = await this.hooks.beforeToolCall(tool, args, ctx);
      if (!verdict.allow) return { ok: false, error: `blocked by beforeToolCall: ${verdict.reason}` };
    }

    // Permission enforcement
    if (ctx.permission === "deny") {
      return { ok: false, error: `permission denied: ${name}` };
    }
    if (ctx.permission === "ask") {
      // M1: no interactive prompt yet -> deny writes, keep read-only safe
      if (tool.defaultPermission === "allow") {
        // read-only tool requested with ask: allow
      } else {
        return { ok: false, error: `permission needed (ask) for ${name} — M1 has no interactive prompt` };
      }
    }

    return await tool.execute(args, ctx);
  }
}

/** Truncate output to 4096 bytes (v2.1 F4 first line of defense) */
export function truncateOutput(text: string, max = 4096): { output: string; truncated: boolean } {
  if (text.length <= max) return { output: text, truncated: false };
  return { output: text.slice(0, max), truncated: true };
}
