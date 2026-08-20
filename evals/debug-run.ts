/**
 * Debug: run e08 through the real DeepSeek provider and inspect the loop.
 */
import { AgentLoop } from "../packages/agent/src/loop.ts";
import { OpenAICompatibleProvider } from "../packages/ai/src/index.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const cwd = join(import.meta.dir, "cases/e08-verify-output");
const instruction = readFileSync(
  join(cwd, "instruction.md"),
  "utf-8"
);

const provider = new OpenAICompatibleProvider({
  baseUrl: "https://api.deepseek.com/v1",
  apiKey: process.env.DEEPSEEK_API_KEY!,
  model: "deepseek-v4-flash",
});

const loop = new AgentLoop({
  cwd,
  provider,
  autoApproveAsk: true,
  maxIterations: 30,
  hooks: {
    beforeToolCall: async (name) => {
      console.log(`[TOOL] ${name}`);
      return true;
    },
    onAssistantMessage: (m) => console.log(`[ASST] ${m.content.slice(0, 80)}`),
  },
});

const outcome = await loop.run(instruction);
console.log("\n=== OUTCOME ===");
console.log("state:", outcome.state);
console.log("summary:", outcome.summary);
console.log("\n=== CONVERSATION ===");
for (const m of loop.getConversation()) {
  console.log(`[${m.role}] ${m.content.slice(0, 120)}`);
}
