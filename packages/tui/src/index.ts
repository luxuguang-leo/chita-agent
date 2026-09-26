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
import { loadConfig, apiKey, budgetTokensFor, compactCeilingFor } from "../../cli/src/config.ts";
import { renderBanner } from "../../cli/src/banner.ts";
import { VERSION } from "../../cli/src/index.ts";
import {
  KeybindingsManager,
  setKeybindings,
  TUI_KEYBINDINGS,
} from "../vendor/keybindings.ts";
import { matchesKey } from "../vendor/keys.ts";
import { buildSessionTree, forkWithSummary, summarizeTopic, readSessionMeta } from "../../session/src/session-tree.ts";
import { Tape, cwdKey, SESSIONS_ROOT } from "../../session/src/tape.ts";
import type { TraceEvent } from "../../session/src/trace.ts";
import { estimateTokens } from "../../agent/src/context.ts";
import { historyFromEvents } from "../../agent/src/history.ts";
import { mergeQueuedIntoDraft } from "./queue.ts";
import { isBannerCmd, formatApprovalCommand, tailWindow, briefCmd, cmdPreview } from "./display.ts";
import { visibleWidth, wrapTextWithAnsi } from "../vendor/utils.ts";
import type { Component } from "../vendor/tui.ts";

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
  /** Resume this specific session at startup instead of the most recent
   *  (chita --resume <id>). */
  resumeId?: string;
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
  /** Input tokens billed THIS turn (Δ since the turn started) — the status bar
   *  shows it as ↑N(ΔM) so per-turn burn is visible, not just the cumulative
   *  total (cur-xxx: a growing session re-sends history every turn; the Δ is
   *  what tells you how much THIS step cost). */
  let turnInputDelta = 0;
  /** True once ANY turn activity is observed (tool_call/tool_result/etc.).
   *  Separated from streamedThisTurn so a pure tool-call turn (no streamed
   *  text) still snapshots usage on endStreaming (cur-xxx). */
  let turnHadActivity = false;
  let running = false; // re-entrancy lock (cur-033 #6)
  let cancelCurrent: (() => void) | null = null;
  let pendingInputs: string[] = []; // FIFO queue while running (cur-038)
  // M-next WAITING_USER: pending permission approval — the loop suspends until
  // the next input line resolves it (allow/deny/timeout). Non-null only while
  // the loop awaits onPermissionRequest.
  let approvalWaiter: { resolve: (allow: boolean) => void; toolName: string; reason: string } | null = null;
  // 本次会话放行白名单（按 guardian reason）：弹窗选「本次会话放行」后，
  // 同 reason 的危险操作不再弹窗，直接放行（参考 hermes 的 "Allow this
  // session"）。进程级，不跨会话持久化。
  const sessionAllow = new Set<string>();

  // --- cur-058 spinner state (waiting indicator) ---
  const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  const SPINNER_INTERVAL_MS = 120;
  /** Live stdout tail line cap for the running-tool row (P1 streaming). */
  const MAX_TAIL_LINES = 8;
  /** Total char cap for the live tail (cursor finding #1: a single huge line
   *  must not bloat the 120ms setText). */
  const MAX_TAIL_CHARS = 4096;
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
  /** Live stdout tail for the running-tool row (P1 streaming): capped to the
   *  last MAX_TAIL_LINES lines, ANSI-sanitized. Filled by onToolOutput,
   *  rendered by the 120ms spinner tick — never requestRender'd directly. */
  let runningTailBuf = "";
  // --- cur-xxx 卡死检测: rolling window of the last tool results — ≥3 failures
  // in 6 calls warns the user (a stuck agent re-tries failing probe scripts
  // interleaved with trivial oks, so a bare "3 consecutive" never fires).
  const TOOL_FAIL_WINDOW = 6;
  const TOOL_FAIL_THRESHOLD = 3;
  let toolWindow: boolean[] = [];
  let failureWarned = false;
  // TUI-level judge budget singleton (cur-040 major: per-invocation instance
  // reset the max-3-per-session counter every /goal)
  const judgeBudget = new JudgeBudget({});
  // last tool results per name (for /tool <name> full expansion, cur-042)
  const toolResults = new Map<string, { ok: boolean; output?: string; error?: string }>();
  const lastToolCmd = new Map<string, string>(); // callId -> command (omp-style pairing)
  const toolStartTs = new Map<string, number>(); // callId -> start ts（✓/✗ 耗时）
  /** recon 读操作：成功时静默（不追加结果行），只保留运行瞬间的 spinner。
   *  read/ls/grep/glob 在 recon 时刷屏是 tool 噪音的主要来源（用户反馈）。 */
  const EXPLORATORY_TOOLS = new Set(["read", "ls", "grep", "glob"]);
  let bannerCount = 0; // consecutive decorative echo banners (folded)
  /** Pending assistant message being streamed (updated in place, not new rows) */
  let streamingText: Markdown | null = null;
  /** 消息流里的动态活动占位行（thinking/running…）：模型思考或工具执行时，
   *  消息流不再静止——用户反馈「少了实时滚动，以为卡住」。首 token 出来后移除。 */
  let activityLine: Markdown | null = null;
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

  /** 授权弹窗面板（参考 hermes approval overlay）：独立覆盖层 + 手绘边框，
   *  完整命令换行展示，↑/↓/数字选择。不会被消息流冲掉。 */
  class ApprovalPanel implements Component {
    private sel = 0;
    private readonly opts = ["放行一次", "本次会话放行", "拒绝"] as const;
    onPick: ((choice: "once" | "session" | "deny") => void) | null = null;
    onCancel: (() => void) | null = null;

    constructor(
      private readonly command: string,
      private readonly label: string,
      private readonly why: string,
    ) {}

    private line(inner: number, content: string): string {
      const vis = visibleWidth(content);
      const pad = Math.max(0, inner - vis);
      return content + " ".repeat(pad);
    }

    render(width: number): string[] {
      const w = Math.max(36, Math.min(width - 6, 92));
      const inner = w - 2;
      const hr = "─".repeat(inner);
      const out: string[] = [];
      out.push(yellow(`╭${hr}╮`));
      out.push(yellow("│") + this.line(inner, brightWhite(` ⚠ 需要授权 · ${this.label}`)) + yellow("│"));
      if (this.why) out.push(yellow("│") + this.line(inner, gray(` ${this.why}`)) + yellow("│"));
      out.push(yellow("│") + this.line(inner, "") + yellow("│"));
      for (const cl of wrapTextWithAnsi(this.command, inner - 2)) {
        out.push(yellow("│") + this.line(inner, ` ${cl}`) + yellow("│"));
      }
      out.push(yellow("│") + this.line(inner, "") + yellow("│"));
      this.opts.forEach((o, i) => {
        const marker = i === this.sel ? "▸ " : "  ";
        const text = `${marker}${i + 1}. ${o}`;
        out.push(yellow("│") + this.line(inner, i === this.sel ? brightWhite(text) : gray(text)) + yellow("│"));
      });
      out.push(yellow("│") + this.line(inner, "") + yellow("│"));
      out.push(yellow("│") + this.line(inner, dim(" ↑/↓ 选择 · Enter 确认 · 1-3 快速 · Esc/Ctrl+C 拒绝")) + yellow("│"));
      out.push(yellow(`╰${hr}╯`));
      return out;
    }

    handleInput(data: string): void {
      if (matchesKey(data, "up")) {
        this.sel = (this.sel + this.opts.length - 1) % this.opts.length;
        tui.requestRender();
        return;
      }
      if (matchesKey(data, "down")) {
        this.sel = (this.sel + 1) % this.opts.length;
        tui.requestRender();
        return;
      }
      if (matchesKey(data, "escape")) {
        this.onCancel?.();
        return;
      }
      if (matchesKey(data, "enter") || matchesKey(data, "return")) {
        this.onPick?.((["once", "session", "deny"] as const)[this.sel]);
        return;
      }
      if (data === "1" || data === "2" || data === "3") {
        this.onPick?.((["once", "session", "deny"] as const)[Number(data) - 1]);
      }
    }

    invalidate(): void {
      // stateless render each frame — nothing to cache
    }
  }

  function appendMessage(role: string, content: string): void {
    const color = ROLE_COLOR[role] ?? ((s: string) => s);
    // role prefix: color only (no ** bold — that would double-wrap via
    // theme.bold around the ANSI codes, cur-040 minor)
    if (role === "tool") {
      // tool activity -> dedicated scrolling strip, not the chat (Leo).
      // dim（不是 brightWhite）：tool 行视觉退后，assistant 文本才是焦点
      // （pi/omp 的 dimToolResults，hermes 的折叠 thinking 区同理）。
      toolBox.addChild(new Markdown(`${color(role)}: ${content}`, 0, 0, mdTheme, { color: dim }));
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
          runningTailBuf = "";
        }
        toolBox.removeChild(oldest);
      }
    }
  }

  /** Streaming: accumulate into one row, update in place (cur-033 #3 refinement) */
  function appendStreamed(content: string): void {
    streamingBuffer += content;
    if (!streamingText) {
      // 首 token 出来：移除活动占位行（thinking spinner），换成真实流式文本
      if (activityLine) {
        if (messagesBox.children.includes(activityLine)) messagesBox.removeChild(activityLine);
        activityLine = null;
      }
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
      // persist usage FIRST even when no text streamed this turn — a pure
      // tool-call turn must still snapshot the counter for /resume (cur-xxx:
      // the old early-return dropped it). Only skip when the provider never
      // ran at all (no event) — that's the cur-056 stale-write guard.
      if (loop && turnHadActivity) {
        const u = loop.getTokensUsed();
        tapeAppend({ type: "usage", total: u.total, input: u.input, output: u.output });
      }
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
    // ctx% is relative to the model's HARD context window (1M for DeepSeek) —
    // that is the real ceiling the provider enforces. Compaction still fires
    // at 0.9×soft ceiling (compactCeilingFor) long before, but the % should
    // answer "how full is the actual context", not "how close to compaction".
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
    const delta = turnInputDelta > 0 ? `(Δ${fmtTokens(turnInputDelta)})` : "";
    statusText.setText(
      `session: ${sid} | mode: ${mode} | model: ${cfg.model} | ` +
        `↑${fmtTokens(tokensUsed.input)}${delta} ↓${fmtTokens(tokensUsed.output)} | ctx ${fmtTokens(cur)}/${fmtTokens(ctx)} (${pct}%)${suffix}`
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
    if (st === "WAITING_USER") return "awaiting approval · ↑/↓ 选择";
    return "thinking";
  }

  /** Append a live stdout chunk to the running-tool tail (P1 streaming).
   *  Capped to the last MAX_TAIL_LINES lines; the 120ms spinner tick renders
   *  it — this never calls requestRender (finding #6 throttle). */
  function pushTail(chunk: string): void {
    runningTailBuf = tailWindow(runningTailBuf, chunk, MAX_TAIL_LINES, MAX_TAIL_CHARS);
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
    // 消息流里的活动占位行：模型思考（首 token 前）或读结果时，在消息流底部
    // 显示动态 spinner，否则用户看到静止界面会以为卡住（cur-xxx）。TOOL_CALL
    // 时 runningToolLine 已在工具条显示，跳过以避免重复（cursor Finding #1）。
    if (!streamingText && !runningToolLine) {
      const label = spinnerLabel || "thinking";
      const text = `${frame} ${label} (${elapsed}s)`;
      if (!activityLine) {
        activityLine = new Markdown(text, 0, 0, mdTheme, { color: dim });
        messagesBox.addChild(activityLine);
      } else {
        activityLine.setText(text);
      }
      trimMessages();
    }
    if (runningToolLine) {
      // P1 streaming: rebuild the row as `[name] ⠋ cmd` + the live tail so the
      // 120ms spinner tick doesn't overwrite streamed stdout (finding #2)
      const tail = runningTailBuf ? `\n${runningTailBuf}` : "";
      // heartbeat (cur-xxx): show elapsed + a longer command so the user can
      // tell WHAT is running, not just "running bash (23s)" with no target
      runningToolLine.setText(`[${runningToolName}] ${frame} (${elapsed}s) ${runningToolCmd}${tail}`);
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
    runningTailBuf = "";
    spinnerLabel = "";
    spinnerTrackState = true;
    if (activityLine) {
      if (messagesBox.children.includes(activityLine)) messagesBox.removeChild(activityLine);
      activityLine = null;
    }
    tui.requestRender();
  }

  /** Loop-side approval timeout (ms). Single source of truth shared by the
   *  AgentLoop (permissionTimeoutMs) and the TUI waiter — the waiter must
   *  expire in step with the loop so a stale input line after a loop-side
   *  timeout falls through to the model instead of being eaten as an
   *  approval decision (F3). */
  const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

  /** 卡死检测 (cur-xxx): rolling window of the last TOOL_FAIL_WINDOW tool
   *  results. ≥TOOL_FAIL_THRESHOLD failures warns once — a stuck agent
   *  re-tries failing probe scripts interleaved with trivial oks, so a bare
   *  "3 consecutive failures" never fires. Reset when the window clears. */
  function noteToolResult(ok: boolean): void {
    toolWindow.push(ok);
    if (toolWindow.length > TOOL_FAIL_WINDOW) toolWindow.shift();
    const failures = toolWindow.filter((o) => !o).length;
    if (failures >= TOOL_FAIL_THRESHOLD && !failureWarned) {
      failureWarned = true;
      appendMessage("system", `⚠ 最近 ${toolWindow.length} 个工具调用 ${failures} 个失败 — 可能卡住，Ctrl+C 中断`);
    } else if (failures < TOOL_FAIL_THRESHOLD) {
      failureWarned = false;
    }
  }

  function buildLoop(): AgentLoop {
    return new AgentLoop({
      cwd: process.cwd(),
      provider: makeProvider(),
      mode,
      maxTokens: budgetTokensFor(cfg), // per-run spend fuse, decoupled from contextWindow (cur-057/058)
      contextMaxTokens: compactCeilingFor(cfg), // soft compaction ceiling, NOT the 1M hard window (cur-xxx)
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
          // 本次会话已放行同类风险操作 → 直接放行，不再弹窗（参考 hermes
          // "Allow this session"，按 guardian reason 粒度）。
          if (sessionAllow.has(reason)) return Promise.resolve(true);
          const m = reason.match(/^guardian\[(\w+)\]:\s*(.*)$/);
          const label = m ? categoryLabel(m[1] as GuardianCategory) : "风险操作";
          const why = m ? m[2] : reason;
          // 参考 hermes approval overlay：独立覆盖层 + 完整命令 + ↑/↓/数字
          // 选择，不会被消息流冲掉。Esc/Ctrl+C 走全局 cancelTurn → deny。
          const panel = new ApprovalPanel(formatApprovalCommand(cmd), label, why);
          const overlay = tui.showOverlay(panel, { anchor: "center", maxHeight: "80%" });
          return new Promise<boolean>((resolve) => {
            let settled = false;
            const finish = (allow: boolean) => {
              if (settled) return; // F3: ignore late resolves after timeout/Ctrl+C
              settled = true;
              overlay.hide();
              if (approvalWaiter?.toolName === toolName) approvalWaiter = null;
              resolve(allow);
            };
            panel.onPick = (choice) => {
              if (choice === "session") sessionAllow.add(reason);
              finish(choice !== "deny");
            };
            panel.onCancel = () => finish(false);
            approvalWaiter = { resolve: finish, toolName, reason };
            // No waiter-side timeout: the loop owns the approval timeout
            // (Promise.race in runTool). A duplicate 5-min timer here fired
            // first and resolved the decision as `false`, so a genuine timeout
            // was mislabeled "denied by user". The waiter is cleared when the
            // loop emits the tool_result (timeout or not) instead.
          });
        },
        afterToolCall: (_n, result) => {
          if (result.output) {
            const scrubbed = scrubSecrets(result.output);
            return { ok: result.ok, output: scrubbed.text, redacted: scrubbed.redacted };
          }
        },
        // P1 live output: pipe streamed stdout into the running-tool row's
        // tail. Throttled — only writes the buffer; the 120ms spinner tick
        // (updateActivity) does the actual render (finding #6). Never
        // persisted: the tape records only the final tool_result.
        onToolOutput: (chunk) => {
          if (runningToolLine && chunk.toolName === runningToolName) {
            pushTail(chunk.chunk);
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
          turnHadActivity = true; // any tool/truncate/error event = real activity (cur-xxx)
  /** Brief command for the tool line: strip redirection/noise, keep the first
   *  80 chars (fold the tail). 'ls -la ~/.agents 2>/dev/null; echo ---' ->
   *  'ls -la ~/.agents'. The old 2-word cut ('sed -n 1,60p file' -> 'sed -n…')
   *  lost the target and made the running-tool row useless (cur-xxx: "卡住
   *  不知道在干啥"). Full command stays in /tool. */
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

  /** Minimal tool line (omp style): command + first meaningful argument —
   *  'curl -s https://api…' -> 'curl https://api…'; 'ls -lat ~/x/' ->
   *  'ls ~/x/'; line count only when >3 lines. Full command/output via
   *  /tool. (Leo: bare first word ('curl') lost the target.) */
  function toolLine(cmd: string, toolName: string, output: string): string {
    if (cmd) {
      return cmdPreview(briefCmd(cmd)); // 复合命令分段 / 单长命令头尾（不报行数，行数是噪音）
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
            toolStartTs.set(ev.callId ?? ev.tool?.name ?? "", Date.now());
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
            // M-next WAITING_USER: a pending approval resolves to a tool_result
            // (allow executed, deny/timeout recorded). Resolve the waiter as
            // deny — finish() has a settled guard, so it is a no-op when the
            // user already answered — which also clears it so a later input
            // line is NOT swallowed as a stale decision (F3).
            if (approvalWaiter && approvalWaiter.toolName === ev.toolName) {
              approvalWaiter.resolve(false);
            }
            // the running indicator row is replaced by the result row (cur-058)
            if (runningToolLine) {
              if (toolBox.children.includes(runningToolLine)) toolBox.removeChild(runningToolLine);
              runningToolLine = null;
              runningToolCmd = "";
              runningToolName = "";
              runningTailBuf = "";
            }
            // Show real content, not bare "ok" (Leo: [bash] ok ×5 is noise).
            // Success -> condensed summary (decorations skipped, titles
            // extracted, long output annotated); failure -> error detail.
            const cmd = lastToolCmd.get(ev.callId ?? ev.toolName) ?? "";
            const startTs = toolStartTs.get(ev.callId ?? ev.toolName);
            toolStartTs.delete(ev.callId ?? ev.toolName);
            const took = startTs !== undefined ? ` (${((Date.now() - startTs) / 1000).toFixed(1)}s)` : "";
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
              // 探索类工具成功时静默：recon 的 read/ls 刷屏是主要噪音源。
              // 失败仍显示（失败重要，可能卡死循环）。
              const quiet = ev.ok && EXPLORATORY_TOOLS.has(ev.toolName);
              if (!quiet) {
                detail = ev.ok
                  ? `${toolLine(cmd, ev.toolName, ev.output ?? "")}${took} ✓`
                  : `✗ ${cmdPreview(briefCmd(cmd)) || ev.toolName} — ${ev.error?.slice(0, 80) ?? "unknown"}${took}`;
                appendMessage("tool", `[${ev.toolName}] ${detail}`);
              }
            }
            // remember full result for /tool expansion (cur-042)
            toolResults.set(ev.toolName, { ok: ev.ok, output: ev.output, error: ev.error });
            noteToolResult(ev.ok);
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
    // M-next WAITING_USER: while the loop awaits permission, the next line is
    // the decision — allow/yes/approve grants, anything else (including an
    // empty Enter) denies (cur-xxx: Enter defaults to deny). Do NOT route it
    // to the model (the loop is suspended mid-tool).
    if (approvalWaiter) {
      const w = approvalWaiter;
      approvalWaiter = null;
      const allow = /^(allow|yes|y|approve|ok)$/i.test(value);
      appendMessage("system", allow ? `✓ allowed ${w.toolName} (${w.reason})` : `✗ denied ${w.toolName} (${w.reason})`);
      w.resolve(allow);
      return;
    }
    if (!value) return;
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
        // first user message = the session topic (for the resume picker)
        topic: summarizeTopic(value),
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
    turnInputDelta = 0; // reset per-turn Δ until the turn's usage lands (cur-xxx)
    turnHadActivity = false; // reset per-turn activity flag (cur-xxx)

    // Set when the turn was aborted (Esc/Ctrl+C). An aborted turn must NOT
    // fire the queued follow-ups at the context the user just rejected; the
    // queue is returned to the editor instead. Normal completion drains it.
    let cancelled = false;
    try {
      const turnStartInput = tokensUsed.input; // Δ baseline for the status bar (cur-xxx)
      const result = await loop.continue(value); // multi-turn
      tokensUsed = loop.getTokensUsed(); // real usage from provider (cur-045)
      turnInputDelta = Math.max(0, tokensUsed.input - turnStartInput);
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
      // A missing session must never be silently created: Tape.tryOpen opens
      // with "a+", which would write an empty tape and pollute the picker.
      // Guard existence before opening (cursor finding #1); `opened` (startup
      // scan) is already known to exist.
      if (!tape && !readSessionMeta(process.cwd(), id)) {
        appendMessage("system", `session ${id} not found`);
        return false;
      }
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
  /** 拒绝当前授权弹窗（只 deny，不取消回合）。Esc 用它，与面板选项「拒绝」
   *  语义一致（cursor Finding #1：Esc 不该 abort 整个 turn）。Ctrl+C 仍走
   *  cancelTurn（deny + 取消回合）。 */
  const denyApproval = (): void => {
    if (!approvalWaiter) return;
    const w = approvalWaiter;
    approvalWaiter = null;
    w.resolve(false); // finish() 里会 overlay.hide() + resolve(false)
  };
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
    // While an approval overlay is up, Esc only DENIES (does not abort the
    // turn) — matches the panel's "Esc 拒绝" label (cursor Finding #1).
    if (running && cancelCurrent && !input.isShowingAutocomplete() && matchesKey(data, "escape")) {
      if (approvalWaiter) denyApproval();
      else cancelTurn();
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

  // Startup: chita --resume <id> resumes a SPECIFIC session; otherwise the
  // default continues the most recent session in this cwd (Leo: opaque ids +
  // manual resume were unfriendly). /new starts fresh.
  if (opts.resumeId) {
    // adopt directly — on failure (locked/missing) stay on a fresh session and
    // say so; do NOT silently fall back to the most-recent (cursor finding #2).
    const ok = adoptSession(opts.resumeId);
    if (!ok) appendMessage("system", `could not resume ${opts.resumeId} — starting a fresh session (/new to reset)`);
  } else {
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
}
