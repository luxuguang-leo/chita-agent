/**
 * chita error layering (v2.1 §2.4 / §2.9)
 *
 * Error classification with retryable distinction:
 * - 4xx (auth/param) -> NOT retryable: attribute directly (likely harness bug or config)
 * - 5xx / 429 / timeout -> retryable: exponential backoff + jitter
 * - context overflow -> overflowRecovery (terminate after >3)
 * - malformed tool call -> retryable (error message NOT fed into retry context)
 *
 * Error messages must never re-enter the retry context verbatim (Pi lesson).
 */

export type ErrorCategory =
  | "auth" // 4xx auth/param
  | "rate_limit" // 429
  | "server" // 5xx
  | "timeout" // network/command timeout
  | "overflow" // context overflow
  | "malformed" // malformed tool call / args
  | "other";

export interface ClassifiedError {
  category: ErrorCategory;
  retryable: boolean;
  /** Human-readable classification reason */
  reason: string;
  /** Backoff delay in ms (only meaningful when retryable) */
  backoffMs?: number;
}

export interface RetryPolicy {
  maxRetries: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  /** Whether to include the error text in the retry context */
  includeErrorInContext: boolean;
}

const DEFAULT_POLICY: RetryPolicy = {
  maxRetries: 3,
  baseBackoffMs: 500,
  maxBackoffMs: 10000,
  includeErrorInContext: false, // errors never re-enter context verbatim
};

/**
 * Classify an error from its status/message.
 * Mirrors v2.1 §2.4: 4xx no-retry, 5xx/429/timeout backoff, overflow special.
 */
export function classifyError(status: number | undefined, message: string): ClassifiedError {
  if (status !== undefined) {
    if (status === 429) {
      return { category: "rate_limit", retryable: true, reason: "rate limited (429)", backoffMs: 1000 };
    }
    if (status >= 500) {
      return { category: "server", retryable: true, reason: `server error (${status})`, backoffMs: 2000 };
    }
    if (status >= 400) {
      return { category: "auth", retryable: false, reason: `client error (${status}) — likely harness bug or config` };
    }
  }

  const m = message.toLowerCase();
  if (m.includes("overflow") || m.includes("context length") || m.includes("token limit")) {
    return { category: "overflow", retryable: true, reason: "context overflow — compact then retry" };
  }
  if (m.includes("timeout") || m.includes("timed out") || m.includes("econnreset") || m.includes("socket hang")) {
    return { category: "timeout", retryable: true, reason: "timeout/network", backoffMs: 1500 };
  }
  if (m.includes("malformed") || m.includes("invalid json") || m.includes("schema") || m.includes("arguments")) {
    return { category: "malformed", retryable: true, reason: "malformed tool call / args" };
  }
  return { category: "other", retryable: false, reason: "unclassified" };
}

/**
 * Exponential backoff with jitter.
 * Returns delay in ms; caller should await before retrying.
 */
export function backoffDelay(attempt: number, policy: RetryPolicy = DEFAULT_POLICY): number {
  const exp = Math.min(policy.maxBackoffMs, policy.baseBackoffMs * 2 ** attempt);
  // jitter: ±20%
  const jitter = 1 + (Math.random() * 0.4 - 0.2);
  return Math.floor(exp * jitter);
}

/** Decide whether to retry given classification and attempt count. */
export function shouldRetry(err: ClassifiedError, attempt: number, policy: RetryPolicy = DEFAULT_POLICY): boolean {
  if (!err.retryable) return false;
  return attempt < policy.maxRetries;
}
