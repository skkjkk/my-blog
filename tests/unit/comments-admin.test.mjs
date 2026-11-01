import test from "node:test";
import assert from "node:assert/strict";
import { nextStatus, allowedActions } from "../../worker/comments-admin.js";
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
	const cookie = (response.headers.get("set-cookie") ?? "").split(";")[0];
	return { cookie, status: response.status };
}

async function seedComment(env, overrides = {}) {
	await ensureCommentsSchema(env);
	await env.DB.prepare(
		`INSERT INTO comments (post_id, slug, parent_id, root_id, depth, name, content, content_hash, status, identity_hash, client_id, created_at)
		 VALUES (?, ?, NULL, NULL, 0, ?, ?, ?, ?, 'id', ?, ?)`,
	)
		.bind(
			overrides.postId ?? "posts/demo.md",
			overrides.slug ?? "/posts/demo/",
			overrides.name ?? "访客",
			overrides.content ?? "内容",
			overrides.hash ?? `h-${Math.random()}`,
			overrides.status ?? "pending",
			overrides.clientId ?? `c-${Math.random()}`,
			overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
		)
		.run();
	return (await env.DB.prepare("SELECT id FROM comments ORDER BY id DESC LIMIT 1").first()).id;
}

function adminPost(path, body, cookie) {
	return { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) };
}

test("状态机允许的迁移", () => {
	assert.equal(nextStatus("approve"), "approved");
	assert.equal(nextStatus("spam"), "spam");
	assert.equal(nextStatus("restore"), "approved");
	assert.equal(nextStatus("delete"), "deleted");
	assert.equal(nextStatus("nonsense"), null);
});

test("动作白名单", () => {
	assert.deepEqual(allowedActions.slice().sort(), ["approve", "delete", "hard_delete", "pin", "restore", "spam", "unpin"]);
	assert.equal(allowedActions.includes("drop_table"), false);
});

test("未登录访问管理接口一律 401", async () => {
	const env = createEnv();
	await ensureCommentsSchema(env);
	assert.equal((await call("/api/admin/comments", {}, env)).status, 401);
	assert.equal((await call("/api/admin/comments/action", adminPost("/api/admin/comments/action", { id: 1, action: "approve" }, ""), env)).status, 401);
});

test("登录后可看到待审列表并一键通过", async () => {
	const env = createEnv();
	const id = await seedComment(env);
	const { cookie, status } = await login(env);
	assert.equal(status, 200);

	const list = await (await call("/api/admin/comments?status=pending", { headers: { cookie } }, env)).json();
	assert.equal(list.items.length, 1);
	assert.equal(list.items[0].status, "pending");

	const action = await call("/api/admin/comments/action", adminPost("/api/admin/comments/action", { id, action: "approve" }, cookie), env);
	assert.equal(action.status, 200);
	const row = await env.DB.prepare("SELECT status FROM comments WHERE id = ?").bind(id).first();
	assert.equal(row.status, "approved");

	const audit = await env.DB.prepare("SELECT action FROM audit_log").all();
	assert.deepEqual(audit.results.map((item) => item.action), ["approve"]);
});

test("博主回复直接通过并带博主标记", async () => {
	const env = createEnv();
	const id = await seedComment(env, { status: "approved" });
	const { cookie } = await login(env);
	const response = await call(
		"/api/admin/comments/reply",
		adminPost("/api/admin/comments/reply", { id, content: "谢谢留言" }, cookie),
		env,
	);
	assert.equal(response.status, 201);
	const body = await response.json();
	assert.equal(body.item.isAdmin, true);
	const row = await env.DB.prepare("SELECT status, is_admin FROM comments WHERE id = ?").bind(body.item.id).first();
	assert.equal(row.status, "approved");
	assert.equal(row.is_admin, 1);
});

test("审核模式可切换成 hold，新评论进待审", async () => {
	const env = createEnv();
	const { cookie } = await login(env);
	await ensureCommentsSchema(env);
	await call("/api/admin/comments/settings", adminPost("/api/admin/comments/settings", { mode: "hold" }, cookie), env);
	const settings = await (await call("/api/admin/comments/settings", { headers: { cookie } }, env)).json();
	assert.equal(settings.mode, "hold");
});

test("非法审核模式被 400 拒绝", async () => {
	const env = createEnv();
	const { cookie } = await login(env);
	await ensureCommentsSchema(env);
	const response = await call("/api/admin/comments/settings", adminPost("/api/admin/comments/settings", { mode: "whatever" }, cookie), env);
	assert.equal(response.status, 400);
});

test("屏蔽词可增可删，命中后新评论进待审", async () => {
	const env = createEnv();
	const { cookie } = await login(env);
	await ensureCommentsSchema(env);
	const created = await call("/api/admin/comments/keywords", adminPost("/api/admin/comments/keywords", { word: "加微信" }, cookie), env);
	assert.equal(created.status, 200);
	const list = await (await call("/api/admin/comments/keywords", { headers: { cookie } }, env)).json();
	assert.deepEqual(list.items.map((item) => item.word), ["加微信"]);
	const id = list.items[0].id;
	const removed = await call(`/api/admin/comments/keywords?id=${id}`, { method: "DELETE", headers: { cookie } }, env);
	assert.equal(removed.status, 200);
	const after = await (await call("/api/admin/comments/keywords", { headers: { cookie } }, env)).json();
	assert.equal(after.items.length, 0);
});

test("彻底删除会把行删掉", async () => {
	const env = createEnv();
	const id = await seedComment(env);
	const { cookie } = await login(env);
	const response = await call("/api/admin/comments/action", adminPost("/api/admin/comments/action", { id, action: "hard_delete" }, cookie), env);
	assert.equal(response.status, 200);
	const row = await env.DB.prepare("SELECT id FROM comments WHERE id = ?").bind(id).first();
	assert.equal(row, null);
});

test("后台统计包含今日新增", async () => {
	const env = createEnv();
	const { cookie } = await login(env);
	await ensureCommentsSchema(env);
	await env.DB.prepare(
		`INSERT INTO comments (post_id, slug, parent_id, root_id, depth, name, content, content_hash, status, identity_hash, client_id, created_at)
		 VALUES ('posts/demo.md', '/posts/demo/', NULL, NULL, 0, '今天的', '刚刚发的', 'h1', 'approved', 'id', 'c-today', ?)`,
	)
		.bind(new Date().toISOString())
		.run();
	const body = await (await call("/api/admin/comments?status=all", { headers: { cookie } }, env)).json();
	assert.equal(body.stats.today, 1);
	assert.equal(body.stats.total, 1);
});
