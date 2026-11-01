import test from "node:test";
import assert from "node:assert/strict";
import { createEnv, makeCaller } from "../support/d1.mjs";
import worker from "../../worker/index.js";
import { ensureCommentsSchema } from "../../worker/lib/db.js";

const call = makeCaller(worker);

async function seed(env, count, { pinOldest = false } = {}) {
	await ensureCommentsSchema(env);
	for (let index = 0; index < count; index++) {
		await env.DB.prepare(
			`INSERT INTO comments (post_id, slug, parent_id, root_id, depth, name, content, content_hash, status, pinned, identity_hash, client_id, created_at)
			 VALUES ('posts/demo.md', '/posts/demo/', NULL, NULL, 0, ?, ?, ?, 'approved', ?, 'id', ?, ?)`,
		)
			.bind(
				`访客${index}`,
				`第 ${index} 条`,
				`h${index}`,
				pinOldest && index === 0 ? 1 : 0,
				`c${index}`,
				`2026-01-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
			)
			.run();
	}
}

test("置顶 + 分页：不重复、不遗漏", async () => {
	const env = createEnv();
	await seed(env, 25, { pinOldest: true });

	const first = await (await call("/api/comments?slug=%2Fposts%2Fdemo%2F&limit=20", {}, env)).json();
	// 置顶的额外占用页首，所以第一页是 limit + 置顶条数
	assert.ok(first.items.length >= 20 && first.items.length <= 21, `第一页 ${first.items.length} 条`);
	assert.equal(first.items[0].pinned, true, "置顶的应当排第一");
	assert.ok(first.nextCursor);

	const second = await (
		await call(`/api/comments?slug=%2Fposts%2Fdemo%2F&limit=20&cursor=${encodeURIComponent(first.nextCursor)}`, {}, env)
	).json();

	const ids = [...first.items, ...second.items].map((item) => item.id);
	assert.equal(ids.length, 25, `实际拿到 ${ids.length} 条`);
	assert.equal(new Set(ids).size, 25, "有重复的评论");
});

test("置顶只有一条时也只出现一次", async () => {
	const env = createEnv();
	await seed(env, 21, { pinOldest: true });
	const first = await (await call("/api/comments?slug=%2Fposts%2Fdemo%2F&limit=20", {}, env)).json();
	const pinned = first.items.filter((item) => item.pinned);
	assert.equal(pinned.length, 1);
});

