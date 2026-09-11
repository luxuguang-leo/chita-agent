/**
 * Trace → conversation reconstruction for resume (cur-109/cur-110 review).
 *
 * The tape records what happened, not the OpenAI message shape:
 * - `tool_call` / `tool_result` are appended while the turn runs, while the
 *   assistant's own text is appended at turn end (`endStreaming`), and the
 *   declaration message the provider emits is never persisted as such;
 * - tapes written before `tool_call` persistence existed carry tool results
 *   but no declarations at all.
 *
 * `seedConversation` enforces the pairing invariant (every tool message is
 * answered by an assistant that declares its call id), so this module rebuilds
 * that shape: each result lands under a declaration that owns its call id, and
 * a call arriving after results opens a new declaration (the live loop emits
 * `assistant(N calls) → tool×N` per model turn, not one assistant per session).
 */

import type { TraceEvent } from "../../session/src/trace.ts";
import type { ChatMessage } from "./loop.ts";

/** Argument marker for a call reconstructed from a tape that never recorded
 *  `tool_call`. The call really happened — its result is on the tape — but the
 *  arguments are gone, so they are marked as reconstructed rather than
 *  presented as a real empty-argument invocation. */
const RESUMED_ARGS = JSON.stringify({ _resumed: true });

function stringifyArgs(args: unknown): string {
  if (args === undefined) return "{}";
  try {
    return JSON.stringify(args) ?? "{}";
  } catch {
    return "{}";
  }
}

/**
 * Rebuild a seedable conversation from raw trace events, in tape order.
 * Never throws: results whose declaration is missing (legacy tapes) get a
 * reconstructed one, and declarations whose result never landed (crash
 * mid-tool) are pruned, so the output always satisfies `seedConversation` and
 * the API's "every tool_call is answered" rule.
 */
export function historyFromEvents(events: readonly TraceEvent[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  /** declared call id → the assistant message that declares it */
  const ownerByCallId = new Map<string, ChatMessage>();
  /** assistant message currently accepting declarations/results */
  let host: ChatMessage | null = null;
  /** tool results already pushed for `host` */
  let answeredForHost = 0;

  const openHost = (): ChatMessage => {
    const msg: ChatMessage = { role: "assistant", content: "", toolCalls: [] };
    messages.push(msg);
    host = msg;
    answeredForHost = 0;
    return msg;
  };

  /** The declaration window of `target` is still open when only tool messages
   *  follow it — the same backward scan `seedConversation` performs. */
  const canAnswer = (target: ChatMessage): boolean => {
    for (let i = messages.lastIndexOf(target) + 1; i < messages.length; i++) {
      if (messages[i].role !== "tool") return false;
    }
    return true;
  };

  const pushResult = (target: ChatMessage, content: string, name: string, callId: string): void => {
    if (host !== target) {
      host = target;
      answeredForHost = 0;
    }
    messages.push({ role: "tool", name, toolCallId: callId, content });
    answeredForHost++;
  };

  /** NOT named `declare`: a statement-start `declare(...)` parses as an ambient
   *  declaration and the transpiler silently strips it (found the hard way). */
  const declareCall = (target: ChatMessage, callId: string, name: string, args: string): void => {
    (target.toolCalls ??= []).push({ id: callId, name, args });
    ownerByCallId.set(callId, target);
  };

  for (const ev of events) {
    if (ev.type === "message") {
      // `reasoning`/`context` are dropped: the provider forwards `role`
      // verbatim to the OpenAI-compatible API, so a role outside the API's
      // set would fail the first resumed request.
      const role = ev.role;
      if (role !== "user" && role !== "assistant" && role !== "system") continue;
      const msg: ChatMessage = { role, content: ev.content };
      messages.push(msg);
      host = role === "assistant" ? msg : null;
      answeredForHost = 0;
      continue;
    }

    if (ev.type === "tool_call") {
      // a call after results starts a fresh round (assistant → tool → assistant)
      const target = !host || answeredForHost > 0 ? openHost() : host;
      const callId = ev.callId ?? `resumed-call-${ev.seq}`;
      declareCall(target, callId, ev.tool.name, stringifyArgs(ev.tool.args));
      continue;
    }

    if (ev.type === "tool_result") {
      const content = ev.ok ? (ev.output ?? "") : `ERROR: ${ev.error ?? ""}`;
      const owner = ev.callId ? ownerByCallId.get(ev.callId) : undefined;
      if (owner && ev.callId && canAnswer(owner)) {
        pushResult(owner, content, ev.toolName, ev.callId);
        continue;
      }
      // No usable declaration on tape (legacy tape, or the declaration window
      // was closed by an intervening message): reconstruct one so the result
      // survives resume with a valid pairing shape.
      const target = host ?? openHost();
      const callId = ev.callId ?? `resumed-${ev.seq}`;
      declareCall(target, callId, ev.toolName, RESUMED_ARGS);
      pushResult(target, content, ev.toolName, callId);
      continue;
    }

    // usage / judge / error / done / context_truncated carry no message shape
  }

  // A declared call cannot stay declared unless its result follows it: the API
  // requires every tool_call to be answered immediately (crash mid-tool, or a
  // declaration cut off from its result by an intervening message). Only the
  // consecutive tool run right after a declaration counts as its answers.
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== "assistant" || !msg.toolCalls) continue;
    const answeredHere = new Set<string>();
    for (let j = i + 1; j < messages.length && messages[j].role === "tool"; j++) {
      const id = messages[j].toolCallId;
      if (id) answeredHere.add(id);
    }
    const kept = msg.toolCalls.filter((call) => answeredHere.has(call.id));
    if (kept.length === msg.toolCalls.length) continue;
    if (kept.length > 0) msg.toolCalls = kept;
    else delete msg.toolCalls;
  }

  // host shells whose declaration was pruned carry no content and no calls
  return messages.filter((m) => m.role !== "assistant" || m.content !== "" || m.toolCalls?.length);
}
