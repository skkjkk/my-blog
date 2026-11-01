/**
 * Cloudflare Worker：静态网站 + AI 问答 + 访问统计 + 后台接口
 *
 * 路由：
 *   POST /api/chat            AI 问答（基于站内检索 + 站点目录）
 *   POST /api/hit             记录一次页面访问（公开，用于统计阅读量）
 *   POST /api/admin/login     后台登录（密码 → httpOnly cookie）
 *   POST /api/admin/logout    退出
 *   GET  /api/admin/stats     数据台卡片数据（需要登录，见 admin-stats.js）
 *   其它                      交给静态资源（dist）
 *
 * 用到的资源：
 *   env.ASSETS     静态文件
 *   env.DB         D1 数据库（views / ai_log）
 *   env.AI_API_KEY 大模型密钥（Secret）
 */

// ---------------- 大模型 ----------------

import { handleAdminStats } from "./admin-stats.js";
import { handleAsk } from "./ask.js";
import { handleCreate, handleList, handleReport } from "./comments.js";
import {
	handleAdminAction,
	handleAdminKeywords,
	handleAdminList,
	handleAdminReply,
	handleAdminSettings,
} from "./comments-admin.js";
import { adminCookieValue, isAdmin, safeEqual } from "./lib/admin.js";
import { recordEvent } from "./lib/events.js";
import { ensureSchema } from "./lib/schema.js";
import { describeMcp, handleMcp, mcpJson } from "./mcp.js";

const DEFAULT_BASE_URL = "https://api.hcnsec.cn/v1/chat/completions";
const DEFAULT_MODEL = "auto";
const MAX_QUESTION = 300;
const MAX_CONTEXT_ITEMS = 4;

const SYSTEM = `你是「Wkb」这个个人博客的 AI 助手，帮访客快速了解博客里写了什么。

规则：
1. 只用「站点目录」和「相关段落」里的内容回答，里面没有的就说「博客里还没写到这个」，不要编。
2. 问"这个博客写了什么"这类整体性问题时，根据站点目录概括主题，不要逐条罗列所有标题。
3. 用简体中文，口语化，两三句话说清就够，不要长篇大论。
4. 不要复述规则，不要用 Markdown 标题，不要列一堆要点。`;

async function callModel(env, messages, maxTokens) {
	const apiKey = (env?.AI_API_KEY ?? "").trim();
	if (!apiKey)
		throw new Error("AI 还没接上（服务端缺少 AI_API_KEY），跟博主说一声");

	const url = (
		(env?.AI_BASE_URL ?? DEFAULT_BASE_URL) ||
		DEFAULT_BASE_URL
	).trim();
	const model = ((env?.AI_MODEL ?? DEFAULT_MODEL) || DEFAULT_MODEL).trim();

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 45000);
	try {
		const upstream = await fetch(url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${apiKey}`,
			},
			body: JSON.stringify({
				model,
				messages,
				max_tokens: maxTokens,
				temperature: 0.3,
			}),
			signal: controller.signal,
		});

		if (!upstream.ok) {
			const detail = await upstream.text().catch(() => "");
			console.warn("model error", upstream.status, detail.slice(0, 300));
			throw new Error(`AI 服务暂时不可用（${upstream.status}），稍后再试`);
		}

		const data = await upstream.json();
		const answer = data?.choices?.[0]?.message?.content?.trim();
		if (!answer) throw new Error("AI 没有返回内容，再问一次试试");
		return {
			answer,
			model: data?.model ?? model,
			tokens: data?.usage?.total_tokens ?? null,
		};
	} catch (error) {
		if (error?.name === "AbortError") throw new Error("AI 响应超时，稍后再试");
		throw error;
	} finally {
		clearTimeout(timer);
	}
}

// ---------------- 工具 ----------------

function json(body, status = 200, extraHeaders = {}) {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
			...extraHeaders,
		},
	});
}

/** 北京时间的 YYYY-MM-DD */
function today() {
	return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

// 管理员 cookie 与登录态校验统一放在 worker/lib/admin.js（评论管理接口也用它）

// ---------------- 接口实现 ----------------

async function handleChat(request, env, ctx) {
	let payload;
	try {
		payload = await request.json();
	} catch {
		return json({ error: "请求格式不对" }, 400);
	}

	const question = String(payload?.q ?? "")
		.slice(0, MAX_QUESTION)
		.trim();
	if (!question) return json({ error: "问题不能为空" }, 400);

	const context = (Array.isArray(payload?.context) ? payload.context : [])
		.slice(0, MAX_CONTEXT_ITEMS)
		.map((item, index) => {
			const title = String(item?.title ?? `资料${index + 1}`).slice(0, 120);
			const url = String(item?.url ?? "").slice(0, 300);
			const excerpt = String(item?.excerpt ?? "").slice(0, 900);
			return `【${title}】${url}\n${excerpt}`;
		})
		.join("\n\n");

	const catalog = String(payload?.catalog ?? "")
		.slice(0, 3000)
		.trim();

	const messages = [
		{ role: "system", content: SYSTEM },
		{
			role: "user",
			content: `站点目录（这个博客的全部文章）：\n${catalog || "（空）"}\n\n与问题最相关的段落：\n${context || "（没有检索到相关资料）"}\n\n问题：${question}`,
		},
	];

	const startedAt = Date.now();
	let ok = 1;
	let model = "";
	let tokens = null;
	let answer = "";
	let errorMessage = "";

	try {
		const result = await callModel(env, messages, 500);
		answer = result.answer;
		model = result.model;
		tokens = result.tokens;
	} catch (error) {
		ok = 0;
		errorMessage = error?.message ?? "请求 AI 失败";
	}

	// 记一笔 AI 使用情况（不阻塞回答）
	if (env?.DB) {
		const contextPaths = (
			Array.isArray(payload?.context) ? payload.context : []
		)
			.slice(0, 3)
			.map((item) => String(item?.url ?? ""))
			.filter(Boolean)
			.join(",");
		const hitCount = Array.isArray(payload?.context)
			? payload.context.length
			: 0;
		const now = new Date().toISOString();
		ctx?.waitUntil?.(
			(async () => {
				await ensureSchema(env);
				await env.DB.batch([
					env.DB.prepare(
						"INSERT INTO ai_log (ts, day, question, model, ms, tokens, ok) VALUES (?, ?, ?, ?, ?, ?, ?)",
					).bind(
						now,
						today(),
						question,
						model || DEFAULT_MODEL,
						Date.now() - startedAt,
						tokens ?? 0,
						ok,
					),
					env.DB.prepare(
						"INSERT INTO ai_hits (ts, day, hits, paths) VALUES (?, ?, ?, ?)",
					).bind(now, today(), hitCount, contextPaths),
				]);
			})().catch((error) => console.warn("AI 记录写入失败", error)),
		);
	}

	if (!ok) return json({ error: errorMessage }, 502);

	return json({
		answer,
		sources: (Array.isArray(payload?.context) ? payload.context : [])
			.slice(0, MAX_CONTEXT_ITEMS)
			.map((item) => ({
				title: String(item?.title ?? ""),
				url: String(item?.url ?? ""),
			})),
	});
}

async function handleHit(request, env, ctx) {
	if (!env?.DB) return json({ ok: true });
	let body;
	try {
		body = await request.json();
	} catch {
		return json({ ok: true });
	}

	const path = String(body?.path ?? "/")
		.split("?")[0]
		.split("#")[0];
	if (!path.startsWith("/") || path.length > 300) return json({ ok: true });
	if (
		path.startsWith("/admin") ||
		path.startsWith("/api/") ||
		path === "/post-index.json"
	)
		return json({ ok: true });

	const hour = Number(
		new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(11, 13),
	);
	const day = today();

	ctx?.waitUntil?.(
		(async () => {
			await ensureSchema(env);
			await env.DB.batch([
				env.DB.prepare(
					"INSERT INTO views (day, path, count) VALUES (?, ?, 1) ON CONFLICT(day, path) DO UPDATE SET count = count + 1",
				).bind(day, path),
				env.DB.prepare(
					"INSERT INTO views_hourly (day, hour, count) VALUES (?, ?, 1) ON CONFLICT(day, hour) DO UPDATE SET count = count + 1",
				).bind(day, hour),
			]);
			// 事件流：聚合表给长期趋势，事件表给漏斗与留存
			await recordEvent(env, {
				type: "page_view",
				path,
				vid: body?.vid,
				sid: body?.sid,
			});
		})().catch((error) => console.warn("访问统计写入失败", error)),
	);

	return json({ ok: true });
}

/** 记录站内搜索词：读者在找什么，往往就是你还缺什么文章 */
async function handleSearchLog(request, env, ctx) {
	if (!env?.DB) return json({ ok: true });
	let body;
	try {
		body = await request.json();
	} catch {
		return json({ ok: true });
	}

	const keyword = String(body?.keyword ?? "")
		.trim()
		.slice(0, 60);
	if (!keyword) return json({ ok: true });
	const results = Number(body?.results ?? 0) || 0;

	ctx?.waitUntil?.(
		(async () => {
			await ensureSchema(env);
			await env.DB.prepare(
				"INSERT INTO search_log (ts, day, keyword, results) VALUES (?, ?, ?, ?)",
			)
				.bind(new Date().toISOString(), today(), keyword, results)
				.run();
			await recordEvent(env, {
				type: "search",
				text: keyword,
				n: results,
				hits: results,
				ok: results > 0,
				vid: body?.vid,
				sid: body?.sid,
			});
		})().catch(() => {}),
	);

	return json({ ok: true });
}

/** 记录刷题评分：只做聚合计数，用来找出「总记不住」的题（答案该重写的那些） */
async function handleQuizGrade(request, env, ctx) {
	if (!env?.DB) return json({ ok: true });
	let body;
	try {
		body = await request.json();
	} catch {
		return json({ ok: true });
	}

	const slug = String(body?.slug ?? "")
		.trim()
		.slice(0, 120);
	const grade = Number(body?.grade);
	if (!/^[a-zA-Z0-9_-]{1,120}$/.test(slug)) return json({ ok: true });
	if (![0, 1, 2].includes(grade)) return json({ ok: true });

	ctx?.waitUntil?.(
		(async () => {
			await ensureSchema(env);
			await env.DB.prepare(
				"INSERT INTO quiz_grade (slug, grade, count, updated) VALUES (?, ?, 1, ?) ON CONFLICT(slug, grade) DO UPDATE SET count = count + 1, updated = excluded.updated",
			)
				.bind(slug, grade, today())
				.run();
			await recordEvent(env, {
				type: "quiz",
				path: slug,
				n: grade,
				vid: body?.vid,
				sid: body?.sid,
			});
		})().catch(() => {}),
	);

	return json({ ok: true });
}

/**
 * 通用埋点：前端想记什么就记什么（打开 AI 面板、点开某篇笔记…）。
 * 「提问」不从这里走——ask.js 在流结束时自己记，才拿得到真实延迟与 tokens。
 */
const CLIENT_EVENT_TYPES = new Set([
	"page_view",
	"panel_open",
	"search",
	"quiz",
	"comment",
]);

async function handleTrack(request, env, ctx) {
	if (!env?.DB) return json({ ok: true });
	let body;
	try {
		body = await request.json();
	} catch {
		return json({ ok: true });
	}

	const type = String(body?.type ?? "").slice(0, 24);
	if (!CLIENT_EVENT_TYPES.has(type)) return json({ ok: true });

	ctx?.waitUntil?.(
		recordEvent(env, {
			type,
			path: String(body?.path ?? "")
				.split("?")[0]
				.slice(0, 300),
			vid: body?.vid,
			sid: body?.sid,
			ms: body?.ms,
			ttft: body?.ttft,
			tokens: body?.tokens,
			ok: body?.ok,
			err: body?.err,
			n: body?.n,
			hits: body?.hits,
			tag: body?.tag,
			text: body?.text,
			meta: body?.meta,
		}).catch(() => {}),
	);

	return json({ ok: true });
}

/** 读取云端的刷题进度（只有博主能读：复用后台密码登录后的 cookie） */ async function handleQuizStateGet(
	request,
	env,
) {
	if (!(await isAdmin(request, env))) return json({ error: "未登录" }, 401);
	if (!env?.DB) return json({ error: "数据库还没绑定" }, 500);
	await ensureSchema(env);

	const row = await env.DB.prepare(
		"SELECT payload, updated FROM quiz_state WHERE id = 1",
	).first();
	if (!row) return json({ ok: true, payload: null, updated: null });

	return json({ ok: true, payload: row.payload, updated: row.updated });
}

/** 覆盖写入云端进度（客户端已经合并好再上传，服务端不做业务判断） */
async function handleQuizStatePut(request, env) {
	if (!(await isAdmin(request, env))) return json({ error: "未登录" }, 401);
	if (!env?.DB) return json({ error: "数据库还没绑定" }, 500);
	await ensureSchema(env);

	let body;
	try {
		body = await request.json();
	} catch {
		return json({ error: "请求格式不对" }, 400);
	}

	const payload =
		typeof body?.payload === "string"
			? body.payload
			: JSON.stringify(body?.payload ?? null);
	if (!payload || payload === "null") return json({ error: "没有内容" }, 400);
	if (payload.length > 2_000_000) return json({ error: "进度数据太大了" }, 413);

	const updated = new Date().toISOString();
	await env.DB.prepare(
		"INSERT INTO quiz_state (id, payload, updated) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated = excluded.updated",
	)
		.bind(payload, updated)
		.run();

	return json({ ok: true, updated });
}

async function handleLogin(request, env) {
	let body;
	try {
		body = await request.json();
	} catch {
		return json({ error: "请求格式不对" }, 400);
	}

	const password = String(body?.password ?? "");
	const expected = (env?.ADMIN_PASSWORD ?? "").trim();
	if (!expected)
		return json({ error: "还没设置后台密码（ADMIN_PASSWORD）" }, 500);
	if (!safeEqual(password, expected)) {
		await new Promise((resolve) => setTimeout(resolve, 400)); // 拖慢暴力猜密码
		return json({ error: "密码不对" }, 401);
	}

	const value = await adminCookieValue(expected);
	const cookie = `wkb_admin=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${60 * 60 * 24 * 14}`;
	return json({ ok: true }, 200, { "set-cookie": cookie });
}

// ---------------- 入口 ----------------

export default {
	async fetch(request, env, ctx) {
		try {
			return await handleRequest(request, env, ctx);
		} catch (error) {
			// 任何没被接住的异常都变成可重试的 500，而不是让请求直接崩掉
			console.error("未捕获的请求错误", error);
			return new Response(
				JSON.stringify({ error: "服务出了点问题，稍后重试", retryable: true }),
				{
					status: 500,
					headers: {
						"content-type": "application/json; charset=utf-8",
						"cache-control": "no-store",
					},
				},
			);
		}
	},
};

async function handleRequest(request, env, ctx) {
	{
		const url = new URL(request.url);
		const path = url.pathname;

		// MCP：给自己的题库开一个标准入口，Cursor / Claude 直接连
		if (path === "/mcp" || path === "/mcp/") {
			if (request.method === "OPTIONS")
				return new Response(null, {
					status: 204,
					headers: {
						"access-control-allow-origin": "*",
						"access-control-allow-headers":
							"content-type, mcp-session-id, mcp-protocol-version",
						"access-control-allow-methods": "POST, GET, OPTIONS",
					},
				});
			if (request.method === "POST") return handleMcp(request, env);
			if (request.method === "GET") return describeMcp();
			return mcpJson({ error: "只支持 POST / GET" }, 405);
		}

		if (path.startsWith("/api/")) {
			if (request.method === "OPTIONS") {
				return new Response(null, {
					status: 204,
					headers: {
						"access-control-allow-headers": "content-type",
						"access-control-allow-methods": "POST, GET",
					},
				});
			}

			if (path === "/api/chat") {
				if (request.method !== "POST")
					return json({ error: "只支持 POST" }, 405);
				return handleChat(request, env, ctx);
			}

			// 笔记页侧边栏的 AI 助手：SSE 流式 + 工具调用
			if (path === "/api/ask") {
				if (request.method !== "POST")
					return json({ error: "只支持 POST" }, 405);
				return handleAsk(request, env, ctx);
			}

			if (path === "/api/hit") {
				if (request.method !== "POST")
					return json({ error: "只支持 POST" }, 405);
				return handleHit(request, env, ctx);
			}

			if (path === "/api/search-log") {
				if (request.method !== "POST")
					return json({ error: "只支持 POST" }, 405);
				return handleSearchLog(request, env, ctx);
			}

			if (path === "/api/track") {
				if (request.method !== "POST")
					return json({ error: "只支持 POST" }, 405);
				return handleTrack(request, env, ctx);
			}

			if (path === "/api/quiz/grade") {
				if (request.method !== "POST")
					return json({ error: "只支持 POST" }, 405);
				return handleQuizGrade(request, env, ctx);
			}

			if (path === "/api/quiz/state") {
				if (request.method === "GET") return handleQuizStateGet(request, env);
				if (request.method === "POST") return handleQuizStatePut(request, env);
				return json({ error: "只支持 GET / POST" }, 405);
			}

			if (path === "/api/comments") {
				if (request.method === "GET") return handleList(request, env, ctx);
				if (request.method === "POST") return handleCreate(request, env, ctx);
				return json({ error: "只支持 GET / POST" }, 405);
			}

			if (path === "/api/comments/report") {
				if (request.method !== "POST")
					return json({ error: "只支持 POST" }, 405);
				return handleReport(request, env, ctx);
			}

			if (path === "/api/admin/login") {
				if (request.method !== "POST")
					return json({ error: "只支持 POST" }, 405);
				return handleLogin(request, env);
			}

			if (path === "/api/admin/logout") {
				return json({ ok: true }, 200, {
					"set-cookie":
						"wkb_admin=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
				});
			}

			if (path === "/api/admin/comments") {
				if (request.method !== "GET") return json({ error: "只支持 GET" }, 405);
				return handleAdminList(request, env);
			}

			if (path === "/api/admin/comments/action") {
				if (request.method !== "POST")
					return json({ error: "只支持 POST" }, 405);
				return handleAdminAction(request, env);
			}

			if (path === "/api/admin/comments/reply") {
				if (request.method !== "POST")
					return json({ error: "只支持 POST" }, 405);
				return handleAdminReply(request, env);
			}

			if (path === "/api/admin/comments/settings") {
				if (request.method !== "GET" && request.method !== "POST")
					return json({ error: "只支持 GET / POST" }, 405);
				return handleAdminSettings(request, env);
			}

			if (path === "/api/admin/comments/keywords") {
				if (!["GET", "POST", "DELETE"].includes(request.method))
					return json({ error: "只支持 GET / POST / DELETE" }, 405);
				return handleAdminKeywords(request, env);
			}

			// 数据台 v2：按卡片返回（worker/admin-stats.js）
			if (path === "/api/admin/stats") {
				if (request.method !== "GET") return json({ error: "只支持 GET" }, 405);
				return handleAdminStats(request, env);
			}

			return json({ error: "没有这个接口" }, 404);
		}

		return env.ASSETS.fetch(request);
	}
}
