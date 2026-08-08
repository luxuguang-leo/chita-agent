/**
 * chita skills (v2.1 §2.6) — progressive disclosure
 *
 * Skills follow the Agent Skills spec (SKILL.md + directory). At startup only
 * the index (name / description / location) is loaded — the model reads the
 * full SKILL.md when it decides a skill is relevant (Pi progressive
 * disclosure, §10). This keeps context small while skills stay discoverable.
 *
 * Layout: ~/.chita/skills/<skill-name>/SKILL.md (project dir may add
 * .chita/skills/ as well — ancestor dirs merge, Pi ResourceLoader style).
 */

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

export interface SkillIndex {
  name: string;
  description: string;
  version?: string;
  /** Path to the SKILL.md file */
  location: string;
  /** Tags from frontmatter metadata */
  tags?: string[];
}

export interface Skill extends SkillIndex {
  /** Full SKILL.md body (after frontmatter) */
  body: string;
}

const DEFAULT_SKILLS_DIR = `${process.env.HOME}/.chita/skills`;

/** Parse YAML-ish frontmatter (name/description/version/tags). Lenient parser. */
export function parseFrontmatter(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return result;
  for (const line of m[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
    if (!key) continue;
    if (key === "tags" || key === "related_skills") {
      result[key] = value
        .replace(/^\[|\]$/g, "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/** Discover skill directories (each dir containing SKILL.md) under roots. */
export function discoverSkillDirs(roots: string[]): string[] {
  const dirs = new Set<string>();
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(join(root, entry.name, "SKILL.md"))) {
        dirs.add(join(root, entry.name));
      }
    }
  }
  return [...dirs].sort();
}

/** Build the progressive-disclosure index (no full bodies). */
export function indexSkills(roots: string[]): SkillIndex[] {
  const dirs = discoverSkillDirs(roots);
  const index: SkillIndex[] = [];
  for (const dir of dirs) {
    const skillPath = join(dir, "SKILL.md");
    const raw = readFileSync(skillPath, "utf-8");
    const fm = parseFrontmatter(raw);
    if (typeof fm.name !== "string" || !fm.name) continue;
    index.push({
      name: fm.name,
      description: typeof fm.description === "string" ? fm.description : "",
      version: typeof fm.version === "string" ? fm.version : undefined,
      location: skillPath,
      tags: Array.isArray(fm.tags) ? (fm.tags as string[]) : undefined,
    });
  }
  return index.sort((a, b) => a.name.localeCompare(b.name));
}

/** Load a full skill by name (progressive disclosure: only when needed). */
export function loadSkill(name: string, roots: string[]): Skill | null {
  for (const root of roots) {
    const skillPath = join(root, name, "SKILL.md");
    if (existsSync(skillPath) && statSync(skillPath).isFile()) {
      const raw = readFileSync(skillPath, "utf-8");
      const fm = parseFrontmatter(raw);
      const body = raw.replace(/^---\n[\s\S]*?\n---\n?/, "");
      return {
        name,
        description: typeof fm.description === "string" ? fm.description : "",
        version: typeof fm.version === "string" ? fm.version : undefined,
        location: skillPath,
        body: body.trim(),
      };
    }
  }
  return null;
}

/** Render the index as a compact system prompt block (progressive disclosure). */
export function renderSkillIndex(index: SkillIndex[]): string {
  if (index.length === 0) return "";
  const lines = ["# Available Skills (read SKILL.md when relevant)", ""];
  for (const s of index) {
    lines.push(`- **${s.name}**: ${s.description} (${s.location})`);
  }
  return lines.join("\n");
}

export { DEFAULT_SKILLS_DIR };
