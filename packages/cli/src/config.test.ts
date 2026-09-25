/**
 * config tests — budgetTokensFor per-run spend fuse semantics (cur-058 review)
 *
 * Covers: default contextWindow×8, 2M cap for 1M-context models, explicit
 * budgetTokens wins uncapped. These pin the decoupling between the spend
 * fuse and the context window (the original bug: maxTokens === contextWindow
 * killed long runs at 131072).
 */

import { test, expect } from "bun:test";
import { budgetTokensFor, compactCeilingFor, DEFAULT_COMPACT_TOKENS, DEFAULT_CONFIG } from "./config.ts";

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

// --- compactCeilingFor: soft compaction ceiling, decoupled from the hard window ---
// (the original bug: a 1M-window model never hits 0.9×1M≈943K, so compaction
//  never fired and the session re-sent its whole growing history every turn.)

test("compactCeilingFor: 1M hard window caps at DEFAULT_COMPACT_TOKENS (256K)", () => {
  const cfg = { ...DEFAULT_CONFIG, contextWindow: 1_048_576 };
  expect(compactCeilingFor(cfg)).toBe(DEFAULT_COMPACT_TOKENS);
});

test("compactCeilingFor: smaller hard window wins (128K ctx → 128K, not 256K)", () => {
  const cfg = { ...DEFAULT_CONFIG, contextWindow: 131_072 };
  expect(compactCeilingFor(cfg)).toBe(131_072);
});

test("compactCeilingFor: explicit compactTokens wins (uncapped by hard window)", () => {
  const cfg = { ...DEFAULT_CONFIG, contextWindow: 1_048_576, compactTokens: 96_000 };
  expect(compactCeilingFor(cfg)).toBe(96_000);
});

test("compactCeilingFor: explicit compactTokens above hard window is clamped down", () => {
  const cfg = { ...DEFAULT_CONFIG, contextWindow: 131_072, compactTokens: 1_000_000 };
  expect(compactCeilingFor(cfg)).toBe(131_072);
});
