/**
 * 评论区后台接口：列表、审核动作、博主回复、审核模式、屏蔽词。
 * 所有处理函数第一句都是 isAdmin 校验——待审内容绝不能漏给外人。
 */

import { jsonResponse, readLimitedJson } from "./comments.js";
import { ensureCommentsSchema, getCommentMode, setSetting, writeAudit } from "./lib/db.js";
import { isAdmin } from "./lib/admin.js";
import { normalizeContent, validName } from "./lib/text.js";

export const allowedActions = ["approve", "spam", "delete", "restore", "pin", "unpin", "hard_delete"];

const STATUS_BY_ACTION = {
	approve: "approved",
	restore: "approved",
	spam: "spam",
	delete: "deleted",
};

export function nextStatus(action) {
	return STATUS_BY_ACTION[action] ?? null;
}

const STATUS_FILTERS = ["all", "pending", "approved", "spam", "deleted"];

function toAdminComment(row) {
	return {
		id: row.id,
		postId: row.post_id,
		slug: row.slug,
		name: row.name,
		website: row.website ?? null,
		content: row.content,
		createdAt: row.created_at,
		status: row.status,
		isAdmin: Boolean(row.is_admin),
		pinned: Boolean(row.pinned),
		depth: row.depth ?? 0,
		parentId: row.parent_id ?? null,
		rootId: row.root_id ?? null,
		reportCount: row.report_count ?? 0,
	};
}

function parseLimit(raw) {
	const value = Number(raw);
	if (!Number.isFinite(value) || raw === null || raw === "") return 30;
	return Math.min(100, Math.max(1, Math.floor(value)));
}

function parseCursor(raw) {
	if (typeof raw !== "string" || !raw) return null;
	const index = raw.lastIndexOf("|");
	if (index <= 0) return null;
	const createdAt = raw.slice(0, index);
	const id = Number(raw.slice(index + 1));
	if (!Number.isInteger(id) || id <= 0) return null;
	if (Number.isNaN(Date.parse(createdAt))) return null;
	return { createdAt, id };
}

export async function handleAdminList(request, env) {
	if (!(await isAdmin(request, env))) return jsonResponse({ error: "未登录" }, 401);
	if (!env?.DB) return jsonResponse({ error: "数据库还没绑定" }, 503);

	const url = new URL(request.url);
	const status = STATUS_FILTERS.includes(url.searchParams.get("status") ?? "") ? url.searchParams.get("status") : "all";
	const keyword = (url.searchParams.get("q") ?? "").trim().slice(0, 60);
	const postId = (url.searchParams.get("postId") ?? "").trim().slice(0, 200);
	const limit = parseLimit(url.searchParams.get("limit"));
	const cursor = parseCursor(url.searchParams.get("cursor"));

	try {
		await ensureCommentsSchema(env);

		const conditions = [];
		const params = [];
		if (status !== "all") {
			conditions.push("status = ?");
			params.push(status);
		}
		if (keyword) {
			conditions.push("(name LIKE ? OR content LIKE ?)");
			params.push(`%${keyword}%`, `%${keyword}%`);
		}
		if (postId) {
			conditions.push("post_id = ?");
			params.push(postId);
		}
		if (cursor) {
			conditions.push("(created_at < ? OR (created_at = ? AND id < ?))");
			params.push(cursor.createdAt, cursor.createdAt, cursor.id);
		}

		const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
		const { results = [] } = await env.DB.prepare(
			`SELECT * FROM comments ${where} ORDER BY created_at DESC, id DESC LIMIT ?`,
		)
			.bind(...params, limit + 1)
			.all();

		const hasMore = results.length > limit;
		const rows = hasMore ? results.slice(0, limit) : results;
		const last = rows[rows.length - 1];

		// 「今日」按北京时间算，和后台其它统计口径一致
		const nowMs = Date.now();
		const offsetMs = 8 * 3600 * 1000;
		const local = new Date(nowMs + offsetMs);
		const dayStartMs = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - offsetMs;
		const todayIso = new Date(dayStartMs).toISOString();

		const stats = await env.DB.prepare(
			`SELECT
         SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
         SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved,
         SUM(CASE WHEN report_count > 0 THEN 1 ELSE 0 END) AS reported,
         SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS today,
         COUNT(*) AS total
       FROM comments`,
		)
			.bind(todayIso)
			.first();

		return jsonResponse({
			items: rows.map(toAdminComment),
			nextCursor: hasMore && last ? `${last.created_at}|${last.id}` : null,
			stats: {
				pending: Number(stats?.pending ?? 0),
				approved: Number(stats?.approved ?? 0),
				reported: Number(stats?.reported ?? 0),
				today: Number(stats?.today ?? 0),
				total: Number(stats?.total ?? 0),
			},
			mode: await getCommentMode(env.DB),
		});
	} catch (error) {
		console.error("读取待审评论失败", error);
		return jsonResponse({ error: "评论列表读不出来，稍后重试" }, 500);
	}
}

export async function handleAdminAction(request, env) {
	if (!(await isAdmin(request, env))) return jsonResponse({ error: "未登录" }, 401);
	if (!env?.DB) return jsonResponse({ error: "数据库还没绑定" }, 503);

	let body;
	try {
		body = await readLimitedJson(request);
	} catch (error) {
		return jsonResponse({ error: error.message }, error.status ?? 400);
	}

	const id = Number(body?.id);
	const action = String(body?.action ?? "");
	if (!Number.isInteger(id) || id <= 0) return jsonResponse({ error: "缺少评论 id" }, 400);
	if (!allowedActions.includes(action)) return jsonResponse({ error: "没有这个操作" }, 400);

	try {
		await ensureCommentsSchema(env);
		const now = new Date().toISOString();

		if (action === "hard_delete") {
			await env.DB.prepare("DELETE FROM comments WHERE id = ?").bind(id).run();
		} else if (action === "pin" || action === "unpin") {
			await env.DB.prepare("UPDATE comments SET pinned = ?, updated_at = ? WHERE id = ?")
				.bind(action === "pin" ? 1 : 0, now, id)
				.run();
		} else {
			const status = nextStatus(action);
			await env.DB.prepare("UPDATE comments SET status = ?, updated_at = ?, deleted_at = ? WHERE id = ?")
				.bind(status, now, status === "deleted" ? now : null, id)
				.run();
		}

		await writeAudit(env.DB, action, id, null);
		return jsonResponse({ ok: true });
	} catch (error) {
		console.error("审核操作失败", error);
		return jsonResponse({ error: "操作没成功，稍后重试", retryable: true }, 500);
	}
}

export async function handleAdminReply(request, env) {
	if (!(await isAdmin(request, env))) return jsonResponse({ error: "未登录" }, 401);
	if (!env?.DB) return jsonResponse({ error: "数据库还没绑定" }, 503);

	let body;
	try {
		body = await readLimitedJson(request);
	} catch (error) {
		return jsonResponse({ error: error.message }, error.status ?? 400);
	}

	const targetId = Number(body?.id);
	const content = normalizeContent(body?.content ?? "");
	const name = validName(body?.name ?? "博主") ?? "博主";
	if (!Number.isInteger(targetId) || targetId <= 0) return jsonResponse({ error: "缺少评论 id" }, 400);
	if (!content) return jsonResponse({ error: "回复不能为空" }, 400);

	try {
		await ensureCommentsSchema(env);
		const target = await env.DB.prepare("SELECT * FROM comments WHERE id = ?").bind(targetId).first();
		if (!target) return jsonResponse({ error: "这条评论不在了" }, 404);

		const rootId = target.depth === 0 ? target.id : (target.root_id ?? target.id);
		const createdAt = new Date().toISOString();
		const clientId = crypto.randomUUID();
		await env.DB.prepare(
			`INSERT INTO comments (post_id, slug, parent_id, root_id, depth, name, email_hash, website, content, content_hash,
        status, is_admin, pinned, report_count, identity_hash, ip_hash, ua_hash, client_id, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, 1, ?, NULL, NULL, ?, ?, 'approved', 1, 0, 0, 'admin', NULL, NULL, ?, ?, NULL, NULL)`,
		)
			.bind(target.post_id, target.slug, target.id, rootId, name, content, content, clientId, createdAt)
			.run();

		const inserted = await env.DB.prepare("SELECT * FROM comments WHERE client_id = ?").bind(clientId).first();
		await writeAudit(env.DB, "reply", target.id, null);
		return jsonResponse({ item: toAdminComment(inserted) }, 201);
	} catch (error) {
		console.error("博主回复失败", error);
		return jsonResponse({ error: "回复没发出去，稍后重试", retryable: true }, 500);
	}
}

export async function handleAdminSettings(request, env) {
	if (!(await isAdmin(request, env))) return jsonResponse({ error: "未登录" }, 401);
	if (!env?.DB) return jsonResponse({ error: "数据库还没绑定" }, 503);

	try {
		await ensureCommentsSchema(env);
		if (request.method === "GET") {
			return jsonResponse({ mode: await getCommentMode(env.DB) });
		}

		let body;
		try {
			body = await readLimitedJson(request);
		} catch (error) {
			return jsonResponse({ error: error.message }, error.status ?? 400);
		}
		const mode = String(body?.mode ?? "");
		if (mode !== "auto" && mode !== "hold") return jsonResponse({ error: "审核模式只能是 auto 或 hold" }, 400);
		await setSetting(env.DB, "comment_mode", mode);
		await writeAudit(env.DB, "settings", mode, null);
		return jsonResponse({ ok: true, mode });
	} catch (error) {
		console.error("审核设置失败", error);
		return jsonResponse({ error: "设置没保存，稍后重试" }, 500);
	}
}

export async function handleAdminKeywords(request, env) {
	if (!(await isAdmin(request, env))) return jsonResponse({ error: "未登录" }, 401);
	if (!env?.DB) return jsonResponse({ error: "数据库还没绑定" }, 503);

	const url = new URL(request.url);

	try {
		await ensureCommentsSchema(env);

		if (request.method === "GET") {
			const { results = [] } = await env.DB.prepare("SELECT id, word FROM comment_keywords ORDER BY id DESC").all();
			return jsonResponse({ items: results.map((row) => ({ id: row.id, word: row.word })) });
		}

		if (request.method === "DELETE") {
			const id = Number(url.searchParams.get("id"));
			if (!Number.isInteger(id) || id <= 0) return jsonResponse({ error: "缺少屏蔽词 id" }, 400);
			await env.DB.prepare("DELETE FROM comment_keywords WHERE id = ?").bind(id).run();
			return jsonResponse({ ok: true });
		}

		if (request.method !== "POST") return jsonResponse({ error: "只支持 GET / POST / DELETE" }, 405);

		let body;
		try {
			body = await readLimitedJson(request);
		} catch (error) {
			return jsonResponse({ error: error.message }, error.status ?? 400);
		}
		const word = String(body?.word ?? "").trim();
		if (!word || word.length > 40) return jsonResponse({ error: "屏蔽词得是 1–40 个字" }, 400);
		await env.DB.prepare("INSERT OR IGNORE INTO comment_keywords (word, ts) VALUES (?, ?)")
			.bind(word, new Date().toISOString())
			.run();
		return jsonResponse({ ok: true });
	} catch (error) {
		console.error("屏蔽词操作失败", error);
		return jsonResponse({ error: "操作没成功，稍后重试" }, 500);
	}
}

