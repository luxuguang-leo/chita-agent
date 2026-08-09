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
  // Ensure the terminal cursor is visible — a hidden cursor (e.g. left over
  // from a previous fullscreen app) makes the input position invisible
  // (Leo: "没有提示光标输入，看不到以为没有输入位置").
  process.stdout.write("\x1b[?25h");

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
  // Prominent prompt: bright/underlined marker + cursor-show, so the input
  // position is obvious even if the terminal cursor doesn't blink visibly.
  const question = (q: string): Promise<string> => {
    process.stdout.write(`\x1b[?25h\x1b[1;36m${q}\x1b[0m`);
    return Promise.resolve(readLineSync());
  };

  // Masked secret input: raw mode, echo '*' per char, support backspace,
  // Ctrl+U (clear line), and pasted content. Falls back to plain line read
  // on non-TTY (piped) stdin. (Leo: pasting the key showed plaintext.)
  const isTTY = process.stdin.isTTY === true;
  const readSecretSync = (): string => {
    if (!isTTY) return readLineSync();
    const prevRaw = process.stdin.isRaw ?? false;
    process.stdin.setRawMode?.(true);
    let secret = "";
    for (;;) {
      const b = Buffer.alloc(1);
      const n = readSync(fd, b, 0, 1, null);
      if (n <= 0) break; // EOF
      const c = b.toString("utf8");
      if (c === "\n" || c === "\r") break; // Enter
      if (c === "\u0003") { process.stdout.write("\n"); process.stdin.setRawMode?.(prevRaw); throw new Error("aborted"); }
      if (c === "\u007f" || c === "\b") { // backspace
        if (secret.length > 0) {
          secret = secret.slice(0, -1);
          process.stdout.write("\b \b");
        }
        continue;
      }
      if (c === "\u0015") { // Ctrl+U: clear line
        process.stdout.write("\r\u001b[K");
        process.stdout.write("\x1b[?25h\x1b[1;36m  API key: \x1b[0m");
        secret = "";
        continue;
      }
      // bracketed paste: \x1b[200~ ... \x1b[201~ — strip markers, echo once
      if (c === "\u001b") {
        // consume escape sequence (single char read: gather the rest)
        let esc = "\u001b";
        while (esc.length < 4) {
          const e = Buffer.alloc(1);
          const en = readSync(fd, e, 0, 1, null);
          if (en <= 0) break;
          esc += e.toString("utf8");
          if (esc.endsWith("~")) break;
        }
        if (esc.startsWith("\u001b[200~")) {
          // paste start marker — subsequent chars are content until [201~
          for (;;) {
            const p = Buffer.alloc(1);
            const pn = readSync(fd, p, 0, 1, null);
            if (pn <= 0) return secret;
            const pc = p.toString("utf8");
            if (pc === "\u001b") {
              let pend = "\u001b";
              while (!pend.endsWith("~") && pend.length < 8) {
                const pe = Buffer.alloc(1);
                const pen = readSync(fd, pe, 0, 1, null);
                if (pen <= 0) break;
                pend += pe.toString("utf8");
              }
              if (pend.includes("201~")) break;
              secret += pend;
              process.stdout.write("*".repeat(pend.length));
              continue;
            }
            if (pc === "\r" || pc === "\n") continue; // paste may contain newlines
            secret += pc;
            process.stdout.write("*");
          }
          continue;
        }
        // other escape (arrow etc): ignore
        continue;
      }
      secret += c;
      process.stdout.write("*");
    }
    process.stdout.write("\n");
    process.stdin.setRawMode?.(prevRaw);
    return secret;
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

  // 4. API key — masked (echoes *, never plaintext; Leo: pasting showed it)
  process.stdout.write("\x1b[?25h\x1b[1;36m  API key: \x1b[0m");
  let key = "";
  try {
    key = (await Promise.resolve(readSecretSync())).trim();
  } catch {
    return { ok: false, message: "setup aborted" };
  }
  if (!key) {
    return { ok: false, message: "no API key provided — setup aborted" };
  }
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
