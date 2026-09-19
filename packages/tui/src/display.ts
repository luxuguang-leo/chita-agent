/**
 * Pure display helpers for the tool feed and the approval prompt.
 *
 * Extracted from index.ts so the folding/formatting rules are unit-testable
 * (they were previously nested inside the onEvent closure).
 */

/**
 * True when the command is a PURE decorative echo banner — `echo "===…"`,
 * `echo ---`, or a bare `echo` — and nothing else. Any statement separator
 * (`;`, `|`, `&`, or a newline) after it means real work follows, so the
 * result must be shown, not folded.
 *
 * (Leo: echo-title banners were pure noise, but `echo "=== x ===" ; curl …`
 *  does real work — folding it hid the decode/curl output behind
 *  "×N banner lines".)
 */
export function isBannerCmd(cmd: string): boolean {
  // strip a trailing `;` so `echo "=== x ===";` still folds, but any OTHER
  // separator (;, |, &, newline) before the end means real work follows.
  const c = cmd.trim().replace(/;\s*$/, "");
  if (/[;|&\n]/.test(c)) return false;
  return /^echo\s+["']?={2,}/.test(c) || /^echo\s+["']?-{2,}/.test(c) || /^echo\s*$/.test(c);
}

/**
 * Format a command for the approval prompt. Collapses whitespace/newlines to
 * one readable line and caps at a generous width with an explicit marker —
 * never a silent mid-word cut (the old `slice(0, 140)` truncated a multi-line
 * `rm -rf … curl --max-time …` right in the middle of `--max-time`).
 */
export function formatApprovalCommand(cmd: string): string {
  if (!cmd) return "(无参数)";
  const collapsed = cmd.replace(/\s+/g, " ").trim();
  const MAX = 1000;
  if (collapsed.length <= MAX) return collapsed;
  const head = collapsed.slice(0, MAX);
  const cut = head.lastIndexOf(" ");
  const shown = cut > MAX / 2 ? head.slice(0, cut) : head;
  return `${shown}… (truncated ${collapsed.length - shown.length} chars)`;
}
