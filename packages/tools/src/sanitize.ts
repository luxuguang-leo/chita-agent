/**
 * Shared output sanitization (P2.1).
 *
 * Lives in the tools package (the lowest layer) so both tools (git ANSI
 * cleanup) and the TUI (live tail) can use it without a tools -> tui reverse
 * dependency. The TUI re-exports it from display.ts.
 */

/** Strip ANSI CSI control sequences + bare CR so output renders clean.
 *  Raw chunks can carry colors, cursor moves, or \r progress bars. */
export function sanitizeTail(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\r/g, "");
}
