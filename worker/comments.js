/**
 * 公开的评论接口：读列表、发评论、举报。
 * 公开接口一律不返回 pending / spam / deleted，也不返回任何哈希字段。
 */

import { LIMITS, normalizePostId, normalizeSlug } from "./lib/text.js";
import { ensureCommentsSchema } from "./lib/db.js";

const PAGE_SIZE_DEFAULT = 20;
const PAGE_SIZE_MAX = 50;

export function jsonResponse(body, status = 200, extraHeaders = {}) {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
			...extraHeaders,
		},
	});
}

/** 只暴露给读者看的字段 */
export function toPublicComment(row) {
	return {
		id: row.id,
		name: row.name,
		website: row.website ?? null,
		content: row.content,
		createdAt: row.created_at,
		isAdmin: Boolean(row.is_admin),
		pinned: Boolean(row.pinned),
		depth: row.depth ?? 0,
	};
}

/**
 * 顶级评论 + 各自的回复（扁平两层）。
 * 顶级按置顶优先、时间按 sort 排；回复按时间正序（对话顺序）。
 */
export function buildTree(rows, { sort = "new" } = {}) {
	const list = Array.isArray(rows) ? rows : [];
	const roots = list.filter((row) => (row.depth ?? 0) === 0);
	const replies = list.filter((row) => (row.depth ?? 0) > 0);

	const byId = new Map(list.map((row) => [row.id, row]));
	const direction = sort === "old" ? 1 : -1;
	roots.sort((a, b) => {
		const pinA = Number(a.pinned ? 1 : 0);
		const pinB = Number(b.pinned ? 1 : 0);
		if (pinA !== pinB) return pinB - pinA;
		const byTime = String(a.created_at).localeCompare(String(b.created_at));
		return direction === 1 ? byTime : -byTime;
	});

	const nodes = new Map();
	for (const root of roots) {
		const node = toPublicComment(root);
		node.replies = [];
		nodes.set(root.id, node);
	}

	const orphanReplies = replies.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
	for (const reply of orphanReplies) {
		const parent = byId.get(reply.parent_id);
		const node = toPublicComment(reply);
		// 回复的回复：扁平挂在同一个顶级评论下，用 @昵称 表达指向
		if (parent && reply.parent_id !== reply.root_id) node.replyTo = parent.name;
		const rootNode = nodes.get(reply.root_id);
		if (rootNode) rootNode.replies.push(node);
	}

	return roots.map((root) => nodes.get(root.id));
}

/** 游标：`<ISO 时间>|<id>`，非法一律当第一页处理 */
export function parseCursor(raw) {
	if (typeof raw !== "string" || !raw) return null;
	const index = raw.lastIndexOf("|");
	if (index <= 0) return null;
	const createdAt = raw.slice(0, index);
	const id = Number(raw.slice(index + 1));
	if (!Number.isInteger(id) || id <= 0) return null;
	if (Number.isNaN(Date.parse(createdAt))) return null;
	return { createdAt, id };
}

function clampLimit(raw) {
	if (raw === null || raw === undefined || raw === "") return PAGE_SIZE_DEFAULT;
	const value = Number(raw);
	if (!Number.isFinite(value)) return PAGE_SIZE_DEFAULT;
	return Math.min(PAGE_SIZE_MAX, Math.max(1, Math.floor(value)));
}

/** 文章归属条件：优先用稳定键 post_id，没有就退回 slug */
function postFilter(postId, slug) {
	if (postId) return { clause: "post_id = ?", value: postId };
	return { clause: "slug = ?", value: slug };
}

export async function handleList(request, env, ctx) {
	if (!env?.DB) return jsonResponse({ error: "评论服务还没配置好（缺少数据库绑定）" }, 503);
	const url = new URL(request.url);
	const slug = normalizeSlug(url.searchParams.get("slug") ?? "");
	const postId = normalizePostId(url.searchParams.get("postId") ?? "");
	if (!slug && !postId) return jsonResponse({ error: "缺少文章标识" }, 400);

	const sort = url.searchParams.get("sort") === "old" ? "old" : "new";
	const limit = clampLimit(url.searchParams.get("limit"));
	const cursor = parseCursor(url.searchParams.get("cursor"));
	const filter = postFilter(postId, slug);

	try {
		await ensureCommentsSchema(env);

		let sql = `SELECT * FROM comments WHERE ${filter.clause} AND status = 'approved' AND depth = 0`;
		const params = [filter.value];
		if (cursor) {
			const comparison = sort === "old" ? ">" : "<";
			sql += ` AND (created_at ${comparison} ? OR (created_at = ? AND id ${comparison} ?))`;
			params.push(cursor.createdAt, cursor.createdAt, cursor.id);
		}
		const direction = sort === "old" ? "ASC" : "DESC";
		sql += ` ORDER BY pinned DESC, created_at ${direction}, id ${direction} LIMIT ?`;
		params.push(limit + 1);

		const { results: rootRows = [] } = await env.DB.prepare(sql)
			.bind(...params)
			.all();

		const hasMore = rootRows.length > limit;
		const roots = hasMore ? rootRows.slice(0, limit) : rootRows;

		let replies = [];
		if (roots.length > 0) {
			const placeholders = roots.map(() => "?").join(",");
			const replyResult = await env.DB.prepare(
				`SELECT * FROM comments WHERE root_id IN (${placeholders}) AND status = 'approved' AND depth > 0 ORDER BY created_at ASC, id ASC`,
			)
				.bind(...roots.map((row) => row.id))
				.all();
			replies = replyResult.results ?? [];
		}

		const last = roots[roots.length - 1];
		return jsonResponse({
			items: buildTree([...roots, ...replies], { sort }),
			nextCursor: hasMore && last ? `${last.created_at}|${last.id}` : null,
		});
	} catch (error) {
		console.error("读取评论失败", error);
		return jsonResponse({ error: "评论暂时读不出来，稍后重试" }, 500);
	}
}

export { LIMITS };
