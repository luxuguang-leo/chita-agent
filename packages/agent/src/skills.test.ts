/**
 * skills tests (v2.1 §2.6 progressive disclosure)
 *
 * Covers: frontmatter parsing, discovery, index (no bodies), loadSkill,
 * index rendering (compact system-prompt block).
 */

import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { indexSkills, loadSkill, renderSkillIndex, parseFrontmatter } from "./skills.ts";

function makeSkillRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "chita-skills-"));
  // skill A: full frontmatter
  mkdirSync(join(root, "skill-a"));
  writeFileSync(
    join(root, "skill-a", "SKILL.md"),
    `---
name: skill-a
description: Does A things.
version: 1.2.0
tags: [alpha, beta]
---
# Skill A body
Steps to do A.`
  );
  // skill B: minimal frontmatter
  mkdirSync(join(root, "skill-b"));
  writeFileSync(
    join(root, "skill-b", "SKILL.md"),
    `---
name: skill-b
description: Does B things.
---
Body B.`
  );
  // non-skill dir (no SKILL.md) — ignored
  mkdirSync(join(root, "not-a-skill"));
  return root;
}

test("parseFrontmatter: name/description/tags", () => {
  const fm = parseFrontmatter(`---
name: x
description: y
tags: [a, b]
---
body`);
  expect(fm.name).toBe("x");
  expect(fm.description).toBe("y");
  expect(fm.tags).toEqual(["a", "b"]);
});

test("indexSkills: discovers only SKILL.md dirs, no bodies", () => {
  const root = makeSkillRoot();
  const idx = indexSkills([root]);
  expect(idx.map((s) => s.name).sort()).toEqual(["skill-a", "skill-b"]);
  // index has description + location but NO body
  for (const s of idx) {
    expect(s.description.length).toBeGreaterThan(0);
    expect(s.location.endsWith("SKILL.md")).toBe(true);
  }
  rmSync(root, { recursive: true, force: true });
});

test("loadSkill: reads full body on demand (progressive disclosure)", () => {
  const root = makeSkillRoot();
  const skill = loadSkill("skill-a", [root]);
  expect(skill).not.toBeNull();
  expect(skill!.body).toContain("Steps to do A");
  expect(skill!.version).toBe("1.2.0");
  expect(loadSkill("missing", [root])).toBeNull();
  rmSync(root, { recursive: true, force: true });
});

test("renderSkillIndex: compact block, no bodies", () => {
  const root = makeSkillRoot();
  const idx = indexSkills([root]);
  const rendered = renderSkillIndex(idx);
  expect(rendered).toContain("# Available Skills");
  expect(rendered).toContain("skill-a");
  expect(rendered).toContain("Does A things");
  expect(rendered).not.toContain("Steps to do A"); // no body in index
  rmSync(root, { recursive: true, force: true });
});

test("renderSkillIndex: empty for no skills", () => {
  const root = mkdtempSync(join(tmpdir(), "chita-skills-empty-"));
  expect(renderSkillIndex(indexSkills([root]))).toBe("");
  rmSync(root, { recursive: true, force: true });
});
