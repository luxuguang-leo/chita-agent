#!/usr/bin/env node
/**
 * Mock MCP server for tests: exposes one tool `echo` (returns the message).
 * Launched via stdio by the MCP client tests.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "mock-server", version: "1.0.0" });

server.tool("echo", { message: z.string() }, async (args) => ({
  content: [{ type: "text", text: `echo: ${args.message}` }],
}));

const transport = new StdioServerTransport();
await server.connect(transport);
