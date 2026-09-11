# Fix notes

Short English record of notable bug fixes, newest first. One entry per fix:
symptom → root cause → change → evidence.

Plans and review rounds are kept in the commit message and the agent-bridge
archive (`~/.hermes/agent-bridge/`, ids `cur-*`); a `docs/` design document is
reserved for major features.

---

## 2026-09-12 — one session, two writers (duplicate turns)

`22a873b` · review `cur-113 → cur-116`

- **Symptom**: a session tape held the same user message twice, ~5 ms apart,
  with the tool executed twice and two differently-worded replies per turn
  (`sess-mt61phph`: seq 45/46, 51/52, 59/60, 71/72).
- **Root cause**: `Tape.open()` takes an exclusive lock, but the TUI opened it
  only for each append and closed it immediately, so the lock lived for
  microseconds. A second `chita` in the same cwd silently auto-resumed the same
  session and appended to the same tape — the documented "second resume is
  blocked" guard never fired. Reproduced with two instances in one cwd.
- **Change**: `tape.ts` gained a refcounted per-process handle registry
  (`open()` shares the handle this process already holds, `close()` releases at
  zero), `tryOpen()` (null while another live process holds the session) and
  `holderPid()`. The TUI holds the active session's tape for the session's
  lifetime and writes through it; the startup scan takes its handle in one
  `tryOpen`, reports sessions held elsewhere with the holder pid and falls back
  to the next free session; `/resume` refuses a held session; `/new`, `/fork`
  (balanced) and process exit release the lock.
- **Evidence**: 206 tests pass, `tsc` clean; two-instance runs stay isolated;
  `/fork` keeps the parent handle writable; `/resume` followed by `/new` leaves
  no lock file behind.

## 2026-09-12 — resume rebuilt a conversation the API rejects

`94ad06d` · review `cur-109 → cur-112`

- **Symptom**: startup auto-resume failed with `seedConversation: orphan tool
  message (no matching assistant toolCalls)`.
- **Root cause**: two defects. TUI never persisted `tool_call` events, so tapes
  carried tool results but no assistant declarations; and its resume mapping
  never attached `toolCalls`/`toolCallId`, so every result it kept was an orphan.
  `seedConversation` itself was also too strict: it required the *immediately*
  preceding message to be the declaring assistant, which the live loop violates
  whenever one assistant declares several calls (`assistant(N) → tool×N`).
- **Change**: `history.ts` reconstructs the OpenAI message shape from trace
  events in tape order (declarations reconstructed with `{"_resumed":true}` args
  for legacy tapes, unanswered declarations pruned); `seedConversation` validates
  with OpenAI parallel-tool semantics; the TUI persists `tool_call` events.
- **Evidence**: 205 tests pass; the failing tape keeps 145/145 tool results and
  resumes in a PTY (`ctx 72.9K/1M` restored).

## 2026-08-30 — per-run budget fuse killed long runs; status looked frozen

`ce28dd6` · review `cur-106 → cur-108`

- **Symptom**: `system: error: per-run token budget exceeded (161564/131072)`
  killed tasks mid-run, and the status bar sat still for long stretches while
  the model thought or a bash command ran.
- **Root cause**: `maxTokens` (cumulative API spend per run) was wired to
  `cfg.contextWindow`, so a long multi-iteration run blew through it; the same
  field was also handed to `ContextManager` as the compaction ceiling. The
  status bar had only a static `| running...`.
- **Change**: `budgetTokens` decoupled as the spend fuse (default
  `min(contextWindow × 8, 2M)`, explicit value uncapped) and `contextMaxTokens`
  fed to compaction; TUI gained a 120 ms spinner with activity label + elapsed
  seconds, an in-progress tool row, and an actionable hint when the fuse fires.
- **Evidence**: 196 tests pass; the default fuse for the local config becomes
  2M instead of 1,048,576.
