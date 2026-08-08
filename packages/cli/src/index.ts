/**
 * chita CLI 入口（M0 版）
 *
 * 子命令（M0 范围）：
 *   chita --version        版本号
 *   chita init             生成 ~/.chita/config.json
 *   chita "任务"           --print 模式占位（M1 实现）
 *   chita --resume         会话恢复占位（M1 实现）
 */

import { loadConfig, initConfig, apiKey, CONFIG_PATH } from "./config.ts";

export const VERSION = "0.0.0";

function printVersion(): void {
  console.log(`chita ${VERSION} (猎豹 · 自建 coding agent)`);
}

function runInit(): void {
  const { created } = initConfig();
  console.log(
    created
      ? `✓ 已生成 ${CONFIG_PATH}（API key 请用环境变量 CHITA_API_KEY 设置）`
      : `已存在 ${CONFIG_PATH}，跳过`
  );
}

async function printMode(task: string): Promise<void> {
  const cfg = loadConfig();
  const key = apiKey();
  console.log(`[chita --print] 任务: ${task}`);
  console.log(`  provider=${cfg.provider} model=${cfg.model}`);
  console.log(
    key ? "  api key: ✓ (env)" : "  api key: ✗ 未设置 CHITA_API_KEY"
  );
  console.log("  [M0 占位] agent loop 于 M1 实现");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("-h") || args.includes("--help")) {
    console.log(
      [
        "chita — 单机终端 coding agent（猎豹）",
        "",
        "用法:",
        "  chita --version          版本号",
        "  chita init               生成 ~/.chita/config.json",
        "  chita \"任务\"            --print 模式（M1 实现）",
        "  chita --resume           会话恢复（M1 实现）",
        "",
      ].join("\n")
    );
    return;
  }

  if (args.includes("--version")) return printVersion();
  if (args[0] === "init") return runInit();
  if (args[0] === "--resume") {
    console.log("[M0 占位] --resume 于 M1 实现");
    return;
  }
  await printMode(args.join(" "));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
