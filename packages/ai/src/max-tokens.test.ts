/**
 * inferMaxTokens tests — per-model output cap (pi parity).
 *
 * Regression under test: chita hard-coded `max_tokens: 4096` for every model,
 * truncating long tool-call arguments and long answers. The fix infers the cap
 * from the model name (DeepSeek V4 = 384K, matching pi's catalog).
 */

import { test, expect } from "bun:test";
import { inferMaxTokens } from "./index.ts";

test("deepseek models get the 384K output cap (pi parity)", () => {
	expect(inferMaxTokens("deepseek-v4-flash")).toBe(384_000);
	expect(inferMaxTokens("deepseek-v4-pro")).toBe(384_000);
	expect(inferMaxTokens("deepseek-chat")).toBe(384_000);
});

test("other known families map to sane caps", () => {
	expect(inferMaxTokens("moonshot-v1-32k")).toBe(8_192);
	expect(inferMaxTokens("glm-4")).toBe(8_192);
	expect(inferMaxTokens("qwen-max")).toBe(8_192);
	expect(inferMaxTokens("claude-3-5")).toBe(8_192);
	expect(inferMaxTokens("gpt-4o")).toBe(16_384);
});

test("unknown models fall back to 4096", () => {
	expect(inferMaxTokens("some-unknown-model")).toBe(4096);
});
