# Security Policy

## Supported Versions

尚无正式 release；安全修复跟随 `main` 分支。

| Version | Supported |
| ------- | --------- |
| main (0.x) | ✅ |

## Reporting a Vulnerability

请**私下**报告，勿开公开 issue。

- **首选**：GitHub Security Advisories → "Report a vulnerability"（私有，仅维护者可见）

收到报告后我们会在 3 个工作日内确认，并尽快发布修复。

## 安全设计（chita 自带的脱敏机制）

- API key 只从环境变量 `CHITA_API_KEY` 或 `~/.chita/.env` 读取，**永不**进入 `config.json`、会话、或 git。
- 主循环（CLI/TUI/evals）下工具输出经 `scrub.ts`（F4）脱敏后才进入模型与 tape，覆盖 `sk-` / `Bearer` / PEM 私钥 / AWS `AKIA` / GitHub token。
- 依赖锁 `bun.lock` 为纯文本，可审计；MCP/skills 走 pinning。

## 已知限制

- `scrub.ts` 目前只在 CLI/TUI/evals 主循环挂载（`afterToolCall`）；`subagent` / `workflow` / `debug-run` 路径暂未挂载，工具输出原样进入模型。
- 用户输入（含粘贴的密钥）不脱敏，会进入会话 tape 与 compaction 摘要。
- 以上两项见开发记录 cur-084，属已知项，后续版本补齐。

## Scope

- 密钥/脱敏缺陷（scrub 漏报、key 意外落盘）为最高优先级。
- 依赖、MCP、skills 的供应链问题。
