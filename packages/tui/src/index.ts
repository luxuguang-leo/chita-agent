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
import { OpenAICompatibleProvider } from "../../ai/src/index.ts";
import { scrubSecrets } from "../../agent/src/scrub.ts";
import { loadConfig, apiKey } from "../../cli/src/config.ts";
import {
  KeybindingsManager,
  setKeybindings,
  TUI_KEYBINDINGS,
} from "../vendor/keybindings.ts";
import { buildSessionTree, forkWithSummary } from "../../session/src/session-tree.ts";
import { Tape } from "../../session/src/tape.ts";

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
  const key = apiKey();
  if (!key) {
    console.error("CHITA_API_KEY is not set (required to run tasks)");
    process.exit(1);
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
    { name: "mode", description: "build|plan", argumentHint: "build|plan" },
    { name: "goal", description: "independent verification" },
    { name: "exit", description: "leave TUI" },
  ];
  input.setAutocompleteProvider(new CombinedAutocompleteProvider(slashCommands, process.cwd()));
  const statusText = new Text("session: new | mode: build | model: " + cfg.model + " | tokens: 0", 0, 0);

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
  let mode: "build" | "plan" = "build";
  let tokensUsed = 0;
  let running = false; // re-entrancy lock (cur-033 #6)
  let cancelCurrent: (() => void) | null = null;
  /** Pending assistant message being streamed (updated in place, not new rows) */
  let streamingText: Markdown | null = null;
  let streamingBuffer = "";

  // Markdown theme (identity — plain rendering, T2; styling T3)
  const mdTheme: MarkdownTheme = {
    heading: id, link: id, linkUrl: id, code: id, codeBlock: id,
    codeBlockBorder: id, quote: id, quoteBorder: id, hr: id, listBullet: id,
    bold: id, italic: id, strikethrough: id, underline: id,
  };

  function appendMessage(role: string, content: string): void {
    messagesBox.addChild(new Markdown(`**${role}** ${content}`, 0, 0, mdTheme));
    tui.requestRender(true);
  }

  /** Streaming: accumulate into one row, update in place (cur-033 #3 refinement) */
  function appendStreamed(content: string): void {
    streamingBuffer += content;
    if (!streamingText) {
      streamingText = new Markdown(`**assistant** ${streamingBuffer}`, 0, 0, mdTheme);
      messagesBox.addChild(streamingText);
    } else {
      streamingText.setText(`**assistant** ${streamingBuffer}`);
    }
    tui.requestRender(true);
  }

  function endStreaming(): void {
    streamingText = null;
    streamingBuffer = "";
  }

  function setStatus(suffix = ""): void {
    statusText.setText(
      `session: ${loop ? "active" : "new"} | mode: ${mode} | model: ${cfg.model} | tokens: ${tokensUsed}${suffix}`
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
        // streaming assistant text rendered live (cur-033 #3)
        onAssistantMessage: (msg) => appendStreamed(msg.content),
        onEvent: (ev) => {
          if (ev.type === "tool_result") {
            appendMessage("tool", `[${ev.toolName}] ${ev.ok ? "ok" : "error"}`);
          }
        },
      },
    });
  }

  async function onSubmit(raw: string): Promise<void> {
    const value = raw.trim();
    if (!value || running) return; // re-entrancy lock

    // local slash commands (never to the model)
    if (value.startsWith("/")) {
      const cmd = value.split(/\s+/)[0];
      switch (cmd) {
        case "/help":
          appendMessage("system", "/help /new /tree /resume <id> /fork /mode build|plan /goal /exit");
          return;
        case "/new":
          loop = null;
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
        case "/goal":
          appendMessage("system", "/goal: independent verification (full wiring in T2)");
          return;
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
          const id = value.split(/\s+/)[1];
          if (!id) {
            appendMessage("system", "usage: /resume <session-id>");
            return;
          }
          try {
            const tape = Tape.open(process.cwd(), id);
            const history = tape.readAll().map((ev) =>
              ev.type === "message"
                ? { role: ev.role, content: ev.content } as const
                : ev.type === "tool_result"
                  ? { role: "tool" as const, name: ev.toolName, toolCallId: ev.callId, content: ev.output ?? "" }
                  : { role: "system" as const, content: JSON.stringify(ev) }
            );
            tape.close();
            loop = buildLoop();
            loop.seedConversation(history as never[]);
            appendMessage("system", `resumed ${id} (${history.length} messages)`);
            setStatus();
          } catch (e) {
            appendMessage("system", `resume failed: ${String(e)}`);
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

    // per-turn AbortController (cur-036: one-shot signal pollutes the loop)
    const turnCancel = new AbortController();
    cancelCurrent = () => turnCancel.abort();
    loop.setSignal(turnCancel.signal);

    running = true;
    appendMessage("user", value);
    setStatus(" | running...");

    try {
      const result = await loop.continue(value); // multi-turn
      if (result.state === "CANCELLED") {
        appendMessage("system", "cancelled");
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
    }
  }

  input.onSubmit = (value) => void onSubmit(value);

  // Ctrl+C: cancel current turn (first), exit (second) — cur-033 #1
  let ctrlCPressed = false;
  tui.addInputListener((data) => {
    if (data === "\u0003") {
      if (running && cancelCurrent) {
        cancelCurrent();
        ctrlCPressed = false;
        return { consume: true };
      }
      if (ctrlCPressed) {
        tui.stop();
        process.exit(0);
      }
      ctrlCPressed = true;
      setTimeout(() => (ctrlCPressed = false), 2000);
      return { consume: true };
    }
  });

  tui.start();
}
