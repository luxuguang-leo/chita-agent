/**
 * inferMaxTokens tests — per-model output cap (pi parity).
 *
 * Regression under test: chita hard-coded `max_tokens: 4096` for every model,
 * truncating long tool-call arguments and long answers. The fix infers the cap
 * from the model name — values read off pi's model catalog
 * (`@earendil-works/pi-ai/dist/providers/data/moonshotai.json`) rather than
 * guessed — and, for a model chita has no entry for, omits `max_tokens` from
 * the request entirely the way pi's openai-completions.js does.
 */

import { test, expect } from "bun:test";
import { inferMaxTokens, OpenAICompatibleProvider } from "./index.ts";

test("deepseek models get the 384K output cap (pi parity)", () => {
	expect(inferMaxTokens("deepseek-v4-flash")).toBe(384_000);
	expect(inferMaxTokens("deepseek-v4-pro")).toBe(384_000);
	expect(inferMaxTokens("deepseek-chat")).toBe(384_000);
});

test("kimi models get the caps from pi's catalog, not /^moonshot/", () => {
	// moonshotai.json / moonshotai-cn.json, provider `moonshotai`
	expect(inferMaxTokens("kimi-k2.5")).toBe(262_144);
	expect(inferMaxTokens("kimi-k2.6")).toBe(262_144);
	expect(inferMaxTokens("kimi-k2.7-code")).toBe(262_144);
	expect(inferMaxTokens("kimi-k2.7-code-highspeed")).toBe(262_144);
	expect(inferMaxTokens("kimi-k2-0905-preview")).toBe(262_144);
	expect(inferMaxTokens("kimi-k2-thinking")).toBe(262_144);
	expect(inferMaxTokens("kimi-k2-turbo-preview")).toBe(262_144);
	// older/smaller entries in the same catalog
	expect(inferMaxTokens("kimi-k2-0711-preview")).toBe(16_384);
	expect(inferMaxTokens("kimi-k3")).toBe(131_072);
});

test("other known families map to sane caps", () => {
	expect(inferMaxTokens("glm-4")).toBe(8_192);
	expect(inferMaxTokens("qwen-max")).toBe(8_192);
	expect(inferMaxTokens("claude-3-5")).toBe(8_192);
	expect(inferMaxTokens("gpt-4o")).toBe(16_384);
});

test("unknown models infer no cap (no 4096 fallback)", () => {
	expect(inferMaxTokens("some-unknown-model")).toBeUndefined();
	// legacy Moonshot id: real endpoint, but absent from pi's catalog
	expect(inferMaxTokens("moonshot-v1-32k")).toBeUndefined();
});

/** SSE mock that records the request body — the omit behaviour is only visible
 *  on the wire, so asserting it on inferMaxTokens alone would prove nothing. */
function startCapturingServer(): { url: string; stop: () => void; bodies: Record<string, unknown>[] } {
	const bodies: Record<string, unknown>[] = [];
	const server = Bun.serve({
		port: 0,
		async fetch(req) {
			bodies.push((await req.json()) as Record<string, unknown>);
			const stream = new ReadableStream({
				start(controller) {
					controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
					controller.close();
				},
			});
			return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
		},
	});
	return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true), bodies };
}

async function captureBody(model: string, maxTokens?: number): Promise<Record<string, unknown>> {
	const { url, stop, bodies } = startCapturingServer();
	try {
		const p = new OpenAICompatibleProvider({ baseUrl: url, apiKey: "test", model, maxTokens });
		for await (const _ of p.chat([{ role: "user", content: "hi" }])) {
			/* drain */
		}
		expect(bodies.length).toBe(1);
		return bodies[0];
	} finally {
		stop();
	}
}

test("request omits max_tokens for a model with no inferred cap (pi parity)", async () => {
	const body = await captureBody("some-unknown-model");
	expect("max_tokens" in body).toBe(false);
	expect(body.model).toBe("some-unknown-model");
	expect(body.stream).toBe(true);
});

test("request carries the inferred cap for a known model", async () => {
	const body = await captureBody("kimi-k2.6");
	expect(body.max_tokens).toBe(262_144);
});

test("explicit maxTokens in the provider config still wins", async () => {
	const body = await captureBody("some-unknown-model", 512);
	expect(body.max_tokens).toBe(512);
});
