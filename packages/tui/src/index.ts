/**
 * chita TUI (T1, cur-033 gaps addressed)
 *
 * Three-region layout: message area (ScrollView) + input line (Input) +
 * status bar. Multi-turn via AgentLoop.continue(). Slash commands local.
 *
 * cur-033 fixes:
 * - assistant streaming rendered via onAssistantMessage hook
 * - Ctrl+C cancels current turn (AbortController via loop signal)
 * - Esc cancels too; a cancel returns queued follow-ups to the editor
 *   (pi/Codex parity) instead of firing them at the rejected context
 * - onSubmit re-entrancy lock (no stacked runs on rapid Enter)
 * - /mode rebuilds the loop with the new mode
 */

import { TuiMainScreen } from "../vendor/tui-main-screen.ts";
import { ProcessTerminal } from "../vendor/terminal.ts";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { ScrollView } from "../vendor/components/scroll-view.ts";
import { Text } from "../vendor/components/text.ts";
import { VStack } from "../vendor/components/v-stack.ts";
import { HStack } from "../vendor/components/h-stack.ts";
import { Box } from "../vendor/components/box.ts";
import { Markdown, type MarkdownTheme } from "../vendor/components/markdown.ts";
import { Editor, type EditorTheme } from "../vendor/components/editor.ts";
import { CombinedAutocompleteProvider, type SlashCommand } from "../vendor/autocomplete.ts";
import type { SelectListTheme } from "../vendor/components/select-list.ts";
import { AgentLoop } from "../../agent/src/loop.ts";
import { categoryLabel, type GuardianCategory } from "../../agent/src/guardian.ts";
import { friendlyError } from "../../agent/src/errors.ts";
import { runJudge } from "../../agent/src/judge.ts";
import { JudgeBudget } from "../../agent/src/judge.ts";
import { OpenAICompatibleProvider } from "../../ai/src/index.ts";
import { scrubSecrets } from "../../agent/src/scrub.ts";
import { loadConfig, apiKey, budgetTokensFor } from "../../cli/src/config.ts";
import { renderBanner } from "../../cli/src/banner.ts";
import { VERSION } from "../../cli/src/index.ts";
import {
  KeybindingsManager,
  setKeybindings,
  TUI_KEYBINDINGS,
} from "../vendor/keybindings.ts";
import { matchesKey } from "../vendor/keys.ts";
import { buildSessionTree, forkWithSummary } from "../../session/src/session-tree.ts";
import { Tape, cwdKey, SESSIONS_ROOT } from "../../session/src/tape.ts";
import type { TraceEvent } from "../../session/src/trace.ts";
import { estimateTokens } from "../../agent/src/context.ts";
import { historyFromEvents } from "../../agent/src/history.ts";
import { mergeQueuedIntoDraft } from "./queue.ts";

/** Describe the most recent session in this cwd: id + first user message +
 *  age. Returns null when none. Used for the startup hint and /resume
 *  without an id (Leo: opaque random ids are unfriendly). */
/** Session held by another live chita, named for a one-line system notice. */
function lockedNotice(id: string, pid: number | null): string {
  return `session ${id} is open in another chita${pid ? ` (pid ${pid})` : ""}`;
}

/** Newest session in this cwd that no other live chita holds. The returned
 *  tape is KEPT OPEN (one handle, one lock): it becomes this process's active
 *  writer, so the handle must not be re-acquired later (cur-114 review #1).
 *  Sessions already held are reported through `onLocked` and skipped. */
function openRecentSession(
  cwd: string,
  onLocked: (id: string, pid: number | null) => void
): { tape: Tape; id: string; first: string; age: string } | null {
  try {
    const dir = join(SESSIONS_ROOT, cwdKey(cwd));
    if (!existsSync(dir)) return null;
    const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    if (files.length === 0) return null;
    // newest first by mtime
    files.sort((a, b) => statSync(join(dir, b)).mtimeMs - statSync(join(dir, a)).mtimeMs);
    for (const f of files) {
      const id = f.replace(/\.jsonl$/, "");
      const tape = Tape.tryOpen(cwd, id);
      if (!tape) {
        onLocked(id, Tape.holderPid(cwd, id));
        continue;
      }
      let events: TraceEvent[];
      try {
        events = tape.readAll();
      } catch {
        tape.close(); // unreadable session: release and keep looking
        continue;
      }
      const firstUser = events.find(
        (e): e is Extract<TraceEvent, { type: "message" }> => e.type === "message" && e.role === "user"
      );
      const first = (firstUser?.content ?? "").replace(/\s+/g, " ").trim();
      if (events.length === 0 || !first) {
        tape.close();
        continue;
      }
      const created = tape.readMeta()?.createdAt;
      return { tape, id, first: first.slice(0, 40), age: created ? ageLabel(created) : "" };
    }
  } catch {
    return null;
  }
  return null;
}

function ageLabel(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

export interface TuiOptions {
  judge?: boolean;
}

export async function startTui(opts: TuiOptions = {}): Promise<void> {
  // Enter=submit, Shift+Enter=newline (design §8). Override pi-tui's default
  // newLine (shift+enter + ctrl+j) — ctrl+j catches bare \n (0x0a), so
  // Enter would insert a newline instead of submitting.
  setKeybindings(
    new KeybindingsManager(TUI_KEYBINDINGS, {
      "tui.input.newLine": "shift+enter",
      "tui.input.submit": "enter",
    })
  );

  const cfg = loadConfig();
  let key = apiKey();
  if (!key) {
    // first-run guidance before entering the TUI
    const { runSetup } = await import("../../cli/src/setup.ts");
    const setup = await runSetup();
    if (!setup.ok) {
      console.error(`\n${setup.message}`);
      process.exit(1);
    }
    console.log(`\n✓ ${setup.message}\n`);
    key = apiKey();
    if (!key) {
      console.error("setup completed but key not readable — check ~/.chita/.env");
      process.exit(1);
    }
  }

  const makeProvider = () =>
    new OpenAICompatibleProvider({ baseUrl: "https://api.deepseek.com/v1", apiKey: key, model: cfg.model });

  // --- TUI primitives ---
  const terminal = new ProcessTerminal();
  const tui = new TuiMainScreen(terminal);

  const messagesBox = new Box();
  const messageScroll = new ScrollView(messagesBox, { follow: "end" });

  // Tool activity region: fixed-height scrollable strip below the chat —
  // tool calls no longer flood the conversation (Leo: wants scrolling).
  const toolBox = new Box();
  const toolScroll = new ScrollView(toolBox, { follow: "end" });

  // Editor with slash-command + @file autocomplete (T2)
  const id = (s: string) => s;
  const selectListTheme: SelectListTheme = {
    selectedPrefix: id,
    selectedText: id,
    description: id,
    scrollInfo: id,
    noMatch: id,
  };
  const editorTheme: EditorTheme = { borderColor: id, selectList: selectListTheme };
  const input = new Editor(tui, editorTheme);
  const slashCommands: SlashCommand[] = [
    { name: "help", description: "show commands" },
    { name: "new", description: "new session" },
    { name: "tree", description: "show session tree" },
    { name: "resume", description: "resume session", argumentHint: "<session-id>" },
    { name: "fork", description: "fork current session" },
    { name: "mode", description: "build|plan", argumentHint: "build|plan" },
    { name: "goal", description: "independent verification" },
    { name: "tool", description: "expand a tool result", argumentHint: "<name>" },
    { name: "exit", description: "leave TUI" },
  ];
  input.setAutocompleteProvider(new CombinedAutocompleteProvider(slashCommands, process.cwd()));
  const statusText = new Text(
    "session: new | mode: build | model: " + cfg.model + ` | ↑0 ↓0 | ctx 0/${fmtTokens(cfg.contextWindow ?? 131_072)} (0%)`,
    0,
    0
  );

  const root = new VStack([
    { component: messageScroll, grow: 1 },
    { component: toolScroll, basis: 5, shrink: 0, grow: 0 }, // fixed 5 rows: input position stable (Leo)
    { component: input },
    { component: new HStack([{ component: statusText }]) },
  ]);
  tui.addChild(root);
  tui.setFocus(input);

  // --- session state ---
  let loop: AgentLoop | null = null;
  let sessionId: string | null = null; // bound to the active tape session
  /** The session tape this process holds (and writes through) — holding it for
   *  the session's lifetime is what keeps a second chita in this cwd out of the
   *  same session (cur-113). */
  let activeTape: Tape | null = null;
  // release the session lock on any exit so the next chita can resume it
  process.on("exit", () => activeTape?.close());

  // persist a trace event to the session tape (cur-042: all turns, not just user)
  const tapeAppend = (ev: unknown) => {
    try {
      activeTape?.append(ev as never);
    } catch {
      // tape write is best-effort; never break the turn for it
    }
  };
  let mode: "build" | "plan" = "build";
  let tokensUsed: { total: number; input: number; output: number } = { total: 0, input: 0, output: 0 };
  let running = false; // re-entrancy lock (cur-033 #6)
  let cancelCurrent: (() => void) | null = null;
  let pendingInputs: string[] = []; // FIFO queue while running (cur-038)
  // M-next WAITING_USER: pending permission approval — the loop suspends until
  // the next input line resolves it (allow/deny/timeout). Non-null only while
  // the loop awaits onPermissionRequest.
  let approvalWaiter: { resolve: (allow: boolean) => void; toolName: string; reason: string } | null = null;

  // --- cur-058 spinner state (waiting indicator) ---
  const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  const SPINNER_INTERVAL_MS = 120;
  let spinnerTimer: ReturnType<typeof setInterval> | null = null;
  let spinnerFrame = 0;
  let spinnerLabel = "";
  let spinnerStart = 0;
  /** true = label follows loop.state (model turns); false = fixed label (judge) */
  let spinnerTrackState = true;
  /** Running-tool indicator row in the tool strip (null when idle) */
  let runningToolLine: Markdown | null = null;
  let runningToolCmd = "";
  /** Real tool name for the running indicator + status label (cur-058 review:
   *  not every tool is bash — read/write/git show their own name). */
  let runningToolName = "";
  // TUI-level judge budget singleton (cur-040 major: per-invocation instance
  // reset the max-3-per-session counter every /goal)
  const judgeBudget = new JudgeBudget({});
  // last tool results per name (for /tool <name> full expansion, cur-042)
  const toolResults = new Map<string, { ok: boolean; output?: string; error?: string }>();
  const lastToolCmd = new Map<string, string>(); // callId -> command (omp-style pairing)
  let bannerCount = 0; // consecutive decorative echo banners (folded)
  /** Pending assistant message being streamed (updated in place, not new rows) */
  let streamingText: Markdown | null = null;
  let streamingBuffer = "";
  /** True once the provider emitted any message THIS turn (cur-056): guards
   *  endStreaming from re-appending a stale assistant message + unchanged
   *  usage when the loop returns without ever calling the provider (e.g. a
   *  resumed session dead-locked on the cumulative token budget). */
  let streamedThisTurn = false;

  // ANSI colors for role/block styling (T3)
  const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
  const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
  const gray = (s: string) => `\x1b[90m${s}\x1b[0m`;
  const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
  const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
  // Base foreground: bright white — terminal profiles with a dark default
  // foreground (some iTerm2 windows) made plain text black/invisible (Leo)
  const brightWhite = (s: string) => `\x1b[97m${s}\x1b[0m`;
  const mdTheme: MarkdownTheme = {
    heading: (s) => green(s), link: cyan, linkUrl: dim, code: yellow,
    codeBlock: yellow, codeBlockBorder: dim, quote: gray, quoteBorder: dim,
    hr: dim, listBullet: green, bold: (s) => `\x1b[1m${s}\x1b[0m`,
    italic: (s) => `\x1b[3m${s}\x1b[0m`, strikethrough: dim, underline: cyan,
    // table frames — some fonts render box chars black/invisible (Leo)
    tableBorder: cyan,
  };
  // role prefix colors: user green, tool yellow, system gray, assistant plain
  const ROLE_COLOR: Record<string, (s: string) => string> = {
    user: green,
    tool: yellow,
    system: gray,
  };

  function appendMessage(role: string, content: string): void {
    const color = ROLE_COLOR[role] ?? ((s: string) => s);
    // role prefix: color only (no ** bold — that would double-wrap via
    // theme.bold around the ANSI codes, cur-040 minor)
    if (role === "tool") {
      // tool activity -> dedicated scrolling strip, not the chat (Leo)
      toolBox.addChild(new Markdown(`${color(role)}: ${content}`, 0, 0, mdTheme, { color: brightWhite }));
      trimTools();
    } else {
      messagesBox.addChild(new Markdown(`${color(role)}: ${content}`, 0, 0, mdTheme, { color: brightWhite }));
      trimMessages();
    }
    // requestRender() (NOT force): force resets the render state, which makes
    // TuiMainScreen emit a clearing full redraw (\x1b[2J\x1b[3J) of the whole
    // growing history — the "screen flooding" bug. Differential rendering is
    // enough here (Box/Markdown invalidate their own caches).
    tui.requestRender();
  }

  /** Window the message area: drop oldest rows past MAX_VISIBLE (cur-042
   *  virtualization; full history stays in the tape).
   *  Uses removeChild (which invalidates Box cache) — never mutate children
   *  directly (cur-043 major: shift() bypassed invalidateCache). */
  function trimMessages(): void {
    const MAX_VISIBLE = 200;
    while (messagesBox.children.length > MAX_VISIBLE) {
      const oldest = messagesBox.children[0];
      if (oldest) messagesBox.removeChild(oldest);
    }
  }

  /** Window the tool strip: keep the last MAX_TOOL_LINES tool entries —
   *  the strip is fixed-height and scrolls, so cap memory/render cost. */
  function trimTools(): void {
    const MAX_TOOL_LINES = 40;
    while (toolBox.children.length > MAX_TOOL_LINES) {
      const oldest = toolBox.children[0];
      if (oldest) {
        // defensive: if the running-tool row is the one being windowed out,
        // drop the reference so updateActivity can't touch a dead node (cur-058)
        if (oldest === runningToolLine) {
          runningToolLine = null;
          runningToolCmd = "";
          runningToolName = "";
        }
        toolBox.removeChild(oldest);
      }
    }
  }

  /** Streaming: accumulate into one row, update in place (cur-033 #3 refinement) */
  function appendStreamed(content: string): void {
    streamingBuffer += content;
    if (!streamingText) {
      streamingText = new Markdown(`**assistant** ${streamingBuffer}`, 0, 0, mdTheme, { color: brightWhite });
      messagesBox.addChild(streamingText);
    } else {
      streamingText.setText(`**assistant** ${streamingBuffer}`);
    }
    trimMessages();
    tui.requestRender(); // differential: update the streamed row in place
  }

  function endStreaming(): void {
    // persist the complete assistant message ONCE (cur-043 major: per-fragment
    // tape writes polluted sessions; write the full buffer at turn end)
    // cur-056: if the provider never ran this turn (deadlock/error before the
    // first streamed token), there is nothing new to persist — writing the
    // stale last-assistant message + unchanged usage here is what polluted
    // the stuck session's tape with repeated
    // "让我再看几个关键 references…" / "let me check a few more key references…".
    if (!streamedThisTurn) {
      streamingText = null;
      streamingBuffer = "";
      return;
    }
    let content = streamingBuffer;
    if (!content.trim() && loop) {
      // tool-only turns: streamingBuffer stays empty — fall back to the last
      // assistant message in the conversation (cur-044 nit)
      const conv = loop.getConversation();
      const lastAsst = [...conv].reverse().find((m) => m.role === "assistant");
      content = lastAsst?.content ?? "";
    }
    if (content.trim()) {
      tapeAppend({ type: "message", role: "assistant", content });
    }
    // persist cumulative token usage — resume restores the counter instead
    // of restarting at 0 (Leo: restart showed ↑0 ↓0 after resume)
    if (loop) {
      const u = loop.getTokensUsed();
      tapeAppend({ type: "usage", total: u.total, input: u.input, output: u.output });
    }
    streamingText = null;
    streamingBuffer = "";
  }

  /** Human-readable token count (omp style): 4615 -> 4.5K, 1048576 -> 1M */
  function fmtTokens(n: number): string {
    if (n >= 1_048_576) return (n / 1_048_576).toFixed(1).replace(/\.0$/, "") + "M";
    if (n >= 1024) return (n / 1024).toFixed(1).replace(/\.0$/, "") + "K";
    return String(n);
  }

  function setStatus(suffix = ""): void {
    const sid = sessionId ? sessionId.slice(-8) : "new"; // short id (cur-042)
    const ctx = cfg.contextWindow ?? 131_072;
    // Context occupancy = the CURRENT conversation's actual length
    // (estimateTokens), NOT cumulative API consumption — the API resends all
    // history every turn, so summing usage.input inflates the %. ↑↓ stay
    // cumulative (billing view). (Leo: what does the % mean?)
    let cur = 0;
    if (loop) {
      const conv = loop.getConversation();
      cur = estimateTokens(conv.map((m) => m.content ?? "").join("\n"));
    }
    const pct = ctx > 0 ? Math.round((cur / ctx) * 100) : 0;
    statusText.setText(
      `session: ${sid} | mode: ${mode} | model: ${cfg.model} | ` +
        `↑${fmtTokens(tokensUsed.input)} ↓${fmtTokens(tokensUsed.output)} | ctx ${fmtTokens(cur)}/${fmtTokens(ctx)} (${pct}%)${suffix}`
    );
    // spinner ticks call this every 120 ms — must stay differential, or the
    // whole screen + scrollback is cleared and reprinted 8x/second
    tui.requestRender();
  }

  /** Map loop state -> status label (cur-058: tells the user WHAT is slow). */
  function activityLabel(): string {
    const st = loop?.state ?? "THINKING";
    if (st === "TOOL_CALL") return runningToolName ? `running ${runningToolName}` : "running tool";
    if (st === "OBSERVING") return "reading result";
    if (st === "WAITING_USER") return "awaiting approval · type allow/deny";
    return "thinking";
  }

  /** Refresh the animated status bar + running-tool row (one tick). */
  function updateActivity(): void {
    if (!spinnerTimer) return;
    // model turns: label follows loop.state (thinking / running tool / reading
    // result); non-loop activity (judge) keeps the explicit label
    if (spinnerTrackState) {
      const label = activityLabel();
      // label change (e.g. thinking -> running bash) resets the elapsed clock
      if (label !== spinnerLabel) {
        spinnerLabel = label;
        spinnerStart = Date.now();
      }
    }
    const elapsed = Math.max(0, Math.floor((Date.now() - spinnerStart) / 1000));
    const frame = SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length];
    setStatus(` | ${frame} ${spinnerLabel} (${elapsed}s)`);
    if (runningToolLine) {
      runningToolLine.setText(`[${runningToolName}] ${frame} ${runningToolCmd}`);
    }
  }

  /** Idempotent: no-op while already animating. trackState=false pins the
   *  label (e.g. judging) instead of deriving it from loop.state. */
  function startSpinner(label: string, trackState = true): void {
    if (spinnerTimer) return;
    spinnerLabel = label;
    spinnerStart = Date.now();
    spinnerFrame = 0;
    spinnerTrackState = trackState;
    updateActivity();
    spinnerTimer = setInterval(() => {
      spinnerFrame = (spinnerFrame + 1) % SPINNER_FRAMES.length;
      updateActivity();
    }, SPINNER_INTERVAL_MS);
  }

  /** Stop the animation and drop any stale running-tool row. */
  function stopSpinner(): void {
    if (spinnerTimer) {
      clearInterval(spinnerTimer);
      spinnerTimer = null;
    }
    if (runningToolLine) {
      // turn ended before a tool_result — don't leave a stale spinning row
      if (toolBox.children.includes(runningToolLine)) toolBox.removeChild(runningToolLine);
      runningToolLine = null;
      runningToolCmd = "";
      runningToolName = "";
    }
    spinnerLabel = "";
    spinnerTrackState = true;
    tui.requestRender();
  }

  /** Loop-side approval timeout (ms). Single source of truth shared by the
   *  AgentLoop (permissionTimeoutMs) and the TUI waiter — the waiter must
   *  expire in step with the loop so a stale input line after a loop-side
   *  timeout falls through to the model instead of being eaten as an
   *  approval decision (F3). */
  const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

  function buildLoop(): AgentLoop {
    return new AgentLoop({
      cwd: process.cwd(),
      provider: makeProvider(),
      mode,
      maxTokens: budgetTokensFor(cfg), // per-run spend fuse, decoupled from contextWindow (cur-057/058)
      contextMaxTokens: cfg.contextWindow, // compaction ceiling stays on contextWindow (cur-058 review)
      autoApproveAsk: true,
      permissionTimeoutMs: APPROVAL_TIMEOUT_MS, // in step with the TUI waiter (F3)
      // P1-2 memory (cur-104 Q3): interactive TUI defaults ON; opt out via CHITA_MEMORY=0
      memory: process.env.CHITA_MEMORY === "0" ? undefined : { enabled: true },
      hooks: {
        beforeToolCall: async () => true,
        // M-next WAITING_USER (v2.1 §8.2): Guardian `ask` — render a prompt
        // and suspend until the next input line resolves it. Timeout (5 min,
        // loop-side) resolves as deny; the loop records it on the tape. The
        // waiter resolves itself on timeout so a late input line is NOT eaten
        // as an approval after the loop already moved on (F3).
        onPermissionRequest: (toolName, args, reason) => {
          const cmd =
            typeof args.command === "string" ? args.command
            : typeof args.path === "string" ? args.path
            : typeof args.pattern === "string" ? args.pattern
            : "";
          // reason looks like "guardian[credential]: reading credential-bearing
          // file". Split it so the user sees the WHAT (Chinese category) and
          // WHY (rule hint) plus an explicit how-to-answer line.
          const m = reason.match(/^guardian\[(\w+)\]:\s*(.*)$/);
          const label = m ? categoryLabel(m[1] as GuardianCategory) : "风险操作";
          const why = m ? m[2] : reason;
          appendMessage("system", `⏸ 需要授权【${label}】${why}`);
          appendMessage("system", `   命令: ${cmd.slice(0, 140) || "(无参数)"}`);
          appendMessage("system", `   → 回复 allow 放行 / deny 拒绝（5 分钟不回复 = 拒绝）`);
          return new Promise<boolean>((resolve) => {
            let settled = false;
            const finish = (allow: boolean) => {
              if (settled) return; // F3: ignore late resolves after timeout/Ctrl+C
              settled = true;
              if (approvalWaiter?.toolName === toolName) approvalWaiter = null;
              resolve(allow);
            };
            approvalWaiter = { resolve: finish, toolName, reason };
            // align with the loop-side timeout (same constant): expire the
            // waiter too, so a stale input line falls through to the model
            // instead of being swallowed as a decision (F3)
            setTimeout(() => finish(false), APPROVAL_TIMEOUT_MS);
          });
        },
        afterToolCall: (_n, result) => {
          if (result.output) {
            const scrubbed = scrubSecrets(result.output);
            return { ok: result.ok, output: scrubbed.text, redacted: scrubbed.redacted };
          }
        },
        // streaming assistant text rendered live (cur-033 #3); NOT persisted
        // per-fragment (cur-043 major: fragments would pollute the tape) —
        // written once at endStreaming from the buffer
        onAssistantMessage: (msg) => {
          streamedThisTurn = true;
          appendStreamed(msg.content);
        },
        onEvent: (ev) => {
  /** Brief command for the tool line: strip redirection/noise, keep first
   *  two words (omp style). 'ls -la ~/.agents 2>/dev/null; echo ---' ->
   *  'ls -la …'. Full command stays in /tool. (Leo: long cmd text = noise.) */
  function briefCmd(cmd: string): string {    const cleaned = cmd
      .replace(/\s*2>\s*\/dev\/null/g, "")
      .replace(/\s*>\s*\/dev\/null/g, "")
      .replace(/\s*\|\s*head(\s+-\d+)?.*$/, "")
      .replace(/;\s*echo\s+["'-]+.*$/, "")
      .trim();
    if (cleaned.length <= 34) return cleaned;
    return cleaned.split(/\s+/).slice(0, 2).join(" ") + "…";
  }

  /** Condensed tool summary for the message area (omp/hermes style): skip
   *  decoration-only lines (===, ---, ***, ...), extract "=== TITLE ==="
   *  markers, append line count when the output is long. Full output stays
   *  available via /tool. (Leo: echo-title banners were pure noise.) */
  function toolSummary(toolName: string, output: string): string {
    const lines = output.trim().split("\n").filter((l) => l.trim());
    if (lines.length === 0) return "done";
    const DECOR = /^(=+|-+|~+|\*+|#+)\s*$/;
    const TITLE = /^={2,}\s*(.+?)\s*={2,}$/;
    let pick = "";
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || DECOR.test(line)) continue;
      const t = line.match(TITLE);
      pick = t ? t[1].trim() : line;
      break;
    }
    if (!pick) pick = "(no content)";
    const suffix = lines.length > 3 ? ` · ${lines.length} lines` : "";
    return pick.slice(0, 60) + suffix;
  }

  /** True when the command is a decorative echo banner (echo "=== xxx ===",
   *  echo ---, echo "-----") — folded out of the tool feed (Leo: flood). */
  function isBannerCmd(cmd: string): boolean {
    return /^echo\s+["']?={2,}/.test(cmd) || /^echo\s+["']?-{2,}/.test(cmd) || /^echo\s*$/.test(cmd);
  }

  /** Minimal tool line (omp style): command + first meaningful argument —
   *  'curl -s https://api…' -> 'curl https://api…'; 'ls -lat ~/x/' ->
   *  'ls ~/x/'; line count only when >3 lines. Full command/output via
   *  /tool. (Leo: bare first word ('curl') lost the target.) */
  function toolLine(cmd: string, toolName: string, output: string): string {
    if (cmd) {
      const cleaned = briefCmd(cmd); // noise-stripped
      const words = cleaned.split(/\s+/).filter(Boolean);
      const arg = words.slice(1).find((w) => !w.startsWith("-") && !w.startsWith("<"));
      const display = arg ? `${words[0] ?? toolName} ${arg}` : (words[0] ?? toolName);
      const short = display.length > 42 ? display.slice(0, 42) + "…" : display;
      const n = output.trim() ? output.trim().split("\n").length : 0;
      return n > 3 ? `${short} · ${n} lines` : short;
    }
    return toolSummary(toolName, output);
  }

          if (ev.type === "tool_call") {
            // remember the command/args — shown next to the result (omp style)
            const a = (ev.tool?.args ?? {}) as Record<string, unknown>;
            const cmd = typeof a.command === "string" ? a.command
              : typeof a.path === "string" ? a.path
              : typeof a.pattern === "string" ? a.pattern
              : "";
            lastToolCmd.set(ev.callId ?? ev.tool?.name ?? "", cmd);
            // persist the declaration so resume can pair results with calls —
            // without it a tape keeps tool results but no toolCalls (cur-109)
            tapeAppend({ type: "tool_call", tool: ev.tool, callId: ev.callId });
            // running-tool indicator row (cur-058): spins with the status bar
            // until the tool_result arrives and replaces it
            if (!runningToolLine) {
              runningToolCmd = briefCmd(cmd) || ev.tool?.name || "tool";
              runningToolName = ev.tool?.name ?? "tool";
              runningToolLine = new Markdown(`[${runningToolName}] ⠋ ${runningToolCmd}`, 0, 0, mdTheme, { color: brightWhite });
              toolBox.addChild(runningToolLine);
              trimTools();
              tui.requestRender();
            }
            return;
          }
          if (ev.type === "tool_result") {
            // the running indicator row is replaced by the result row (cur-058)
            if (runningToolLine) {
              if (toolBox.children.includes(runningToolLine)) toolBox.removeChild(runningToolLine);
              runningToolLine = null;
              runningToolCmd = "";
              runningToolName = "";
            }
            // Show real content, not bare "ok" (Leo: [bash] ok ×5 is noise).
            // Success -> condensed summary (decorations skipped, titles
            // extracted, long output annotated); failure -> error detail.
            const cmd = lastToolCmd.get(ev.callId ?? ev.toolName) ?? "";
            const isBanner = ev.ok && isBannerCmd(cmd);
            let detail = "";
            if (isBanner) {
              // decorative `echo "==="` banners: fold consecutive ones into
              // a single line instead of flooding (Leo: 5× echo "===…)
              bannerCount++;
            } else {
              if (bannerCount > 0) {
                appendMessage("tool", `[bash] ×${bannerCount} banner lines`);
                bannerCount = 0;
              }
              detail = ev.ok
                ? toolLine(cmd, ev.toolName, ev.output ?? "")
                : `error: ${ev.error?.slice(0, 80) ?? "unknown"}`;
              appendMessage("tool", `[${ev.toolName}] ${detail}`);
            }
            // remember full result for /tool expansion (cur-042)
            toolResults.set(ev.toolName, { ok: ev.ok, output: ev.output, error: ev.error });
            // persist tool result to tape (cur-042)
            tapeAppend({
              type: "tool_result",
              toolName: ev.toolName,
              ok: ev.ok,
              output: ev.output,
              error: ev.error,
              callId: ev.callId,
            });
          }
        },
      },
    });
  }

  async function onSubmit(raw: string): Promise<void> {
    const value = raw.trim();
    if (!value) return;
    // M-next WAITING_USER: while the loop awaits permission, the next line is
    // the decision — allow/yes/approve grants, anything else denies. Do NOT
    // route it to the model (the loop is suspended mid-tool).
    if (approvalWaiter) {
      const w = approvalWaiter;
      approvalWaiter = null;
      const allow = /^(allow|yes|y|approve|ok)$/i.test(value);
      appendMessage("system", allow ? `✓ allowed ${w.toolName} (${w.reason})` : `✗ denied ${w.toolName} (${w.reason})`);
      w.resolve(allow);
      return;
    }
    // record non-slash task prompts in editor history (↑↓ navigation)
    if (!value.startsWith("/")) input.addToHistory(value);
    if (running) {
      // FIFO queue: normal turn end drains it; Esc/Ctrl+C return it to the
      // editor instead (pi/Codex). Never drop input.
      pendingInputs.push(value);
      return;
    }
    await handleTurn(value);
  }

  /** Take queued follow-ups back into the editor (pi/Codex "take back what you
   *  queued"): merge them with the current draft, oldest first, separated by
   *  blank lines, so the user can edit/reorder before re-submitting. Returns
   *  how many were returned. */
  function restorePendingInputs(): number {
    const queued = pendingInputs;
    pendingInputs = [];
    if (queued.length === 0) return 0;
    input.setText(mergeQueuedIntoDraft(queued, input.getText()));
    tui.requestRender();
    return queued.length;
  }

  /** The actual turn handler (slash or model task). */
  async function handleTurn(value: string): Promise<void> {
    // local slash commands (never to the model)
    // also accept bare 'quit' / 'exit' (user intuition, cur-045)
    if (value === "quit" || value === "exit") {
      tui.stop();
      process.exit(0);
      return;
    }
    if (value.startsWith("/")) {
      const cmd = value.split(/\s+/)[0];
      switch (cmd) {
        case "/help":
          appendMessage("system", "/help /new /tree /resume <id> /fork /mode build|plan /tool <name> /goal /exit");
          return;
        case "/tool": {
          const name = value.split(/\s+/)[1];
          if (!name) {
            appendMessage("system", "usage: /tool <name> (recent results: " + [...toolResults.keys()].join(", ") + ")");
            return;
          }
          const r = toolResults.get(name);
          if (!r) {
            appendMessage("system", `no recent result for ${name}`);
            return;
          }
          appendMessage("tool", `[${name}] ${r.ok ? "ok" : "error"}\n${(r.output ?? r.error ?? "").slice(0, 2000)}`);
          return;
        }
        case "/new":
          loop = null;
          sessionId = null; // new session unbinds the tape (cur-040 minor)
          activeTape?.close(); // release this session's lock (cur-113)
          activeTape = null;
          toolResults.clear(); // no stale /tool output (cur-043 nit)
          pendingInputs = []; // drop queued inputs from old session (cur-043 nit)
          tokensUsed = { total: 0, input: 0, output: 0 }; // fresh stats (Leo: /new kept old ↑↓/ctx)
          appendMessage("system", "new session");
          setStatus();
          return;
        case "/exit":
          tui.stop();
          process.exit(0);
          return;
        case "/mode": {
          mode = value.includes("plan") ? "plan" : "build";
          loop = buildLoop(); // rebuild with new mode (cur-033 #5)
          tokensUsed = { total: 0, input: 0, output: 0 }; // loop reset -> stats reset
          appendMessage("system", `mode -> ${mode} (session reset)`);
          setStatus();
          return;
        }
        case "/goal": {
          if (!loop) {
            appendMessage("system", "/goal: run a task first");
            return;
          }
          const goal = value.split(/\s+/).slice(1).join(" ") || "complete the current task";
          const judgeModel =
            process.env.CHITA_JUDGE_MODEL ??
            (cfg.model === "deepseek-v4-pro" ? "deepseek-v4-flash" : "deepseek-v4-pro");
          // budget gate (v2.1 cost anchors): max 3/session + $10/month persisted
          // — singleton instance so the session counter survives across /goal calls
          if (!judgeBudget.canInvoke(2000, 0.3)) {
            appendMessage("system", "/goal: judge budget exhausted (max 3/session or $10/month)");
            return;
          }
          const judgeProvider = new OpenAICompatibleProvider({
            baseUrl: "https://api.deepseek.com/v1",
            apiKey: key!, // non-null: TUI exits if CHITA_API_KEY missing at start
            model: judgeModel,
          });
          appendMessage("system", `/goal: judging with ${judgeModel}...`);
          running = true; // judge is a long op — block re-entrancy (cur-038)
          startSpinner("judging", false); // pinned label: loop isn't running here
          try {
            const verdict = await runJudge(judgeProvider, loop.getConversation(), goal);
            judgeBudget.record(verdict.tokensUsed || 2000);
            appendMessage(
              "system",
              `/goal verdict: ${verdict.verdict} — ${verdict.reason}${verdict.evidence.length ? ` (evidence: ${verdict.evidence.join("; ")})` : ""}`
            );
          } catch (e) {
            appendMessage("system", `/goal failed: ${String(e)}`);
          } finally {
            running = false;
            stopSpinner();
          }
          return;
        }
        case "/tree": {
          const roots = buildSessionTree(process.cwd());
          if (roots.length === 0) {
            appendMessage("system", "no sessions yet");
            return;
          }
          const lines: string[] = [];
          const walk = (nodes: typeof roots, depth: number) => {
            for (const n of nodes) {
              lines.push("  ".repeat(depth) + `${n.sessionId}${n.branchSummary ? ` (${n.branchSummary})` : ""}`);
              walk(n.children, depth + 1);
            }
          };
          walk(roots, 0);
          appendMessage("system", "sessions:\n" + lines.join("\n"));
          return;
        }
        case "/resume": {
          let id = value.split(/\s+/)[1];
          let opened: Tape | undefined;
          if (!id) {
            // no id: resume the most recent session in this cwd (Leo-friendly)
            // — the scan hands back the held handle, adopted below
            const recent = openRecentSession(process.cwd(), (lockedId, pid) =>
              appendMessage("system", `${lockedNotice(lockedId, pid)} — skipped`)
            );
            if (!recent) {
              appendMessage("system", "no previous session in this directory — /resume <session-id>");
              return;
            }
            id = recent.id;
            opened = recent.tape;
          }
          if (adoptSession(id, opened)) {
            appendMessage("system", `resumed ${id}`);
          }
          return;
        }
        case "/fork": {
          if (!loop) {
            appendMessage("system", "no active session to fork");
            return;
          }
          const parentId = sessionId ?? `sess-${Date.now().toString(36)}`;
          const parent = Tape.open(process.cwd(), parentId);
          const childId = `fork-${Date.now().toString(36)}`;
          try {
            const child = forkWithSummary(parent, childId, "manual fork from TUI", {
              cwd: process.cwd(),
              model: cfg.model,
              provider: "openai-compatible",
              createdAt: new Date().toISOString(),
            });
            child.close();
            sessionId = parentId;
            appendMessage("system", `forked ${parentId} -> ${childId}`);
          } catch (e) {
            appendMessage("system", `fork failed: ${String(e)}`);
          } finally {
            parent.close(); // always balance the open above (cur-115 review #2)
          }
          return;
        }
        default:
          appendMessage("system", `unknown: ${cmd} (try /help)`);
          return;
      }
    }

    if (!loop) loop = buildLoop();

    if (!sessionId) {
      // bind a real tape session on first turn and hold it: /fork and /tree
      // need a real sessionId, not a timestamp placeholder (cur-038), and the
      // held handle is what keeps a second chita out of this session (cur-113)
      sessionId = `sess-${Date.now().toString(36)}`;
      activeTape = Tape.open(process.cwd(), sessionId);
      activeTape.appendMeta({
        sessionId,
        cwd: process.cwd(),
        model: cfg.model,
        provider: "openai-compatible",
        createdAt: new Date().toISOString(),
      });
    }
    // append the user turn through the held handle (one writer per session)
    activeTape?.append({ type: "message", role: "user", content: value } as never);
    // (assistant + tool events are persisted via tapeAppend in the hooks)

    // per-turn AbortController (cur-036: one-shot signal pollutes the loop)
    const turnCancel = new AbortController();
    cancelCurrent = () => turnCancel.abort();
    loop.setSignal(turnCancel.signal);

    running = true;
    appendMessage("user", value);
    startSpinner("thinking");
    streamedThisTurn = false; // reset per-turn (cur-056)
    streamingBuffer = ""; // defensive: never carry over from a prior turn

    // Set when the turn was aborted (Esc/Ctrl+C). An aborted turn must NOT
    // fire the queued follow-ups at the context the user just rejected; the
    // queue is returned to the editor instead. Normal completion drains it.
    let cancelled = false;
    try {
      const result = await loop.continue(value); // multi-turn
      tokensUsed = loop.getTokensUsed(); // real usage from provider (cur-045)
      if (result.state === "CANCELLED") {
        cancelled = true;
        appendMessage("system", "cancelled");
      } else if (result.state === "ERROR" && result.error) {
        appendMessage("system", `error: ${friendlyError(result.error).slice(0, 160)}`);
      }
      // summary already streamed via onAssistantMessage; no duplicate append
      // (cur-036 minor: streamed text vs summary could double-show)
    } catch (e) {
      const aborted = e instanceof Error && e.name === "AbortError";
      if (aborted) cancelled = true;
      appendMessage("system", aborted ? "cancelled" : friendlyError(String(e)));
    } finally {
      endStreaming();
      running = false;
      cancelCurrent = null;
      stopSpinner();
      // Hardening (review): a cancel can race a provider-side failure, so trust
      // the abort signal itself, not only the CANCELLED/AbortError classification.
      if (turnCancel.signal.aborted) cancelled = true;
      if (pendingInputs.length > 0) {
        if (cancelled) {
          const n = restorePendingInputs();
          appendMessage("system", `↩ ${n} queued message${n > 1 ? "s" : ""} returned to input`);
        } else {
          // normal end: drain the FIFO one message per turn
          const next = pendingInputs.shift()!;
          void handleTurn(next);
        }
      }
    }
  }

  /** Resume a session tape into a fresh loop (shared by /resume and startup
   *  auto-resume; Leo: default should continue the last session). `opened` is
   *  a handle the caller already holds (startup scan) — never re-acquired, and
   *  released here if the resume fails (cur-114 review #1). */
  function adoptSession(id: string, opened?: Tape): boolean {
    let tape: Tape | null = opened ?? null;
    try {
      tape ??= Tape.tryOpen(process.cwd(), id);
      if (!tape) {
        appendMessage("system", `${lockedNotice(id, Tape.holderPid(process.cwd(), id))} — not switching`);
        return false;
      }
      const events = tape.readAll();
      // rebuild the OpenAI message shape (assistant declarations + paired tool
      // results) from the flat event stream: the tape keeps calls and results
      // in append order, which is not conversation order (cur-109/110)
      const next = buildLoop();
      next.seedConversation(historyFromEvents(events));
      // restore cumulative usage from persisted snapshots (Leo: restart 0).
      // Snapshots are CUMULATIVE (endStreaming writes running totals), so
      // take the LAST one — summing re-inflates (cur-054 major:
      // turn1=100,turn2=250 would sum to 350).
      const usage = events
        .filter((e): e is Extract<TraceEvent, { type: "usage" }> => e.type === "usage")
        .pop() ?? { total: 0, input: 0, output: 0 };
      next.restoreTokens({ total: usage.total, input: usage.input, output: usage.output });
      if (tape === activeTape) {
        // adopted the session already held (e.g. /resume landing on it again):
        // drop the extra ref, or a later /new would leave the lock behind
        // and keep other chita instances out (cur-115 review #1)
        tape.close();
      } else if (activeTape) {
        activeTape.close(); // release the previous session
      }
      activeTape = tape;
      loop = next;
      sessionId = id;
      tokensUsed = next.getTokensUsed(); // TUI copy must match (Leo: resume 0)
      setStatus();
      return true;
    } catch (e) {
      appendMessage("system", `resume failed: ${String(e)}`);
      tape?.close();
      return false;
    }
  }

  input.onSubmit = (value) => void onSubmit(value);

  // Ctrl+C: cancel current turn (first), exit (second) — cur-033 #1.
  // Handle BOTH paths: raw-mode byte (\u0003 via input listener) and the
  // SIGINT signal (some terminals/PTYs deliver Ctrl+C as a signal even in
  // raw mode; Leo: neither worked). Shared handler keeps semantics identical.
  let ctrlCPressed = false;
  /** Abort the running turn and deny a pending approval. Shared by Ctrl+C and
   *  Esc so both cancel identically; the queue is returned to the editor by
   *  handleTurn's finally. Returns false when nothing is cancellable. */
  const cancelTurn = (): boolean => {
    if (!running || !cancelCurrent) return false;
    // M-next WAITING_USER: cancel also resolves a pending approval as deny —
    // otherwise the loop would sit on the 5-min timeout after a cancel.
    if (approvalWaiter) {
      const w = approvalWaiter;
      approvalWaiter = null;
      appendMessage("system", `✗ cancelled ${w.toolName} approval`);
      w.resolve(false);
    }
    cancelCurrent();
    return true;
  };
  const handleCtrlC = () => {
    // Running: first press cancels the turn AND arms exit — the next press
    // (within 2s) exits unconditionally. Previously ctrlCPressed was reset
    // here, so a second Ctrl+C while still running re-cancelled forever
    // (user report: 'Ctrl+C cannot exit' during a turn).
    if (!ctrlCPressed && cancelTurn()) {
      ctrlCPressed = true;
      setTimeout(() => (ctrlCPressed = false), 2000);
      return;
    }
    // Idle single press, or any second press: exit.
    tui.stop();
    process.exit(0);
  };
  // Ctrl+C arrives as \u0003 (classic raw mode) OR as a kitty keyboard
  // protocol sequence from iTerm2/kitty: ESC[99;5u (key 99='c', modifier
  // 5/6 = Ctrl). Real-terminal diagnosis (Leo): iTerm2 sent \x1b[99;5u,
  // never \u0003, so byte-only matching never fired. SIGINT also never
  // fires (raw mode disables ISIG). Match both encodings.
  const KITTY_CTRL_C = /^\x1b\[99[:;]\d*[:;]?[456]/; // 99 + mod bit 4 (Ctrl)
  tui.addInputListener((data) => {
    if (data === "\u0003" || KITTY_CTRL_C.test(data)) {
      handleCtrlC();
      return { consume: true };
    }
    // Esc = cancel the running turn (pi/Codex). Don't steal it while the
    // autocomplete menu is open — there the editor uses Esc to close the menu.
    if (running && cancelCurrent && !input.isShowingAutocomplete() && matchesKey(data, "escape")) {
      cancelTurn();
      return { consume: true };
    }
    // Alt+Up = take back the queue without cancelling (Codex edit_queued_message)
    if (running && pendingInputs.length > 0 && matchesKey(data, "alt+up")) {
      const n = restorePendingInputs();
      appendMessage("system", `↩ ${n} queued message${n > 1 ? "s" : ""} returned to input`);
      return { consume: true };
    }
  });
  process.on("SIGINT", () => handleCtrlC());

  tui.start();

  // Startup banner (user report: missing in the TUI) — plain Text, NOT Markdown:
  // the ASCII art (\\ _ | `) would be mangled by the md parser (rendered as garbage).
  const bannerText = new Text(renderBanner({ version: VERSION, model: cfg.model, cwd: process.cwd() }), 1, 0);
  messagesBox.addChild(bannerText);
  trimMessages();

  // Startup: default = continue the most recent session in this cwd
  // (Leo: opaque ids + manual resume were unfriendly). /new starts fresh.
  const recent = openRecentSession(process.cwd(), (id, pid) =>
    appendMessage("system", `${lockedNotice(id, pid)} — skipped; typing starts a new session`)
  );
  if (recent) {
    const when = recent.age ? ` (${recent.age})` : "";
    if (adoptSession(recent.id, recent.tape)) {
      appendMessage("system", `resumed last session ${recent.id}${when} — topic: "${recent.first}"`);
      appendMessage("system", `/new for a fresh session, or keep typing`);
    }
  }
}
