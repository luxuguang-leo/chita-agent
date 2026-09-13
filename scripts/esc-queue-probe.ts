/**
 * chita Esc/queue behavior probe — headless, no API calls, no terminal.
 *
 * Run with bun (the repo's runtime):   bun scripts/esc-queue-probe.ts
 * Also runnable on node >=22.18 (type stripping):
 *                                      node scripts/esc-queue-probe.ts
 *
 * Covers the two regression surfaces of the Esc "take back what you queued"
 * change (pi/Codex parity):
 *   1. the merge semantics of returning queued follow-ups to the editor, and
 *   2. the TUI wiring of cancel -> restore vs normal completion -> drain,
 *      including the race hardening that trusts the abort signal.
 */
import { readFileSync } from "node:fs";
import { mergeQueuedIntoDraft } from "../packages/tui/src/queue.ts";

let failures = 0;
function check(cond: boolean, msg: string): void {
	if (cond) console.log(`  ok: ${msg}`);
	else {
		failures++;
		console.error(`  FAIL: ${msg}`);
	}
}

console.log("mergeQueuedIntoDraft (take-back merge):");
check(mergeQueuedIntoDraft(["fix the test"], "") === "fix the test", "single queued message -> empty draft");
check(mergeQueuedIntoDraft(["second thought"], "draft") === "second thought\n\ndraft", "queued messages go ahead of the draft");
check(mergeQueuedIntoDraft(["one", "two"], "") === "one\n\ntwo", "multiple queued stay oldest-first, blank-line separated");
check(mergeQueuedIntoDraft(["", "  ", "real"], "  ") === "real", "empty / whitespace-only parts are dropped");
check(mergeQueuedIntoDraft([], "keep me") === "keep me", "empty queue leaves the draft untouched");

const src = readFileSync(new URL("../packages/tui/src/index.ts", import.meta.url), "utf8");
console.log("TUI wiring:");
check(src.includes("turnCancel.signal.aborted"), "cancel trusts the abort signal (race hardening)");
check(src.includes('matchesKey(data, "escape")'), "Esc is wired to cancel the running turn");
check(src.includes('matchesKey(data, "alt+up")'), "Alt+Up is wired to take the queue back");
check(src.includes("!input.isShowingAutocomplete()"), "Esc defers to an open autocomplete menu");
check(src.includes("restorePendingInputs()"), "queued inputs are restored to the editor");
check(src.includes("void handleTurn(next)"), "normal completion still drains the queue");
check(src.includes("categoryLabel("), "guardian approval shows the Chinese risk category");
check(src.includes("回复 allow"), "approval prompt tells the user to answer allow/deny");
check(src.includes("friendlyError("), "turn errors are rendered through friendlyError");

console.log(failures === 0 ? "\nPROBE OK" : `\nPROBE FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
