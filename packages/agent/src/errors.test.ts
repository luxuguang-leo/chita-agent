/**
 * error layering tests (v2.1 §2.4)
 *
 * Covers: 4xx no-retry, 5xx/429/timeout retryable, overflow classification,
 * backoff growth with jitter bounds, retry budget.
 */

import { test, expect } from "bun:test";
import { classifyError, backoffDelay, shouldRetry, RetryPolicy } from "./errors.ts";

test("4xx client errors are not retryable", () => {
  const e = classifyError(401, "invalid api key");
  expect(e.category).toBe("auth");
  expect(e.retryable).toBe(false);
});

test("429 rate limit is retryable with backoff", () => {
  const e = classifyError(429, "rate limited");
  expect(e.category).toBe("rate_limit");
  expect(e.retryable).toBe(true);
  expect(e.backoffMs).toBeDefined();
});

test("5xx server errors are retryable", () => {
  const e = classifyError(502, "bad gateway");
  expect(e.category).toBe("server");
  expect(e.retryable).toBe(true);
});

test("overflow classified from message", () => {
  const e = classifyError(undefined, "This model's maximum context length is 200000 tokens");
  expect(e.category).toBe("overflow");
  expect(e.retryable).toBe(true);
});

test("malformed tool call classified from message", () => {
  const e = classifyError(undefined, "Malformed JSON in arguments");
  expect(e.category).toBe("malformed");
  expect(e.retryable).toBe(true);
});

test("backoff grows exponentially with bounded jitter", () => {
  const policy: RetryPolicy = { maxRetries: 5, baseBackoffMs: 500, maxBackoffMs: 10000, includeErrorInContext: false };
  const d1 = backoffDelay(0, policy); // ~500
  const d2 = backoffDelay(1, policy); // ~1000
  const d3 = backoffDelay(2, policy); // ~2000
  expect(d1).toBeGreaterThanOrEqual(400);
  expect(d1).toBeLessThanOrEqual(600);
  expect(d2).toBeGreaterThanOrEqual(800);
  expect(d3).toBeGreaterThanOrEqual(1600);
  expect(d3).toBeLessThanOrEqual(2400);
});

test("shouldRetry respects retryable flag and budget", () => {
  const policy: RetryPolicy = { maxRetries: 2, baseBackoffMs: 500, maxBackoffMs: 10000, includeErrorInContext: false };
  const retryable = classifyError(500, "boom");
  expect(shouldRetry(retryable, 0, policy)).toBe(true);
  expect(shouldRetry(retryable, 1, policy)).toBe(true);
  expect(shouldRetry(retryable, 2, policy)).toBe(false); // budget exhausted

  const noRetry = classifyError(403, "forbidden");
  expect(shouldRetry(noRetry, 0, policy)).toBe(false);
});

test("unclassified errors default to non-retryable", () => {
  const e = classifyError(undefined, "something weird happened");
  expect(e.category).toBe("other");
  expect(e.retryable).toBe(false);
});
