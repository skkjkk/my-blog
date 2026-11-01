import test from "node:test";
import assert from "node:assert/strict";
import { createEnv, makeCaller } from "../support/d1.mjs";
import worker from "../../worker/index.js";
import { ensureCommentsSchema } from "../../worker/lib/db.js";

const call = makeCaller(worker);

async function login(env) {
	const response = await call(
		"/api/admin/login",
		{ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "test-pass" }) },
		env,
	);
	return (response.headers.get("set-cookie") ?? "").split(";")[0];
}

function payload(overrides = {}) {
	return {
		slug: "/posts/demo/",
		postId: "posts/demo.md",
		name: "博主",
		content: "我在自己博客留言",
		clientId: crypto.randomUUID(),
		elapsed: 9000,
		...overrides,
	};
}

test("博主登录态发的评论直接通过并带博主标记", async () => {
	const env = createEnv();
	await ensureCommentsSchema(env);
	const cookie = await login(env);
	const response = await call("/api/comments", {
		method: "POST",
		headers: { "content-type": "application/json", cookie },
		body: JSON.stringify(payload()),
	}, env);
	assert.equal(response.status, 201);
	const body = await response.json();
	assert.equal(body.status, "approved");
	assert.equal(body.item.isAdmin, true);
});

test("「全部待审」模式下博主自己的评论仍然免审", async () => {
	const env = createEnv();
	await ensureCommentsSchema(env);
	const cookie = await login(env);
	await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('comment_mode', 'hold')").run();
	const response = await call("/api/comments", {
		method: "POST",
		headers: { "content-type": "application/json", cookie },
		body: JSON.stringify(payload({ clientId: crypto.randomUUID() })),
	}, env);
	const body = await response.json();
	assert.equal(body.status, "approved");
	assert.equal(body.item.isAdmin, true);
});

test("普通访客在 hold 模式下发评论仍然进待审", async () => {
	const env = createEnv();
	await ensureCommentsSchema(env);
	await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('comment_mode', 'hold')").run();
	const response = await call("/api/comments", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload()) }, env);
	const body = await response.json();
	assert.equal(body.status, "pending");
	assert.equal(body.item.isAdmin, false);
});
