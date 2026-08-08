/**
 * evals runner tests — discovery + verify-only mode
 *
 * Uses the real evals/cases directory (M0 artifacts). Expectation:
 * - e01/e03/e05/e06/e08: read-only cases FAIL in verify-only mode because
 *   env/answer.json is absent (agent never ran) — correct: verifier asserts
 *   agent artifacts
 * - e02/e04/e07: fix-bug cases FAIL because fixtures are unfixed — correct
 *
 * This proves the runner wiring, not case outcomes.
 */

import { test, expect } from "bun:test";
import { discoverCases, runVerifier } from "./index.ts";
import { resolve } from "node:path";

const CASES_ROOT = resolve(import.meta.dir, "../../../evals/cases");

test("discovers exactly the 8 M0 cases", () => {
  const cases = discoverCases(CASES_ROOT);
  expect(cases.length).toBe(8);
  const ids = cases.map((c) => c.id).sort();
  expect(ids).toEqual([
    "e01-read-project",
    "e02-edit-file",
    "e03-run-test",
    "e04-fix-bug",
    "e05-git-log",
    "e06-grep-search",
    "e07-consistent-edit",
    "e08-verify-output",
  ]);
});

test("every case has a verifier", () => {
  const cases = discoverCases(CASES_ROOT);
  for (const c of cases) expect(c.hasVerifier).toBe(true);
});

test("verify-only: read-only cases fail without agent answer.json", () => {
  const cases = discoverCases(CASES_ROOT);
  const e01 = cases.find((c) => c.id === "e01-read-project")!;
  const { exit, output } = runVerifier(e01);
  expect(exit).not.toBe(0);
  expect(output).toContain("answer.json");
});

test("verify-only: fix-bug cases fail on unfixed fixtures", () => {
  const cases = discoverCases(CASES_ROOT);
  const e02 = cases.find((c) => c.id === "e02-edit-file")!;
  const { exit } = runVerifier(e02);
  expect(exit).not.toBe(0);
});
