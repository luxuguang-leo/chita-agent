/**
 * Input-queue take-back tests (pi/Codex parity).
 *
 * Regression under test: cancelling a turn (Esc/Ctrl+C) used to REPLAY queued
 * follow-ups against the context the user just aborted. The fix returns them to
 * the editor instead (`restorePendingInputs` -> `mergeQueuedIntoDraft`). These
 * pin the merge shape: queued entries first, oldest first, blank-line
 * separated, ahead of whatever was already typed.
 */

import { test, expect } from "bun:test";
import { mergeQueuedIntoDraft } from "./queue.ts";

test("restores a single queued message into an empty draft", () => {
	expect(mergeQueuedIntoDraft(["fix the test"], "")).toBe("fix the test");
});

test("puts queued messages ahead of the current draft", () => {
	expect(mergeQueuedIntoDraft(["second thought"], "half-typed dr")).toBe("second thought\n\nhalf-typed dr");
});

test("keeps multiple queued messages in oldest-first order", () => {
	expect(mergeQueuedIntoDraft(["one", "two", "three"], "")).toBe("one\n\ntwo\n\nthree");
});

test("drops empty and whitespace-only parts", () => {
	expect(mergeQueuedIntoDraft(["", "   ", "real"], "  ")).toBe("real");
});

test("no queued messages leaves the draft untouched", () => {
	expect(mergeQueuedIntoDraft([], "keep me")).toBe("keep me");
	expect(mergeQueuedIntoDraft([], "")).toBe("");
});
