/**
 * chita interactive REPL — `chita` with no args enters a conversational loop.
 *
 * Features:
 * - continuous multi-turn (each turn runs the agent loop with history)
 * - @filepath inline references (resolved to file contents in the task)
 * - slash commands: /new (fresh session), /resume (reopen last session),
 *   /exit, /help
 * - Ctrl-C cancels the current turn (stays in REPL)
 *
 * This is the minimal interactive surface before the pi-tui TUI (M2+
 * selection; full TUI renders the same loop through a terminal UI).
 */

import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { loadConfig, apiKey } from "./config.ts";
import { AgentLoop } from "@chita/agent/src/loop.ts";
import { OpenAICompatibleProvider } from "@chita/ai/src/index.ts";
import { scrubSecrets } from "@chita/agent/src/scrub.ts";
import { runJudge } from "@chita/agent/src/judge.ts";
import { printBanner } from "./banner.ts";
import { VERSION } from "./index.ts";

interface TurnState {
  messages: Parameters<AgentLoop["getConversation"]> extends never ? never : ReturnType<AgentLoop["getConversation"]>;
  loop: AgentLoop;
}

/** Resolve @filepath references in the task into inline file contents. */
function expandReferences(task: string): string {
  return task.replace(/@([\w./~-]+)/g, (m, path: string) => {
    try {
      const full = path.startsWith("~") ? path.replace("~", process.env.HOME ?? "~") : path;
      const content = readFileSync(full, "utf-8");
      return `\n--- @${path} ---\n${content.slice(0, 4000)}`;
    } catch {
      return m; // unresolvable: keep as-is
    }
  });
}

/** Run one turn through the agent loop; returns (state, summary, conversation). */
async function runTurn(
  loop: AgentLoop,
  task: string,
  opts: { judge?: boolean; key: string; model: string }
): Promise<{ state: string; summary?: string }> {
  const outcome = await loop.run(task);
  console.log(`\n[chita] state: ${outcome.state}${outcome.summary ? ` | ${outcome.summary}` : ""}`);

  if (opts.judge && outcome.state === "DONE") {
    const judgeModel = process.env.CHITA_JUDGE_MODEL ?? (opts.model === "deepseek-v4-pro" ? "deepseek-v4-flash" : "deepseek-v4-pro");
    const judgeProvider = new OpenAICompatibleProvider({
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: opts.key,
      model: judgeModel,
    });
    const judgeResult = await runJudge(judgeProvider, loop.getConversation(), task);
    console.log(`[chita] judge (${judgeModel}): ${judgeResult.verdict} — ${judgeResult.reason}`);
  }
  return { state: outcome.state, summary: outcome.summary };
}

/** Interactive REPL main loop. */
export async function startRepl(opts: { judge?: boolean } = {}): Promise<void> {
  const cfg = loadConfig();
  const key = apiKey();
  if (!key) {
    console.error("CHITA_API_KEY is not set (required to run tasks)");
    process.exit(1);
  }

  printBanner({ version: VERSION, model: cfg.model, cwd: process.cwd() });
  console.log("Interactive mode — type a task, @file for references, /help for commands.\n");

  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "chita> " });
  const provider = () =>
    new OpenAICompatibleProvider({ baseUrl: "https://api.deepseek.com/v1", apiKey: key, model: cfg.model });

  let turn: TurnState | null = null;

  rl.prompt();
  rl.on("line", async (line) => {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }

    // slash commands
    if (input.startsWith("/")) {
      const cmd = input.split(/\s+/)[0];
      switch (cmd) {
        case "/new":
          turn = null;
          console.log("[chita] new session started\n");
          rl.prompt();
          return;
        case "/exit":
          rl.close();
          return;
        case "/help":
          console.log(
            [
              "commands:",
              "  /new         fresh session (drop history)",
              "  /resume      (planned) reopen last session",
              "  /exit        leave interactive mode",
              "  @file        inline a file's contents into the task",
              "",
              "examples:",
              '  chita> explain @src/main.ts',
              '  chita> fix the bug, then run the tests',
              "",
            ].join("\n")
          );
          rl.prompt();
          return;
        default:
          console.log(`[chita] unknown command: ${cmd} (try /help)\n`);
          rl.prompt();
          return;
      }
    }

    // task turn: reuse loop for multi-turn continuity (conversation history)
    const task = expandReferences(input);
    if (!turn) {
      const loop = new AgentLoop({
        cwd: process.cwd(),
        provider: provider(),
        autoApproveAsk: true,
        hooks: {
          beforeToolCall: async () => true,
          afterToolCall: (_n, result) => {
            if (result.output) {
              const scrubbed = scrubSecrets(result.output);
              return { ok: result.ok, output: scrubbed.text, redacted: scrubbed.redacted };
            }
          },
        },
      });
      turn = { loop, messages: loop.getConversation() };
    }

    const outcome = await runTurn(turn.loop, task, { judge: opts.judge, key, model: cfg.model });
    // multi-turn continuity: the loop keeps its messages; a follow-up appends
    // the next task as a new user turn after the previous DONE
    if (outcome.state === "DONE") {
      // conversation is inside the loop; next line continues from there
    }
    console.log("");
    rl.prompt();
  });

  rl.on("close", () => {
    console.log("\nbye from chita");
    process.exit(0);
  });
}
