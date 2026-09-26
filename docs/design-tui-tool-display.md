# design-tui-tool-display.md — TUI tool 显示优化（无用打印太吵）

- **状态**：方案已定，代码未改
- **来源**：用户实测反馈「agent 跑 pwd/ls 时弹出很多无用的 tool 打印」+ 参考 hermes / omp(oh-my-pi) / pi

## 0. 问题现象（用户实测）

```
tool: [bash] pwd · 31 lines                    ← pwd 只该 1 行，31 行是复合命令被截断误导
tool: [bash] error: total 6984
      drwxrwxr-x ... __MACOSX                   ← ls -la 的 stdout 被塞进 error 字段
      drwxr ...
```

两个具体 bug + 一个体验问题：

1. **命令显示不准确**：`briefCmd` 对 `pwd && ls -la ~` 这种复合命令清理后只剩首词/头 80 字符，丢了命令主体，行数又来自整条命令输出 → `pwd · 31 lines` 严重误导。
2. **失败时 stdout 混入 error**：`bashShape` 失败分支 `error = truncateOutput(stdout + stderr)`，把 ls 的 stdout（`total 6984 …`）当成了 error 文本。
3. **tool 行视觉权重 = assistant 文本**：没有 dim 弱化，探索命令的输出和 agent 真正说的话一样醒目，形成噪音。

## 1. 参考实现

### hermes（Ink，`ui-tui/src/lib/text.ts`）

- **紧凑单行**：`ToolName("preview") (1.2s) :: result ✓/✗`
  - `compactPreview(context, 64)`：命令/参数 64 字符预览
  - `detail`（结果摘要）72 字符
  - `✓/✗` 成功/失败 + `(1.2s)` 耗时
- **大输出硬上限**（`config/limits.ts`）：
  - `VERBOSE_TRAIL_MAX_CHARS = 800` / `MAX_LINES = 12`（trail 持久块）
  - `LIVE_RENDER_MAX_CHARS = 16000` / `MAX_LINES = 240`（live 渲染）
- **tool 放进可折叠的 thinking/tools 区**，默认折叠，展开才看详情。

### omp / pi（`cli.js`）

- **三个独立截断上限**：`toolResultMaxChars=2000` / `toolArgMaxChars=500` / `toolCallMaxChars=2000`。
- **`truncateHeadRatio=0.6`**：截断时保留头 60% + 尾 40%（而不是只砍尾）。
- **`dimToolResults`**：tool 结果用暗色弱化，和正文区分。
- **bash 大输出溢出到临时文件**：`Ran \`cmd\` + [Showing lines X-Y of Z (50KB limit). Full output: /tmp/pi-bash-xxx.log]`——TUI 只显示尾部 + 文件路径，完整输出落盘。

## 2. chita 现状（`packages/tui/src/index.ts`）

| 函数 | 现状 | 问题 |
|---|---|---|
| `briefCmd` | 80 字符折叠**头部** | 复合命令丢主体，`pwd && ls -la` → `pwd` |
| `toolSummary` | 提取 `=== TITLE ===` + 行数 | 仅用于无 command 的工具 |
| `toolLine` | `verb arg · N lines`，42 字符截断 | 大输出无内容摘要，只报行数 |
| 失败分支 | `error: <error 前 80 字符>` | `bashShape` 已把 stdout 混进 error |
| 视觉 | `appendMessage("tool", …)` 用 `yellow` 前缀 | 无 dim，权重同正文 |

## 3. 方案（分层）

### P0（必做，直接消噪）

1. **失败分支修 bashShape 的 stdout/stderr 混淆（bashShape + loop 同批）**：
   - `bashShape`（`packages/tools/src/builtin.ts`）：失败时 `error` 只放 **stderr**（无 stderr 则 `exit code N`），stdout 单独放 `output`。只修 `code !== 0` 分支（超时/interrupted 已基本分离）。
   - `loop.ts`（约 L373）：失败时拼给模型 `ERROR: ${error}\n${output}`（有 output 才附）——否则 agent 拿不到失败命令的 stdout（ls/pytest 常把关键信息打在 stdout）。TUI 仍分字段干净显示。
   - 这样 TUI 的 error 字段干净、agent 也拿到完整信息，两边各取所需。

2. **tool 行加 `✓/✗` + 耗时**（hermes 风格）：
   - 完成行：`[bash] <命令预览> (1.2s) ✓` / `[bash] ✗ <error 摘要>`。
   - 耗时从 `tool_call` → `tool_result` 的时间差计算（`lastToolCmd` 已有 callId 关联，补一个 start 时间戳）。

3. **命令预览：混合策略**（omp truncateHeadRatio 风格）：
   - 有 `&&`/`;`/`||` 分段：显示第一段 + `… N more`（正对 `pwd && ls` 误导），不再缩成首词。
   - 单条长命令：头 60% + 尾 40%。
   - 引号内分隔符勿切：MVP 用朴素扫描，失败退回 head/tail。

### P1（可选，体验再上一层）

4. **结果摘要化 + dim 弱化（一起做，成本低）**：成功时显示结果第一行有意义内容（复用 `toolSummary`）+ 行数；tool 行结果正文用 `dim`/`gray` 渲染（命令名保留黄色前缀）。

### 本轮不做

- **大输出溢出临时文件**（omp 做法）：已有 `truncateOutput`，等真有「要看全文」痛点再做。
- **accordion 折叠树**：vendor 无现成组件，dim + 单行紧凑足够。

## 4. 涉及文件

- `packages/tools/src/builtin.ts` — bashShape 失败分支（P0.1）。
- `packages/tui/src/index.ts` — `briefCmd`/`toolLine`/`toolSummary`/onEvent tool_result 分支（P0.2/3, P1）。
- `packages/tui/src/display.ts` — 可能新增 `headTail()` 截断 helper。

## 5. 验证

- 单测：`bashShape` 失败时 error 只含 stderr（builtin.test.ts）；`briefCmd`/`headTail` 复合命令预览（display.test.ts）。
- 手测：跑一个会失败的复合命令 + 一个 `pwd && ls -la`，看 tool 行是否准确、error 是否干净、耗时/✓✗ 是否显示。

## 6. 非目标

- 不做 hermes 的完整 accordion 折叠树（chita vendor 无现成 Accordion，成本高，后续再说）。
- 不改 tool 输出的 tape 持久化（tape 存完整结果，只是 TUI 显示层精简）。
