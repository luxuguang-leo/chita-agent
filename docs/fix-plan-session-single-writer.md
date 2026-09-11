# chita 修复方案：一个会话被两个实例同时写入（tape 单写者失效）rev2

> 状态：**已实施并复审通过**（2026-09-12；cur-113 request_changes → rev2 → cur-114 approve_with_nits → 实施 → cur-115 request_changes → cur-116 approve_with_nits）
>
> 实施记录（2026-09-12）：
> - `packages/session/src/tape.ts`：进程内 refcount 注册表（`open()` 同进程重入共享句柄）、`tryOpen()`、`holderPid()`；`close()` 归零才释放（幂等）
> - `packages/tui/src/index.ts`：`activeTape` 持有活跃会话句柄（首绑 / `adoptSession` / 启动 auto-resume），`tapeAppend` 直写句柄；`openRecentSession` 一次 tryOpen 拿住并跳过被占会话（提示含持有者 pid）、落到次新空闲会话；`/resume` 占用不切换；`/new`、`/fork`（try/finally 平衡 refs）、`process.on("exit")` 释放
> - 测试：`tape.test.ts` 用活 pid 子进程模拟他进程占锁 + 同进程 refcount 共享/释放
> - 验证：`bun test` 206 pass / 0 fail、`tsc --noEmit` exit 0；真机两实例隔离（第二个实例 skip 并落到次新空闲会话，消息不再重复）；`/fork` 后父句柄仍可写；`/resume` → `/new` 后锁残留已消除；Ctrl+C 退出释放锁
> - 二进制：`dist/chita-darwin-arm64` sha256 `96e182b5…`
> 范围：`chita-agent` TUI 会话 tape 写入（`packages/session` + `packages/tui`）
> 现象：tape 中出现「同一 user 消息 5–7 ms 内重复两次 + 两次模型回复 + 工具被执行两遍」

## rev2 变更摘要（对应 cur-113）

| cur-113 | 处理 |
|---|---|
| #1 major：注册表缺 refcount，`/fork` 的 `parent.close()` 会卸掉 TUI 正持有的句柄 | **采纳 refcount**：`open()`/`tryOpen()` +1，`close()` −1，归零才 unlink 锁文件并从注册表移除。`/fork`（`tui/index.ts:773-778` 的 open → forkWithSummary → close）在 TUI 已持有的情况下只增减计数，不会再释放活跃会话的锁。测试锁定该序列 |
| #2 minor：`recentSessionSummary` 用 `Tape.open` + 总 catch，长持锁后扫到被占会话会整段放弃 auto-resume | 采纳：启动扫描一律走 `tryOpen`（占用 → skip → 取次新未占用）；显式写明「不是放弃 auto-resume」 |
| #3 nit：占用 UX | 采纳：提示（含持有者 pid）+ 跳过取次新未占用；都没有则新会话；不 hard-exit；`/resume <id>` 占用时只提示不切换 |
| #4/#5 nit：选 A 而非 B；注册表 + refcount 可接受，TUI 保留 `activeTape` 唯一写入口 | 采纳 |
| #6 nit：其他路径 | 采纳：`evals/` 无 Tape 使用、CLI `--print` 不写 tape（已核对）；`mergeBranchBack`（`session-tree.ts:118-128`）用裸 `openSync` **绕过锁**，本方案**不修**，仅记录为后续单列项 |
| #7 nit：启动提示含持有者 pid | 采纳：读 `tape + ".lock"` 内容即可 |
| #8 nit | 证据核对无误，保持不变 |

---

## 1. 结论（可复现）

`Tape.open()` 本来就有排他锁并会抛 `session <id> is locked by another process`（源码注释写明用途是「second --resume errors out」），但 **TUI 只在每次 append 的瞬间 open/close**，锁的持有时间是微秒级，于是「同一 cwd 的第二个 chita 实例会静默 auto-resume 同一个 session 并往同一份 tape 里写」——设计意图中的单写者保护从未真正生效。

两个实例各自持有独立的 `AgentLoop`，因此内存态互不干扰；但 tape 是 resume 的唯一真相源，结果是：**同一轮被写两遍、工具被执行两遍、双份模型回复，resume 时把两轮都恢复出来**。

## 2. 证据

### 2.1 用户真实 tape（`~/.chita/agent/sessions/--Users-luxuguang/sess-mt61phph.jsonl`）

```
51  2026-09-06T09:49:07.913Z  message    user       chita update
52  2026-09-06T09:49:07.920Z  message    user       chita update      ← 7 ms 后同一文本
53  2026-09-06T09:49:09.603Z  tool_result bash      [chita update] already up to date
54  2026-09-06T09:49:10.076Z  tool_result bash      [chita update] already up to date   ← 工具跑了两遍
55  2026-09-06T09:49:10.172Z  message    assistant  「…再次执行，结果不变…」
57  2026-09-06T09:49:10.858Z  message    assistant  「…运行结果：already up to date…」 ← 两次模型调用
```

同签名出现在 seq 45/46、51/52、59/60、71/72（同一文本 + 毫秒级间隔 + 双回复/双工具）。「工具执行两次」排除了「一个 turn 写了两次」：只有一个 handleTurn 时工具只会跑一次。

### 2.2 受控复现（当前 HEAD 构建的二进制）

两个实例 A/B（`/tmp/chita-dup-test2`，同一 cwd，同一真实 key）：A 首轮创建 session `sess-mtx91nj4`；启动 B —— B 日志 `resumed last session`，绑定同一 id；同时向两者发送同一文本：

```
6   2026-09-11T17:48:08.161Z  message  user       probe-shared 只回复 ok
7   2026-09-11T17:48:08.166Z  message  user       probe-shared 只回复 ok   ← 5 ms
8   2026-09-11T17:48:08.886Z  message  assistant  ok
10  2026-09-11T17:48:08.981Z  message  assistant  ok
```

与真实 tape 签名完全一致 → 机制确认。

### 2.3 代码事实

- `packages/session/src/tape.ts:60-95`：`Tape.open()` 用 `tape + ".lock"`（内容为本进程 pid）+ `openSync(...,"wx")` 抢锁，被他人持有时抛错，lockFd **持有到 close()**。
- `packages/tui/src/index.ts`：`tapeAppend()`、`handleTurn()` 的会话绑定、`recentSessionSummary()` 都是 `Tape.open(...) → 用 → close()`，锁只被持有毫秒级。
- 启动「auto-resume 最近会话」是默认行为，因此「新开一个终端再跑 chita」「重启但旧实例还在跑」都会命中。

### 2.4 已排除的其他机制（实测）

- 单个 Enter 只产生 1 条 user 事件；
- 运行中提交：被 `pendingInputs` 正确排队、首轮结束后按序 replay（`sleep 20` 长轮实测），无并发；
- `Editor.submitValue()` 同步清空编辑器 → CRLF 双触发即使发生也只提交空串（被 `onSubmit` 丢弃）；「输入不清空」的旧假设来自未被使用的 `components/input.ts`，不成立。

## 3. 修复方案（方案 A + refcount）

### A1. `packages/session/src/tape.ts`

- **进程内注册表** `Map<string, { tape: Tape; refs: number }>`（key = root + cwdKey + sessionId）。
  - `open(cwd, id, root)`：本进程已持有 → `refs++`，**返回同一实例**（不重复抢锁）；否则抢锁并 `refs = 1`。
  - 新增 `tryOpen(cwd, id, root): Tape | null`：被**其他存活进程**持有时返回 null；本进程已持有则同 `open`（`refs++`）。陈旧锁（pid 已死）仍按既有逻辑接管。
  - `close()`：`refs--`，**归零**才 unlink lock 文件、关闭 fd、从注册表移除；`refs > 0` 时只减计数（`/fork` 的 `parent.close()` 因此不会卸掉 TUI 持有的锁）。
  - 新增 `holderPid(cwd, id, root): number | null`：读 `.lock` 内容（供提示文案）。
- 语义不变：第二个**进程**持有期间 `open()` 仍抛原错误文案。

### A2. `packages/tui/src/index.ts`

- 活跃会话持有 `activeTape: Tape | null` 作为**唯一写入口**：
  - 首次绑定会话 / `/resume` / 启动 auto-resume 时获取并保留；
  - `tapeAppend()` 直写 `activeTape`（删掉 per-event 的 open+flock+close）；
  - `/new`、`/resume` 切换、`/fork` 切换会话、进程退出时 `close()`（`fork` 场景靠 refcount 保证活跃句柄不被卸掉）。
- **启动扫描改用 `tryOpen`**：按时间序取最近会话，占用（`null`）则 `system:` 提示 ``session <id> is open in another chita (pid N) — skipped`` 并继续取次新未占用者；全部被占用则按新会话开始（**不是**放弃 auto-resume，这正是 cur-113 #2 指出的隐患）。
- `/resume <id>` 命中被占用会话：只提示、不切换、不退出。

### A3. 测试

- `packages/session/src/tape.test.ts` 增补：
  1. `open` 两次 → 同一实例；`close` 一次后仍可用且**其他进程仍取不到**（refcount）；再 `close` 后可被获取；
  2. `tryOpen` 在他进程持锁时返回 null（用临时 `.lock` 写活 pid 模拟）；
  3. `/fork` 序列（open parent → 追加 → close）后，TUI 侧持有的同一句柄仍可写；
  4. 陈旧锁（死 pid）接管不回退；
  5. `holderPid` 返回锁文件中的 pid。
- 真机验收：两实例同 cwd → 第二个实例不共享会话（提示 + 新/次新会话），任一消息在 tape 中只出现一次；`/fork`、`/tree`、`/resume`、`/new` 各跑一遍无锁冲突；单实例长轮 + 运行中提交行为不变。

### A4. 本方案不修（记录为后续单列）

- `session-tree.mergeBranchBack`（`:118-128`）用裸 `openSync` 追加，绕过锁；在 TUI 长持 parent 的场景下可能与活跃写入并发（cur-113 #6）。
- 历史 tape 中已存在的重复轮次不做「去重清洗」——数据是事实记录，清洗会掩盖这次的真实原因。

## 4. 请 Cursor 复审

1. refcount 语义（`close()` 归零才解锁）是否就是你要的？需要额外提供 `forceClose()` 供异常路径吗？
2. 启动扫描用 `tryOpen`（会短暂抢锁再释放）是否可以，还是应该加一个**完全不加锁**的只读 peek（避免扫描本身干扰其他实例）？
3. `holderPid` 读 `.lock` 内容即可，是否有更稳的持有者标识方式（例如写入启动时间）？
