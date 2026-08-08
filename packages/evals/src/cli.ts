/**
 * chita evals CLI — `bun run evals [--only e01,e02] [--verify-only]`
 *
 * Modes:
 * - default: verify-only against current env state (M0 behavior)
 * - --only <ids>: comma-separated case filter
 *
 * M1: with a real Provider wired in, `--run` executes instructions through
 * the agent first; the provider hookup lands with the ai layer (M1.5).
 */

import { runEvals, summarize, discoverCases, runVerifier } from "./index.ts";
import { resolve } from "node:path";

const CASES_ROOT = resolve(import.meta.dir, "../../../evals/cases");
const args = process.argv.slice(2);

const onlyIdx = args.indexOf("--only");
const only = onlyIdx > -1 ? args[onlyIdx + 1] : undefined;

async function main(): Promise<void> {
  const cases = discoverCases(CASES_ROOT);
  if (only) {
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

  // verify-only (no provider yet)
  const results = await runEvals({ root: CASES_ROOT });
  summarize(results);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
