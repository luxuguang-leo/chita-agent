/**
 * evals scaling tests (v2.1 §8 / kimi P1-2)
 *
 * Covers: meta parsing (grader/holdout), holdout split, failure taxonomy,
 * cost estimation.
 */

import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseEvalMeta, splitHoldout, classifyFailure, estimateCost } from "./scale.ts";
import type { EvalCase } from "./index.ts";

function tempCaseDir(meta: string): string {
  const dir = mkdtempSync(join(tmpdir(), "chita-eval-meta-"));
  writeFileSync(join(dir, "meta.yaml"), meta);
  return dir;
}

test("parseEvalMeta: defaults when no meta.yaml", () => {
  const dir = mkdtempSync(join(tmpdir(), "chita-eval-nometa-"));
  const meta = parseEvalMeta(dir);
  expect(meta.grader).toBe("code");
  expect(meta.holdout).toBe(false);
  rmSync(dir, { recursive: true, force: true });
});

test("parseEvalMeta: parses grader + holdout + capability", () => {
  const dir = tempCaseDir("grader: model\nholdout: true\ncapability: edit\n");
  const meta = parseEvalMeta(dir);
  expect(meta.grader).toBe("model");
  expect(meta.holdout).toBe(true);
  expect(meta.capability).toBe("edit");
  rmSync(dir, { recursive: true, force: true });
});

test("splitHoldout: separates holdout from train", () => {
  const mkCase = (id: string, holdout: boolean): EvalCase => {
    const dir = tempCaseDir(`grader: code\nholdout: ${holdout}\n`);
    return { id, dir, instruction: "x", hasVerifier: true };
  };
  const cases = [mkCase("a", false), mkCase("b", true), mkCase("c", false)];
  const { train, holdout } = splitHoldout(cases);
  expect(train.map((c) => c.id)).toEqual(["a", "c"]);
  expect(holdout.map((c) => c.id)).toEqual(["b"]);
  cases.forEach((c) => rmSync(c.dir, { recursive: true, force: true }));
});

test("classifyFailure: harness for permission/blocked", () => {
  expect(classifyFailure(1, "blocked by plan mode")).toBe("harness");
  expect(classifyFailure(1, "agent did not finish (ERROR)")).toBe("harness");
});

test("classifyFailure: env for network tool errors", () => {
  expect(classifyFailure(1, undefined, ["ECONNRESET"])).toBe("env");
  expect(classifyFailure(1, undefined, ["timeout after 5s"])).toBe("env");
});

test("classifyFailure: verifier crash is grader, not model (Cursor F2)", () => {
  expect(classifyFailure(2)).toBe("grader");
  expect(classifyFailure(2, "agent ran fine")).toBe("grader");
});

test("classifyFailure: tool for unknown-tool/schema", () => {
  expect(classifyFailure(1, undefined, ["unknown tool: foo"])).toBe("tool");
});

test("classifyFailure: passed case is unknown", () => {
  expect(classifyFailure(0)).toBe("unknown");
});

test("estimateCost: tokens -> USD at rate", () => {
  expect(estimateCost(1_000_000, 0.3)).toBeCloseTo(0.3);
  expect(estimateCost(500_000, 0.3)).toBeCloseTo(0.15);
  expect(estimateCost(0)).toBe(0);
});
