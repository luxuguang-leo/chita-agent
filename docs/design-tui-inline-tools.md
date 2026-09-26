# design-tui-inline-tools.md — tool 回归内联（对齐 pi/oh-my-pi 的流动叙事）

- **状态**：方案已定，代码未改
- **来源**：用户反复反馈 tool 显示「差一点意思 / 少了实时滚动 / 和卡住差不多」，要求对比 pi/oh-my-pi 后回归内联

## 0. 问题与根因

chita 现在把 tool 放在**独立的固定 5 行 strip**（`toolScroll`，屏幕下方），和消息流（`messagesBox`）割裂成**两条叙事线**：

- 消息流：assistant 文本（思考时静止 → 用户觉得卡住）
- 工具条：tool 行"啪啪"跳（0.0s 太快，spinner 一闪而过）

对比 pi/oh-my-pi（同一套 pi-tui 引擎）：tool 结果**内联在消息流里**，assistant 文本和 tool 行**交错滚动**（`Dye` 函数：assistant → renderCalls → toolResult → …），tool 是 dim 的"脚注"，assistant 是唯一的主叙事线。

**结论**：差距不在渲染引擎（同源 pi-tui），在**布局范式**——chita 把 tool 拆出去了，丢了"流动叙事"。

## 1. 现状（`packages/tui/src/index.ts`）

```
root VStack:
  messageScroll (messagesBox, grow:1)   ← assistant 文本 + activityLine
  toolScroll   (toolBox, 固定 5 行)      ← runningToolLine + tool 结果行
  input
  statusText
```

tool 相关引用点：`toolBox`/`toolScroll`（L176/177/210）、`appendMessage("tool",…)`（L417）、`trimTools`（L444）、`runningToolLine`（创建 L808、更新 L602、移除 L633/826）。

## 2. 目标

**单一消息流**：assistant 文本 + tool 行（dim 脚注）交错滚动，一个 ScrollView。用户永远只看一个画面，形成连续的"滚动叙事"。

## 3. 方案

1. **移除独立 strip**：删 `toolBox`/`toolScroll`，root 只留 `messageScroll + input + statusText`。

2. **tool 结果行内联**：`appendMessage("tool", …)` 直接加到 `messagesBox`（不再 `toolBox`）。格式对齐 pi/omp：保留短工具名（`bash cmdPreview ✓ (0.3s)`），去掉沉重的 `tool:` role 前缀。成功动作 dim，**失败不 dim（黄/亮色 + ✗）**。

3. **runningToolLine 内联 + 原地替换**：tool 执行时 `[bash] ⠋ (Ns) cmd` 加到 `messagesBox`（不是 toolBox），运行中 brightWhite。**完成时原地替换**为结果行（动作类）或**直接删除**（探索成功，不落结果，避免幽灵空行），绝不 running + 结果双行残留。

4. **activityLine 保留并协调**：
   - THINKING → `⠋ thinking (Ns)`（dim）
   - TOOL_CALL → runningToolLine（brightWhite，内联）
   - OBSERVING → `⠋ reading result (Ns)`（dim）
   - 首 token → 换成流式 assistant 文本
   三者互斥（同一时刻消息流底部只有一个"活动"行），形成 thinking → running → reading → 流式 的连续节奏。

5. **探索类静默保留**：read/ls/grep/glob 成功仍不落结果行（只闪 running 瞬间）。

6. **trimTools 并入 trimMessages**：单一 `MAX_VISIBLE` 上限（200）。探索类静默后动作类 tool 行不多，不担心刷屏。

7. **失败 tool 行仍显示且不 dim**（`✗ cmd — error`，黄/亮色醒目），成功探索静默、成功动作 dim 落行。

## 4. 状态机（内联后的消息流节奏，单 turn）

```
user 提问
  → ⠋ thinking (Ns)               [activityLine, dim]
  → [bash] ⠋ (Ns) cmd             [runningToolLine, bright]（tool 执行）
  → cmd ✓ (0.3s)                  [结果落行；探索成功则直接删 running，不落结果]
  → （更多 tool：running → 结果落行 …）
  → ⠋ reading result (Ns)         [activityLine, dim]（读结果/再思考）
  → assistant 流式文本             [bright，首 token 替换 activityLine]
```

注：**tool 结果落行在前，assistant 流式回复在后**（单 turn 内通常先跑完 tool 再回复）。

## 5. 涉及文件

- `packages/tui/src/index.ts` — 布局 + appendMessage + runningToolLine + activityLine + trimTools（主要）。
- `packages/tui/src/display.ts` — `toolLine`/`cmdPreview`/`briefCmd` 复用，可能微调（去 `[name]` 前缀）。

## 6. 验证

- `bun test`（display.test.ts 等）+ `tsc --noEmit` + `bun run build`。
- 手测：跑一个含 bash + read + 长回复的任务，确认消息流里 thinking → running → 流式 → tool 脚注 连续滚动，无割裂。

## 7. 非目标

- 不做折叠区/accordion（回归内联后单流已足够）。
- 不改 tape 持久化（tool 结果仍完整落盘）。
- 不改探索类静默、dim、✓/✗、耗时（已就位，只是挪位置）。
