# Design: async tool execution + live output streaming

Status: ✅ 方案已定（2026-09-23 design review `her-20260923-082` → Cursor
`approve_with_nits`，nits 已吸收）。对应 `chita-TUI架构设计.md` §14。

## 0. 评审结论与已定决策

Cursor verdict：**approve_with_nits**。以下决策已拍板：

| 决策点 | 结论 |
|---|---|
| Q2 流式通道 | **独立 `LoopHooks.onToolOutput`**，**不进** `TraceEvent` union。`TraceEvent` 保持「可持久化评估燃料」的纯洁性；`tool_output` 是量大纯 UI 噪声，不落盘不回放 |
| Finding #1 | `runShell` 中断路径补 **SIGTERM → 300ms grace → SIGKILL**，绝不留顽固子进程 |
| Finding #2 | spinner tick 重建 `runningToolLine` 文本时**拼上 `runningToolTail`**（P1 落 UI 时） |
| Finding #3 | `TextDecoder` 在 `close` 前对 stdout/stderr **各 flush 一次** |
| Finding #4 | 中断测试 **await 进程退出**（`close` 触发才 resolve），杜绝 flake |
| Finding #6 | 流式刷新**与 spinner 同频节流**（120ms），或仅 chunk 含 `\n` 时刷（P1） |
| Q6 内存上限 | **1MB 有界滚动尾**（对齐 execSync 默认 maxBuffer），最终仍 `truncateOutput` → 4KB 喂模型 |
| Q1/Q7 里程碑 | **P0 只改 bash**；grep/ls/glob/git 留 P2 统一 |

## 1. Background

用户报告「prompt 后 bash 运行期间界面像卡死，几十秒后结果一次性刷出」。
`chita-TUI架构设计.md` §14 已完成四家对照调研（pi / Codex / Claude Code / OMP），
结论一致：**全部是 async spawn + 实时流式 + spinner/耗时 + 可中断**，没有一家用
`execSync` 阻塞 UI。本文是 §14 策略的落地架构。

## 2. Root cause

`packages/tools/src/builtin.ts` 的 `bashTool`（以及 grep/ls/glob/git）用的是
`child_process.execSync`（同步阻塞），执行期间占满 Node 事件循环 → TUI 的
`setInterval(120ms)` spinner 定时器不触发 → UI 冻结。命令结束或 `timeoutMs`
超时后，全部输出一次性返回。

代码自认局限：`builtin.ts` 内注释 `mid-command interrupt needs async spawn, T3`。

## 3. Goals / non-goals

**Goals**
1. 工具执行异步化：`execSync` → `child_process.spawn`，spinner 恢复动画。
2. 流式可观测：bash 输出 chunk 实时回传，TUI 工具条滚动显示尾部 N 行 + 已耗时。
3. 可中断：Esc 中断 turn 时，正在跑的 shell 进程被真正杀掉（kill 整个进程组）。

**Non-goals（本期不做）**
- 不引入新的工具执行模型（保持单工具顺序执行；多工具并行是另一个课题）。
- 不改 `done` 硬门、权限/Guardian、WAITING_USER 审批语义。
- 不做 sandbox / 隔离 tmp workspace（仍是 M1.5+ 项）。

## 4. Proposed architecture

### 4.1 执行流程（现状 → 目标）

现状：`loop.runTool → tools.execute → tool.execute → execSync（阻塞）→ ToolResult`

目标：`loop.runTool → tools.execute → tool.execute → runShell(spawn) → ctx.onOutput(chunk)* → ToolResult`

`onOutput` 是本次新增的**单向流式通道**，仅 bash 在 P0 落地，其余工具忽略。

### 4.2 接口变更（2 处，均向后兼容；`TraceEvent` **不变**）

**① `ToolContext`（tools/src/index.ts）新增可选字段 —— tool → loop 的传输**

```ts
export interface ToolContext {
  cwd: string;
  permission: Permission;
  sandbox?: { id: string };
  signal?: AbortSignal;
  /** Stream live output chunks as they arrive (bash only; ignored by other
   *  tools). UI-only, ephemeral — never persisted to the tape. */
  onOutput?(chunk: string): void;
}
```

**② `LoopHooks.onToolOutput`（agent/src/loop.ts）新增 —— loop → UI 的传输**

```ts
export interface LoopHooks {
  // ... existing ...
  /** Live tool output chunk (async tool execution). UI-only, ephemeral —
   *  NEVER persisted/replayed. TUI renders a tail window; --print ignores. */
  onToolOutput?(chunk: { toolName: string; callId?: string; chunk: string }): void;
}
```

> 设计取舍（Cursor 评审确认）：**不复用 `onEvent(TraceEvent)` 通道**，而是
> 新增独立 `onToolOutput`。理由：`TraceEvent` 是「可持久化的评估燃料」，而
> `tool_output` 是量大、纯 UI、不落盘的噪声；混进 schema 会污染类型面、加大
> 误 `tapeAppend` 的风险。独立 hook 让「持久化」与「实时 UI」两条通道彻底分开。

**③ `Tool.execute` 签名不变**

已是 `Promise<ToolResult> | ToolResult`，loop 已 `await`。bash 只需把同步
返回改成返回 Promise，**无破坏性接口变更**。

### 4.3 异步 shell 执行器（builtin.ts）

```ts
import { spawn } from "node:child_process";

const MAX_BUF = 1024 * 1024; // bounded tail (aligns execSync maxBuffer, cursor Q6)
const KILL_GRACE_MS = 300;   // SIGTERM → grace → SIGKILL (cursor finding #1)

function runShell(
  command: string,
  opts: { cwd: string; timeoutMs: number; signal?: AbortSignal; onOutput?: (c: string) => void }
): Promise<ToolResult> {
  return new Promise((resolve) => {
    const child = spawn("/bin/bash", ["-c", command], {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32", // process-group kill
    });
    const stdoutDec = new TextDecoder("utf-8");
    const stderrDec = new TextDecoder("utf-8");
    let stdout = "", stderr = "";
    let settled = false, timedOut = false, killed = false;

    const append = (buf: string, to: "stdout" | "stderr") => {
      if (to === "stdout") {
        stdout += buf;
        if (stdout.length > MAX_BUF) stdout = stdout.slice(stdout.length - MAX_BUF);
        opts.onOutput?.(buf);
      } else {
        stderr += buf;
        if (stderr.length > MAX_BUF) stderr = stderr.slice(stderr.length - MAX_BUF);
      }
    };

    const finish = (r: ToolResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve(r);
    };

    const killGroup = (sig: NodeJS.Signals) => {
      try {
        if (process.platform !== "win32" && child.pid != null) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch { /* already dead */ }
    };

    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      if (settled) return;
      killed = true;
      killGroup("SIGTERM");
      graceTimer = setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS); // finding #1
    };
    opts.signal?.addEventListener("abort", onAbort);

    const timer = setTimeout(() => { timedOut = true; killGroup("SIGKILL"); }, opts.timeoutMs);

    child.stdout.on("data", (b: Buffer) => append(stdoutDec.decode(b, { stream: true }), "stdout"));
    child.stderr.on("data", (b: Buffer) => append(stderrDec.decode(b, { stream: true }), "stderr"));
    child.on("error", (e) => finish({ ok: false, error: String(e) }));
    child.on("close", (code) => {
      try { append(stdoutDec.decode(), "stdout"); } catch {} // flush tail (finding #3)
      try { append(stderrDec.decode(), "stderr"); } catch {}
      if (timedOut) {
        const partial = truncateOutput(stdout || stderr);
        finish({ ok: false, output: partial.output || undefined, truncated: partial.truncated,
          error: `command timed out after ${opts.timeoutMs}ms — raise the timeoutMs arg if this run needs longer (curl/wget --max-time won't help: the tool kills first)` });
      } else if (killed) {
        const partial = truncateOutput(stdout);
        finish({ ok: false, output: partial.output || undefined, truncated: partial.truncated,
          error: "interrupted" });
      } else if (code !== 0) {
        const detail = truncateOutput(stdout + stderr || "command failed");
        finish({ ok: false, error: detail.output, truncated: detail.truncated,
          verificationHint: "command exited non-zero — inspect the output above" });
      } else {
        const out = truncateOutput(stdout);
        finish({ ok: true, output: out.output, truncated: out.truncated });
      }
    });
  });
}
```

`bashTool.execute` 改为 `async`：先查 `ctx.signal?.aborted`（复用现有「aborted
before execution」分支），再 `return runShell(...)`。

### 4.4 loop 接线（loop.ts `runTool`）

在构造 `ctx` 时挂 `onOutput`（唯一改动点，`emitToolResult` 的单点模式同理）：

```ts
const ctx: ToolContext = {
  cwd: this.opts.cwd,
  permission: /* ...现有逻辑... */,
  signal: this.opts.signal,
  onOutput: (chunk) => {
    this.opts.hooks?.onToolOutput?.({ toolName: name, callId, chunk });
  },
};
```

### 4.5 TUI 渲染（tui/src/index.ts，P1 落 UI）

- `tool_call`：维持现状，创建 `runningToolLine`（`[bash] ⠋ <briefCmd>`）。
- **新增 `onToolOutput` 回调**：只当 `chunk.toolName === runningToolName` 时，
  把 `chunk` 追加到 `runningToolTail: string[]`（按行切分，保留尾部 8 行），
  并按**节流后的下一帧**刷新。
- **spinner 冲突（finding #2）**：`updateActivity()` 每 120ms 重建
  `runningToolLine` 文本，必须拼上 `runningToolTail`，否则会盖掉流式尾部。
  两个方案：a) `setText` 时拼 `[name] ⠋ <cmd>\n<tail>`；b) spinner 行与 tail
  拆成两个 child。**选 a**（少一个节点、复用现有清理逻辑）。
- **节流（finding #6）**：`onToolOutput` 高频触发时，用 spinner 的 120ms tick
  统一刷新（chunk 只写 `runningToolTail` 缓冲区，不单独 `requestRender`），
  或仅 chunk 含 `\n` 时刷。
- `tool_result`：维持现状——移除 `runningToolLine`、清空 `runningToolTail`、
  贴 omp style 精简行 + `tapeAppend`。
- `stopSpinner()` / `trimTools()` 兜底：清 `runningToolTail`（与
  `runningToolLine` 既有兜底一致）。

### 4.6 CLI（--print）

不注册 `onToolOutput`（`onOutput` 仍是空调用，开销可忽略）。行为与现状一致：
最终只输出结果。

## 5. 结果语义兼容契约（必须保持，不能破坏现有测试）

| 场景 | 现状（execSync） | 目标（spawn） |
|---|---|---|
| aborted-before | `{ok:false, error:"aborted before execution"}` | 不变（bashTool 先查 `signal.aborted`） |
| 正常退出 0 | `{ok:true, output, truncated}` | 不变 |
| 超时 | `{ok:false, error:"timed out after Nms…", output: 部分stdout, truncated}` | 不变（partial stdout 放 `output`，**不进 error**） |
| 非零退出 | `{ok:false, error: stdout+stderr, truncated, verificationHint}` | 不变 |
| 中途 abort | 现状无此能力 | **新增** `{ok:false, error:"interrupted", output: 部分stdout}` |

对应现有用例 `builtin.test.ts`：aborted-skip / non-aborted-runs / timeout-keeps-
partial-out-of-error / non-zero-exit-keeps-stderr，全部必须继续通过。

## 6. Cancellation 语义

- Esc 中断 turn → loop 的 `AbortSignal`（`this.opts.signal`）触发。
- `runShell` 收到 abort → `SIGTERM` 整个进程组（`process.kill(-pid)`，需
  `detached:true`）→ **300ms grace → `SIGKILL`**（finding #1）→ 靠 `close`
  触发 `finish({ok:false, error:"interrupted"})`。**finish 只发生在 `close`/
  `error` 上，abort 路径不立即 resolve**（finding #4，杜绝进程还活着就返回）。
- `settled` 守卫防双 resolve；`code === null`（信号杀）由 `killed`/`timedOut`
  标志先行覆盖。
- loop 侧：`tool_result(ok:false)` 照常回给模型，与 deny/timeout 同路径，
  不引入新的状态机分支。
- 已知边界：双 fork 守护进程会逃出进程组（P0 接受，文档记录）。

## 7. Milestones

| 阶段 | 内容 | 验收 |
|---|---|---|
| **P0 解冻** | bash 改 async `spawn` + timeout + signal（真杀进程组）；`ctx.onOutput` + `onToolOutput` 通道铺好但 TUI 暂不消费 | `sleep 8; echo done` 期间 spinner 可见、耗时递增、Esc 能中止；现有 4 条 bash 用例 + 新增流式/中断用例全绿 |
| **P1 流式** | TUI `onToolOutput` 渲染 + 尾部 8 行滚动 + 节流 | `for i in 1..5; do echo $i; sleep 1; done` 数字逐行出现 |
| **P2 统一** | grep/ls/glob/git 一并 async；大输出截断/回滚抽 `accumulateTail`；ANSI/二进制清理 | 所有 shell 工具无冻结；超长输出不卡顿 |

## 8. Edge cases & risks

1. **内存放大**（Q6）：`stdout +=` 无限累积 → 1MB 有界滚动尾（超出丢头部），
   最终 `truncateOutput` 仍裁到 4096 喂模型。P2 抽成共享 `accumulateTail`。
2. **stdout/stderr 交错**：P0 只流式 stdout；stderr 仅累积、进 error 语义，
   避免交错。P2 再定交错策略。
3. **UTF-8 边界**（finding #3）：`TextDecoder({stream:true})` 分块解码，`close`
   前 `decode()` flush 一次，避免末尾残缺码点丢失。
4. **ANSI/控制字符**：P1 渲染前做轻量清理（去 `\x1b[...m`、`\r`）。
5. **`detached:true` 副作用**：脱离父进程组；`stdio:"pipe"` 下 `close` 可靠
   （用 `close` 而非 `exit`）；`child.pid` 判空再 `-pid` kill；win32 降级
   `child.kill`（本项目 macOS 10.13 优先，Windows 后置）。
6. **onToolOutput 不落盘**：resume 只靠 `tool_result`，流式中间态不回放——
   预期行为，UI 是「实时」不是「回放」。

## 9. Test plan

- `builtin.test.ts`（新增）：
  - `bash: streams stdout chunks via ctx.onOutput`（`for i in 1..3; do echo $i; sleep 0.05; done`，断言 chunks ≥ 1 且 join 含 1/3，最终 output 含 1）。
  - `bash: mid-run abort kills the process group and returns interrupted`（`sleep 60` + 200ms 后 abort，断言 `error` 含 "interrupted"；**await 进程退出**，finding #4）。
  - 现有 4 条 bash 用例**不改断言、继续通过**（语义兼容契约）。
- `loop.test.ts`（新增）：
  - `onToolOutput fired between tool_call and tool_result`（FakeProvider 驱动 bash 工具，收集 hook 回调，断言 `toolName` 正确且 chunk 非空）。

## 10. Files to change（P0）

| 文件 | 改动 |
|---|---|
| `packages/tools/src/index.ts` | `ToolContext.onOutput?` 字段 |
| `packages/tools/src/builtin.ts` | 新增 `runShell`（async spawn）；`bashTool.execute` 改 async |
| `packages/agent/src/loop.ts` | `LoopHooks.onToolOutput?` + `runTool` 挂 `ctx.onOutput` |
| `packages/tools/src/builtin.test.ts` | 新增流式/中断用例 |
| `packages/agent/src/loop.test.ts` | 新增 onToolOutput 顺序用例 |

> `TraceEvent`（trace.ts）**不改**；TUI 渲染属 P1，本阶段不动。
