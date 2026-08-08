/**
 * e05 verifier — 检查 agent 对 git 历史的调查是否准确
 *
 * 判据（Ground Truth）：env 用 build-env.ts 生成，含 4 个提交：
 * - 最近提交 message = "fix bug in app"
 * - 改过 src/app.js 的提交数 = 3（initial scaffold / add feature A / fix bug in app）
 * verifier 先构建 env，再用 git 重新计算，供 runner 与 agent 报告对比。
 */

import { execSync } from "node:child_process";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

const envDir = join(import.meta.dir, "..", "env");
mkdirSync(join(envDir, "src"), { recursive: true });

// 先构建 git fixture（幂等：.git 已存在则跳过）
const { buildEnv } = await import("../env/build-env.ts");
buildEnv();

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

if (lastMsg !== "fix bug in app") fail(`最近提交应为 "fix bug in app"，实际 "${lastMsg}"`);
if (appCount !== 3) fail(`app.js 提交数应为 3，实际 ${appCount}`);

console.log(`PASS: e05-git-log（最近提交="${lastMsg}"，app.js 改动 ${appCount} 次）`);
if (failed) process.exit(1);
