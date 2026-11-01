import test from "node:test";
import assert from "node:assert/strict";
import { normalizePostId } from "../../worker/lib/text.js";
import { createEnv, makeCaller } from "../support/d1.mjs";
import worker from "../../worker/index.js";

const call = makeCaller(worker);
const CHINESE_ID = "binlog_redo_log和undo_log的区别.md";

function post(body) {
	return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

function payload(overrides = {}) {
	return {
		slug: "/posts/binlog-redo-log/",
		postId: CHINESE_ID,
		name: "小明",
		content: "中文文件名的文章",
		clientId: crypto.randomUUID(),
		elapsed: 9000,
		...overrides,
	};
}

test("normalizePostId 接受中文文件名", () => {
	assert.equal(normalizePostId(CHINESE_ID), CHINESE_ID);
	assert.equal(normalizePostId("2026/中文目录/文章.md"), "2026/中文目录/文章.md");
	assert.equal(normalizePostId("../etc/passwd"), null);
	assert.equal(normalizePostId("a?b"), null);
});

test("中文 entry.id 会原样落到 post_id（不退化成 slug）", async () => {
	const env = createEnv();
	const response = await call("/api/comments", post(payload()), env);
	assert.equal(response.status, 201);
	const row = await env.DB.prepare("SELECT post_id FROM comments").first();
	assert.equal(row.post_id, CHINESE_ID);
});

test("按 postId 能查到这篇文章的评论", async () => {
	const env = createEnv();
	await call("/api/comments", post(payload()), env);
	const url = `/api/comments?slug=%2Fposts%2Fbinlog-redo-log%2F&postId=${encodeURIComponent(CHINESE_ID)}`;
	const body = await (await call(url, {}, env)).json();
	assert.equal(body.items.length, 1);
});

test("没给 postId 时不会把 slug 塞进 post_id", async () => {
	const env = createEnv();
	const response = await call("/api/comments", post(payload({ postId: "" })), env);
	assert.equal(response.status, 201);
	const row = await env.DB.prepare("SELECT post_id, slug FROM comments").first();
	assert.equal(row.post_id, "");
	assert.equal(row.slug, "/posts/binlog-redo-log/");
	// 仍能按 slug 回退查到
	const body = await (await call("/api/comments?slug=%2Fposts%2Fbinlog-redo-log%2F", {}, env)).json();
	assert.equal(body.items.length, 1);
});
