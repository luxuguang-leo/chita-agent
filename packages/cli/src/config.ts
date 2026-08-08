/**
 * chita config module (part of the cli package)
 *
 * Location: ~/.chita/config.json
 * API key: read only from environment (CHITA_API_KEY) — never in config.json,
 *          never in git, never in conversation.
 */

import { mkdirSync, existsSync, writeFileSync, readFileSync } from "node:fs";

export interface Config {
  /** Default provider (OpenAI-compatible first, v2.1 §2.1) */
  provider: string;
  /** Model name, e.g. "deepseek-chat" */
  model: string;
  /** Default tool permission: allow | ask | deny (v2.1 §2.3) */
  permissionDefault: "allow" | "ask" | "deny";
  /** Hard per-task token budget cap (v2.1 §2.2, <1M) */
  maxTokensPerTask: number;
}

export const DEFAULT_CONFIG: Config = {
  provider: "openai-compatible",
  model: "deepseek-chat",
  permissionDefault: "ask",
  maxTokensPerTask: 1_000_000,
};

/** Config directory (decision #6: ~/.chita/) */
export const CONFIG_DIR = `${process.env.HOME}/.chita`;
export const CONFIG_PATH = `${CONFIG_DIR}/config.json`;

/** Whitelist: config.json only accepts these keys; unknown keys (e.g. apiKey) never enter memory */
const CONFIG_KEYS = ["provider", "model", "permissionDefault", "maxTokensPerTask"] as const;

/** Load config; returns defaults if file is missing (never auto-creates; only init writes) */
export function loadConfig(): Config {
  try {
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const picked: Record<string, unknown> = {};
    for (const k of CONFIG_KEYS) {
      if (k in parsed) picked[k] = parsed[k];
    }
    return { ...DEFAULT_CONFIG, ...(picked as Partial<Config>) };
  } catch {
    return DEFAULT_CONFIG;
  }
}

/** API key comes only from environment (never config, never conversation) */
export function apiKey(): string | null {
  return process.env.CHITA_API_KEY ?? null;
}

/** chita init: create ~/.chita/ + config.json; skip if already present */
export function initConfig(): { created: boolean; path: string } {
  if (existsSync(CONFIG_PATH)) return { created: false, path: CONFIG_PATH };
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n");
  return { created: true, path: CONFIG_PATH };
}
