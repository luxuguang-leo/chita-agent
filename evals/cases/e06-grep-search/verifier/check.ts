/**
 * e06 verifier — checks the agent's locate-computeTotal answer (env/answer.json)
 *
 * Ground truth: defined in lib.js; called by order.js and cart.js.
 * The verifier recomputes with grep and compares with the agent's answer.
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const envDir = join(import.meta.dir, "..", "env");

// Ground truth
const files = readdirSync(envDir).filter((f) => f.endsWith(".js"));
const defs = files.filter((f) => readFileSync(join(envDir, f), "utf-8").includes("function computeTotal"));
const callers = files
  .filter((f) => f !== "lib.js" && readFileSync(join(envDir, f), "utf-8").includes("computeTotal"))
  .sort();

let failed = false;
const fail = (m: string) => {
  failed = true;
  console.error(`FAIL: ${m}`);
};

const answerPath = join(envDir, "answer.json");
if (!existsSync(answerPath)) {
  fail("env/answer.json missing — agent did not write its answer");
  process.exit(1);
}
const answer = JSON.parse(readFileSync(answerPath, "utf-8"));

if (defs.length !== 1) fail(`definition should be exactly 1 file, got ${defs.length}`);
else if (answer.definitionFile !== defs[0]) {
  fail(`definitionFile should be "${defs[0]}", got "${answer.definitionFile}"`);
}

const wantCallers = ["cart.js", "order.js"];
const gotCallers = (answer.callerFiles ?? []).slice().sort();
if (JSON.stringify(gotCallers) !== JSON.stringify(wantCallers)) {
  fail(`callerFiles should be ${wantCallers.join(",")}, got ${gotCallers.join(",")}`);
}

if (failed) process.exit(1);
console.log("PASS: e06-grep-search (definition=lib.js, callers=order.js,cart.js)");
