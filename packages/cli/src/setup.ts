/**
 * chita first-run setup — interactive API key configuration.
 *
 * When no CHITA_API_KEY is found (env or ~/.chita/.env), guide the user like
 * other agents (Claude Code /login, codex login): pick a provider, paste the
 * key, write ~/.chita/.env. Mirrors the "select model, input API key" flow.
 */

import { mkdirSync, writeFileSync, readFileSync, readSync } from "node:fs";
import { CONFIG_DIR } from "./config.ts";

export interface ProviderChoice {
  id: string;
  label: string;
  baseUrl: string;
  defaultModel: string;
}

/** OpenAI-compatible providers (chita speaks this protocol). */
export const PROVIDERS: ProviderChoice[] = [
  { id: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", defaultModel: "deepseek-v4-flash" },
  { id: "kimi", label: "Kimi (Moonshot)", baseUrl: "https://api.moonshot.cn/v1", defaultModel: "moonshot-v1-8k" },
  { id: "glm", label: "GLM (Zhipu)", baseUrl: "https://open.bigmodel.cn/api/paas/v4", defaultModel: "glm-4-flash" },
  { id: "ollama", label: "Ollama (local)", baseUrl: "http://localhost:11434/v1", defaultModel: "llama3" },
  { id: "custom", label: "Custom (OpenAI-compatible)", baseUrl: "", defaultModel: "" },
];

/** Interactive setup: choose provider, paste key, write ~/.chita/.env. */
export async function runSetup(): Promise<{ ok: boolean; message: string }> {
  // bun's stream/readline stdin events are unreliable for piped input;
  // read synchronously (works for both TTY line input and piped stdin).
  const fd = 0;
  let syncBuf = "";
  const readLineSync = (): string => {
    for (;;) {
      const nl = syncBuf.indexOf("\n");
      if (nl !== -1) {
        const line = syncBuf.slice(0, nl).replace(/\r$/, "");
        syncBuf = syncBuf.slice(nl + 1);
        return line;
      }
      const chunk = Buffer.alloc(4096);
      const n = readSync(fd, chunk, 0, chunk.length, null);
      if (n <= 0) return syncBuf; // EOF — return what we have
      syncBuf += chunk.toString("utf8", 0, n);
    }
  };
  const question = (q: string): Promise<string> => {
    process.stdout.write(q);
    return Promise.resolve(readLineSync());
  };

  console.log("\nchita needs an API key to run tasks (OpenAI-compatible provider).\n");

  // 1. provider
  console.log("Choose a provider:");
  PROVIDERS.forEach((p, i) => console.log(`  ${i + 1}. ${p.label}${p.baseUrl ? ` (${p.baseUrl})` : ""}`));
  const provRaw = (await question("  [1-5]: ")).trim();
  const provIdx = Number(provRaw) - 1;
  const provider = PROVIDERS[provIdx] ?? PROVIDERS[0];
  console.log(`→ ${provider.label}\n`);

  // 2. base URL (custom only)
  let baseUrl = provider.baseUrl;
  if (provider.id === "custom" && !baseUrl) {
    baseUrl = (await question("  Base URL (e.g. https://api.example.com/v1): ")).trim() || baseUrl;
  }

  // 3. model
  let model = provider.defaultModel;
  if (!model) {
    model = (await question("  Model name: ")).trim();
  }

  // 4. API key (masked input is hard cross-platform; just read the line)
  const key = (await question("  API key: ")).trim();
  if (!key) {
    return { ok: false, message: "no API key provided — setup aborted" };
  }

  // 5. write ~/.chita/.env (chita's own key file; NOT hermes')
  mkdirSync(CONFIG_DIR, { recursive: true });
  const envPath = `${CONFIG_DIR}/.env`;
  writeFileSync(envPath, `CHITA_API_KEY=${key}\n`);
  // also write provider/model into config.json if not already there
  try {
    const cfgPath = `${CONFIG_DIR}/config.json`;
    const cfg = JSON.parse(readFileSync(cfgPath, "utf-8")) as Record<string, unknown>;
    cfg.provider = "openai-compatible";
    cfg.model = model;
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
  } catch {
    // config.json may not exist yet; init will handle it
  }

  return {
    ok: true,
    message: `configured: ${provider.label} / ${model}\nkey saved to ${envPath} (chita's own, independent of Hermes)`,
  };
}
