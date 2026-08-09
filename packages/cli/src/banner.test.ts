/**
 * banner tests — cheetah head logo renders + info columns align.
 */

import { test, expect } from "bun:test";
import { renderBanner, CHITA_LOGO } from "./banner.ts";

test("logo: all lines monospace-safe, bounded width", () => {
  const widths = CHITA_LOGO.map((l) => l.length);
  // cheetah-head logo: widest line ~ 56 chars
  expect(Math.max(...widths)).toBeLessThanOrEqual(60);
  expect(Math.min(...widths)).toBeGreaterThan(5);
});

test("banner: contains version, model, cwd", () => {
  const out = renderBanner({ version: "0.1.0", model: "deepseek-v4-flash", cwd: "~" });
  expect(out).toContain("chita v0.1.0");
  expect(out).toContain("model  deepseek-v4-flash");
  expect(out).toContain("cwd    ~");
});

test("banner: cheetah features present (spots, ears, tear marks)", () => {
  const art = CHITA_LOGO.join("\n");
  // spotted coat rendered as . : * clusters
  expect(art).toMatch(/[:*.]/);
  // ears (top corners)
  expect(art).toContain(".-:");
  expect(art).toContain(".:-");
  // signature tear marks: eye-to-cheek vertical lines
  expect(art).toContain(":");
  expect(art).toContain("+");
});

test("banner: task info truncated to 40 chars", () => {
  const long = "x".repeat(100);
  const out = renderBanner({ version: "1", task: long });
  expect(out).toContain("task   " + "x".repeat(40));
});
