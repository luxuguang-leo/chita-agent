/**
 * tape-first storage integration test (v2.1 §2.7 semantics)
 *
 * Covers: append-only, readAll, fork (source untouched), crash marker,
 * SqliteIndex FTS5 search, per-cwd grouping. All tests use an injected
 * temp sessions root to avoid touching the real ~/.chita.
 */

import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Tape, tapePaths } from "./tape.ts";
import { SqliteIndex } from "./index.ts";

function tempRoot(): { root: string; cwd: string } {
  return {
    root: mkdtempSync(join(tmpdir(), "chita-tape-")),
    cwd: "/tmp/fake-project",
  };
}

test("tape: append + readAll roundtrip", () => {
  const { root, cwd } = tempRoot();
  const tape = Tape.open(cwd, "sess-001", root);
  tape.appendMeta({ sessionId: "sess-001", cwd, model: "m", provider: "p", createdAt: new Date().toISOString() });
  const seq1 = tape.append({ type: "message", role: "user", content: "hello" } as never);
  const seq2 = tape.append({ type: "tool_call", tool: { name: "read", permission: "allow" } } as never);
  expect(seq1).toBe(1);
  expect(seq2).toBe(2);

  const events = tape.readAll();
  expect(events.length).toBe(2);
  expect(events[0].type).toBe("message");
  expect((events[0] as { role: string }).role).toBe("user");
  tape.close();
  rmSync(root, { recursive: true, force: true });
});

test("tape: fork copies prefix, source untouched", () => {
  const { root, cwd } = tempRoot();
  const t1 = Tape.open(cwd, "sess-fork-src", root);
  t1.appendMeta({ sessionId: "sess-fork-src", cwd, model: "m", provider: "p", createdAt: new Date().toISOString() });
  t1.append({ type: "message", role: "user", content: "original" } as never);

  const t2 = t1.fork("sess-fork-child");
  t2.append({ type: "message", role: "user", content: "child addition" } as never);
  t2.close();

  expect(t1.readAll().length).toBe(1); // source untouched
  t1.close();

  const child = Tape.open(cwd, "sess-fork-child", root);
  expect(child.readAll().length).toBe(2); // 1 inherited + 1 new
  child.close();
  rmSync(root, { recursive: true, force: true });
});

test("tape: crash marker mid-toolcall", () => {
  const { root, cwd } = tempRoot();
  const t = Tape.open(cwd, "sess-crash", root);
  t.markCrashed("bash");
  const events = t.readAll();
  expect(events.length).toBe(2); // error event + tool_result the model can see
  const ev = events[0] as { type: string; faultSide?: string; retryable?: boolean };
  expect(ev.type).toBe("error");
  expect(ev.faultSide).toBe("tool");
  expect(ev.retryable).toBe(true);
  const result = events[1] as { type: string; ok?: boolean; output?: string };
  expect(result.type).toBe("tool_result");
  expect(result.ok).toBe(false);
  expect(result.output).toContain("crashed");
  t.close();
  rmSync(root, { recursive: true, force: true });
});

test("sqlite index: FTS5 search + recent sessions", () => {
  const { root, cwd } = tempRoot();
  const tape = Tape.open(cwd, "sess-idx", root);
  tape.append({ type: "message", role: "user", content: "check the HERMES memory system" } as never);
  tape.append({ type: "message", role: "assistant", content: "found the memory module" } as never);

  // index into the same temp root
  const idxDir = join(root, "--tmp-fake-project");
  const idx = new SqliteIndex(join(idxDir, "index.db"));
  idx.indexEvents("sess-idx", tape.readAll());

  const hits = idx.search("memory");
  expect(hits.length).toBeGreaterThan(0);
  const recent = idx.recentSessions();
  expect(recent.some((r) => r.sessionId === "sess-idx")).toBe(true);

  idx.close();
  tape.close();
  rmSync(root, { recursive: true, force: true });
});

test("tape: stale lock (dead pid) is taken over", () => {
  const { root, cwd } = tempRoot();
  const paths = tapePaths(cwd, "sess-stale", root);
  const { mkdirSync, writeFileSync } = require("node:fs");
  mkdirSync(paths.dir, { recursive: true });
  // Simulate a crashed process's leftover lock with a dead pid (999999)
  writeFileSync(paths.tape + ".lock", "999999");
  const t = Tape.open(cwd, "sess-stale", root);
  t.close();
  expect(true).toBe(true); // open succeeded despite stale lock
  rmSync(root, { recursive: true, force: true });
});

test("tape: second open of same session is prevented", () => {
  const { root, cwd } = tempRoot();
  const t1 = Tape.open(cwd, "sess-lock", root);
  // Second open should not silently corrupt; our lock file makes it throw
  let threw = false;
  try {
    Tape.open(cwd, "sess-lock", root);
  } catch {
    threw = true;
  }
  expect(threw).toBe(true);
  t1.close();
  rmSync(root, { recursive: true, force: true });
});
