/**
 * Pure helpers for the TUI input queue (pi/Codex "take back what you queued").
 *
 * Kept out of `index.ts` so tests can import them without pulling in the CLI
 * entrypoint (which runs `main()` on import).
 */

/**
 * Merge queued follow-ups into the current draft, oldest first, separated by
 * blank lines (pi joins with "\n\n"). Empty/whitespace-only parts are dropped,
 * so restoring an empty queue leaves the draft untouched.
 */
export function mergeQueuedIntoDraft(queued: string[], draft: string): string {
	const parts = [...queued.filter((q) => q.trim()), draft];
	return parts.filter((t) => t.trim()).join("\n\n");
}
