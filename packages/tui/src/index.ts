/**
 * chita TUI (T1, cur-033 gaps addressed)
 *
 * Three-region layout: message area (ScrollView) + input line (Input) +
 * status bar. Multi-turn via AgentLoop.continue(). Slash commands local.
 *
 * cur-033 fixes:
 * - assistant streaming rendered via onAssistantMessage hook
 * - Ctrl+C cancels current turn (AbortController via loop signal)
 * - onSubmit re-entrancy lock (no stacked runs on rapid Enter)
 * - /mode rebuilds the loop with the new mode
 */

import { TuiMainScreen } from "../vendor/tui-main-screen.ts";
import { ProcessTerminal } from "../vendor/terminal.ts";
import { existsSync, readdirSync, statSync, appendFileSync } from "node:fs";
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
import { runJudge } from "../../agent/src/judge.ts";
import { JudgeBudget } from "../../agent/src/judge.ts";
import { OpenAICompatibleProvider } from "../../ai/src/index.ts";
import { scrubSecrets } from "../../agent/src/scrub.ts";
import { loadConfig, apiKey } from "../../cli/src/config.ts";
import {
  KeybindingsManager,
  setKeybindings,
  TUI_KEYBINDINGS,
} from "../vendor/keybindings.ts";
import { buildSessionTree, forkWithSummary } from "../../session/src/session-tree.ts";
import { Tape, cwdKey, SESSIONS_ROOT } from "../../session/src/tape.ts";
import type { TraceEvent } from "../../session/src/trace.ts";
import { estimateTokens } from "../../agent/src/context.ts";

/** Describe the most recent session in this cwd: id + first user message +
 *  age. Returns null when none. Used for the startup hint and /resume
 *  without an id (Leo: opaque random ids are unfriendly). */
function recentSessionSummary(cwd: string): { id: string; first: string; age: string } | null {
  try {
    const dir = join(SESSIONS_ROOT, cwdKey(cwd));
    if (!existsSync(dir)) return null;
    const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    if (files.length === 0) return null;
    // newest first by mtime
    files.sort((a, b) => statSync(join(dir, b)).mtimeMs - statSync(join(dir, a)).mtimeMs);
    for (const f of files) {
      const id = f.replace(/\.jsonl$/, "");
      const tape = Tape.open(cwd, id);
      const events = tape.readAll();
      const created = tape.readMeta()?.createdAt;
      tape.close();
      if (events.length === 0) continue;
      const firstUser = events.find(
        (e): e is Extract<TraceEvent, { type: "message" }> => e.type === "message" && e.role === "user"
      );
      const first = (firstUser?.content ?? "").replace(/\s+/g, " ").trim();
      if (!first) continue;
      const age = created ? ageLabel(created) : "";
      return { id, first: first.slice(0, 40), age };
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
    "session: new | mode: build | model: " + cfg.model + ` | ↑0 ↓0 | 会话 0/${cfg.contextWindow ?? 131_072} (0%)`,
    0,
    0
  );

  const root = new VStack([
    { component: messageScroll, grow: 1 },
    { component: input },
    { component: new HStack([{ component: statusText }]) },
  ]);
  tui.addChild(root);
  tui.setFocus(input);

  // --- session state ---
  let loop: AgentLoop | null = null;
  let sessionId: string | null = null; // bound to the active tape session

  // persist a trace event to the session tape (cur-042: all turns, not just user)
  const tapeAppend = (ev: unknown) => {
    if (!sessionId) return;
    try {
      const tape = Tape.open(process.cwd(), sessionId);
      tape.append(ev as never);
      tape.close();
    } catch {
      // tape write is best-effort; never break the turn for it
    }
  };
  let mode: "build" | "plan" = "build";
  let tokensUsed: { total: number; input: number; output: number } = { total: 0, input: 0, output: 0 };
  let running = false; // re-entrancy lock (cur-033 #6)
  let cancelCurrent: (() => void) | null = null;
  let pendingInputs: string[] = []; // FIFO queue while running (cur-038)
  // TUI-level judge budget singleton (cur-040 major: per-invocation instance
  // reset the max-3-per-session counter every /goal)
  const judgeBudget = new JudgeBudget({});
  // last tool results per name (for /tool <name> full expansion, cur-042)
  const toolResults = new Map<string, { ok: boolean; output?: string; error?: string }>();
  const lastToolCmd = new Map<string, string>(); // callId -> command (omp-style pairing)
  /** Pending assistant message being streamed (updated in place, not new rows) */
  let streamingText: Markdown | null = null;
  let streamingBuffer = "";

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
    messagesBox.addChild(new Markdown(`${color(role)}: ${content}`, 0, 0, mdTheme, { color: brightWhite }));
    trimMessages();
    tui.requestRender(true);
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
    tui.requestRender(true);
  }

  function endStreaming(): void {
    // persist the complete assistant message ONCE (cur-043 major: per-fragment
    // tape writes polluted sessions; write the full buffer at turn end)
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
        `↑${tokensUsed.input} ↓${tokensUsed.output} | 会话 ${cur}/${ctx} (${pct}%)${suffix}`
    );
    tui.requestRender(true);
  }

  function buildLoop(): AgentLoop {
    return new AgentLoop({
      cwd: process.cwd(),
      provider: makeProvider(),
      mode,
      autoApproveAsk: true,
      hooks: {
        beforeToolCall: async () => true,
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
          appendStreamed(msg.content);
        },
        onEvent: (ev) => {
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
    const suffix = lines.length > 3 ? ` · ${lines.length} 行` : "";
    return pick.slice(0, 60) + suffix;
  }

          if (ev.type === "tool_call") {
            // remember the command/args — shown next to the result (omp style)
            const a = (ev.tool?.args ?? {}) as Record<string, unknown>;
            const cmd = typeof a.command === "string" ? a.command
              : typeof a.path === "string" ? a.path
              : typeof a.pattern === "string" ? a.pattern
              : "";
            lastToolCmd.set(ev.callId ?? ev.tool?.name ?? "", cmd);
            return;
          }
          if (ev.type === "tool_result") {
            // Show real content, not bare "ok" (Leo: [bash] ok ×5 is noise).
            // Success -> condensed summary (decorations skipped, titles
            // extracted, long output annotated); failure -> error detail.
            let detail: string;
            if (ev.ok) {
              const cmd = lastToolCmd.get(ev.callId ?? ev.toolName) ?? "";
              detail = cmd ? `\`${cmd.slice(0, 50)}\`` : toolSummary(ev.toolName, ev.output ?? "");
            } else {
              detail = `error: ${ev.error?.slice(0, 80) ?? "unknown"}`;
            }
            appendMessage("tool", `[${ev.toolName}] ${detail}`);
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
    // record non-slash task prompts in editor history (↑↓ navigation)
    if (!value.startsWith("/")) input.addToHistory(value);
    if (running) {
      // FIFO queue for replay after the current turn (don't drop input)
      pendingInputs.push(value);
      return;
    }
    await handleTurn(value);
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
          toolResults.clear(); // no stale /tool output (cur-043 nit)
          pendingInputs = []; // drop queued inputs from old session (cur-043 nit)
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
          setStatus(" | judging...");
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
            setStatus();
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
          if (!id) {
            // no id: resume the most recent session in this cwd (Leo-friendly)
            const recent = recentSessionSummary(process.cwd());
            if (!recent) {
              appendMessage("system", "no previous session in this directory — /resume <session-id>");
              return;
            }
            id = recent.id;
          }
          if (resumeSession(id)) {
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
          const child = forkWithSummary(parent, childId, "manual fork from TUI", {
            cwd: process.cwd(),
            model: cfg.model,
            provider: "openai-compatible",
            createdAt: new Date().toISOString(),
          });
          parent.close();
          child.close();
          sessionId = parentId;
          appendMessage("system", `forked ${parentId} -> ${childId}`);
          return;
        }
        default:
          appendMessage("system", `unknown: ${cmd} (try /help)`);
          return;
      }
    }

    if (!loop) loop = buildLoop();

    // bind a real tape session on first turn (cur-038 major: /fork and
    // /tree need a real sessionId, not a timestamp placeholder)
    if (!sessionId) {
      sessionId = `sess-${Date.now().toString(36)}`;
      const tape = Tape.open(process.cwd(), sessionId);
      tape.appendMeta({
        sessionId,
        cwd: process.cwd(),
        model: cfg.model,
        provider: "openai-compatible",
        createdAt: new Date().toISOString(),
      });
      tape.append({ type: "message", role: "user", content: value } as never);
      tape.close();
    } else {
      // append the new user turn to the existing session tape
      const tape = Tape.open(process.cwd(), sessionId);
      tape.append({ type: "message", role: "user", content: value } as never);
      tape.close();
    }
    // (assistant + tool events are persisted via tapeAppend in the hooks)

    // per-turn AbortController (cur-036: one-shot signal pollutes the loop)
    const turnCancel = new AbortController();
    cancelCurrent = () => turnCancel.abort();
    loop.setSignal(turnCancel.signal);

    running = true;
    appendMessage("user", value);
    setStatus(" | running...");

    try {
      const result = await loop.continue(value); // multi-turn
      tokensUsed = loop.getTokensUsed(); // real usage from provider (cur-045)
      if (result.state === "CANCELLED") {
        appendMessage("system", "cancelled");
      } else if (result.state === "ERROR" && result.error) {
        appendMessage("system", `error: ${result.error.slice(0, 160)}`);
      }
      // summary already streamed via onAssistantMessage; no duplicate append
      // (cur-036 minor: streamed text vs summary could double-show)
    } catch (e) {
      const msg = e instanceof Error && e.name === "AbortError" ? "cancelled" : String(e);
      appendMessage("system", msg);
    } finally {
      endStreaming();
      running = false;
      cancelCurrent = null;
      setStatus();
      // replay inputs queued while this turn was running (FIFO)
      if (pendingInputs.length > 0) {
        const next = pendingInputs.shift()!;
        void handleTurn(next);
      }
    }
  }

  /** Resume a session tape into a fresh loop (shared by /resume and startup
   *  auto-resume; Leo: default should continue the last session). */
  function resumeSession(id: string): boolean {
    try {
      const tape = Tape.open(process.cwd(), id);
      const history: { role: string; content: string }[] = [];
      const events = tape.readAll();
      tape.close();
      // map only complete tool pairs + messages; skip orphan/meta
      // (cur-038 minor: seedConversation rejects orphan tools)
      for (const ev of events) {
        if (ev.type === "message") {
          // message role is never "tool" (TraceRole excludes it)
          history.push({ role: ev.role, content: ev.content });
        } else if (ev.type === "tool_result") {
          const prev = history[history.length - 1];
          if (prev && prev.role === "assistant") {
            history.push({ role: "tool", content: ev.output ?? ev.error ?? "" });
          }
          // orphan tool_result without preceding assistant: skip
        }
      }
      loop = buildLoop();
      loop.seedConversation(history as never[]);
      // restore cumulative usage from persisted snapshots (Leo: restart 0)
      const usage = events
        .filter((e): e is Extract<TraceEvent, { type: "usage" }> => e.type === "usage")
        .reduce((acc, e) => ({ total: acc.total + e.total, input: acc.input + e.input, output: acc.output + e.output }),
          { total: 0, input: 0, output: 0 });
      loop.restoreTokens(usage);
      tokensUsed = loop.getTokensUsed(); // TUI copy must match (Leo: resume 0)
      sessionId = id;
      setStatus();
      return true;
    } catch (e) {
      appendMessage("system", `resume failed: ${String(e)}`);
      return false;
    }
  }

  input.onSubmit = (value) => void onSubmit(value);

  // Ctrl+C: cancel current turn (first), exit (second) — cur-033 #1.
  // Handle BOTH paths: raw-mode byte (\u0003 via input listener) and the
  // SIGINT signal (some terminals/PTYs deliver Ctrl+C as a signal even in
  // raw mode; Leo: neither worked). Shared handler keeps semantics identical.
  let ctrlCPressed = false;
  const ctrlLog = (msg: string) => {
    try {
      appendFileSync("/tmp/chita-ctrl.log", `${new Date().toISOString()} ${msg} running=${running} ctrl=${ctrlCPressed}\n`);
    } catch {
      // best-effort debug log
    }
  };
  const handleCtrlC = () => {
    ctrlLog("handleCtrlC called");
    // Running: first press cancels the turn AND arms exit — the next press
    // (within 2s) exits unconditionally. Previously ctrlCPressed was reset
    // here, so a second Ctrl+C while still running re-cancelled forever
    // (Leo: 'Ctrl+C 无法退出' during a turn).
    if (running && cancelCurrent && !ctrlCPressed) {
      ctrlLog("-> cancel turn + arm exit");
      cancelCurrent();
      ctrlCPressed = true;
      setTimeout(() => (ctrlCPressed = false), 2000);
      return;
    }
    // Idle single press, or any second press: exit.
    ctrlLog("-> exit");
    tui.stop();
    process.exit(0);
  };
  tui.addInputListener((data) => {
    if (data === "\u0003") {
      ctrlLog("byte \\u0003 received");
      handleCtrlC();
      return { consume: true };
    }
  });
  process.on("SIGINT", () => {
    ctrlLog("SIGINT signal received");
    handleCtrlC();
  });

  tui.start();

  // Startup: default = continue the most recent session in this cwd
  // (Leo: opaque ids + manual resume were unfriendly). /new starts fresh.
  const recent = recentSessionSummary(process.cwd());
  if (recent) {
    const when = recent.age ? ` (${recent.age})` : "";
    if (resumeSession(recent.id)) {
      appendMessage("system", `已恢复上次会话 ${recent.id}${when} — 内容: "${recent.first}"`);
      appendMessage("system", `/new 开新会话，或直接继续输入`);
    }
  }
}
