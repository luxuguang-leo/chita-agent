# 修复草案：sess-mue9vq6c 会话审阅发现（4 类问题）

- **状态**：P0/P1 已实现并提交，P2 待做
- **进度**：P0 = `317df70`（soft compact + 心跳 + 卡死 + Δinput）；P1 = `07669f6`（授权单键 Enter=deny + dup-turn 去重 + `~/.chita/tmp/` 白名单 + usage 落盘 + `Users/` 清理 + `.chita/` gitignore）；P2（AGENTS.md 守则）未做
- **来源**：对 `~/.chita/agent/sessions/--Users-luxuguang-Projects-chita-agent/sess-mue9vq6c.jsonl` 的逐行审阅（220 行，107 tool_call / 106 tool_result / 4 message / 3 usage）
- **日期**：2026-09-25

## 会话事实基线

这条 tape 装了两个请求，全程几乎纯 recon（3 个 `write` 均为 70~85 字节的 /tmp probe 脚本，无代码产出）：

| 时间 | 请求 | 结果 |
|---|---|---|
| 09-23 15:43 | `resume` 加 session 选择 + session 摘要/主题 | 探索 ~130 tool call，未在本会话实现 |
| 09-25 14:41 | 小米/苹果遥控器语音做 vibe coding | 纯 recon，结尾仅 "Recon done" |

（resume picker 功能实际已在并行会话完成并提交 `e8efc92`；本会话 agent 最后才意识到。）

usage 三段：`total=1,504,972 → 1,827,542 → 3,842,905`，其中 `input=3,798,330 / output=44,575`，**输入:输出 ≈ 85:1**。

---

## 问题 1：token 消耗过快（不正常，压缩阈值与硬窗耦合导致永不触发）

### 现象 / 证据

- 两段纯 recon（零代码产出）累计烧 384 万 token，输入占比 98.8%。
- tape 中 grep 不到任何 `Session Summary` 压缩痕迹（仅 23 处 `system`，全是授权提示）。

### 根因（已按 Cursor 纠正）

- `deepseek-v4-flash`（遗留名）官方 **CONTEXT LENGTH = 1M**（DeepSeek 定价页 api-docs.deepseek.com/quick_start/pricing），仓库 `packages/ai` 注释也写「1M context」。`inferContextWindow` 的 `/^deepseek/ → 1M` 对 flash **基本正确**，**不能改**。
- 真正的问题：压缩阈值**与硬窗耦合**——`0.9 × 1M ≈ 943K`（`packages/agent/src/context.ts:34` THRESHOLD_RATIO_DEFAULT × `contextMaxTokens`）。单次请求上下文永远摸不到 943K → **压缩从不触发** → 上下文每轮全量重发、只增不减。

### 修复方案（草案）

1. **soft compact 与硬窗解耦**：新增独立压缩阈值，形如 `compactAt = min(0.9 × contextWindow, softCap)`，`softCap` 默认 128K/256K（可配，新增 config key `compactAt` 或 `softCap`）。硬窗仍保留 1M（合法窗口不压），但压缩在 softCap 处提前触发。
2. 保留用户显式 `contextWindow` 覆盖（现有 `loadConfig` 已支持）。
3. 附加（P0 旁路，Cursor 认可）：usage 事件加**每轮 input 增量**到 TUI 状态栏（`↑Δ` / 本轮 input / ctx%），别只堆 total——顺带缓解问题 4「不知道在烧什么」。

### 涉及文件

- `packages/agent/src/context.ts`（soft compact 阈值 / `compactAt` / 大窗更低 ratio）
- `packages/cli/src/config.ts`（新增 `compactAt`/`softCap` 配置项；`contextWindow` 覆盖保留）
- `packages/agent/src/loop.ts`（usage 增量上报 + `contextMaxTokens` 传参改为 soft 阈值）
- `packages/tui/src/index.ts`（状态栏 Δinput）

### 验证

- 单测：**soft 阈值触发**断言（不是断言 flash=128K）——构造超过 softCap 的上下文，断言压缩触发一次、硬窗 1M 不被误压。
- 报文级：mock provider 构造 N 轮 tool-call，断言累计 input 不再线性膨胀、压缩在 softCap 处触发。

---

## 问题 2：是否按提示词执行（行为性，拖后 P2）

### 现象

- 请求 1 探索充分（~130 call），也表态 "Let me implement"，但本会话零实现；实现在并行会话 `e8efc92` 完成。
- 请求 2 纯 recon，结尾无方案文档/结论，只一句 "Recon done"。

### 定性

方向对、探索过细、**不收敛到产物**。过程问题，非代码 bug。

### 处理

- **拖后（P2）**：本轮不为 recon 收敛改核心循环。约定「recon 类请求先落 `docs/fix-plan-*.md` 再动代码」可作为 AGENTS.md 一行守则，**另开小 PR**，不挡 P0/P1。

---

## 问题 3：授权界面不友好

### 现状代码（`packages/tui/src/index.ts`）

- `onPermissionRequest`（~519-560）：`appendMessage("system", "⏸ 需要授权【…】")` + `命令: <formatApprovalCommand>` + `→ 回复 allow 放行 / deny 拒绝（5 分钟不回复 = 拒绝）`。
- 状态栏（~428）：`awaiting approval · type allow/deny`。
- 输入处理（~708-716）：`/^(allow|yes|y|approve|ok)$/i` 才放行，其余全当 deny。

### 问题点

1. 无单键交互：必须整词输入 allow/deny，无 y/N、无 Enter 默认、无高亮。
2. 被授权的**命令本体不突出**（`formatApprovalCommand` 截断藏在一行 system 消息里）。
3. 授权提示是普通消息，会滚动走，看不出"现在卡在等授权"。
4. 5 分钟超时无倒计时反馈。

### 修复方案（草案）

1. 授权态切到**独立提示层/底部栏**：完整显示命令原文（多行、不截断关键部分）+ 类别标签 + 理由。
2. 交互改单键：`[y] 放行 / [n] 拒绝 / 5 分钟不响应 = 拒绝`，同时保留 `allow`/`deny` 词兼容。**Enter 默认 = 拒绝**（与现状「显式 allow 才放行」一致，更安全；Cursor 拍板）。
3. 超时倒计时（状态栏 `awaiting approval (2:31)`）。
4. `formatApprovalCommand` 截断策略复核：命令长时折叠尾部而非头部。

### 涉及文件

- `packages/tui/src/index.ts`（onPermissionRequest / WAITING_USER 输入处理 / 状态栏 / formatApprovalCommand）

### 验证

- 手测：触发 guardian ask → 单键 y/n → Enter 默认拒绝 → 超时倒计时 → 终端无残留态。

---

## 问题 4：卡住不知道在干啥

### 现象 / 证据（tape lines 204-221）

```
205  timeout: command not found               ← macOS 无 GNU timeout
207/215  Module not found / 相对路径 probe 找不到
211  guardian[destructive]: redirecting to absolute path  ← 写 /tmp 被拦
218  find Users -type f                       ← 自己生成嵌套垃圾目录
220  mv Users/luxuguang/... 又被 guardian 当 rm -rf 拦
143  cd /Users/luxiguang                      ← typo 少个 u
```

后果：仓库根目录至今留未跟踪垃圾目录 `Users/`（`git status` → `?? Users/`）。agent 想写 `/tmp` probe 脚本验证，但 guardian 拦绝对路径 + 相对/绝对路径混用，来回十几个 tool call 自我修复；界面侧只有 `⠋ running bash`，不突出当前命令，用户只能干等。

### 根因拆解

1. **无心跳**：running tool 行未醒目显示"正在执行哪条命令 + 已耗时"。
2. **无卡死检测**：连续 N 次同类失败不降级、不提示用户。
3. **guardian 误伤**：`redirecting to absolute path` 把"写 probe 到 /tmp"当破坏性操作拦了。
4. **路径 typos / 嵌套目录**：`cd /Users/luxiguang` 与相对/绝对混用生成了 `Users/` 嵌套。

### 修复方案（草案）

1. **心跳（P0）**：running tool 行固定显示 `[bash] <命令原文前 N 字符> (12s)`，与 spinner 同帧刷新；命令超长折叠尾部。
2. **卡死检测（P0）**：同类工具连续失败阈值（如 3 次）→ 状态栏提示 `⚠ 连续失败，可能卡住，Ctrl+C 中断`。
3. **guardian 白名单（窄）**：优先约定 probe 进 workspace `scripts/`；若要 `~/.chita/tmp/`，**只白名单该前缀的 write 工具**（及等价受控写入），**不放宽**通用 `/tmp`、不放宽任意绝对路径 redirect/`tee /…`（Cursor 拍板）。
4. **清理**：删除 `Users/` 垃圾目录（实施时一并清理，commit 前确认）。
5. **dup-turn（P1，先复现）**：tape line 131 assistant 消息整段重复，疑似 `duplicate turns` 老 bug。**先最小复现**（半小时级）：查同一 turn 是否 `onAssistantMessage` 收到「全文快照」而非 delta，导致 `appendStreamed` 累加成双份。确认是 provider 事件语义再针对性修，**不盲改 tape**。可与 P1 并行，不阻塞 P0。

### 涉及文件

- `packages/tui/src/index.ts`（心跳 / 卡死检测 / 状态栏）
- `packages/agent/src/guardian.ts`（`~/.chita/tmp/` 白名单，窄）
- `packages/session/src/tape.ts`（dup-turn 复现后决定）
- 清理：`Users/`（工作树，非代码）

### 验证

- 手测：长命令可见性、连续失败降级提示、probe 写 `~/.chita/tmp/` 不再误拦、`git status` 干净。

---

## 优先级（已按 Cursor 纠正）

| 优先级 | 事项 | 理由 |
|---|---|---|
| P0 | 问题 1 **soft compact**（硬窗 1M 不动） | 直接决定 token 成本 |
| P0 | 问题 4 **心跳 + 卡死检测** | 体验最痛 |
| P0 旁路 | 状态栏 Δinput | 膨胀肉眼可见 |
| P1 | 问题 3 授权单键（Enter=deny） | 体验 |
| P1 | 问题 4 dup-turn 最小复现 | 正确性 |
| P1 | 问题 4 `~/.chita/tmp/` 窄白名单 + `Users/` 清理 | 卫生 |
| P2 | 问题 2 AGENTS.md 守则（另开小 PR） | 过程性 |
| wontfix | 「改 flash=128K」 | 官方 1M，误压合法窗口 |

## 已拍板决策（Cursor cur-20260925-217）

1. flash = **1M**，勿改 128K，上 **soft compact**（`compactAt = min(0.9×window, softCap)`）。
2. 授权 Enter 默认 = **拒绝**。
3. `~/.chita/tmp/` **可白名单（窄，仅 write 工具）**；probe 优先 `scripts/`。
4. dup-turn：**先最小复现**，再定是否动 `appendStreamed`。

## 实施顺序

P0 soft compact + 心跳/卡死提示 → P1 授权单键（Enter=deny）+ dup 复现 + `~/.chita/tmp/` 白名单 + `Users/` 清理 → P2 AGENTS 守则（独立小 PR）。改完发代码轮 review。
