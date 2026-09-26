/**
 * Pure display helpers for the tool feed and the approval prompt.
 *
 * Extracted from index.ts so the folding/formatting rules are unit-testable
 * (they were previously nested inside the onEvent closure).
 */

import { sanitizeTail } from "../../tools/src/sanitize.ts";
export { sanitizeTail };

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

/** Append a sanitized stdout chunk to a tail buffer, capped to the last
 *  `maxLines` lines and `maxChars` total chars. Pure — no I/O; the partial
 *  last line is kept verbatim until a newline completes it. */
export function tailWindow(current: string, chunk: string, maxLines: number, maxChars = 4096): string {
  let buf = current + sanitizeTail(chunk);
  const lines = buf.split("\n");
  if (lines.length > maxLines) {
    buf = lines.slice(-maxLines).join("\n");
  }
  // Hard char cap (cursor finding #1): a single line without \n (progress bar)
  // or a very long line must not bloat the 120ms setText unboundedly. Slice
  // from the end, then drop the leading partial line so the tail starts on a
  // line boundary.
  if (buf.length > maxChars) {
    buf = buf.slice(buf.length - maxChars);
    const nl = buf.indexOf("\n");
    if (nl !== -1) buf = buf.slice(nl + 1);
  }
  return buf;
}

/** Strip redirection/noise from a command for the tool line. 'ls -la ~/.agents
 *  2>/dev/null; echo ---' -> 'ls -la ~/.agents'. Full command stays in /tool. */
export function briefCmd(cmd: string): string {
  const cleaned = cmd
    .replace(/\s*2>\s*\/dev\/null/g, "")
    .replace(/\s*>\s*\/dev\/null/g, "")
    .replace(/\s*\|\s*head(\s+-\d+)?.*$/, "")
    .replace(/;\s*echo\s+["'-]+.*$/, "")
    .trim();
  if (cleaned.length <= 80) return cleaned;
  return cleaned.slice(0, 80) + "…";
}

/** 命令预览（混合策略，cursor Finding #2）：复合命令（&&/||/;）显示第一段
 *  + …N more（正对 `pwd && ls` 误导）；单条长命令头 60% + 尾 40%。引号内
 *  分隔符不单独处理（MVP 朴素扫描，失败则退回 head/tail 也足够）。 */
export function cmdPreview(cmd: string): string {
  const MAX = 42;
  const segs = cmd.split(/\s*&&\s*|\s*\|\|\s*|;\s*/).filter((s) => s.trim());
  if (segs.length > 1) {
    const first = segs[0]!.trim();
    const head = first.length > MAX ? first.slice(0, MAX) + "…" : first;
    return `${head} …${segs.length - 1} more`;
  }
  if (cmd.length > MAX) {
    const headLen = Math.floor(MAX * 0.6);
    const tailLen = MAX - headLen - 1; // -1 留给 …
    return `${cmd.slice(0, headLen)}…${cmd.slice(-tailLen)}`;
  }
  return cmd;
}
