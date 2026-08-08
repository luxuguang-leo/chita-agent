/**
 * e02 verifier — checks that add() matches the mathematical definition
 *
 * Ground truth: for several positive/negative/zero combinations,
 * the result must equal a+b (final Environment state, not self-reported).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

const calcPath = join(import.meta.dir, "..", "env", "calc.js");

// Load the (possibly fixed) calc.js in a child process and run assertions
const testScript = `
import { add } from '${calcPath}';
const cases = [
  [-1, 2, 1],
  [2, -1, 1],
  [-3, -4, -7],
  [0, 0, 0],
  [5, 7, 12],
  [-2.5, 1.5, -1],
];
for (const [a, b, want] of cases) {
  const got = add(a, b);
  if (got !== want) {
    console.error('FAIL: add(' + a + ', ' + b + ') = ' + got + ' expected ' + want);
    process.exit(1);
  }
}
console.log('ok');
`;

try {
  execSync(`node --input-type=module -e "${testScript.replace(/"/g, '\\"')}"`, {
    timeout: 5000,
    stdio: "pipe",
  });
} catch (e) {
  const msg = String(e.stderr || e.stdout || e.message);
  console.error("FAIL: add() behavior does not match the mathematical definition");
  console.error(msg.slice(0, 500));
  process.exit(1);
}

// Source check: Math.abs should not remain (marker of a proper fix)
const src = readFileSync(calcPath, "utf-8");
if (src.includes("Math.abs")) console.warn("WARN: still contains Math.abs (fix may be partial)");

console.log("PASS: e02-edit-file");
