/**
 * chita tape-first storage (v2.1 §2.7)
 *
 * The JSONL tape is the single source of truth (append-only). SQLite is only
 * an index layer. Semantics:
 * - append-only: events are written line by line, never rewritten
 * - fork: copying the tape prefix to a new file (source tape untouched)
 * - flock: exclusive lock per session file; a second --resume of the same
 *   session errors out ("two terminals, different sessions" is fine)
 * - crashed: a crash mid-ToolCall marks the event and recovery continues
 * - sessions are grouped by cwd (~/.chita/agent/sessions/--path--/)
 */

import { existsSync, mkdirSync, openSync, readFileSync, writeSync, closeSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { TraceEvent, SessionMeta } from "./trace.ts";

export const SESSIONS_ROOT = `${process.env.HOME}/.chita/agent/sessions`;

/** Encode a cwd path into a safe directory name (same approach as Pi).
 *  Leading "/" is stripped first so "/tmp/x" -> "--tmp-x" (not "---tmp-x"). */
export function cwdKey(cwd: string): string {
  const safe = cwd.replace(/^\/+/, "").replace(/\//g, "-").replace(/[^a-zA-Z0-9._-]/g, "_");
  return "--" + safe;
}

export interface TapePaths {
  dir: string;
  tape: string; // JSONL, source of truth
}

/** Resolve session file paths grouped by cwd (v2.1 §2.7) */
export function tapePaths(cwd: string, sessionId: string, root = SESSIONS_ROOT): TapePaths {
  const dir = join(root, cwdKey(cwd));
  return { dir, tape: join(dir, `${sessionId}.jsonl`) };
}

/** Append-only tape writer. One instance per session; flock held for lifetime. */
export class Tape {
  readonly paths: TapePaths;
  private fd: number;
  private seq = 0;
  private locked = false;
  private root: string;
  private lockPath: string | null = null;

  private constructor(paths: TapePaths, fd: number, root: string) {
    this.paths = paths;
    this.fd = fd;
    this.root = root;
  }

  /**
   * Open (or create) a session tape with an exclusive lock.
   * Throws if another process already holds the lock (second --resume).
   */
  static open(cwd: string, sessionId: string, root = SESSIONS_ROOT): Tape {
    const paths = tapePaths(cwd, sessionId, root);
    mkdirSync(paths.dir, { recursive: true });
    const fd = openSync(paths.tape, "a+");

    // Exclusive advisory lock. Prefer flock; fall back to a lock file.
    const tape = new Tape(paths, fd, root);
    const lockPath = paths.tape + ".lock";
    let flockOk = false;
    try {
      const { lockSync } = require("node:fs");
      if (typeof lockSync === "function") {
        lockSync(fd);
        flockOk = true;
      }
    } catch {
      flockOk = false;
    }
    if (!flockOk) {
      // Lock-file fallback: wx fails if the lock already exists -> concurrent open
      try {
        const lockFd = openSync(lockPath, "wx");
        closeSync(lockFd);
        tape.lockPath = lockPath;
      } catch {
        closeSync(fd);
        throw new Error(`session ${sessionId} is locked by another process (${lockPath})`);
      }
    }
    tape.locked = true;

    // Seed seq from existing lines (resume)
    if (existsSync(paths.tape)) {
      const content = readFileSync(paths.tape, "utf-8");
      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line) as { seq?: number };
          if (typeof ev.seq === "number" && ev.seq > tape.seq) tape.seq = ev.seq;
        } catch {
          // skip malformed line (tape is append-only; never fix in place)
        }
      }
    }
    return tape;
  }

  /** Append one event as a JSONL line (append-only). Returns its seq. */
  append(event: Omit<TraceEvent, "seq" | "ts">): number {
    const seq = ++this.seq;
    const line = JSON.stringify({ ...event, seq, ts: new Date().toISOString() }) + "\n";
    writeSync(this.fd, line);
    return seq;
  }

  /** Append a session meta header line (first line of a fresh tape) */
  appendMeta(meta: SessionMeta): void {
    const line = JSON.stringify({ __meta: meta }) + "\n";
    writeSync(this.fd, line);
  }

  /** Read all events back (used for resume / replay) */
  readAll(): TraceEvent[] {
    const content = readFileSync(this.paths.tape, "utf-8");
    const events: TraceEvent[] = [];
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.__meta) continue;
        events.push(obj as TraceEvent);
      } catch {
        // skip malformed
      }
    }
    return events;
  }

  /** Fork: copy the tape prefix to a new session file (source untouched, v2.1 §2.7) */
  fork(newSessionId: string): Tape {
    const content = existsSync(this.paths.tape) ? readFileSync(this.paths.tape, "utf-8") : "";
    // cwd comes from the tape meta header (authoritative), not path decoding
    const cwd = this.readMeta()?.cwd ?? process.cwd();
    const newPaths = tapePaths(cwd, newSessionId, this.root);
    mkdirSync(newPaths.dir, { recursive: true });
    const fd = openSync(newPaths.tape, "w");
    writeSync(fd, content);
    closeSync(fd);
    return Tape.open(cwd, newSessionId, this.root);
  }

  /** Read the meta header line (first line, __meta) */
  readMeta(): SessionMeta | null {
    if (!existsSync(this.paths.tape)) return null;
    const first = readFileSync(this.paths.tape, "utf-8").split("\n")[0];
    if (!first.trim()) return null;
    try {
      const obj = JSON.parse(first);
      return obj.__meta ?? null;
    } catch {
      return null;
    }
  }

  /** Crash marker: mid-ToolCall recovery (v2.1 §2.7) */
  markCrashed(toolName: string): void {
    this.append({
      type: "error",
      category: "other",
      retryable: true,
      message: `[tool crashed mid-execution; no output] (${toolName})`,
      faultSide: "tool",
    } as unknown as Omit<TraceEvent, "seq" | "ts">);
  }

  close(): void {
    if (this.fd !== undefined) closeSync(this.fd);
    if (this.lockPath) {
      try {
        rmSync(this.lockPath, { force: true });
      } catch {
        // best effort
      }
      this.lockPath = null;
    }
  }
}
