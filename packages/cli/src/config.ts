/**
 * chita 配置模块（属 cli 包）
 *
 * 位置：~/.chita/config.json
 * API key：仅从环境变量读取（CHITA_API_KEY），不进 config.json、不进 git、不进对话。
 */

import { mkdirSync, existsSync, writeFileSync } from "node:fs";

export interface Config {
  /** 默认 provider（OpenAI 兼容起步，v2.1 §2.1） */
  provider: string;
  /** 模型名，如 "deepseek-chat" */
  model: string;
  /** 工具权限默认值：allow | ask | deny（v2.1 §2.3） */
  permissionDefault: "allow" | "ask" | "deny";
  /** 单任务 token 预算硬上限（v2.1 §2.2，<1M） */
  maxTokensPerTask: number;
}

export const DEFAULT_CONFIG: Config = {
  provider: "openai-compatible",
  model: "deepseek-chat",
  permissionDefault: "ask",
  maxTokensPerTask: 1_000_000,
};

/** 配置目录（决策点 #6：~/.chita/） */
export const CONFIG_DIR = `${process.env.HOME}/.chita`;
export const CONFIG_PATH = `${CONFIG_DIR}/config.json`;

/** 读取配置；文件不存在时返回默认值（不自动建文件，init 才写） */
export function loadConfig(): Config {
  try {
    const { readFileSync } = require("node:fs");
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_CONFIG;
  }
}

/** API key 只从环境变量读（不进配置、不进对话） */
export function apiKey(): string | null {
  return process.env.CHITA_API_KEY ?? null;
}

/** chita init：建 ~/.chita/ + config.json；已存在则跳过 */
export function initConfig(): { created: boolean; path: string } {
  if (existsSync(CONFIG_PATH)) return { created: false, path: CONFIG_PATH };
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n");
  return { created: true, path: CONFIG_PATH };
}
