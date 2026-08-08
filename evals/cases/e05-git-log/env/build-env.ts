/**
 * e05 env builder — generates a git fixture with 4 commits
 *
 * Design: the env directory ships without .git (avoids being tracked as a
 * submodule by the outer repo); running this script generates the git history
 * for the agent to investigate and the verifier to judge.
 * Ground truth: last commit "fix bug in app"; src/app.js touched 3 times.
 */

import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";

const envDir = join(import.meta.dir, "..", "env");

export function buildEnv(): string {
  const gitDir = join(envDir, ".git");
  if (!existsSync(gitDir)) {
    execSync("git init -q", { cwd: envDir });
    execSync('git config user.email "eval@chita.local"', { cwd: envDir });
    execSync('git config user.name "chita-eval"', { cwd: envDir });
    writeFileSync(join(envDir, "src", "app.js"), "v1\n");
    writeFileSync(join(envDir, "src", "util.js"), "v1\n");
    execSync("git add -A && git commit -qm 'initial scaffold'", { cwd: envDir });
    writeFileSync(join(envDir, "src", "app.js"), "v2\n");
    execSync("git commit -qam 'add feature A'", { cwd: envDir });
    writeFileSync(join(envDir, "src", "util.js"), "v3\n");
    execSync("git commit -qam 'refactor util'", { cwd: envDir });
    writeFileSync(join(envDir, "src", "app.js"), "v4\n");
    execSync("git commit -qam 'fix bug in app'", { cwd: envDir });
  }
  return gitDir;
}

if (import.meta.main) {
  mkdirSync(join(envDir, "src"), { recursive: true });
  buildEnv();
  console.log("e05 env built:");
  console.log(execSync("git log --oneline", { cwd: envDir }).toString().trim());
}
