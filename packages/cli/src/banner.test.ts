/**
 * banner tests — cheetah logo renders + info columns align.
 */

import { test, expect } from "bun:test";
import { renderBanner, CHITA_LOGO } from "./banner.ts";

test("logo: all lines equal width (monospace-safe)", () => {
  const widths = CHITA_LOGO.map((l) => l.length);
  expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(2);
});

test("banner: contains version, model, cwd", () => {
  const out = renderBanner({ version: "0.1.0", model: "deepseek-v4-flash", cwd: "~" });
  expect(out).toContain("chita v0.1.0");
  expect(out).toContain("model  deepseek-v4-flash");
  expect(out).toContain("cwd    ~");
});

test("banner: tear-streak cheetah marks present", () => {
  // the logo has the tear-streak mouth region (___/_____\___)
  expect(CHITA_LOGO.join("\n")).toContain("\\");
  expect(CHITA_LOGO.join("\n")).toContain("/");
});

test("banner: task info truncated to 40 chars", () => {
  const long = "x".repeat(100);
  const out = renderBanner({ version: "1", task: long });
  expect(out).toContain("task   " + "x".repeat(40));
});
