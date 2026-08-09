/**
 * chita config module (part of the cli package)
 *
 * Location: ~/.chita/config.json
 * API key: read only from environment (CHITA_API_KEY) — never in config.json,
 *          never in git, never in conversation.
 */

import { mkdirSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface Config {
  /** Default provider (OpenAI-compatible first, v2.1 §2.1) */
  provider: string;
  /** Model name, e.g. "deepseek-chat" */
  model: string;
  /** Default tool permission: allow | ask | deny (v2.1 §2.3) */
  permissionDefault: "allow" | "ask" | "deny";
  /** Hard per-task token budget cap (v2.1 §2.2, <1M) */
  maxTokensPerTask: number;
  /** Model context window in tokens (status bar shows usage %; e.g. DS 1M = 1_048_576) */
  contextWindow: number;
}

export const DEFAULT_CONFIG: Config = {
  provider: "openai-compatible",
  model: "deepseek-chat",
  permissionDefault: "ask",
  maxTokensPerTask: 1_000_000,
  contextWindow: 131_072,
};

/** Config directory (decision #6: ~/.chita/) */
export const CONFIG_DIR = `${process.env.HOME}/.chita`;
export const CONFIG_PATH = `${CONFIG_DIR}/config.json`;

/** Whitelist: config.json only accepts these keys; unknown keys (e.g. apiKey) never enter memory */
const CONFIG_KEYS = ["provider", "model", "permissionDefault", "maxTokensPerTask", "contextWindow"] as const;

/** Load config; returns defaults if file is missing (never auto-creates; only init writes).
 *  contextWindow defaults by model when not explicitly set: DeepSeek models
 *  ship with a 1M-token context (Leo saw 295% against the 128K default). */
export function loadConfig(): Config {
  try {
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const picked: Record<string, unknown> = {};
    for (const k of CONFIG_KEYS) {
      if (k in parsed) picked[k] = parsed[k];
    }
    const cfg = { ...DEFAULT_CONFIG, ...(picked as Partial<Config>) };
    // explicit config wins; otherwise infer from the model name
    if (!("contextWindow" in parsed)) {
      const model = (parsed.model as string) ?? cfg.model;
      if (/^deepseek/.test(model)) cfg.contextWindow = 1_048_576; // DS 1M
    }
    return cfg;
  } catch {
    return DEFAULT_CONFIG;
  }
}

/** API key comes only from environment or ~/.chita/.env (never config.json,
 *  never conversation). Precedence: CHITA_API_KEY env > ~/.chita/.env. */
export function apiKey(): string | null {
  if (process.env.CHITA_API_KEY) return process.env.CHITA_API_KEY;
  // chita's own key file (~/.chita/.env): "CHITA_API_KEY=sk-..."
  try {
    const raw = readFileSync(join(CONFIG_DIR, ".env"), "utf-8");
    const m = raw.match(/^CHITA_API_KEY=(.+)$/m);
    if (m) return m[1].trim();
  } catch {
    // no .env — caller decides (missing key)
  }
  return null;
}

/** chita init: create ~/.chita/ + config.json; skip if already present */
export function initConfig(): { created: boolean; path: string } {
  if (existsSync(CONFIG_PATH)) return { created: false, path: CONFIG_PATH };
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n");
  return { created: true, path: CONFIG_PATH };
}
