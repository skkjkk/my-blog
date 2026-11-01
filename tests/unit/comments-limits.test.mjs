import test from "node:test";
import assert from "node:assert/strict";
import { volumeVerdict, VOLUME_LIMITS } from "../../worker/comments.js";
import { createEnv, makeCaller } from "../support/d1.mjs";
import worker from "../../worker/index.js";

const call = makeCaller(worker);

function post(body) {
	return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

function payload(overrides = {}) {
	return {
		slug: "/posts/demo/",
		postId: "posts/demo.md",
		name: "小明",
		content: "内容",
		clientId: crypto.randomUUID(),
		elapsed: 9000,
		...overrides,
	};
}

test("体量闸门：未超限放行", () => {
	assert.deepEqual(volumeVerdict({ postCount: 10, totalCount: 100 }), { allowed: true });
});

test("体量闸门：单篇或全表超限即拒", () => {
	assert.equal(volumeVerdict({ postCount: VOLUME_LIMITS.perPost, totalCount: 100 }).allowed, false);
	assert.equal(volumeVerdict({ postCount: 10, totalCount: VOLUME_LIMITS.total }).allowed, false);
});

test("机器人重复提交不会无限写库", async () => {
	const env = createEnv();
	const ip = "9.9.9.9";
	for (let index = 0; index < 3; index++) {
		const response = await call("/api/comments", { ...post(payload({ honey: "bot" })), headers: { "content-type": "application/json", "cf-connecting-ip": ip } }, env);
		assert.equal(response.status, 200, "机器人的响应不该暴露任何信息");
	}
	const { results } = await env.DB.prepare("SELECT status FROM comments").all();
	assert.equal(results.length, 1, "同一来源的机器人重复提交只应落一行样本");
});

test("正常评论也受 30 秒频率限制（机器人分支不再绕过限流）", async () => {
	const env = createEnv();
	const headers = { "content-type": "application/json", "cf-connecting-ip": "8.8.8.8" };
	await call("/api/comments", { ...post(payload()), headers }, env);
	const second = await call("/api/comments", { ...post(payload()), headers }, env);
	assert.equal(second.status, 429);
});
