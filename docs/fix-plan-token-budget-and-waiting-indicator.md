# chita 修复方案：per-run token budget 熔断 + Pi 风格等待提示

> 状态：**已实施**（2026-08-30 首轮；2026-08-30 按 Cursor review 修订）
> 范围：`chita-agent` 本地终端编码代理（macOS，node22 shim 运行）
> 关联现象（TUI 中看到的两个问题）：
> 1. `system: error: per-run token budget exceeded (161564/131072)`
> 2. 长时间状态不更新（等待模型思考 / bash 长命令时画面像卡死）
>
> 实施记录：
> - 首轮（cur-057/058）：budgetTokens 接线 + spinner 机制，bun test 134 pass
> - Cursor review 修订（cur-058 review）：AgentLoop 拆分 `maxTokens`(spend fuse) / `contextMaxTokens`(压缩阈值)，修 activityLabel 工具名、WAITING_USER 映射、CLI 提示文案、budgetTokensFor 上限 2M、docs 状态

---

## 背景与证据

- 配置：`~/.chita/config.json` → `{ "provider": "openai-compatible", "model": "deepseek-v4-flash", "permissionDefault": "ask", "contextWindow": 131072 }`
- 真实会话磁带 `~/.chita/agent/sessions/--Users-leo/sess-mtfafx1o.jsonl`（73 事件）：
  - 累计 usage 达到 **691,413 tokens（input 670,507 / output 20,906）**
  - 存在 `spawnSync /bin/bash ETIMEDOUT`（bash 长命令超时）
  - agent 自己输出「没有卡住，我还在推进」——即用户侧看到长时间无反馈
- `sess-mt7c955v.jsonl`：单轮 usage 差值即可超过 5K+，长任务多轮工具调用后累计消耗轻松击穿 131072 熔断。

---

## 问题 1：`per-run token budget exceeded (161564/131072)`

### 根因

| 项 | 说明 |
|---|---|
| 熔断值来源 | CLI（`packages/cli/src/index.ts`）与 TUI（`packages/tui/src/index.ts` 的 `buildLoop()`）都把 `maxTokens` 传成 `cfg.contextWindow`（=131072） |
| 熔断语义 | `loop.ts` 的 `maxTokens` 是**单次 run 的累计 API 消耗**（`tokensUsed` 跨轮累加），不是上下文长度上限 |
| 放大效应 | 每轮循环把整个会话重新发给 API，input token **成倍累积**；长任务（大文件 + 多次工具调用）一轮内轻松烧掉 161K+ |
| 后果 | `while ((this.iterations - runStartIterations) < maxIter && (this.tokensUsed - runStartTokens) < maxTokens)` 守卫触发 → `state = ERROR`，整个任务被杀 |
| 正确的部分 | 上下文压缩/截断（`context.ts` ContextManager，阈值 = 0.9 × contextWindow）用的是 `contextWindow`，**这部分是对的，不该动** |

关键区分：
- `contextWindow` = 每次 API 请求的**上下文上限**（模型真实容量，错不了）
- `budgetTokens`（新概念）= 单次 run 的**累计消耗熔断**（费用保护，应与上下文窗口解耦）

### 修复方案

1. **解耦消耗熔断与上下文窗口**
   - `contextWindow` 继续承担：上下文压缩阈值、状态栏 ctx 百分比
   - 新增独立配置 `budgetTokens`：单次 run 累计消耗熔断
2. `packages/cli/src/config.ts`
   - `Config` 接口新增 `budgetTokens?: number`
   - `CONFIG_KEYS` 白名单新增 `"budgetTokens"`
   - 未显式配置时默认 `contextWindow × 8`：
     - 131072 × 8 = 1,048,576（≈ 代码里已有 `DEFAULT_MAX_TOKENS = 1_000_000` 兜底，对齐 DeepSeek 真实 1M 上下文）
     - 按 DeepSeek 价格，1M token 消耗仅数厘钱，费用风险可忽略
     - 对 1M 上下文模型 → 8M 熔断，随模型缩放（保持原「model-scaled ceiling」设计意图）
3. 调用方改为传 `maxTokens: cfg.budgetTokens`
   - `packages/cli/src/index.ts`（print/plan/judge 模式）
   - `packages/tui/src/index.ts`（`buildLoop()`）
4. **熔断仍触发时的可操作提示**（罕见路径，保留清晰报错 + 提示）
   - TUI：`handleTurn` 里对包含 `budget` 的 error 追加提示：`/resume` 可续跑，或在 `~/.chita/config.json` 提高 `budgetTokens`
   - CLI print 模式：同样追加一行提示
5. `~/.chita/config.json` 中 `contextWindow: 131072` **保持不变**（若确认 v4-flash 为 128K 上下文，该值正确，仅作压缩/展示用途）

> 注：`packages/agent/src/continue.test.ts` 已有 `maxTokens: 100`、`restoreTokens({total: 500_000...})` 等用例，守卫语义（per-run delta）不变，不受影响。

---

## 问题 2：长时间状态不更新 → 类似 Pi 的等待提示

### 根因

- TUI 状态栏只有静态 `| running...`（`handleTurn` 里 `setStatus(" | running...")` 一次性设置）
- 等待模型思考（DeepSeek 长思考）或 bash 长命令执行时，画面完全静止 → 看起来像卡死
- 磁带证据：`ETIMEDOUT` + agent 自己说「没有卡住」
- 已 vendored 的 `packages/tui/vendor/components/loader.ts` 自带 spinner 帧（`⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`）与 interval 逻辑，但 TUI 未使用
- Pi 参考实现（`@earendil-works/pi-coding-agent/docs/tui.md` Pattern 4b）：动画帧 + 状态提示，`setWorkingIndicator({frames, intervalMs})`

### 修复方案（全部在 `packages/tui/src/index.ts`）

1. **状态栏动画 spinner**
   - turn 开始后 `startSpinner(label)`，每 120ms 切一帧（`⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`），复用 `setStatus()` + `tui.requestRender(true)`
   - 显示**活动 + 已耗时秒数**：`| ⠋ thinking (23s)` ←「已耗时」是消除「看着像冻住」的关键
2. **实时活动状态标签**：`updateActivity()` 读 `loop.state`
   - `THINKING` → `thinking`
   - `TOOL_CALL` → `running bash: <cmd>`
   - `OBSERVING` → `reading result`
   - 标签变化时重置耗时计时（`spinnerStart = Date.now()`）
3. **工具条运行中指示**
   - `onEvent` 收到 `tool_call` 时，在工具条追加一行 `[bash] ⠋ npm install...`（同 timer 动画，`runningToolLine` 引用 + `setText` 原地更新）
   - `tool_result` 到达后该行被结果行替换（引用置空）
   - 防御：`trimTools()` 挤掉该行时重置引用（`toolBox.children.includes()` 检查）
4. **`/goal`（judge）复用 spinner**：`startSpinner("judging")`，`finally` 里 `stopSpinner()`
5. **生命周期**：`startSpinner()` 幂等（已有 timer 不重复启动）；`stopSpinner()` 清 interval（`finally` 中调用），无泄漏
   - turn 开始处：`setStatus(" | running...")` → `startSpinner("thinking")`
   - `finally` 中：`stopSpinner(); setStatus();`

---

## 涉及文件清单

| 文件 | 改动 |
|---|---|
| `packages/cli/src/config.ts` | `budgetTokens` 配置项 + 默认值（contextWindow × 8） |
| `packages/cli/src/index.ts` | `maxTokens: cfg.budgetTokens`；熔断报错提示 |
| `packages/tui/src/index.ts` | `maxTokens: cfg.budgetTokens`；spinner/状态/工具行动画；熔断提示 |
| `packages/agent/src/loop.ts` | **不改**（守卫语义已正确，只换调用方传参） |
| `packages/agent/src/context.ts` | **不改**（contextWindow 语义保持） |
| `~/.chita/config.json` | **不改**（`budgetTokens` 缺省即用默认值） |

## 验证计划

1. `bun test`（agent 包：continue.test.ts 中 maxTokens/restoreTokens 用例应仍通过）
2. `bun build`（package.json scripts.build → `dist/`），重启 `chita` 生效
3. 手动验证：
   - 长任务中状态栏出现动画 spinner + 耗时，工具条有运行中工具行
   - `/goal` 时显示 judging spinner
   - （若仍触发熔断）报错信息含 `/resume` 与 `budgetTokens` 提示
