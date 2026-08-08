/**
 * MCP client tests (v2.1 §2.6)
 *
 * Launches the mock MCP server (stdio), discovers its `echo` tool, calls it,
 * and verifies the chita Tool wrapper (permission, truncation, errors).
 */

import { test, expect } from "bun:test";
import { connectMcp } from "./mcp.ts";
import { ToolRegistry } from "../../tools/src/index.ts";
import { join } from "node:path";

const MOCK_SERVER = join(import.meta.dir, "..", "test", "mock-mcp-server.mjs");

test("MCP: discovers tools and calls echo", async () => {
  const handle = await connectMcp({
    name: "mock",
    command: process.execPath, // node
    args: [MOCK_SERVER],
  });
  try {
    expect(handle.tools.length).toBeGreaterThan(0);
    const echo = handle.tools.find((t) => t.name === "mock_echo");
    expect(echo).toBeDefined();
    expect(echo!.defaultPermission).toBe("ask");

    const result = await echo!.execute({ message: "hello mcp" }, { cwd: "/tmp", permission: "allow" });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("echo: hello mcp");
  } finally {
    await handle.close();
  }
});

test("MCP: tools register into chita ToolRegistry", async () => {
  const handle = await connectMcp({
    name: "mock",
    command: process.execPath,
    args: [MOCK_SERVER],
  });
  try {
    const registry = new ToolRegistry();
    for (const t of handle.tools) registry.register(t);
    const names = registry.list().map((t) => t.name);
    expect(names).toContain("mock_echo");
  } finally {
    await handle.close();
  }
});

test("MCP: tool output truncated at 4096", async () => {
  const handle = await connectMcp({
    name: "mock",
    command: process.execPath,
    args: [MOCK_SERVER],
  });
  try {
    const echo = handle.tools.find((t) => t.name === "mock_echo")!;
    const big = "x".repeat(5000);
    const result = await echo.execute({ message: big }, { cwd: "/tmp", permission: "allow" });
    expect(result.truncated).toBe(true);
    expect(result.output!.length).toBeLessThanOrEqual(4096);
  } finally {
    await handle.close();
  }
});
