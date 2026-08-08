/**
 * e01 verifier — 确定性检查 Environment 最终状态
 *
 * 判据：fixture 的 main 指向 src/main.js，且第 1 行导出 GREETING。
 * 注意：本 verifier 检查的是"答案可验证的事实"（文件内容），
 *      不是 agent 的自述——agent 若读错文件或编造，这里会 fail。
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const envDir = join(import.meta.dir, "..", "env");
const pkgPath = join(envDir, "package.json");
const mainPath = join(envDir, "src", "main.js");

let failed = false;
const fail = (msg: string) => {
  failed = true;
  console.error(`FAIL: ${msg}`);
};

// 1. package.json main 指向 src/main.js
const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
if (pkg.main !== "src/main.js") fail(`main 应为 src/main.js，实际 ${pkg.main}`);
if (pkg.scripts?.start !== "node src/main.js") fail(`start 脚本异常: ${pkg.scripts?.start}`);

// 2. main.js 存在且第 1 行导出 GREETING
if (!existsSync(mainPath)) fail("src/main.js 不存在");
else {
  const firstLine = readFileSync(mainPath, "utf-8").split("\n")[0];
  if (!firstLine.includes("GREETING")) fail(`第 1 行未导出 GREETING: ${firstLine}`);
}

// 3. 入口真实可运行（环境最终状态，非自述）
const { execSync } = require("node:child_process");
try {
  const out = execSync(`node -e "import('${mainPath}').then(m => process.exit(m.GREETING ? 0 : 1))"`, {
    cwd: envDir,
    timeout: 5000,
  });
} catch {
  fail("入口模块无法加载 GREETING");
}

if (failed) process.exit(1);
console.log("PASS: e01-read-project");