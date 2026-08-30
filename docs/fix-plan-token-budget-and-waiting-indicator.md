# chita Fix Plan: per-run token budget fuse + Pi-style waiting indicator

> Status: **Implemented** (2026-08-30 first round; 2026-08-30 revised per Cursor review)
> Scope: `chita-agent` local terminal coding agent (macOS, node22 shim runtime)
> Related symptoms (the two problems seen in the TUI):
> 1. `system: error: per-run token budget exceeded (161564/131072)`
> 2. Status not updating for long periods (screen looks frozen while waiting for model thinking / long bash commands)
>
> Implementation notes:
> - First round (cur-057/058): budgetTokens wiring + spinner mechanism, bun test 134 pass
> - Cursor review revision (cur-058 review): split `maxTokens` (spend fuse) / `contextMaxTokens` (compaction threshold) in AgentLoop, fixed activityLabel tool name, WAITING_USER mapping, CLI hint copy, budgetTokensFor 2M cap, docs status

---

## Background & evidence

- Config: `~/.chita/config.json` → `{ "provider": "openai-compatible", "model": "deepseek-v4-flash", "permissionDefault": "ask", "contextWindow": 131072 }`
- Real session tape `~/.chita/agent/sessions/--Users-leo/sess-mtfafx1o.jsonl` (73 events):
  - Cumulative usage reached **691,413 tokens (input 670,507 / output 20,906)**
  - Contains `spawnSync /bin/bash ETIMEDOUT` (long bash command timeout)
  - The agent itself printed "not stuck, still making progress" — i.e. the user saw a long period with no feedback
- `sess-mt7c955v.jsonl`: a single-turn usage delta can exceed 5K+; after multiple tool-call rounds in a long task, cumulative spend easily blows through the 131072 fuse.

---

## Problem 1: `per-run token budget exceeded (161564/131072)`

### Root cause

| Item | Description |
|---|---|
| Fuse value source | Both CLI (`packages/cli/src/index.ts`) and TUI (`buildLoop()` in `packages/tui/src/index.ts`) pass `maxTokens` as `cfg.contextWindow` (=131072) |
| Fuse semantics | `maxTokens` in `loop.ts` is the **cumulative API spend per run** (`tokensUsed` accumulates across iterations), not a context length cap |
| Amplification | Each iteration resends the whole session to the API, so input tokens **accumulate multiplicatively**; a long task (large files + multiple tool calls) can burn 161K+ in a single round |
| Consequence | The guard `while ((this.iterations - runStartIterations) < maxIter && (this.tokensUsed - runStartTokens) < maxTokens)` triggers → `state = ERROR`, the whole task is killed |
| What was already correct | Context compaction/truncation (`ContextManager` in `context.ts`, threshold = 0.9 × contextWindow) uses `contextWindow` — **this part is correct and should not be touched** |

Key distinction:
- `contextWindow` = **context cap per API request** (the model's real capacity; not wrong)
- `budgetTokens` (new concept) = **cumulative spend fuse per run** (cost protection; should be decoupled from the context window)

### Fix plan

1. **Decouple the spend fuse from the context window**
   - `contextWindow` continues to serve: context compaction threshold, status bar ctx percentage
   - Add an independent config `budgetTokens`: per-run cumulative spend fuse
2. `packages/cli/src/config.ts`
   - Add `budgetTokens?: number` to the `Config` interface
   - Add `"budgetTokens"` to the `CONFIG_KEYS` whitelist
   - Default to `contextWindow × 8` when not explicitly configured:
     - 131072 × 8 = 1,048,576 (≈ aligns with the existing `DEFAULT_MAX_TOKENS = 1_000_000` fallback in the code, matching DeepSeek's real 1M context)
     - At DeepSeek pricing, 1M tokens cost only fractions of a cent — cost risk is negligible
     - For a 1M-context model → 8M fuse, scaling with the model (preserving the original "model-scaled ceiling" design intent)
3. Call sites pass `maxTokens: cfg.budgetTokens`
   - `packages/cli/src/index.ts` (print/plan/judge modes)
   - `packages/tui/src/index.ts` (`buildLoop()`)
4. **Actionable hint when the fuse still triggers** (rare path; keep a clear error + hint)
   - TUI: in `handleTurn`, for errors containing `budget`, append a hint: `/resume` to continue, or raise `budgetTokens` in `~/.chita/config.json`
   - CLI print mode: append the same one-line hint
5. `contextWindow: 131072` in `~/.chita/config.json` **stays unchanged** (if v4-flash is confirmed to have 128K context, this value is correct; it serves compaction/display purposes only)

> Note: `packages/agent/src/continue.test.ts` already has cases like `maxTokens: 100`, `restoreTokens({total: 500_000...})` — the guard semantics (per-run delta) are unchanged and unaffected.

---

## Problem 2: Status not updating for long periods → Pi-like waiting indicator

### Root cause

- The TUI status bar only has a static `| running...` (set once via `setStatus(" | running...")` in `handleTurn`)
- While waiting for the model to think (DeepSeek long reasoning) or a long bash command, the screen is completely static → looks frozen
- Tape evidence: `ETIMEDOUT` + the agent itself saying "not stuck"
- The vendored `packages/tui/vendor/components/loader.ts` already ships spinner frames (`⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`) and interval logic, but the TUI doesn't use it
- Pi reference implementation (`@earendil-works/pi-coding-agent/docs/tui.md` Pattern 4b): animated frames + status hint via `setWorkingIndicator({frames, intervalMs})`

### Fix plan (all in `packages/tui/src/index.ts`)

1. **Animated spinner in the status bar**
   - After a turn starts, `startSpinner(label)`, rotate a frame every 120ms (`⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`), reusing `setStatus()` + `tui.requestRender(true)`
   - Show **activity + elapsed seconds**: `| ⠋ thinking (23s)` ← "elapsed time" is the key to eliminating the "looks frozen" impression
2. **Live activity label**: `updateActivity()` reads `loop.state`
   - `THINKING` → `thinking`
   - `TOOL_CALL` → `running bash: <cmd>`
   - `OBSERVING` → `reading result`
   - Reset the elapsed timer when the label changes (`spinnerStart = Date.now()`)
3. **In-progress tool line in the tool box**
   - On `tool_call` via `onEvent`, append a line `[bash] ⠋ npm install...` to the tool box (same timer animation; `runningToolLine` reference + in-place `setText` updates)
   - On `tool_result`, the line is replaced by the result line (reference nulled)
   - Defensive: when `trimTools()` evicts that line, reset the reference (`toolBox.children.includes()` check)
4. **`/goal` (judge) reuses the spinner**: `startSpinner("judging")`, `stopSpinner()` in `finally`
5. **Lifecycle**: `startSpinner()` is idempotent (does not restart an existing timer); `stopSpinner()` clears the interval (called in `finally`), no leaks
   - At turn start: `setStatus(" | running...")` → `startSpinner("thinking")`
   - In `finally`: `stopSpinner(); setStatus();`

---

## Files touched

| File | Change |
|---|---|
| `packages/cli/src/config.ts` | `budgetTokens` config item + default (contextWindow × 8) |
| `packages/cli/src/index.ts` | `maxTokens: cfg.budgetTokens`; fuse error hint |
| `packages/tui/src/index.ts` | `maxTokens: cfg.budgetTokens`; spinner/status/tool animation; fuse hint |
| `packages/agent/src/loop.ts` | **unchanged** (guard semantics already correct; only call-site arguments change) |
| `packages/agent/src/context.ts` | **unchanged** (contextWindow semantics preserved) |
| `~/.chita/config.json` | **unchanged** (`budgetTokens` falls back to the default when absent) |

## Verification plan

1. `bun test` (agent package: maxTokens/restoreTokens cases in continue.test.ts should still pass)
2. `bun build` (package.json scripts.build → `dist/`), restart `chita` to take effect
3. Manual verification:
   - During a long task, the status bar shows an animated spinner + elapsed time, and the tool box shows the in-progress tool line
   - `/goal` shows the judging spinner
   - (If the fuse still triggers) the error message includes the `/resume` and `budgetTokens` hints
