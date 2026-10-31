import test from "node:test";
import assert from "node:assert/strict";
import { readLimitedJson, buildCommentRow } from "../../worker/comments.js";
import { createEnv, makeCaller } from "../support/d1.mjs";
import worker from "../../worker/index.js";
import { ensureCommentsSchema } from "../../worker/lib/db.js";

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

function post(body, headers = {}) {
	return {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: typeof body === "string" ? body : JSON.stringify(body),
	};
}

test("content-length 超限直接拒绝，不读 body", async () => {
	const request = new Request("https://blog.test/api/comments", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: "{}",
	});
	const fake = { headers: new Headers({ "content-length": String(999999), "content-type": "application/json" }), text: request.text.bind(request) };
	await assert.rejects(
		() => readLimitedJson(fake),
		(error) => error.status === 413,
	);
});

test("非 JSON 请求体报 400", async () => {
	const fake = { headers: new Headers({ "content-type": "application/json" }), text: async () => "not json" };
	await assert.rejects(
		() => readLimitedJson(fake),
		(error) => error.status === 400,
	);
});

test("buildCommentRow 填好派生字段与默认状态", async () => {
	const row = await buildCommentRow({
		slug: "/posts/a/",
		postId: "posts/a.md",
		name: "小明",
		content: "你好\n\n世界",
		identityHash: "id1",
		ipHash: "ip1",
		clientId: "c1",
		parentId: null,
		website: null,
		emailHash: null,
	});
	assert.equal(row.depth, 0);
	assert.equal(row.status, "approved");
	assert.equal(row.content, "你好\n\n世界");
	assert.match(row.content_hash, /^[0-9a-f]{64}$/);
	assert.ok(row.created_at.endsWith("Z"));
});

test("正常发一条：201、立即可见、下发身份 cookie", async () => {
	const env = createEnv();
	const response = await call("/api/comments", post(payload()), env);
	assert.equal(response.status, 201);
	const body = await response.json();
	assert.equal(body.status, "approved");
	assert.equal(body.item.content, "第一条评论");
	assert.match(response.headers.get("set-cookie") ?? "", /wkb_commenter=/);
	assert.match(response.headers.get("set-cookie") ?? "", /HttpOnly/);
});

test("同一 clientId 重复提交只有一条（幂等）", async () => {
	const env = createEnv();
	const first = await (await call("/api/comments", post(payload()), env)).json();
	const second = await (await call("/api/comments", post(payload()), env)).json();
	assert.equal(first.item.id, second.item.id);
	const { results } = await env.DB.prepare("SELECT COUNT(*) AS n FROM comments").all();
	assert.equal(results[0].n, 1);
});

test("XSS 载荷按原文本存储与返回，不转义成实体也不丢内容", async () => {
	const env = createEnv();
	const xss = '<img src=x onerror=alert(1)><script>alert(1)</script>';
	const response = await call("/api/comments", post(payload({ content: xss, clientId: "22222222-2222-4222-8222-222222222222" })), env);
	const body = await response.json();
	assert.equal(body.item.content, xss);
});

test("两条以上链接进待审", async () => {
	const env = createEnv();
	const response = await call(
		"/api/comments",
		post(payload({ content: "看 https://a.com 和 https://b.com", clientId: "33333333-3333-4333-8333-333333333333" })),
		env,
	);
	const body = await response.json();
	assert.equal(body.status, "pending");
});

test("蜜罐命中：返回 200 但落库为 spam", async () => {
	const env = createEnv();
	const response = await call("/api/comments", post(payload({ honey: "机器人", clientId: "44444444-4444-4444-8444-444444444444" })), env);
	assert.equal(response.status, 200);
	const { results } = await env.DB.prepare("SELECT status FROM comments").all();
	assert.deepEqual(results.map((row) => row.status), ["spam"]);
});

test("连发第二条触发 429 并给出 retryAfter", async () => {
	const env = createEnv();
	await call("/api/comments", post(payload()), env);
	const second = await call("/api/comments", post(payload({ clientId: "55555555-5555-4555-8555-555555555555", content: "第二条" })), env);
	assert.equal(second.status, 429);
	const body = await second.json();
	assert.ok(body.retryAfter > 0);
});

test("跨站 Origin 被 403 拒绝", async () => {
	const env = createEnv();
	const response = await call("/api/comments", post(payload(), { origin: "https://evil.test" }), env);
	assert.equal(response.status, 403);
});

test("空昵称/空正文被 400 拒绝", async () => {
	const env = createEnv();
	assert.equal((await call("/api/comments", post(payload({ name: "   " })), env)).status, 400);
	assert.equal((await call("/api/comments", post(payload({ content: "   " })), env)).status, 400);
});

test("回复挂到顶级评论下，depth 恒为 1", async () => {
	const env = createEnv();
	await ensureCommentsSchema(env);
	await env.DB.prepare(
		`INSERT INTO comments (post_id, slug, parent_id, root_id, depth, name, content, content_hash, status, identity_hash, client_id, created_at)
		 VALUES ('posts/demo.md', '/posts/demo/', NULL, NULL, 0, '楼主', '一楼', 'h', 'approved', 'id', 'root-1', '2026-01-01T00:00:00.000Z')`,
	).run();
	const rootId = (await env.DB.prepare("SELECT id FROM comments WHERE client_id = 'root-1'").first()).id;

	const response = await call(
		"/api/comments",
		post(payload({ parentId: rootId, content: "回复一句", clientId: "66666666-6666-4666-8666-666666666666" })),
		env,
	);
	const body = await response.json();
	assert.equal(body.item.depth, 1);
	const row = await env.DB.prepare("SELECT root_id FROM comments WHERE client_id = '66666666-6666-4666-8666-666666666666'").first();
	assert.equal(row.root_id, rootId);
});
