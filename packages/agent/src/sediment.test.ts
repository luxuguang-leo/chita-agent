/**
 * skill sedimentation tests (v2.1 §2.6 / hermes P1-1)
 *
 * Covers: draft render, pending write/list, activate (review), suggestFromTrace
 * heuristic, and the M3 metric (>=30% trigger rate on successful sessions).
 */

import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  renderSkillMd,
  writePendingSkill,
  listPendingSkills,
  activateSkill,
  suggestFromTrace,
  PENDING_SKILLS_DIR,
  SKILLS_DIR,
} from "./sediment.ts";
import type { TraceEvent } from "../../session/src/trace.ts";

// Redirect to temp dirs by monkey-patching module constants (test isolation)
const tempBase = mkdtempSync(join(tmpdir(), "chita-sed-"));
process.env.HOME = tempBase; // HOME override makes ~/.chita land in temp

function makeEvents(nTools: number, allOk: boolean): TraceEvent[] {
  const events: TraceEvent[] = [];
  for (let i = 0; i < nTools; i++) {
    events.push({
      seq: i * 2 + 1,
      type: "tool_call",
      tool: { name: `tool${i}`, permission: "allow" },
      ts: new Date().toISOString(),
    } as TraceEvent);
    events.push({
      seq: i * 2 + 2,
      type: "tool_result",
      toolName: `tool${i}`,
      ok: allOk,
      output: allOk ? "ok" : "failed",
      ts: new Date().toISOString(),
    } as TraceEvent);
  }
  return events;
}

test("renderSkillMd: Agent Skills format with pending status", () => {
  const md = renderSkillMd({
    name: "test-skill",
    description: "Does things",
    body: "Steps here",
    fromSession: "sess-1",
    tags: ["a", "b"],
  });
  expect(md).toContain("name: test-skill");
  expect(md).toContain("status: pending");
  expect(md).toContain("source_session: sess-1");
  expect(md).toContain("Steps here");
});

test("writePendingSkill + listPendingSkills + activateSkill", () => {
  const draft = {
    name: "review-me",
    description: "Awaiting review",
    body: "Body",
    fromSession: "sess-2",
    tags: ["x"],
  };
  const path = writePendingSkill(draft);
  expect(existsSync(path)).toBe(true);
  expect(listPendingSkills()).toContain("review-me");

  const active = activateSkill("review-me");
  expect(existsSync(active)).toBe(true);
  expect(readFileSync(active, "utf-8")).toContain("name: review-me");
  // status flipped to active, pending copy removed (Cursor F4)
  expect(readFileSync(active, "utf-8")).toContain("status: active");
  expect(existsSync(join(PENDING_SKILLS_DIR, "review-me"))).toBe(false);
});

test("suggestFromTrace: >=3 tools all-ok suggests; failures don't", () => {
  const success = suggestFromTrace("sess-3", makeEvents(4, true));
  expect(success).not.toBeNull();
  expect(success!.tags).toContain("tool0");
  expect(success!.body).toContain("Workflow");

  const tooFew = suggestFromTrace("sess-4", makeEvents(2, true));
  expect(tooFew).toBeNull();

  const failed = suggestFromTrace("sess-5", makeEvents(4, false));
  expect(failed).toBeNull();
});

test("M3 metric: >=30% trigger rate on successful sessions", () => {
  // 5 successful sessions with >=3 tools each -> all suggest
  const sessions = Array.from({ length: 5 }, (_, i) => makeEvents(3 + i, true));
  const suggested = sessions.map((s, i) => suggestFromTrace(`sess-${i}`, s)).filter((s) => s !== null).length;
  const rate = suggested / sessions.length;
  expect(rate).toBeGreaterThanOrEqual(0.3); // M3 metric
});

test("cleanup", () => {
  rmSync(tempBase, { recursive: true, force: true });
  void PENDING_SKILLS_DIR;
  void SKILLS_DIR;
});
