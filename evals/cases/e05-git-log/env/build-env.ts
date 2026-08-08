/**
 * e05 env 构建器 — 生成带 4 个提交的 git fixture
 *
 * 设计：env 目录本身不含 .git（避免被外层仓库当 submodule 提交），
 * 运行时执行本脚本生成 git 历史，供 agent 调查与 verifier 判定。
 * Ground Truth：最近提交 "fix bug in app"；src/app.js 被改 3 次。
 */

import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";

const envDir = join(import.meta.dir, "..", "env");

export function buildEnv(): string {
  const gitDir = join(envDir, ".git");
  if (!existsSync(gitDir)) {
    execSync("git init -q", { cwd: envDir });
    execSync('git config user.email "eval@chita.local"', { cwd: envDir });
    execSync('git config user.name "chita-eval"', { cwd: envDir });
    writeFileSync(join(envDir, "src", "app.js"), "v1\n");
    writeFileSync(join(envDir, "src", "util.js"), "v1\n");
    execSync("git add -A && git commit -qm 'initial scaffold'", { cwd: envDir });
    writeFileSync(join(envDir, "src", "app.js"), "v2\n");
    execSync("git commit -qam 'add feature A'", { cwd: envDir });
    writeFileSync(join(envDir, "src", "util.js"), "v3\n");
    execSync("git commit -qam 'refactor util'", { cwd: envDir });
    writeFileSync(join(envDir, "src", "app.js"), "v4\n");
    execSync("git commit -qam 'fix bug in app'", { cwd: envDir });
  }
  return gitDir;
}

if (import.meta.main) {
  mkdirSync(join(envDir, "src"), { recursive: true });
  buildEnv();
  console.log("e05 env built:");
  console.log(execSync("git log --oneline", { cwd: envDir }).toString().trim());
}
