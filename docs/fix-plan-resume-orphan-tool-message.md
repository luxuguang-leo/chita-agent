# chita 修复方案：resume 因 orphan tool message 失败（rev2）

> 状态：**已实施并复审通过**（2026-09-12；cur-109 request_changes → rev2 → cur-110 approve_with_nits → cur-111 approve_with_nits → cur-112 approve）
>
> 实施记录（2026-09-12）：
> - `packages/agent/src/history.ts` 新增 `historyFromEvents()`（方案 A，含 cur-110 #1 轮次边界、#2 `{"_resumed":true}` 标记）
> - `packages/agent/src/loop.ts` `seedConversation` 校验改为并行 tool 语义（方案 D，含 cur-110 #2 的重复 id 检查）
> - `packages/tui/src/index.ts`：resumeSession 改用新函数（B）；`tool_call` 分支补 `tapeAppend`（C）
> - 额外加固（rev2 未列，实施时发现）：未被回答的声明会在重建末尾剪除——C 让 tape 记录 `tool_call` 后，若进程在工具执行中途崩溃，tape 末尾会留下"已声明但无结果"的调用，而 OpenAI 要求每个 `tool_call` 必须紧跟其 tool 结果，否则 resume 后的第一个请求会 400
> - 测试：`history.test.ts` 7 例 + `continue.test.ts` 1 例（live N-call 形状回归）
> - 验证：`bun test` 204 pass / 0 fail；`tsc --noEmit` 无错误；`/tmp/repro-resume.ts` 对 `sess-mt61phph` 145/145 条工具结果全部保留；重建 `dist/chita-darwin-arm64`（sha256 `28e2bd45…`）后在 PTY 真机启动，输出 `resumed last session sess-mt61phph`、状态栏 `↑1.1M ↓28.6K | ctx 72.9K/1M (7%)`
> - cur-110 #2 的"结果条数不得超过声明数"检查经验证不可达（重复 id 已先被拒），故未实现（避免死代码）
>
> 未纳入本次（后续单列 issue）：
> - **根因 4 重复消息**：`vendor/components/input.ts:101` 的 `kb.matches(data,"tui.input.submit") || data === "\n"` 对 CRLF 双触发提交，且 TUI 从不 `setValue("")` 清空输入，第二次同值提交进 `pendingInputs` 被 replay（tape 证据：seq 45/46、51/52、59/60）
> 范围：`chita-agent` 会话恢复（TUI 启动自动 resume / `/resume`）
> 现象：重启后 `chita system: resume failed: Error: seedConversation: orphan tool message (no matching assistant toolCalls)`
> 复现脚本：`/tmp/repro-resume.ts`、`/tmp/check-validator.ts`（只读，不改仓库）

## rev2 变更摘要（对应 cur-109）

| cur-109 | 处理 |
|---|---|
| #1 major：`seedConversation` 的"紧邻前驱"语义与 live 形状冲突 | **采纳"修校验"**（OpenAI 并行 tool 语义：向前跳过连续 `tool`，找拥有该 `toolCallId` 的 assistant）。新增根因 3 与方案 D，并已用 `/tmp/check-validator.ts` 实测确认：live N=2 形状当前必被拒 |
| #2 minor：合成 args 加标记 | 采纳：合成声明 `args` 用 `{"_resumed":true}`；不做整段 system 摘要（保留结构化 `toolCallId` 配对） |
| #3 minor：接受顺序近似 | 采纳：v1 保持近似，测试补"assistant 文本晚于 tool_result 仍能配对"；改 flush 时机单列 |
| #4 nit：C 与 A/B 同 PR | 采纳：C 同批实施（先堵生产者，A 的合成仅作旧 tape 兜底） |
| #5 nit：重复消息单列 | 采纳：单列 issue（机制假设见根因 4） |
| #6 nit：其他破坏路径 | 采纳：`/fork`/`compact`/CLI `--resume` 均无独立第四路径 |

---

## 1. 现象与证据

**报错**（启动时对最后一个会话自动 resume）：`resume failed: Error: seedConversation: orphan tool message (no matching assistant toolCalls)`

**复现**（真实 tape → TUI 现有映射 → 真正的 `AgentLoop.seedConversation()`）：

```
tape sess-mt61phph: 194 events -> 33 mapped messages
type counts: {"message":32,"tool_result":145,"usage":17}      # tool_call: 0
first violation at index 32
seedConversation THREW: Error: seedConversation: orphan tool message (no matching assistant toolCalls)
```

`~/.chita/agent/sessions/--Users-luxuguang/` 下 **9 个 tape 的 `tool_call` 事件数全为 0**。

**校验器与 live 形状冲突**（`/tmp/check-validator.ts`）：

```
live 1-call:        ACCEPTED
live N-call (N=2):  REJECTED — Error: seedConversation: orphan tool message (no matching assistant toolCalls)
```

## 2. 根因（四处）

### 根因 1：TUI 从不把 `tool_call` 事件写进 tape

`packages/tui/src/index.ts` 的 `onEvent` 中 `tool_call` 分支只做 UI 后 `return`，无 `tapeAppend`；相邻 `tool_result` 分支则写盘。→ tape 只有结果、没有 assistant 的 tool_calls 声明。

### 根因 2：`resumeSession()` 重建算法错误

只在上一条映射消息是 assistant 时把 `tool_result` 压成 `{role:"tool", content}`，且从不附 `toolCalls`、不带 `toolCallId` → 要么丢 144/145 条结果，要么掷 orphan。

### 根因 3（rev2 新增，cur-109 #1）：`seedConversation` 的配对校验语义与真实对话形状不符

`packages/agent/src/loop.ts:235-243` 要求 tool 消息的**紧邻前驱**是带 `toolCalls` 的 assistant。但 provider（`packages/ai/src/index.ts:159-184`）在流结束时先 yield **一条**携带全部 `declared` 的 assistant 消息，再逐个 yield `tool_call`；loop（`loop.ts:317-342`）flush 该 assistant 后**连续 push N 条 tool**。故 live 形状为 `assistant(N calls), tool×N`——N≥2 时第 2 条 tool 的紧邻前驱是 tool，被现校验判为 orphan（实测复现）。

### 根因 4（观察，本次不修，单列 issue）：tape 内消息重复

`sess-mt61phph.jsonl` 出现相邻重复 user 消息 + 成对 assistant 回复（seq 45/46、51/52、59/60）。机制假设：`vendor/components/input.ts:101` 的 `kb.matches(data,"tui.input.submit") || data === "\n"` 对 CRLF 会触发两次提交，而 TUI 从不 `setValue("")` 清空输入（全仓无 `input.setValue` 调用），第二次同值提交进入 `pendingInputs` 并在回合末 replay。写入者是 8-27 旧二进制，需先确认 HEAD 是否仍可复现。

## 3. 修复方案

### A. 新增 `packages/agent/src/history.ts` — `historyFromEvents(events: readonly TraceEvent[]): ChatMessage[]`

| 事件 | 处理 |
|---|---|
| `message`（user/assistant/system） | 原样 push；`assistant` 成为"当前声明宿主" |
| `message`（reasoning/context） | 跳过（provider 把 role 原样发给 OpenAI，会 400；当前无生产者） |
| `tool_call` | 归入当前 assistant 声明宿主（无则创建 `content: ""` 的 assistant），`toolCalls.push({id: callId, name, args: stringify(args ?? {})})`，登记 `callId → 宿主` |
| `tool_result`（`callId` 已在登记表） | push `{role:"tool", name: toolName, toolCallId: callId, content: ok ? (output ?? "") : \`ERROR: ${error ?? ""}\`}`（与 loop 写 conversation 一致） |
| `tool_result`（**旧 tape 无声明**） | **归入同一批**连续结果共享的合成 assistant（`content: ""`），`args` 用 `{"_resumed":true}` 标记；无 `callId` 时用 `resumed-<seq>` 兜底 |
| `usage`/`judge`/`error`/`done`/`context_truncated` | 跳过 |

形状目标：**与 live 一致** —— `assistant(N calls), tool×N`。`callId` 登记表不随 `message` 事件清空（assistant 文本晚于 tool_result 落盘仍可配对）。

### B. TUI `resumeSession()` 改用 `historyFromEvents(tape.readAll())`，删本地拼装（usage 恢复不动）

### C. TUI `onEvent` 的 `tool_call` 分支补 `tapeAppend({ type: "tool_call", tool: ev.tool, callId: ev.callId })`（同批，先堵生产者）

### D. 修正 `seedConversation` 校验语义（`packages/agent/src/loop.ts:235-243`）

对每条 `tool` 消息：向前跳过连续 `tool` 消息，找到第一条非 tool 消息 `owner`；要求

1. `owner.role === "assistant"` 且 `owner.toolCalls?.length > 0`；且
2. 若该 tool 消息带非空 `toolCallId`，该 id 必须在 `owner.toolCalls` 中声明（无 id 时仅要求 1 成立，兼容 provider 不返回 id 的情形）。

仍拒绝真 orphan（声明中间隔着 user/system，或 id 未被声明）。不改 loop 写 conversation 的路径（live 形状本就正确）。

### E. 测试 `packages/agent/src/history.test.ts`（新增）+ `loop.test.ts`（补校验用例）

1. **回归**：`assistant(N=2 calls) + tool×2` 必须被 `seedConversation` 接受（当前抛错）；
2. **旧 tape**：连续 3 条只有 `tool_result` 的事件 → 合成 1 个 assistant(3 calls) + 3 条 tool，内容不丢、校验通过；
3. **真 orphan 仍被拒**：声明与 tool 之间插入 user 消息；或 `toolCallId` 未在任何前驱 assistant 中声明；
4. **顺序近似**（cur-109 #3）：`tool_result` 之后才出现 assistant 文本，配对仍然成立；
5. **无 `callId`**：用 `resumed-<seq>` 兜底，内容不丢；
6. **过滤**：`usage`/`judge`/`error`/`done` 被忽略；`reasoning`/`context` 按上表处理；
7. **属性**：任意事件序列（含交错、截断、连续 tool_result）的输出都能通过 `seedConversation`。

### 涉及文件

| 文件 | 改动 |
|---|---|
| `packages/agent/src/history.ts` | 新增（重建函数） |
| `packages/agent/src/history.test.ts` | 新增 |
| `packages/agent/src/loop.ts` | 仅 `seedConversation` 校验语义（+ `loop.test.ts` 用例） |
| `packages/tui/src/index.ts` | resumeSession 改用新函数；tool_call 分支补 `tapeAppend` |
| `packages/session/*` | 不改 |

## 4. 验证计划（实施后）

1. `env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY -u all_proxy -u ALL_PROXY bun test` 全量 + `tsc --noEmit` 全绿；
2. `/tmp/repro-resume.ts` 对 `sess-mt61phph`：不再抛错，145 条工具输出保留为 `assistant(N calls)+tool×N`；
3. `/tmp/check-validator.ts`：1-call 与 N-call 均 ACCEPTED；
4. 重建 `dist/chita-darwin-arm64`，真实启动 chita 验证 resume 成功并可继续对话；
5. 达标后补发实施轮 review（ref = `her-20260912-001`），approve 前不 commit。
