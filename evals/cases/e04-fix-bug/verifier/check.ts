/**
 * e04 verifier — checks that the slugify fix covers both scenarios
 *
 * Ground truth: both bug scenarios plus edge cases (case, surrounding spaces, single char).
 */

import { execSync } from "node:child_process";
import { join } from "node:path";

const slugPath = join(import.meta.dir, "..", "env", "slug.js");
const testScript = `
import { slugify } from '${slugPath}';
const cases = [
  ['Hello World', 'hello-world'],
  ['A  B  C', 'a-b-c'],
  ['  Hello  ', 'hello'],
  ['MixedCase', 'mixedcase'],
  ['a', 'a'],
  ['', ''],
];
for (const [input, want] of cases) {
  const got = slugify(input);
  if (got !== want) {
    console.error('FAIL: slugify(' + JSON.stringify(input) + ') = ' + JSON.stringify(got) + ' expected ' + JSON.stringify(want));
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
  console.error("FAIL: slugify behavior is incorrect");
  console.error(String(e.stderr || e.stdout || e.message).slice(0, 500));
  process.exit(1);
}

console.log("PASS: e04-fix-bug");
