# Design: P2 — async shell tools (grep / ls / glob / git) + shared executor

Status: 📋 方案已定，待评审。接续 `docs/design-async-tool-execution.md` §7 的 P2。

## 1. Background

P0 把 `bash` 改成了 async `spawn`，P1 加了 TUI 流式尾窗。但 `grep / ls / glob / git`
四个工具**仍在用 `execSync` / `execFileSync` 同步阻塞**：

| 工具 | 现状 | 会卡的场景 |
|---|---|---|
| `grep` | `execSync('grep -rn "pat" "path"')` | 大目录树递归 |
| `ls` | `execSync('ls -la "path"')` | iCloud/网络挂载盘 |
| `glob` | `execSync('ls -d pat 2>/dev/null || true')` | 一般快，风险低 |
| `git` | `execFileSync('git', argv)` | `log/show/diff` 大仓库 |

模型跑 `grep -rn xxx ~/Documents` 或大仓库 `git log` 时，**TUI 仍会像旧 bash 那样冻住**。
冻结 bug 目前只修了 bash 一半。

## 2. Goal / non-goals

**Goal**：四工具异步化（`spawn`），复用 P0 的进程组 kill + 有界缓冲 + 流式通道；
统一超时/中断语义；顺手做输出清理（ANSI / 二进制）。

**Non-goals**：
- 不改工具语义、权限、Guardian、done 硬门、loop 结构。
- `read`/`write` 的 `readFileSync`/`writeFileSync` **不在本次范围**（用户明确只提
  四 shell 工具；read/write 是本地 fs 快操作，另议）。
- 不做 glob 的 JS 重实现（语义差异大），只把现有 shell glob 异步化（见 §4）。

## 3. 当前结果语义（契约，P2 必须逐字保留）

| 工具 | 成功 | exit 1 | 其它失败 / 超时 |
|---|---|---|---|
| `grep` | `{ok:true, output:截断}` | `{ok:true, output:"(no matches)"}` | `{ok:false, error: stderr}` |
| `ls` | `{ok:true, output:截断}` | — | `{ok:false, error: String(e)}` |
| `glob` | `{ok:true, output: out.trim() \|\| "(no matches)"}`（**无 truncated 标记**） | — | `{ok:false, error}`（罕见，`\|\| true` 兜底） |
| `git` | `{ok:true, output:截断}` | — | `{ok:false, error: stderr}` |

> 现状不一致点：`glob` 不调 `truncateOutput`（无 `truncated` 标记）。P2 顺手补齐。

## 4. argv vs shell（每工具的执行载体）

| 工具 | 载体 | 理由 |
|---|---|---|
| `git` | **argv**（`spawn("git", argv)`） | 本来就是 argv（`execFileSync`），无 shell 注入；沿用 `tokenizeArgs` |
| `grep` | **argv**（`spawn("grep", ["-rn", pattern, path])`） | 去掉 `pattern.replace(/"/g,'\\"')` 转义 hack，更安全 |
| `ls` | **argv**（`spawn("ls", ["-la", path])`） | 无 shell 需求 |
| `glob` | **保留 shell**（走 `runShell`） | `ls -d *.ts` 的 **glob 展开是 shell 干的**，`ls` 自己不 glob；argv 传 `*.ts` 会当字面量。改 JS glob 语义差异大（`**`/dotfile/brace），留后续 |

> `glob` 的 shell 注入面（pattern 原样进 shell）是**既有行为**，本次只异步化、不扩大；
> 且模型已有 bash 工具，glob 注入不构成提权。在 §10 记录，作为已知边界。

## 5. 共享异步执行器（抽取 `spawnToResult`）

P0 的 `runShell` 把「spawn + kill + 有界缓冲 + 流式 + 结果塑形」焊死在一起。
P2 抽成**核心 + 塑形回调**，四工具复用：

```ts
type ExitShape = (r: {
  code: number | null;
  stdout: string;
  stderr: string;
  killed: boolean;   // abort mid-run
  timedOut: boolean; // timeout fired
}) => ToolResult;

/** Async spawn core: argv 直传（无 shell）、detached 进程组、timeout SIGKILL、
 *  abort SIGTERM→grace→SIGKILL、1MB 有界尾、TextDecoder flush、onOutput 流式。
 *  退出时把 (code, stdout, stderr, killed, timedOut) 交给 shape 塑形。 */
function spawnToResult(
  argv: string[],
  opts: { cwd: string; timeoutMs: number; signal?: AbortSignal; onOutput?: (c: string) => void },
  shape: ExitShape
): Promise<ToolResult>;
```

- `runShell(command, opts)` = `spawnToResult(["/bin/bash", "-c", command], opts, bashShape)`
  （P0 的 4 分支逻辑原样搬进 `bashShape`，**行为零变化**）。
- 四工具各自的 `shape`：
  - `grepShape`：`killed→interrupted`；`timedOut→timed out`；`code===1→"(no matches)"`；`code!==0→error:stderr`；否则 `ok:output截断`。
  - `lsShape`：无 exit-1 特判。
  - `globShape`：`(stdout.trim() || "(no matches)")` + 补 `truncateOutput`。
  - `gitShape`：`code!==0→error:stderr`；否则 `ok:output截断`。

## 6. 超时/中断语义（统一）

现状四工具超时是 execSync 抛 `ETIMEDOUT` → 被当成泛化错误 `String(e)`，文案不可控。
P2 统一走核心的 `timedOut`/`killed` 分支：

| 场景 | P2 返回 |
|---|---|
| 超时 | `{ok:false, error:"command timed out after Nms"}` |
| Esc 中断 | `{ok:false, error:"interrupted"}` |

（文案从「ETIMEDOUT 原文」变为「可读文案」，属可接受的行为收敛；现有测试对
grep/ls/glob/git 的失败断言只查 `ok===false`，不断言 ETIMEDOUT 原文——需在测试里核实。）

## 7. 流式（onOutput）

核心 `spawnToResult` 已带 `onOutput`，四工具**零成本**接入流式：
- `git`（log/show 大输出）、`grep`（大目录）**建议流式**。
- `ls`/`glob` 输出小，流式收益低，但**统一接入也无害**（尾窗只在有内容时出现）。

决定：四工具都挂 `ctx.onOutput`（与 bash 一致），TUI 尾窗天然复用，不新增 TUI 代码。

## 8. 输出清理（ANSI / 二进制）

- **ANSI**：`git` 可能带颜色码（`color.ui=auto` 在 pipe 下通常禁用，但 `--color`/
  config 会强制）。在 `gitShape` 加一次 `sanitizeTail`（复用 `display.ts` 的纯函数，
  但要**移到 tools 包**或复制一份——`display.ts` 在 tui 包，tools 不应依赖 tui）。
- **二进制**：`git show <二进制文件>` 会把 NUL/乱码灌进 output。`gitShape` 检测
  首块含 `\0` → 返回 `{ok:true, output:"(binary file)"}`。

> `sanitizeTail` 的归属：P1 放在 `tui/src/display.ts`。P2 若 tools 也要用，应把它
> 下沉到 `tools/src/`（或 `session`/共享包），tui 从那里 re-export。见 §12 文件清单。

## 9. 里程碑切分（两个粒度，供评审拍板）

| 方案 | 内容 | 风险/收益 |
|---|---|---|
| **P2 完整** | async + 流式 + `spawnToResult` 抽取 + ANSI/二进制清理 | 一次到位；改动面大（4 工具 + 抽取 + 下沉 sanitize） |
| **P2 轻量** | 仅四工具改 async（复用 `runShell`/新增 `runCommand`），**不做**流式/清理/抽取 | 解冻最快、回归面最小；抽取与清理留 P2.1 |

Cursor 上轮已提过「可选加速：四工具都改 async 但不做流式」。倾向 **P2 轻量**为主：
先解冻，抽取/清理作为紧随的第二刀。请评审定夺。

## 10. Edge cases & risks

1. **glob shell 注入**：pattern 原样进 shell（既有行为）。本次不扩大；可选后续
   JS-glob 重写。已知边界。
2. **`spawnToResult` 抽取回归**：P0 `runShell` 的 4 分支 + kill + flush 是刚评审过、
   有测试兜底的代码。抽取时**逐字搬运**，bash 的 `bashShape` 与现 `runShell` 行为
   必须等价——用现有 4 条 bash 契约用例 + 新增流式/中断用例做回归闸门。
3. **`sanitizeTail` 跨包依赖**：tools 不应 import tui。下沉到 `tools/src/`（或共享），
   tui `display.ts` re-export 保持现有 import 不变。
4. **argv 转换的行为差**：grep/ls 从 shell 转 argv，路径含空格/引号由 argv 原生处理
   （更正确），但极少数依赖 shell 展开的写法（如 `grep -rn pat /tmp/*` 的 glob 在
   path 参数里）会变——需确认没有用例依赖。grep 的 path 默认 `.`，模型通常传具体
   目录，风险低。
5. **`git` 的 `detached` 进程组**：git 是 argv 直传、无孙进程，进程组 kill 仍适用
   （`spawn` 统一带 `detached`）。
6. **超时文案变化**：见 §6，需核实现有测试是否断言 ETIMEDOUT 原文。

## 11. Test plan

- `builtin.test.ts`（新增）：
  - `grep: exit 1 → "(no matches)"`（argv 版）；`grep: 大目录不阻塞`（冒烟，spawn 返回 Promise 即可断言不抛同步）。
  - `ls / glob / git` async 化后**现有行为断言**（git 只读守卫、argv tokenizer 用例已存在，需保绿）。
  - `git: binary show → "(binary file)"`。
  - 四工具 `timeout` → `{ok:false, error 含 "timed out"}`。
  - 四工具 `abort mid-run → interrupted`（可选，至少 grep/git）。
- 回归：P0 的 4 条 bash 契约用例 + P1 的 7 条 display 用例**全部保持**。

## 12. Files to change

| 文件 | 改动 |
|---|---|
| `packages/tools/src/builtin.ts` | 抽 `spawnToResult` + `runCommand`；`bashShape` 承接现 `runShell` 逻辑；grep/ls/glob/git 改 async |
| `packages/tools/src/sanitize.ts`（新） | `sanitizeTail` 下沉（从 tui/display.ts 搬来）；`isBinary` 辅助 |
| `packages/tui/src/display.ts` | `sanitizeTail` 改为 re-export 自 tools（或保留副本——见评审） |
| `packages/tools/src/builtin.test.ts` | 新增用例（§11） |

## 13. Open decisions（请 Cursor 拍板）

1. **P2 完整 vs P2 轻量**（§9）—— 倾向轻量，抽取/清理第二刀。
2. **`sanitizeTail` 归属**：下沉到 `tools/src/`（tui re-export）vs tools 内复制一份
   vs 保持 tui 独占、tools 用更轻的内联清理。倾向「下沉 + re-export」。
3. **grep/ls 转 argv 是否值得**：去掉转义 hack 更安全，但引入 §10.4 的 glob-in-path
   行为差。若评审认为保守起见应保留 shell，则 grep/ls 也走 `runShell`（拼字符串）。
4. **glob 是否顺手 JS 重写**（去掉 shell 注入）—— 我倾向**本次不做**，记 P2.x。
