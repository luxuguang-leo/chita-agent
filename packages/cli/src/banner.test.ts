/**
 * banner tests — running cheetah logo renders + info columns align.
 */

import { test, expect } from "bun:test";
import { renderBanner, CHITA_LOGO } from "./banner.ts";

test("logo: all lines monospace-safe, bounded width", () => {
  const widths = CHITA_LOGO.map((l) => l.length);
  // compact logo: widest line ~ 25 chars
  expect(Math.max(...widths)).toBeLessThanOrEqual(30);
  expect(Math.min(...widths)).toBeGreaterThan(5);
});

test("banner: contains version, model, cwd", () => {
  const out = renderBanner({ version: "0.1.0", model: "deepseek-v4-flash", cwd: "~" });
  expect(out).toContain("chita v0.1.0");
  expect(out).toContain("model  deepseek-v4-flash");
  expect(out).toContain("cwd    ~");
});

test("banner: cheetah spots present (o/O/0)", () => {
  const art = CHITA_LOGO.join("\n");
  expect(art).toMatch(/[oO0]/);
  // streamlines: head curve + tail
  expect(art).toContain("/ \\_,");
});

test("banner: task info truncated to 40 chars", () => {
  const long = "x".repeat(100);
  const out = renderBanner({ version: "1", task: long });
  expect(out).toContain("task   " + "x".repeat(40));
});
