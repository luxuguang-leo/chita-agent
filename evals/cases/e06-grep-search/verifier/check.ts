/**
 * e06 verifier — 检查 computeTotal 的定位是否准确
 *
 * 判据：定义在 lib.js；被 order.js 和 cart.js 调用（README 不含代码，不算）。
 * verifier 自己 grep，对比 agent 报告。
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const envDir = join(import.meta.dir, "..", "env");

// Ground Truth：定义与调用
const files = readdirSync(envDir).filter((f) => f.endsWith(".js"));
const defs = files.filter((f) => readFileSync(join(envDir, f), "utf-8").includes("function computeTotal"));
const callers = files.filter(
  (f) => f !== "lib.js" && readFileSync(join(envDir, f), "utf-8").includes("computeTotal")
);

let failed = false;
const fail = (m: string) => {
  failed = true;
  console.error(`FAIL: ${m}`);
};

if (defs.length !== 1 || defs[0] !== "lib.js") fail(`定义文件应为 lib.js，实际 ${defs}`);
if (callers.length !== 2 || !callers.includes("order.js") || !callers.includes("cart.js")) {
  fail(`调用文件应为 order.js + cart.js，实际 ${callers}`);
}

console.log(`PASS: e06-grep-search（定义=lib.js，调用=${callers.join(",")}）`);
if (failed) process.exit(1);
