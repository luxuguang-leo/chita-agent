/**
 * e04 verifier — 检查 slugify 修复是否覆盖两个场景
 *
 * 判据：两个 bug 场景 + 边界（大小写/前后空格/单字符）。
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
    console.error('FAIL: slugify(' + JSON.stringify(input) + ') = ' + JSON.stringify(got) + ' 期望 ' + JSON.stringify(want));
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
  console.error("FAIL: slugify 行为不正确");
  console.error(String(e.stderr || e.stdout || e.message).slice(0, 500));
  process.exit(1);
}

console.log("PASS: e04-fix-bug");
