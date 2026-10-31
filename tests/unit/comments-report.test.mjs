import test from "node:test";
import assert from "node:assert/strict";
import { reportShouldHold } from "../../worker/comments.js";
import { createEnv, makeCaller } from "../support/d1.mjs";
import worker from "../../worker/index.js";
import { ensureCommentsSchema } from "../../worker/lib/db.js";

const call = makeCaller(worker);

function report(id, ip) {
	return { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": ip }, body: JSON.stringify({ id }) };
}

async function seedComment(env) {
	await ensureCommentsSchema(env);
	await env.DB.prepare(
		`INSERT INTO comments (post_id, slug, parent_id, root_id, depth, name, content, content_hash, status, identity_hash, client_id, created_at)
		 VALUES ('posts/demo.md', '/posts/demo/', NULL, NULL, 0, '楼主', '一楼', 'h', 'approved', 'id', 'root-1', '2026-01-01T00:00:00.000Z')`,
	).run();
	return (await env.DB.prepare("SELECT id FROM comments WHERE client_id = 'root-1'").first()).id;
}

test("累计 3 次举报触发待审", () => {
	assert.equal(reportShouldHold(3), true);
	assert.equal(reportShouldHold(2), false);
});

test("同一 IP 重复举报同一条只算一次", async () => {
	const env = createEnv();
	const id = await seedComment(env);
	await call("/api/comments/report", report(id, "1.1.1.1"), env);
	await call("/api/comments/report", report(id, "1.1.1.1"), env);
	const row = await env.DB.prepare("SELECT report_count FROM comments WHERE id = ?").bind(id).first();
	assert.equal(row.report_count, 1);
});

test("三个不同来源举报后评论自动转待审", async () => {
	const env = createEnv();
	const id = await seedComment(env);
	await call("/api/comments/report", report(id, "1.1.1.1"), env);
	await call("/api/comments/report", report(id, "2.2.2.2"), env);
	await call("/api/comments/report", report(id, "3.3.3.3"), env);
	const row = await env.DB.prepare("SELECT status, report_count FROM comments WHERE id = ?").bind(id).first();
	assert.equal(row.report_count, 3);
	assert.equal(row.status, "pending");
});

test("举报不存在的评论也返回 200，不泄露存在性", async () => {
	const env = createEnv();
	await ensureCommentsSchema(env);
	const response = await call("/api/comments/report", report(999999, "1.1.1.1"), env);
	assert.equal(response.status, 200);
});

test("跨站举报被 403 拒绝", async () => {
	const env = createEnv();
	const id = await seedComment(env);
	const response = await call("/api/comments/report", {
		method: "POST",
		headers: { "content-type": "application/json", origin: "https://evil.test" },
		body: JSON.stringify({ id }),
	}, env);
	assert.equal(response.status, 403);
});
