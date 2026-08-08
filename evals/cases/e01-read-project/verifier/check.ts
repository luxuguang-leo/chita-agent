/**
 * e01 verifier — checks the agent's answer (env/answer.json) for accuracy
 *
 * Ground truth:
 * - entryFile = "src/main.js" (package.json main)
 * - firstExport = "GREETING" (identifier exported on line 1 of the entry file)
 * Read-only tasks leave the environment unchanged, so the answer must be
 * written to env/answer.json before the agent's work can be verified; otherwise fail.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const envDir = join(import.meta.dir, "..", "env");
const answerPath = join(envDir, "answer.json");

let failed = false;
const fail = (msg: string) => {
  failed = true;
  console.error(`FAIL: ${msg}`);
};

// 1. The agent's artifact must exist (missing answer.json = task not completed)
if (!existsSync(answerPath)) {
  fail("env/answer.json missing — agent did not write its answer");
  process.exit(1);
}

let answer: { entryFile?: string; firstExport?: string };
try {
  answer = JSON.parse(readFileSync(answerPath, "utf-8"));
} catch (e) {
  fail(`answer.json is not valid JSON: ${e}`);
  process.exit(1);
}

// 2. Ground truth: fixture facts
const pkg = JSON.parse(readFileSync(join(envDir, "package.json"), "utf-8"));
const mainPath = join(envDir, pkg.main ?? "");
const firstLine = existsSync(mainPath)
  ? readFileSync(mainPath, "utf-8").split("\n")[0]
  : "";

if (answer.entryFile !== pkg.main) {
  fail(`entryFile should be "${pkg.main}", got "${answer.entryFile}"`);
}
if (!firstLine.includes(answer.firstExport ?? "\u0000")) {
  fail(`firstExport should be the identifier exported on line 1, got "${answer.firstExport}"`);
}

if (failed) process.exit(1);
console.log("PASS: e01-read-project");
