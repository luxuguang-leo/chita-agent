/**
 * e02 verifier — 检查 add() 是否符合数学定义
 *
 * 判据：对若干正/负/零组合，结果必须等于 a+b（Environment 最终状态，非自述）。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

const calcPath = join(import.meta.dir, "..", "env", "calc.js");

// 用子进程加载修改后的 calc.js 并跑断言
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
    console.error('FAIL: add(' + a + ', ' + b + ') = ' + got + ' 期望 ' + want);
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
  console.error("FAIL: add() 行为不符合数学定义");
  console.error(msg.slice(0, 500));
  process.exit(1);
}

// 源码检查：不应残留 Math.abs（修复的标记）
const src = readFileSync(calcPath, "utf-8");
if (src.includes("Math.abs")) console.warn("WARN: 仍含 Math.abs（可能只是部分修复）");

console.log("PASS: e02-edit-file");
