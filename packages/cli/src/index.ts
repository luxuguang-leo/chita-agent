/**
 * chita CLI entry (M0 version)
 *
 * Subcommands (M0 scope):
 *   chita --version        print version
 *   chita init             generate ~/.chita/config.json
 *   chita "task"           --print mode placeholder (implemented in M1)
 *   chita --resume         session resume placeholder (implemented in M1)
 */

import { loadConfig, initConfig, apiKey, CONFIG_PATH } from "./config.ts";

export const VERSION = "0.0.0";

function printVersion(): void {
  console.log(`chita ${VERSION}`);
}

function runInit(): void {
  const { created } = initConfig();
  console.log(
    created
      ? `created ${CONFIG_PATH} (set API key via CHITA_API_KEY env var)`
      : `${CONFIG_PATH} already exists, skipping`
  );
}

async function printMode(task: string): Promise<void> {
  const cfg = loadConfig();
  const key = apiKey();
  console.log(`[chita --print] task: ${task}`);
  console.log(`  provider=${cfg.provider} model=${cfg.model}`);
  console.log(key ? "  api key: ok (env)" : "  api key: missing CHITA_API_KEY");
  console.log("  [M0 placeholder] agent loop lands in M1");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("-h") || args.includes("--help")) {
    console.log(
      [
        "chita — a local terminal coding agent",
        "",
        "Usage:",
        "  chita --version          print version",
        "  chita init               generate ~/.chita/config.json",
        '  chita "task"             --print mode (M1)',
        "  chita --resume           resume session (M1)",
        "",
      ].join("\n")
    );
    return;
  }

  if (args.includes("--version")) return printVersion();
  if (args[0] === "init") return runInit();
  if (args[0] === "--resume") {
    console.log("[M0 placeholder] --resume lands in M1");
    return;
  }
  await printMode(args.join(" "));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
