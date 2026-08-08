/**
 * e05 verifier — checks that the agent's git-history investigation is accurate
 * (env/answer.json)
 *
 * Ground truth: build-env.ts generates 4 commits:
 * - last commit message = "fix bug in app"
 * - commits touching src/app.js = 3 (initial scaffold / add feature A / fix bug in app)
 * The verifier builds env first, recomputes with git, and compares with the agent's answer.
 */

import { execSync } from "node:child_process";
import { join } from "node:path";
import { mkdirSync, readFileSync, existsSync } from "node:fs";

const envDir = join(import.meta.dir, "..", "env");
mkdirSync(join(envDir, "src"), { recursive: true });

// Build the git fixture first (idempotent: skips if .git exists)
const { buildEnv } = await import("../env/build-env.ts");
buildEnv();

// Ground truth
const lastMsg = execSync("git log -1 --format=%s", { cwd: envDir }).toString().trim();
const appCount = execSync("git log --oneline -- src/app.js", { cwd: envDir })
  .toString()
  .trim()
  .split("\n").length;

let failed = false;
const fail = (m: string) => {
  failed = true;
  console.error(`FAIL: ${m}`);
};

// The agent's artifact must exist
const answerPath = join(envDir, "answer.json");
if (!existsSync(answerPath)) {
  fail("env/answer.json missing — agent did not write its answer");
  process.exit(1);
}
const answer = JSON.parse(readFileSync(answerPath, "utf-8"));

if (answer.lastCommitMessage !== lastMsg) {
  fail(`lastCommitMessage should be "${lastMsg}", got "${answer.lastCommitMessage}"`);
}
if (answer.appJsCommitCount !== appCount) {
  fail(`appJsCommitCount should be ${appCount}, got ${answer.appJsCommitCount}`);
}

if (failed) process.exit(1);
console.log(`PASS: e05-git-log (agent report matches "${lastMsg}" / ${appCount} commits)`);
