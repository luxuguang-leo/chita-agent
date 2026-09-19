/**
 * Pure display helpers (isBannerCmd / formatApprovalCommand).
 *
 * Regression tests for the 2026-09-19 session: `echo "===…" ; curl …` was
 * folded into "×N banner lines" (hiding real output), and the approval prompt
 * truncated a multi-line command mid-word at 140 chars.
 */

import { test, expect } from "bun:test";
import { isBannerCmd, formatApprovalCommand } from "./display.ts";

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
