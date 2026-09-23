# Design: CLI session resume picker + per-session topic

Status: ✅ 方案已定（2026-09-24 design review `her-20260924-088` → Cursor
`approve_with_nits`，nits 已吸收）。

## 0. 评审结论与已定决策

| 决策点 | 结论 |
|---|---|
| topic 持久化 | 持久化 `SessionMeta.topic?` + 回退链（topic → branchSummary → 懒读首条 user） |
| picker 交互 | TTY 用箭头选择；**非 TTY 兜底**：打印列表 + 提示 `--resume <id>`，禁止进 raw-mode（Finding #1） |
| TUI resumeId | 复用 `adoptSession`；**locked/missing 时不静默回退最近一个**，停在空会话 + 明确提示（Finding #2） |
| 命令形态 | 只保留 `chita --resume [id]`，不加 `resume` 子命令 |
| topic 来源 | 首条用户消息；done summary 更新 meta 破坏 append-only，不做 |
| slash 当 topic | `summarizeTopic` 跳过以 `/` 开头的首条，懒回退时找下一条真实 user 消息（Finding #3） |
| locked 会话 | picker 标 🔒 仍可选，选中走现有 adopt 提示；不硬禁选 |


## 1. Background

- CLI `chita --resume` 是占位符（`console.log("[chita] --resume lands in M2+")`）。
- session 只由 TUI 持久化：JSONL tape 在 `~/.chita/agent/sessions/--<cwd>/<id>.jsonl`，
  首行 `__meta`（`SessionMeta`：sessionId/cwd/model/provider/createdAt/parentId?/branchSummary?）。
- TUI 启动时**自动 resume 最近一个** session，`/resume <id>`、`/tree`、`/fork` 已有。
- **无持久化 topic**：TUI 的 `openRecentSession` 会懒读 tape 找「首条 user 消息」当启动提示
  （`topic: "..."`），但这个 `first` 不落盘、也不用于列表选择。

## 2. Goals / non-goals

**Goals**
1. `chita --resume` → 列出当前 cwd 的 session（**带 topic + 时间**）→ 交互选择 → 在 TUI 里
   resume 选中的 session。
2. 每个 session 有一个**持久化的 topic**（首条用户消息），让列表可读、可挑。

**Non-goals**
- `--print` 模式（`chita "task"`）**不持久化 session**（现状如此，保持）；resume 只针对 TUI
  创建的 session。
- 不做 topic 的自动重命名/编辑；首版只「创建时写首条消息 + 旧 session 懒回退」。
- 不做 session 删除/搜索；只做「列出 + 选择」。

## 3. Schema：`SessionMeta.topic`

```ts
// session/src/trace.ts
export interface SessionMeta {
  sessionId: string;
  cwd: string;
  repoRoot?: string;
  model: string;
  provider: string;
  createdAt: string;
  parentId?: string;
  branchSummary?: string;
  /** One-line topic for session listing (first user message, truncated). */
  topic?: string;
  pinnedResources?: PinningStub[];
}
```

- **写入时机**：TUI 首轮绑定 session 时（`index.ts` 首次 `appendMeta` 处），此刻 `value`
  就是首条用户消息，直接 `topic: summarizeTopic(value)`（折叠空白 + 截断 60 字符）。
- **旧 session 兼容**：没有 `topic` 的历史 session 走懒回退（见 §4）。
- **fork**：子 session 的 `branchSummary` 已是「为什么分叉」的天然 topic，`topic` 留空，
  列表时用 `branchSummary` 回退。

## 4. 列表 + topic 解析（session-tree.ts）

```ts
/** topic 解析优先级：meta.topic → meta.branchSummary → 首条 user 消息（懒读）。 */
export function sessionTopic(cwd: string, sessionId: string, root = SESSIONS_ROOT): string;

/** 当前 cwd 的 session 列表，按最后活跃（tape mtime）降序，供 picker。 */
export interface SessionEntry {
  sessionId: string;
  topic: string;
  createdAt?: string;
  locked: boolean;       // Tape.holderPid() 非空 = 别的 chita 正持有
}
export function listRecentSessions(cwd: string, limit = 20, root = SESSIONS_ROOT): SessionEntry[];
```

- `listRecentSessions` 只读 meta 首行（快）；`sessionTopic` 只在 `topic`/`branchSummary`
  都缺时才懒读首条 user 消息（逐行读、找到即停，不读全量）。
- `locked` 用 `Tape.holderPid()`（已存在）：picker 标记 🔒，选中后 `adoptSession` 会给出
  已有的「locked by another chita (pid N)」提示，不额外处理。

## 5. CLI resume 流程（cli/src/index.ts + 新 picker.ts）

```
chita --resume [<id>]
```

- 带 `<id>` → 直接 `startTui({ resumeId: id })`（跳过 picker，脚本友好）。
- 不带 id →
  1. `listRecentSessions(process.cwd())`。
  2. 空 → `no sessions in this directory (start `chita` first)` + exit 0。
  3. 单个 → 直接 resume（不弹 picker）。
  4. 多个 → 渲染 picker → 用户选 → `startTui({ resumeId })`。

**picker**（新文件 `packages/cli/src/picker.ts`，raw-mode 箭头选择）：

```
? resume which session? (↑/↓ move, Enter select, q cancel)
  1. 修 loop.ts token 熔断                          · 3h ago
  2. 调研 pi 的流式渲染                              · 1d ago   🔒
> 3. 部署 CosyVoice 到 GPU                           · 2d ago
```

- 键：↑/↓（或 j/k）移动、Enter 选、q / Ctrl+C 取消（退出）。
- `process.stdin.setRawMode(true)` + 还原；Ctrl+C 恢复终端后 exit。
- 单列、无依赖（手写 ANSI，不引 Ink——CLI 是轻量路径）。

## 6. TUI 支持指定 resume（tui/src/index.ts）

```ts
export interface TuiOptions {
  judge?: boolean;
  /** Resume this specific session at startup instead of the most recent. */
  resumeId?: string;
}
```

- `startTui` 启动段：`opts.resumeId` 存在 → `adoptSession(opts.resumeId)`（内部 tryOpen +
  seed + adopt）；否则维持现有「auto-resume 最近一个」。
- 复用现有 `adoptSession`（含 locked 提示、history 重建、usage 恢复），零新增语义。

## 7. Open decisions（请 Cursor 拍板）

1. **picker 交互**：箭头选择（raw mode） vs 数字列表（输入序号回车）。倾向箭头选择
   （「选择」直觉），数字列表作零依赖兜底。两者都要？还是只做箭头？
2. **topic 来源**：首条用户消息（本次方案） vs done() summary（更语义化，但要改 tape
   首行/追加 topic 更新，破坏 append-only）。倾向首条用户消息，done summary 留后续。
3. **命令形态**：`chita --resume` 保留 + 新增 `chita --resume <id>` 直连；是否也要
   `chita resume`（无 `--`）别名？倾向保留 `--resume` 即可，避免新增子命令面。
4. **topic 更新**：session 里跑了很多轮后，首条消息可能已不反映最终主题。是否值得在
   done 时把 topic 更新成 done summary（需改 tape，见 decision 2）？倾向本次不做。

## 8. Test plan

- `session-tree.test.ts`：
  - `sessionTopic` 优先级（topic → branchSummary → 首条 user 消息）。
  - `listRecentSessions` 排序（mtime 降序）+ locked 标记 + 空目录返回 []。
- `picker` 纯逻辑（若有）：高亮/移动/取消的状态机（抽纯函数，不测 raw-mode IO）。
- `cli`：`--resume` 无 session 时输出提示 + exit 0（行为测）。

## 9. Files to change

| 文件 | 改动 |
|---|---|
| `packages/session/src/trace.ts` | `SessionMeta.topic?` |
| `packages/session/src/session-tree.ts` | `sessionTopic` + `listRecentSessions` |
| `packages/tui/src/index.ts` | `TuiOptions.resumeId` + 首轮 `appendMeta` 写 topic + 启动段 resumeId 分支 |
| `packages/cli/src/picker.ts`（新） | raw-mode 箭头选择器 |
| `packages/cli/src/index.ts` | `runResume()` 接 picker + `--resume [id]` 解析 |
| `packages/session/src/session-tree.test.ts` | 新增用例 |
