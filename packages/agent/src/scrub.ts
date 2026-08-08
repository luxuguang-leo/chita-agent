/**
 * chita redaction scrub (v2.1 F4) — afterToolCall hook
 *
 * Patterns: OpenAI-style keys (sk-...), Bearer tokens, PEM private keys,
 * AWS access keys. Applied to tool output before it reaches the model
 * (and before it lands in the tape).
 */

const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{16,}/g, // OpenAI-style API keys
  /Bearer\s+[A-Za-z0-9._-]{20,}/gi, // Bearer tokens
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, // PEM
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /gh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub tokens
];

export interface ScrubResult {
  text: string;
  redacted: boolean;
}

/** Replace secret-looking substrings with [REDACTED].
 *  Note: each pattern is applied with a fresh replace; the g-flag lastIndex
 *  pitfall (test() advancing lastIndex before replace) is avoided by never
 *  calling test() on the shared global regexes (Cursor F1). */
export function scrubSecrets(text: string): ScrubResult {
  let redacted = false;
  let out = text;
  for (const re of SECRET_PATTERNS) {
    const next = out.replace(re, "[REDACTED]");
    if (next !== out) redacted = true;
    out = next;
  }
  return { text: out, redacted };
}
