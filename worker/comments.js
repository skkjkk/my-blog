/**
 * 公开的评论接口：读列表、发评论、举报。
 * 公开接口一律不返回 pending / spam / deleted，也不返回任何哈希字段。
 */

import {
	LIMITS,
	countLinks,
	isUuid,
	normalizeContent,
	normalizePostId,
	normalizeSlug,
	safeUrl,
	validEmailShape,
	validName,
} from "./lib/text.js";
import { ensureCommentsSchema, getCommentMode } from "./lib/db.js";
import { hashIp, identityHash, newUid, sha256Hex, signIdentity, verifyIdentity } from "./lib/crypto.js";
import { rateCheck, ratePrune, rateRecord } from "./lib/rate.js";
import { classifyComment, detectBot } from "./lib/classify.js";

const IDENTITY_COOKIE = "wkb_commenter";
const IDENTITY_MAX_AGE = 15552000; // 180 天

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

export const DELETED_PLACEHOLDER = "该评论已被删除";

/**
 * 只暴露给读者看的字段。
 * 软删除的评论保留占位，避免楼中楼塌掉——但名字与正文一律抹掉。
 */
export function toPublicComment(row) {
	const removed = row.status === "deleted";
	return {
		id: row.id,
		name: removed ? "已删除" : row.name,
		website: removed ? null : (row.website ?? null),
		content: removed ? DELETED_PLACEHOLDER : row.content,
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

		let sql = `SELECT * FROM comments WHERE ${filter.clause} AND status IN ('approved', 'deleted') AND depth = 0`;
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
				`SELECT * FROM comments WHERE root_id IN (${placeholders}) AND status IN ('approved', 'deleted') AND depth > 0 ORDER BY created_at ASC, id ASC`,
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

// ---------------- 举报 ----------------

export const REPORT_HOLD_THRESHOLD = 3;

export function reportShouldHold(count) {
	return Number(count) >= REPORT_HOLD_THRESHOLD;
}

export async function handleReport(request, env, ctx) {
	if (!env?.DB) return jsonResponse({ error: "评论服务还没配置好（缺少数据库绑定）" }, 503);
	if (!sameOrigin(request)) return jsonResponse({ error: "来源校验没通过" }, 403);

	let body;
	try {
		body = await readLimitedJson(request);
	} catch (error) {
		return jsonResponse({ error: error.message }, error.status ?? 400);
	}

	const id = Number(body?.id);
	if (!Number.isInteger(id) || id <= 0) return jsonResponse({ error: "没找到要举报的评论" }, 400);

	const salt = (env.IP_SALT ?? "").trim() || "wkb-comments";
	const ipHash = await hashIp(
		request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for") ?? "unknown",
		salt,
	);

	try {
		await ensureCommentsSchema(env);
		const target = await env.DB.prepare("SELECT id, status FROM comments WHERE id = ?").bind(id).first();
		// 不存在 / 已删除：照样 200，不告诉对方"这条评论存不存在"
		if (!target || target.status === "deleted") return jsonResponse({ ok: true });

		const inserted = await env.DB
			.prepare("INSERT OR IGNORE INTO comment_reports (comment_id, ip_hash, ts) VALUES (?, ?, ?)")
			.bind(id, ipHash, new Date().toISOString())
			.run();
		const changed = Number(inserted?.meta?.changes ?? 0);
		if (changed === 0) return jsonResponse({ ok: true });

		await env.DB.prepare("UPDATE comments SET report_count = report_count + 1 WHERE id = ?").bind(id).run();
		const row = await env.DB.prepare("SELECT report_count, status FROM comments WHERE id = ?").bind(id).first();
		if (row && reportShouldHold(row.report_count) && row.status === "approved") {
			await env.DB.prepare("UPDATE comments SET status = 'pending', updated_at = ? WHERE id = ?")
				.bind(new Date().toISOString(), id)
				.run();
		}
		return jsonResponse({ ok: true });
	} catch (error) {
		console.error("举报失败", error);
		return jsonResponse({ error: "举报没成功，稍后再试", retryable: true }, 500);
	}
}

// ---------------- 发表评论 ----------------

function httpError(status, message) {
	const error = new Error(message);
	error.status = status;
	error.expose = true;
	return error;
}

/** 请求体上限：先看 content-length，读完再兜一次（防伪造） */
export async function readLimitedJson(request) {
	const declared = Number(request.headers.get("content-length") ?? "");
	if (Number.isFinite(declared) && declared > LIMITS.bodyBytes) throw httpError(413, "内容太长了");
	const text = await request.text();
	if (text.length > LIMITS.bodyBytes) throw httpError(413, "内容太长了");
	try {
		return JSON.parse(text);
	} catch {
		throw httpError(400, "请求格式不对");
	}
}

function readCookie(request, name) {
	const cookie = request.headers.get("cookie") ?? "";
	for (const part of cookie.split(";")) {
		const [key, ...rest] = part.trim().split("=");
		if (key === name) return rest.join("=");
	}
	return "";
}

function identityCookie(value, maxAge) {
	return `${IDENTITY_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

/** 只接受本站发起的写请求 */
function sameOrigin(request) {
	const siteOrigin = new URL(request.url).origin;
	const origin = request.headers.get("origin");
	if (origin && origin !== siteOrigin) return false;
	if ((request.headers.get("sec-fetch-site") ?? "") === "cross-site") return false;
	return true;
}

/**
 * Cloudflare Turnstile 校验。没配 secret 就整体跳过（降级到蜜罐 + 频率限制）；
 * 配了但校验不过——包括校验服务自己挂了——一律按机器人处理（安全优先）。
 */
async function verifyTurnstile(env, token, ip) {
	const secret = (env?.TURNSTILE_SECRET ?? "").trim();
	if (!secret) return { enabled: false, ok: true };
	if (!token) return { enabled: true, ok: false };

	const form = new URLSearchParams();
	form.set("secret", secret);
	form.set("response", String(token));
	if (ip && ip !== "unknown") form.set("remoteip", ip);

	try {
		const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
			method: "POST",
			body: form,
		});
		const data = await response.json().catch(() => null);
		return { enabled: true, ok: data?.success === true };
	} catch (error) {
		console.warn("Turnstile 校验失败，按机器人处理", error);
		return { enabled: true, ok: false };
	}
}

/** 组装待写入的行（纯派生，不碰数据库） */
export async function buildCommentRow(input) {
	const content = normalizeContent(input.content);
	const normalized = content.toLowerCase().replace(/\s+/g, " ");
	return {
		post_id: input.postId,
		slug: input.slug,
		parent_id: input.parentId ?? null,
		root_id: input.rootId ?? null,
		depth: input.parentId ? 1 : 0,
		name: input.name,
		email_hash: input.emailHash ?? null,
		website: input.website ?? null,
		content,
		content_hash: await sha256Hex(normalized),
		status: input.status ?? "approved",
		is_admin: input.isAdmin ? 1 : 0,
		pinned: 0,
		report_count: 0,
		identity_hash: input.identityHash,
		ip_hash: input.ipHash ?? null,
		ua_hash: input.uaHash ?? null,
		client_id: input.clientId,
		created_at: new Date().toISOString(),
		updated_at: null,
		deleted_at: null,
	};
}

const INSERT_SQL = `INSERT INTO comments
  (post_id, slug, parent_id, root_id, depth, name, email_hash, website, content, content_hash,
   status, is_admin, pinned, report_count, identity_hash, ip_hash, ua_hash, client_id, created_at, updated_at, deleted_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

function insertValues(row) {
	return [
		row.post_id,
		row.slug,
		row.parent_id,
		row.root_id,
		row.depth,
		row.name,
		row.email_hash,
		row.website,
		row.content,
		row.content_hash,
		row.status,
		row.is_admin,
		row.pinned,
		row.report_count,
		row.identity_hash,
		row.ip_hash,
		row.ua_hash,
		row.client_id,
		row.created_at,
		row.updated_at,
		row.deleted_at,
	];
}

async function findByClientId(db, clientId) {
	return db.prepare("SELECT * FROM comments WHERE client_id = ?").bind(clientId).first();
}

async function keywordHit(db, content) {
	const { results = [] } = await db.prepare("SELECT word FROM comment_keywords").all();
	const text = content.toLowerCase();
	return results.some((row) => row.word && text.includes(String(row.word).toLowerCase()));
}

async function duplicateRecently(db, identity, contentHash, now) {
	const since = new Date(now - 24 * 3600 * 1000).toISOString();
	const row = await db
		.prepare("SELECT 1 AS hit FROM comments WHERE identity_hash = ? AND content_hash = ? AND created_at > ? LIMIT 1")
		.bind(identity, contentHash, since)
		.first();
	return Boolean(row);
}

async function priorReportsOf(db, identity) {
	const row = await db
		.prepare("SELECT COALESCE(SUM(report_count), 0) AS n FROM comments WHERE identity_hash = ?")
		.bind(identity)
		.first();
	return Number(row?.n ?? 0);
}

export async function handleCreate(request, env, ctx) {
	if (!env?.DB) return jsonResponse({ error: "评论服务还没配置好（缺少数据库绑定）" }, 503);
	if (!sameOrigin(request)) return jsonResponse({ error: "来源校验没通过" }, 403);

	let body;
	try {
		body = await readLimitedJson(request);
	} catch (error) {
		return jsonResponse({ error: error.message }, error.status ?? 400);
	}

	const slug = normalizeSlug(body?.slug ?? "");
	const postId = normalizePostId(body?.postId ?? "");
	const name = validName(body?.name ?? "");
	const content = normalizeContent(body?.content ?? "");
	const clientId = String(body?.clientId ?? "").trim();

	if (!slug && !postId) return jsonResponse({ error: "缺少文章标识" }, 400);
	if (!name) return jsonResponse({ error: "昵称不能为空（最多 24 个字）" }, 400);
	if (!content) return jsonResponse({ error: "评论不能为空" }, 400);
	if (!isUuid(clientId)) return jsonResponse({ error: "请求标识不对，刷新页面再试" }, 400);

	const email = validEmailShape(body?.email ?? "");
	const website = safeUrl(body?.website ?? "");
	const parentId = Number.isInteger(Number(body?.parentId)) && Number(body?.parentId) > 0 ? Number(body.parentId) : null;

	const cookieSecret = (env.COMMENT_COOKIE_SECRET ?? "").trim();
	const salt = (env.IP_SALT ?? "").trim() || "wkb-comments";
	const existing = await verifyIdentity(readCookie(request, IDENTITY_COOKIE), cookieSecret);
	const uid = typeof existing?.uid === "string" && existing.uid ? existing.uid : newUid();
	const identity = await identityHash(uid, salt);

	const ipHash = await hashIp(
		request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for") ?? "unknown",
		salt,
	);
	const now = Date.now();

	try {
		await ensureCommentsSchema(env);

		// 1) 幂等：浏览器重试/连点，先认领已经存在的那一条（放在限流之前，重试不该被限流挡住）
		const duplicate = await findByClientId(env.DB, clientId);
		if (duplicate) {
			return jsonResponse({ item: toPublicComment(duplicate), status: duplicate.status }, 200);
		}

		// 2) 机器人：给个 200，但落 spam 留样本
		const bot = detectBot({ honey: body?.honey, elapsed: body?.elapsed });
		const challenge = bot.bot
			? { enabled: false, ok: true }
			: await verifyTurnstile(env, body?.turnstileToken, request.headers.get("cf-connecting-ip") ?? "");
		if (bot.bot || !challenge.ok) {
			const row = await buildCommentRow({
				slug: slug || "/",
				postId: postId || slug || "/",
				name,
				content,
				identityHash: identity,
				ipHash,
				clientId,
				parentId,
				website,
				emailHash: email ? await sha256Hex(`${salt}mail:${email.toLowerCase()}`) : null,
				status: "spam",
			});
			await env.DB.prepare(INSERT_SQL)
				.bind(...insertValues(row))
				.run()
				.catch((error) => console.warn("机器人样本没写进去", error));
			return jsonResponse({ ok: true });
		}

		// 3) 限流
		const buckets = [
			{ scope: "ip", value: ipHash },
			{ scope: "id", value: identity },
			{ scope: "site", value: "" },
		];
		const verdict = await rateCheck(env.DB, buckets, now);
		if (!verdict.allowed) {
			return jsonResponse(
				{ error: "发得有点频繁，歇一会儿再试", retryAfter: verdict.retryAfter },
				429,
				{ "retry-after": String(verdict.retryAfter) },
			);
		}

		// 4) 回复关系：一律拍平到顶级评论
		let rootId = null;
		if (parentId) {
			const parent = await env.DB.prepare("SELECT id, root_id, depth, status FROM comments WHERE id = ?")
				.bind(parentId)
				.first();
			if (!parent || parent.status === "deleted" || parent.status === "spam") {
				return jsonResponse({ error: "要回复的那条评论已经不在了" }, 400);
			}
			rootId = parent.depth === 0 ? parent.id : (parent.root_id ?? parent.id);
		}

		// 5) 分类
		const mode = await getCommentMode(env.DB);
		const row = await buildCommentRow({
			slug: slug || "/",
			postId: postId || slug || "/",
			name,
			content,
			identityHash: identity,
			ipHash,
			clientId,
			parentId,
			rootId,
			website,
			emailHash: email ? await sha256Hex(`${salt}mail:${email.toLowerCase()}`) : null,
		});
		const verdictClass = classifyComment({
			isAdmin: false,
			mode,
			linkCount: countLinks(content),
			keywordHit: await keywordHit(env.DB, content),
			recentSameHash: await duplicateRecently(env.DB, identity, row.content_hash, now),
			priorReports: await priorReportsOf(env.DB, identity),
		});
		row.status = verdictClass.status;

		// 6) 写库
		let inserted;
		try {
			await env.DB.prepare(INSERT_SQL).bind(...insertValues(row)).run();
			inserted = await findByClientId(env.DB, clientId);
		} catch (error) {
			const raced = await findByClientId(env.DB, clientId);
			if (!raced) throw error;
			inserted = raced;
		}

		// 7) 计数与清理（不影响本次响应）
		const tasks = (async () => {
			try {
				await rateRecord(env.DB, buckets, now);
				await ratePrune(env.DB, now);
			} catch (error) {
				console.warn("限流计数写入失败", error);
			}
		})();
		if (ctx?.waitUntil) ctx.waitUntil(tasks);
		else await tasks;

		const cookie = identityCookie(
			await signIdentity({ uid, name, emailHash: row.email_hash, website }, cookieSecret),
			IDENTITY_MAX_AGE,
		);
		return jsonResponse({ item: toPublicComment(inserted ?? row), status: row.status }, 201, { "set-cookie": cookie });
	} catch (error) {
		console.error("发表评论失败", error);
		return jsonResponse({ error: "没发出去，稍后再试", retryable: true }, 500);
	}
}


