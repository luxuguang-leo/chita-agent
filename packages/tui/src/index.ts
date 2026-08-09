/**
 * chita TUI (T1 skeleton, TUI design v2)
 *
 * Three-region layout: message area (ScrollView) + input line (Input) +
 * status bar. Multi-turn via AgentLoop.continue() (T1 前置). Slash commands
 * handled locally — never fed to the model (design §5).
 *
 * Host-only: all logic lives in AgentLoop/hooks; this file renders + handles
 * input (design §1: host does not pollute core).
 */

import { TuiMainScreen } from "../vendor/tui-main-screen.ts";
import { ProcessTerminal } from "../vendor/terminal.ts";
import { ScrollView } from "../vendor/components/scroll-view.ts";
import { Input } from "../vendor/components/input.ts";
import { Text } from "../vendor/components/text.ts";
import { Box } from "../vendor/components/box.ts";
import { VStack } from "../vendor/components/v-stack.ts";
import { HStack } from "../vendor/components/h-stack.ts";
import { Container } from "../vendor/tui.ts";
import { AgentLoop, type ChatMessage } from "../../agent/src/loop.ts";
import { OpenAICompatibleProvider } from "../../ai/src/index.ts";
import { scrubSecrets } from "../../agent/src/scrub.ts";
import { loadConfig, apiKey } from "../../cli/src/config.ts";

export interface TuiOptions {
  judge?: boolean;
}

interface SessionState {
  loop: AgentLoop;
  messages: ChatMessage[];
}

/** Local slash commands — never reach the model (design §5). */
const LOCAL_COMMANDS = ["/help", "/new", "/exit", "/mode", "/goal"];

export async function startTui(opts: TuiOptions = {}): Promise<void> {
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

  // 1) message area: ScrollView wraps a message container
  const messagesBox = new Box();
  const messageScroll = new ScrollView(messagesBox, { follow: "end" });

  // 2) input line
  const input = new Input();

  // 3) status bar
  const statusText = new Text(
    `session: new | mode: build | model: ${cfg.model} | tokens: 0`,
    0,
    0
  );

  // root layout: message area (grow) + input + status
  const root = new VStack([
    { component: messageScroll, grow: 1 },
    { component: input },
    { component: new HStack([{ component: statusText }]) },
  ]);
  tui.addChild(root);
  tui.setFocus(input);

  // --- session ---
  let session: SessionState | null = null;
  let mode: "build" | "plan" = "build";
  let tokensUsed = 0;

  function appendMessage(role: string, content: string): void {
    messagesBox.addChild(new Text(`[${role}] ${content}`, 0, 0));
    tui.requestRender(true);
  }

  function setStatus(suffix = ""): void {
    statusText.setText(
      `session: ${session ? "active" : "new"} | mode: ${mode} | model: ${cfg.model} | tokens: ${tokensUsed}${suffix}`
    );
    tui.requestRender(true);
  }

  async function onSubmit(raw: string): Promise<void> {
    const value = raw.trim();
    if (!value) return;

    // local slash commands (design §5 — never to the model)
    if (value.startsWith("/")) {
      const cmd = value.split(/\s+/)[0];
      switch (cmd) {
        case "/help":
          appendMessage("system", LOCAL_COMMANDS.join("  "));
          return;
        case "/new":
          session = null;
          appendMessage("system", "new session");
          return;
        case "/exit":
          tui.stop();
          process.exit(0);
          return;
        case "/mode":
          mode = value.includes("plan") ? "plan" : "build";
          setStatus();
          appendMessage("system", `mode -> ${mode}`);
          return;
        case "/goal":
          appendMessage("system", "/goal: independent verification (after a task)");
          return;
        default:
          appendMessage("system", `unknown: ${cmd} (try /help)`);
          return;
      }
    }

    // new session on first turn
    if (!session) {
      const loop = new AgentLoop({
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
          onEvent: (ev) => {
            if (ev.type === "tool_result") {
              const outcome = ev.ok ? "ok" : `error: ${ev.error ?? ""}`;
              appendMessage("tool", `[${ev.toolName}] ${outcome}`);
            }
          },
        },
      });
      session = { loop, messages: loop.getConversation() };
    }

    appendMessage("user", value);
    setStatus(" | running...");

    const result = await session.loop.continue(value); // multi-turn via continue (T1 前置)
    if (result.summary) {
      appendMessage("assistant", result.summary);
    }
    setStatus();
  }

  input.onSubmit = (value) => void onSubmit(value);

  // terminal input: Ctrl+C cancel/exit handled via terminal.start callback
  tui.start();
  terminal.start(
    (data) => {
      if (data === "\u0003") {
        // Ctrl+C: TUI library handles focus input; here we just note it.
        appendMessage("system", "Ctrl+C (cancellation wiring lands in T2)");
      }
    },
    () => tui.requestRender(true)
  );
}
