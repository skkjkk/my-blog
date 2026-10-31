import test from "node:test";
import assert from "node:assert/strict";
import { toPublicComment, buildTree, parseCursor } from "../../worker/comments.js";
import { createEnv, makeCaller } from "../support/d1.mjs";
import worker from "../../worker/index.js";
import { ensureCommentsSchema } from "../../worker/lib/db.js";

const call = makeCaller(worker);

test("toPublicComment 丢弃内部字段", () => {
	const row = {
		id: 1,
		name: "小明",
		content: "hi",
		website: null,
		is_admin: 0,
		pinned: 0,
		depth: 0,
		status: "approved",
		created_at: "2026-01-01T00:00:00.000Z",
		ip_hash: "x",
		email_hash: "y",
		identity_hash: "z",
	};
	assert.deepEqual(Object.keys(toPublicComment(row)).sort(), [
		"content",
		"createdAt",
		"depth",
		"id",
		"isAdmin",
		"name",
		"pinned",
		"website",
	]);
});

test("buildTree 把回复挂到顶级评论下，二级挂到一级", () => {
	const rows = [
		{ id: 1, root_id: 1, parent_id: null, depth: 0, created_at: "2026-01-01", name: "楼主" },
		{ id: 2, root_id: 1, parent_id: 1, depth: 1, created_at: "2026-01-02", name: "访客甲" },
		{ id: 3, root_id: 1, parent_id: 2, depth: 1, created_at: "2026-01-03", name: "访客乙" },
	];
	const tree = buildTree(rows);
	assert.equal(tree.length, 1);
	assert.deepEqual(
		tree[0].replies.map((reply) => reply.id),
		[2, 3],
	);
	assert.equal(tree[0].replies[1].replyTo, "访客甲");
});

test("buildTree 置顶评论排在最前", () => {
	const rows = [
		{ id: 1, root_id: 1, parent_id: null, depth: 0, created_at: "2026-01-01", name: "a", pinned: 0 },
		{ id: 2, root_id: 2, parent_id: null, depth: 0, created_at: "2026-01-02", name: "b", pinned: 1 },
	];
	assert.deepEqual(
		buildTree(rows).map((item) => item.id),
		[2, 1],
	);
});

test("parseCursor 非法输入返回 null", () => {
	assert.equal(parseCursor(""), null);
	assert.equal(parseCursor("garbage"), null);
	assert.deepEqual(parseCursor("2026-01-01T00:00:00.000Z|12"), { createdAt: "2026-01-01T00:00:00.000Z", id: 12 });
});

async function seed(env, rows) {
	await ensureCommentsSchema(env);
	for (const row of rows) {
		await env.DB.prepare(
			`INSERT INTO comments (post_id, slug, parent_id, root_id, depth, name, content, content_hash, status, identity_hash, client_id, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
			.bind(
				row.postId ?? "posts/demo.md",
				row.slug ?? "/posts/demo/",
				row.parentId ?? null,
				row.rootId ?? null,
				row.depth ?? 0,
				row.name ?? "访客",
				row.content ?? "内容",
				row.hash ?? "h",
				row.status ?? "approved",
				"id-hash",
				row.clientId,
				row.createdAt,
			)
			.run();
	}
}

test("列表接口只返回 approved，待审与垃圾不泄漏", async () => {
	const env = createEnv();
	await seed(env, [
		{ clientId: "c1", createdAt: "2026-01-01T00:00:00.000Z", content: "看得见的" },
		{ clientId: "c2", createdAt: "2026-01-02T00:00:00.000Z", content: "待审的", status: "pending" },
		{ clientId: "c3", createdAt: "2026-01-03T00:00:00.000Z", content: "垃圾的", status: "spam" },
	]);
	const response = await call("/api/comments?slug=%2Fposts%2Fdemo%2F", {}, env);
	assert.equal(response.status, 200);
	const body = await response.json();
	assert.equal(body.items.length, 1);
	assert.equal(body.items[0].content, "看得见的");
	assert.equal(JSON.stringify(body).includes("待审的"), false);
	assert.equal(JSON.stringify(body).includes("ip_hash"), false);
});

test("分页游标翻页不重叠、不遗漏", async () => {
	const env = createEnv();
	const rows = Array.from({ length: 25 }, (_, index) => ({
		clientId: `c${index}`,
		createdAt: `2026-01-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
		content: `第 ${index} 条`,
	}));
	await seed(env, rows);

	const first = await (await call("/api/comments?slug=%2Fposts%2Fdemo%2F", {}, env)).json();
	assert.equal(first.items.length, 20);
	assert.ok(first.nextCursor);

	const second = await (
		await call(`/api/comments?slug=%2Fposts%2Fdemo%2F&cursor=${encodeURIComponent(first.nextCursor)}`, {}, env)
	).json();
	assert.equal(second.items.length, 5);
	const seen = new Set([...first.items, ...second.items].map((item) => item.id));
	assert.equal(seen.size, 25);
});

test("缺 slug 报 400", async () => {
	const env = createEnv();
	const response = await call("/api/comments", {}, env);
	assert.equal(response.status, 400);
});
