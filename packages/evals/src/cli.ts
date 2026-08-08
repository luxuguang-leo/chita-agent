/**
 * chita evals CLI — `bun run evals [--only e01,e02] [--run]`
 *
 * Modes:
 * - default (no --run): verify-only against current env state (M0/M1 behavior)
 * - --run: execute each case's instruction through the agent with a real
 *   OpenAI-compatible provider (CHITA_API_KEY env), then verify
 * - --only <ids>: comma-separated case filter
 * - --base-url <url>: provider endpoint (default https://api.deepseek.com/v1)
 * - --model <name>: model (default deepseek-chat)
 *
 * Security: --run attaches the afterToolCall scrub hook (v2.1 F4) so tool
 * output reaching the model/tape never carries secrets from eval fixtures.
 */

import { runEvals, summarize, discoverCases, runVerifier } from "./index.ts";
import { OpenAICompatibleProvider } from "@chita/ai/src/index.ts";
import { scrubSecrets } from "@chita/agent/src/scrub.ts";
import { resolve } from "node:path";

const CASES_ROOT = resolve(import.meta.dir, "../../../evals/cases");
const args = process.argv.slice(2);

const onlyIdx = args.indexOf("--only");
const only = onlyIdx > -1 ? args[onlyIdx + 1] : undefined;
const runMode = args.includes("--run");
const baseUrlIdx = args.indexOf("--base-url");
const baseUrl = baseUrlIdx > -1 ? args[baseUrlIdx + 1] : "https://api.deepseek.com/v1";
const modelIdx = args.indexOf("--model");
const model = modelIdx > -1 ? args[modelIdx + 1] : "deepseek-chat";

async function main(): Promise<void> {
  const cases = discoverCases(CASES_ROOT);

  // --only with verifier detail (verify-only per case)
  if (only && !runMode) {
    const ids = only.split(",");
    for (const id of ids) {
      const c = cases.find((x) => x.id === id);
      if (!c) {
        console.error(`unknown case: ${id}`);
        process.exitCode = 1;
        continue;
      }
      const { exit, output } = runVerifier(c);
      console.log(`${exit === 0 ? "PASS" : "FAIL"}  ${c.id}`);
      if (exit !== 0) console.log(output.trim().slice(0, 500));
    }
    return;
  }

  // --run: agent executes instructions through a real provider
  if (runMode) {
    const apiKey = process.env.CHITA_API_KEY;
    if (!apiKey) {
      console.error("CHITA_API_KEY is required for --run mode");
      process.exit(1);
    }
    const provider = new OpenAICompatibleProvider({ baseUrl, apiKey, model });
    const results = await runEvals({
      root: CASES_ROOT,
      provider,
      only,
      maxIterations: 30,
      // scrub tool output before it reaches the model (v2.1 F4)
      hooks: {
        beforeToolCall: async () => true,
        afterToolCall: (_name, result) => {
          if (result.output) {
            const scrubbed = scrubSecrets(result.output);
            return { ok: result.ok, output: scrubbed.text, redacted: scrubbed.redacted };
          }
        },
      },
    });
    summarize(results);
    return;
  }

  // default: verify-only baseline
  const results = await runEvals({ root: CASES_ROOT, only });
  summarize(results);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
