/**
 * config tests — budgetTokensFor per-run spend fuse semantics (cur-058 review)
 *
 * Covers: default contextWindow×8, 2M cap for 1M-context models, explicit
 * budgetTokens wins uncapped. These pin the decoupling between the spend
 * fuse and the context window (the original bug: maxTokens === contextWindow
 * killed long runs at 131072).
 */

import { test, expect } from "bun:test";
import { budgetTokensFor, DEFAULT_CONFIG } from "./config.ts";

test("budgetTokensFor: default = contextWindow × 8 (128K ctx → 1,048,576)", () => {
  const cfg = { ...DEFAULT_CONFIG, contextWindow: 131_072 };
  expect(budgetTokensFor(cfg)).toBe(131_072 * 8);
});

test("budgetTokensFor: capped at 2M for 1M-context models (DeepSeek)", () => {
  const cfg = { ...DEFAULT_CONFIG, contextWindow: 1_048_576 };
  expect(budgetTokensFor(cfg)).toBe(2_000_000);
});

test("budgetTokensFor: explicit budgetTokens wins and is uncapped", () => {
  const cfg = { ...DEFAULT_CONFIG, contextWindow: 1_048_576, budgetTokens: 5_000_000 };
  expect(budgetTokensFor(cfg)).toBe(5_000_000);
});

test("budgetTokensFor: zero/negative explicit value is honored (no magic floor)", () => {
  const cfg = { ...DEFAULT_CONFIG, contextWindow: 131_072, budgetTokens: 0 };
  expect(budgetTokensFor(cfg)).toBe(0);
});
