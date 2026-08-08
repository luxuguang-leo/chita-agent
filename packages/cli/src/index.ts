/**
 * chita CLI (M2 version)
 *
 * Subcommands:
 *   chita --version        print version
 *   chita init             generate ~/.chita/config.json
 *   chita "task"           run the task through the agent loop (--print mode)
 *   chita --plan "task"    read-only analysis (plan mode)
 *   chita --resume         session resume (M1.5+; placeholder)
 */

import { loadConfig, initConfig, apiKey, CONFIG_PATH } from "./config.ts";
import { AgentLoop } from "@chita/agent/src/loop.ts";
import { OpenAICompatibleProvider } from "@chita/ai/src/index.ts";
import { scrubSecrets } from "@chita/agent/src/scrub.ts";
import { runJudge } from "@chita/agent/src/judge.ts";

export const VERSION = "0.1.0";

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

async function runAgent(task: string, opts: { plan?: boolean; judge?: boolean }): Promise<void> {
  const cfg = loadConfig();
  const key = apiKey();
  if (!key) {
    console.error("CHITA_API_KEY is not set (required to run tasks)");
    process.exit(1);
  }

  // Worker provider: the model doing the task
  const provider = new OpenAICompatibleProvider({
    baseUrl: `https://api.deepseek.com/v1`,
    apiKey: key,
    model: cfg.model,
  });

  const loop = new AgentLoop({
    cwd: process.cwd(),
    provider,
    mode: opts.plan ? "plan" : "build",
    autoApproveAsk: true, // --print dev mode (v2.1 §2.3)
    hooks: {
      beforeToolCall: async () => true,
      // scrub tool output before it reaches the model (v2.1 F4)
      afterToolCall: (_name, result) => {
        if (result.output) {
          const scrubbed = scrubSecrets(result.output);
          return { ok: result.ok, output: scrubbed.text };
        }
      },
    },
  });

  console.log(`[chita ${opts.plan ? "plan" : "build"}] ${task}`);
  const outcome = await loop.run(task);
  console.log(`\n[chita] state: ${outcome.state}${outcome.summary ? ` | ${outcome.summary}` : ""}`);
  if (outcome.state !== "DONE") process.exitCode = 1;

  // /goal judge (v2.1 §2.2, M4): independent verification on done().
  // Judge uses a SEPARATE provider instance (never the worker's) so the
  // evaluating model is distinct from the working model (Cursor nit: the
  // orchestration layer guarantees this, not the judge module itself).
  if (opts.judge && outcome.state === "DONE") {
    // /goal judge: SEPARATE provider instance AND separate model — same-model
    // self-review is optimistically consistent (Cursor F1). CHITA_JUDGE_MODEL
    // overrides; default to a different, stronger tier.
    const judgeModel = process.env.CHITA_JUDGE_MODEL ?? (cfg.model === "deepseek-v4-pro" ? "deepseek-v4-flash" : "deepseek-v4-pro");
    const judgeProvider = new OpenAICompatibleProvider({
      baseUrl: `https://api.deepseek.com/v1`,
      apiKey: key,
      model: judgeModel,
    });
    const judgeResult = await runJudge(judgeProvider, loop.getConversation(), task);
    console.log(`[chita] judge (${judgeModel}): ${judgeResult.verdict} — ${judgeResult.reason}`);
    if (judgeResult.verdict === "fail") process.exitCode = 1;
  }
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
        '  chita "task"             run a task (--print mode)',
        '  chita --plan "task"      read-only analysis (plan mode)',
        "  chita --judge \"task\"     run task + /goal judge verification",
        "  chita --resume           resume session (M2+)",
        "",
        "Env: CHITA_API_KEY required for running tasks",
      ].join("\n")
    );
    return;
  }

  if (args.includes("--version")) return printVersion();
  if (args[0] === "init") return runInit();
  if (args[0] === "--resume") {
    console.log("[chita] --resume lands in M2+");
    return;
  }
  if (args[0] === "--plan") {
    await runAgent(args.slice(1).join(" "), { plan: true });
    return;
  }
  if (args[0] === "--judge") {
    await runAgent(args.slice(1).join(" "), { judge: true });
    return;
  }
  await runAgent(args.join(" "), { plan: false });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
