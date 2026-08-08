/**
 * chita MCP client (v2.1 §2.6) — stdio transport
 *
 * Connects to MCP servers over stdio, discovers their tools, and wraps them
 * as chita Tools so the agent loop can call them. Supply-chain note: MCP
 * servers are third-party code — pinning (name/version/commit/hash) lands in
 * trace via SessionMeta.pinnedResources (v2.1 N2).
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Tool } from "../../tools/src/index.ts";

export interface McpServerConfig {
  /** Display name (used in tool names: "<name>_<tool>") */
  name: string;
  /** Command to spawn (e.g. "npx", "python3") */
  command: string;
  /** Args (e.g. ["-y", "@some/mcp-server"]) */
  args: string[];
  /** Optional env overrides */
  env?: Record<string, string>;
}

export interface McpHandle {
  /** Tools registered into the loop's registry */
  tools: Tool[];
  close(): Promise<void>;
}

/** Launch an MCP server via stdio and collect its tools. */
export async function connectMcp(cfg: McpServerConfig): Promise<McpHandle> {
  const client = new Client({ name: "chita", version: "0.1.0" });
  const transport = new StdioClientTransport({
    command: cfg.command,
    args: cfg.args,
    env: cfg.env,
  });
  await client.connect(transport);

  const toolsResult = await client.listTools();
  const tools: Tool[] = (toolsResult.tools ?? []).map((t) => ({
    name: `${cfg.name}_${t.name}`,
    description: `[MCP ${cfg.name}] ${t.description ?? ""}`,
    parameters: (t.inputSchema ?? { type: "object", properties: {} }) as Record<string, unknown>,
    defaultPermission: "ask", // external tools need permission
    execute: async (args, ctx) => {
      const raw = await client.callTool({
        name: t.name,
        arguments: args,
      });
      const text = extractMcpText(raw);
      const isError = raw?.isError === true;
      const truncated = text.length > 4096;
      return {
        ok: !isError,
        output: truncated ? text.slice(0, 4096) : text,
        truncated,
        error: isError ? text.slice(0, 500) : undefined,
      };
    },
  }));

  return {
    tools,
    close: async () => {
      await client.close();
    },
  };
}

/** Convenience: register all MCP tools into a registry. */
export async function attachMcpServers(
  cfgs: McpServerConfig[],
  registry: { register(t: Tool): void }
): Promise<McpHandle[]> {
  const handles: McpHandle[] = [];
  for (const cfg of cfgs) {
    const handle = await connectMcp(cfg);
    for (const t of handle.tools) registry.register(t);
    handles.push(handle);
  }
  return handles;
}

/**
 * Extract text from an MCP callTool result (content blocks).
 * Type guard: narrows the SDK's loose return shape without unchecked casts.
 */
function extractMcpText(raw: Record<string, unknown>): string {
  const content = Array.isArray(raw.content) ? raw.content : [];
  return content
    .map((c) => {
      if (c && typeof c === "object" && "text" in c && typeof c.text === "string") {
        return c.text;
      }
      return JSON.stringify(c);
    })
    .join("\n");
}
