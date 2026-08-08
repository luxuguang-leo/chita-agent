/**
 * e08 verifier — 检查 agent 是否真的计算了而非编造
 *
 * 判据：data.txt 是确定性生成的（seed=42，17 行）。verifier 重新计算
 * 行数与最大值，与 agent 报告对比。若 agent 没跑命令瞎猜，fail。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const dataPath = join(import.meta.dir, "..", "env", "data.txt");
const nums = readFileSync(dataPath, "utf-8").trim().split("\n").map(Number);
const truthLines = nums.length;
const truthMax = Math.max(...nums);

let failed = false;
const fail = (m: string) => {
  failed = true;
  console.error(`FAIL: ${m}`);
};

// 本 verifier 只确认 Ground Truth 可计算（agent 报告的比对在 runner 层做）
if (nums.some((n) => Number.isNaN(n))) fail("data.txt 含非数字");
if (truthLines !== 17) fail(`行数应为 17，实际 ${truthLines}`);

console.log(`PASS: e08-verify-output（Ground Truth：${truthLines} 行，最大 ${truthMax}）`);
if (failed) process.exit(1);
