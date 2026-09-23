/**
 * Minimal interactive session picker for `chita --resume` (CLI, no Ink).
 *
 * TTY: arrow-key selection (↑/↓ or j/k), Enter to select, q / Ctrl+C to cancel.
 * Non-TTY (pipe/CI): prints a numbered list and returns null — the caller
 * prints a hint to use `chita --resume <id>` (cursor finding #1: never enter
 * raw mode without a TTY).
 */

export interface PickerEntry {
  id: string;
  topic: string;
  age: string;
  locked: boolean;
}

export function pickSession(entries: PickerEntry[]): Promise<string | null> {
  if (entries.length === 0) return Promise.resolve(null);
  if (entries.length === 1) return Promise.resolve(entries[0].id);
  if (!process.stdin.isTTY) {
    renderNumbered(entries);
    return Promise.resolve(null);
  }
  return interactivePick(entries);
}

function renderNumbered(entries: PickerEntry[]): void {
  process.stdout.write("sessions in this directory:\n");
  entries.forEach((e, i) => {
    const age = e.age ? ` · ${e.age}` : "";
    const lock = e.locked ? " 🔒" : "";
    process.stdout.write(`  ${i + 1}. ${e.topic || "(no topic)"}${age}${lock}\n`);
  });
}

function interactivePick(entries: PickerEntry[]): Promise<string | null> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    let idx = 0;
    let rendered = 0;
    let settled = false;

    function render(): void {
      if (rendered > 0) process.stdout.write(`\x1b[${rendered}A`);
      const out: string[] = ["? resume which session? (↑/↓ move, Enter select, q cancel)"];
      entries.forEach((e, i) => {
        const mark = i === idx ? ">" : " ";
        const age = e.age ? ` · ${e.age}` : "";
        const lock = e.locked ? " 🔒" : "";
        out.push(`  ${mark} ${e.topic || "(no topic)"}${age}${lock}`);
      });
      for (const line of out) process.stdout.write(`\x1b[2K${line}\n`);
      rendered = out.length;
    }

    function cleanup(): void {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      // erase the picker block so the terminal hands off clean to the TUI
      if (rendered > 0) process.stdout.write(`\x1b[${rendered}A\x1b[J`);
    }

    // Single resolve choke point: every exit path (Enter/q/Ctrl+C/error) goes
    // through finish(), which is guarded against double resolution.
    const finish = (id: string | null): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(id);
    };

    function onData(data: string): void {
      if (data === "\u001b[A" || data === "\u001bOA" || data === "k") {
        idx = (idx - 1 + entries.length) % entries.length;
        render();
      } else if (data === "\u001b[B" || data === "\u001bOB" || data === "j") {
        idx = (idx + 1) % entries.length;
        render();
      } else if (data === "\r" || data === "\n") {
        finish(entries[idx].id);
      } else if (data === "q" || data === "\u0003") {
        finish(null);
      }
    }

    try {
      stdin.setRawMode(true);
      stdin.resume();
      stdin.setEncoding("utf-8");
      stdin.on("data", onData);
      render();
    } catch {
      // never leak raw mode (cursor finding #2)
      finish(null);
    }
  });
}
