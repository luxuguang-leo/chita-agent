/**
 * /goal judge tests (v2.1 §2.2 / MiMo / Agent-goal)
 *
 * Covers: verdict parsing (pass/fail/uncertain + malformed), budget
 * enforcement (max-per-session, monthly), judge prompt rendering via
 * FakeProvider.
 */

import { test, expect } from "bun:test";
import { runJudge, parseJudgeResponse, JudgeBudget } from "./judge.ts";
import { Provider, StreamEvent, ChatMessage } from "./loop.ts";

function judgeProvider(reply: string): Provider {
  return {
    async *chat(_m: ChatMessage[]): AsyncIterable<StreamEvent> {
      await new Promise((r) => setTimeout(r, 1));
      yield { kind: "message", message: { role: "assistant", content: reply } };
    },
  };
}

test("parseJudgeResponse: pass verdict", () => {
  const r = parseJudgeResponse('{"verdict":"pass","reason":"tests passed","evidence":["npm test ok"]}', 100);
  expect(r.verdict).toBe("pass");
  expect(r.reason).toContain("tests passed");
  expect(r.evidence).toEqual(["npm test ok"]);
});

test("parseJudgeResponse: fail + uncertain + malformed", () => {
  expect(parseJudgeResponse('{"verdict":"fail","reason":"no files","evidence":[]}', 0).verdict).toBe("fail");
  expect(parseJudgeResponse('{"verdict":"weird","reason":"x"}', 0).verdict).toBe("uncertain");
  expect(parseJudgeResponse("no json here", 0).verdict).toBe("uncertain");
});

test("runJudge: streams reply through provider", async () => {
  const conv: ChatMessage[] = [
    { role: "user", content: "fix the bug" },
    { role: "assistant", content: "fixed calc.js, tests pass" },
  ];
  const result = await runJudge(judgeProvider('{"verdict":"pass","reason":"verified","evidence":["test"]}'), conv, "fix the bug");
  expect(result.verdict).toBe("pass");
});

test("JudgeBudget: max per session enforced", () => {
  const budget = new JudgeBudget({ maxPerSession: 2, turnThrottle: 0 });
  expect(budget.canInvoke(1000, 0.3, 1)).toBe(true);
  budget.record(1000, 1);
  expect(budget.canInvoke(1000, 0.3, 11)).toBe(true);
  budget.record(1000, 11);
  expect(budget.canInvoke(1000, 0.3, 21)).toBe(false); // 3rd blocked
  expect(budget.invokedCount()).toBe(2);
});

test("JudgeBudget: turn throttle blocks early re-invoke", () => {
  const budget = new JudgeBudget({ maxPerSession: 5, turnThrottle: 10 });
  expect(budget.canInvoke(1000, 0.3, 5)).toBe(true);
  budget.record(1000, 5);
  expect(budget.canInvoke(1000, 0.3, 10)).toBe(false); // <10 turns since last
  expect(budget.canInvoke(1000, 0.3, 15)).toBe(true); // 10 turns passed
});

test("JudgeBudget: monthly budget cap", () => {
  const budget = new JudgeBudget({ monthlyBudgetUsd: 1, turnThrottle: 0 });
  // 3M tokens @ $0.3/M = $0.9 < $1 -> ok; next 1M = $1.2 > $1 -> blocked
  expect(budget.canInvoke(3_000_000, 0.3, 1)).toBe(true);
  budget.record(3_000_000, 1);
  expect(budget.canInvoke(1_000_000, 0.3, 2)).toBe(false);
});
