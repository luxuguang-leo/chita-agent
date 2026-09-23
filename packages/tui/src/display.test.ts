/**
 * Pure display helpers (isBannerCmd / formatApprovalCommand).
 *
 * Regression tests for the 2026-09-19 session: `echo "===…" ; curl …` was
 * folded into "×N banner lines" (hiding real output), and the approval prompt
 * truncated a multi-line command mid-word at 140 chars.
 */

import { test, expect } from "bun:test";
import { isBannerCmd, formatApprovalCommand, sanitizeTail, tailWindow } from "./display.ts";

test("isBannerCmd: folds a pure decorative echo", () => {
  expect(isBannerCmd('echo "=== title ==="')).toBe(true);
  expect(isBannerCmd('echo "=== title ===";')).toBe(true); // trailing ; still pure
  expect(isBannerCmd("echo ---")).toBe(true);
  expect(isBannerCmd("echo")).toBe(true);
});

test("isBannerCmd: does NOT fold echo followed by real work", () => {
  // the exact 2026-09-19 session shape: echo title + real command
  expect(isBannerCmd('echo "=== 直连 GitHub API 测试 ===" ; curl -s https://api.github.com')).toBe(false);
  expect(isBannerCmd('echo "=== 解码 ===" ; python3 - <<EOF\nprint(1)\nEOF')).toBe(false);
  // newline-separated work (no semicolon) must also survive
  expect(isBannerCmd('echo "=== title ==="\ncurl -s https://x')).toBe(false);
  // piped work
  expect(isBannerCmd('echo "=== x ===" | head')).toBe(false);
});

test("isBannerCmd: leaves non-echo commands alone", () => {
  expect(isBannerCmd("ls -la")).toBe(false);
  expect(isBannerCmd("cd /tmp && rm -rf x")).toBe(false);
});

test("isBannerCmd: a ; inside quotes is NOT folded (documented tradeoff)", () => {
  // The separator check is quote-unaware, so an echo whose ARGUMENT contains
  // `;` is treated as non-banner. Accepted: we prefer under-folding over
  // hiding real work.
  expect(isBannerCmd('echo "a;b ==="')).toBe(false);
});

test("formatApprovalCommand: empty command", () => {
  expect(formatApprovalCommand("")).toBe("(无参数)");
});

test("formatApprovalCommand: collapses newlines to one line", () => {
  expect(formatApprovalCommand("echo 'a'\necho 'b'")).toBe("echo 'a' echo 'b'");
});

test("formatApprovalCommand: caps long commands with an explicit marker", () => {
  const out = formatApprovalCommand("x".repeat(5000));
  expect(out).toContain("…");
  expect(out).toMatch(/truncated \d+ chars/);
  expect(out.length).toBeLessThan(5000);
});

test("formatApprovalCommand: does not truncate a normal command", () => {
  const cmd = "cd /tmp && rm -rf jev-probe && mkdir jev-probe";
  expect(formatApprovalCommand(cmd)).toBe(cmd);
});

test("sanitizeTail: strips ANSI colors and CR", () => {
  expect(sanitizeTail("\x1b[32mhello\x1b[0m")).toBe("hello");
  expect(sanitizeTail("line1\r\nline2")).toBe("line1\nline2");
  // cursor-up sequences (CSI with leading ?) are also stripped
  expect(sanitizeTail("\x1b[?25lhidden\x1b[?25h")).toBe("hidden");
});

test("tailWindow: caps to the last N lines, keeping the partial tail", () => {
  // 3 complete lines then a partial 4th — with a 3-line cap only the last
  // two complete + the partial survive
  const buf = tailWindow("", "1\n2\n3\npar", 3);
  expect(buf).toBe("2\n3\npar");
});

test("tailWindow: accumulates across chunks across newline boundaries", () => {
  // chunks split mid-line must reassemble ("hello world" arrives as "hel",
  // "lo ", "world")
  let buf = tailWindow("", "hel", 8);
  buf = tailWindow(buf, "lo ", 8);
  buf = tailWindow(buf, "world", 8);
  expect(buf).toBe("hello world");
});

test("tailWindow: live-loop shape — one line per iteration survives", () => {
  // the P1 acceptance: `for i in 1..5; do echo $i; sleep 1; done` streams
  // one line at a time; the tail keeps the last 8
  let buf = "";
  for (let i = 1; i <= 5; i++) buf = tailWindow(buf, `${i}\n`, 8);
  expect(buf).toBe("1\n2\n3\n4\n5\n");
});

test("tailWindow: empty chunk is a no-op (decoder flush edge)", () => {
  expect(tailWindow("abc", "", 8)).toBe("abc");
});

test("tailWindow: hard char cap bounds a single huge line", () => {
  const buf = tailWindow("", "x".repeat(10000), 8, 256);
  expect(buf.length).toBeLessThanOrEqual(256);
  expect(buf).toBe("x".repeat(256));
});

test("tailWindow: char cap starts the tail on a line boundary", () => {
  let buf = "";
  for (let i = 0; i < 50; i++) buf = tailWindow(buf, "0123456789\n", 1000, 100);
  expect(buf.length).toBeLessThanOrEqual(100);
  expect(buf[0]).not.toBe("\n");
  // every surviving line is intact (no mid-line fragment from the char cut)
  for (const l of buf.split("\n").filter(Boolean)) expect(l).toBe("0123456789");
});
