import test from "node:test";
import assert from "node:assert/strict";
import { createEnv, makeCaller } from "../support/d1.mjs";
import worker from "../../worker/index.js";

const call = makeCaller(worker);

function payload(overrides = {}) {
	return {
		slug: "/posts/demo/",
		postId: "posts/demo.md",
		name: "小明",
		content: "第一条评论",
		clientId: "11111111-1111-4111-8111-111111111111",
		elapsed: 9000,
		...overrides,
	};
}

function post(body) {
	return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

function stubFetch(impl) {
	const original = globalThis.fetch;
	globalThis.fetch = impl;
	return () => {
		globalThis.fetch = original;
	};
}

test("没配 TURNSTILE_SECRET 时不发人机验证请求，评论照常发布", async () => {
	const env = createEnv();
	let called = 0;
	const restore = stubFetch(async () => {
		called += 1;
		return new Response(JSON.stringify({ success: true }), { headers: { "content-type": "application/json" } });
	});
	try {
		const response = await call("/api/comments", post(payload()), env);
		assert.equal(response.status, 201);
		assert.equal(called, 0);
	} finally {
		restore();
	}
});

test("配了 TURNSTILE_SECRET 但没带 token：当机器人处理，200 且落 spam", async () => {
	const env = createEnv({ TURNSTILE_SECRET: "secret-key" });
	const restore = stubFetch(async () =>
		new Response(JSON.stringify({ success: false }), { headers: { "content-type": "application/json" } }),
	);
	try {
		const response = await call("/api/comments", post(payload()), env);
		assert.equal(response.status, 200);
		const { results } = await env.DB.prepare("SELECT status FROM comments").all();
		assert.deepEqual(
			results.map((row) => row.status),
			["spam"],
		);
	} finally {
		restore();
	}
});

test("Turnstile 校验通过则正常发布", async () => {
	const env = createEnv({ TURNSTILE_SECRET: "secret-key" });
	const restore = stubFetch(async () =>
		new Response(JSON.stringify({ success: true }), { headers: { "content-type": "application/json" } }),
	);
	try {
		const response = await call("/api/comments", post(payload({ turnstileToken: "token-ok" })), env);
		assert.equal(response.status, 201);
	} finally {
		restore();
	}
});

test("Turnstile 服务本身挂了也不放行（安全优先）", async () => {
	const env = createEnv({ TURNSTILE_SECRET: "secret-key" });
	const restore = stubFetch(async () => {
		throw new Error("network down");
	});
	try {
		const response = await call("/api/comments", post(payload({ turnstileToken: "token-ok" })), env);
		assert.equal(response.status, 200);
		const { results } = await env.DB.prepare("SELECT status FROM comments").all();
		assert.deepEqual(
			results.map((row) => row.status),
			["spam"],
		);
	} finally {
		restore();
	}
});
