# chita / 猎豹

A local terminal coding agent. Single binary, eval-driven, audit-friendly.
单机终端 coding agent。单二进制、评估驱动、供应链可审计。

- **形态 Form**: 单机终端 CLI（`--print` 起步，TUI 选型已定 pi-tui）
- **定位 Positioning**: Harness Layer —— 冻结模型、重写外围 harness，让评估数据驱动 harness 自身改进
- **三个立项目标 Goals**:
  1. 会话可恢复 Session-recoverable（崩溃/换终端不丢上下文，tape-first 存储 + compaction）
  2. 评估驱动 Eval-driven（EDD：先写 eval 再开发，traces 锚定改进）
  3. 供应链可审计 Audit-friendly（text lockfile、bun audit、MCP/Skills pinning）

## 状态 Status

✅ **M0-M4 全里程碑完成 + M4.5 收尾**（2026-08-09，118/118 测试）——8/8 eval 用真实 DeepSeek 可复现 PASS。
✅ All milestones (M0-M4) + M4.5 cleanup complete — 8/8 evals reproducibly PASS with real DeepSeek.

## 安装 Install（待发布 / pending release）

```bash
# 单二进制 Single binary（Bun compile，对标 codex 一行安装）
bun build --compile --target=bun ./packages/cli/src/index.ts --outfile ./dist/chita
```

## 使用 Usage

```bash
export CHITA_API_KEY=...          # DeepSeek (OpenAI-compatible)

chita init                        # 生成 ~/.chita/config.json
chita "看看这个项目的入口"          # 运行任务 Run a task（--print 模式）
chita --plan "审查这个改动"        # 只读分析 Read-only analysis（plan 模式，禁写工具）
chita --judge "修这个 bug"        # 运行 + /goal judge 独立验证（CHITA_JUDGE_MODEL 可指定独立模型）
chita --version

# 中英混用均可，任务指令用自然语言
# Chinese or English task instructions both work
```

| 环境变量 Env | 说明 |
|---|---|
| `CHITA_API_KEY` | 必填，OpenAI 兼容 provider key（DeepSeek/Kimi/GLM/Ollama） |
| `CHITA_JUDGE_MODEL` | 可选，/goal judge 独立模型（默认自动切档位） |

## 架构 Architecture

```
UI 层        cli (--print) / tui (pi-tui, M2)
编排层        coding-agent（技能组合 + prompt 体系）
核心层        agent loop（状态机 + done 硬门）
             ├─ tool registry（权限分级 + beforeToolCall hook）
             ├─ context-manager（compact/truncate/overflow）
             ├─ hook 体系（before/after tool call, session_end）
             ├─ subagent（TaskResult 证据契约, M3）
             └─ judge（/goal 独立评估防早停, M4）
能力层        ai（OpenAI-compatible provider） mcp skills
存储层        session-backends（tape-first JSONL + SQLite 索引）
             memory（四层：MEMORY/checkpoint/notes/tasks）
```

## 评估 Evaluation

```bash
bun run evals              # verify-only 基线
bun run evals --run        # agent 执行 + verifier（需 CHITA_API_KEY）
bun run evals --only e01   # 单 case
```

8 个 eval case（`evals/cases/`）：读项目 / 修 bug / 跑测试 / git 调查 / 搜索定位 / 跨文件改名 / 如实报告。每个 case = instruction + env(fixture) + verifier(确定性检查)。`--run` 模式用 tmpdir 隔离（fixture 永不被污染）。

8 eval cases: read-project / edit-file / run-test / fix-bug / git-log / grep-search / consistent-edit / verify-output. Each = instruction + env(fixture) + verifier(deterministic). `--run` isolates fixtures in tmpdir.

## 开发 Development

```bash
bun test                   # 118 tests across packages
bunx tsc --noEmit          # type check
```

Monorepo（bun workspaces）：`packages/{ai, agent, tools, session, cli, evals}`。

## 许可 License

MIT
