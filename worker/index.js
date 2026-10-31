/**
 * Cloudflare Worker：静态网站 + AI 问答 + 访问统计 + 后台接口
 *
 * 路由：
 *   POST /api/chat            AI 问答（基于站内检索 + 站点目录）
 *   POST /api/hit             记录一次页面访问（公开，用于统计阅读量）
 *   POST /api/admin/login     后台登录（密码 → httpOnly cookie）
 *   POST /api/admin/logout    退出
 *   GET  /api/admin/overview  后台数据（需要登录）
 *   其它                      交给静态资源（dist）
 *
 * 用到的资源：
 *   env.ASSETS     静态文件
 *   env.DB         D1 数据库（views / ai_log）
 *   env.AI_API_KEY 大模型密钥（Secret）
 */

// ---------------- 大模型 ----------------

import { handleCreate, handleList, handleReport } from "./comments.js";

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
	if (!apiKey) throw new Error("AI 还没接上（服务端缺少 AI_API_KEY），跟博主说一声");

	const url = ((env?.AI_BASE_URL ?? DEFAULT_BASE_URL) || DEFAULT_BASE_URL).trim();
	const model = ((env?.AI_MODEL ?? DEFAULT_MODEL) || DEFAULT_MODEL).trim();

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 45000);
	try {
		const upstream = await fetch(url, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
			body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0.3 }),
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
		return { answer, model: data?.model ?? model, tokens: data?.usage?.total_tokens ?? null };
	} catch (error) {
		if (error?.name === "AbortError") throw new Error("AI 响应超时，稍后再试");
		throw error;
	} finally {
		clearTimeout(timer);
	}
}

// ---------------- 数据结构自愈 ----------------
// 所有建表语句都是 IF NOT EXISTS，可重复执行。每个 Worker 实例第一次用到数据库时跑一遍，
// 这样即使忘了手动执行 schema.sql，统计表也会自动出现。
let schemaReady = null;
function ensureSchema(env) {
	if (!env?.DB) return Promise.resolve();
	if (!schemaReady) {
		schemaReady = env.DB.batch([
			env.DB.prepare(
				"CREATE TABLE IF NOT EXISTS views_hourly (day TEXT NOT NULL, hour INTEGER NOT NULL, count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, hour))",
			),
			env.DB.prepare(
				"CREATE TABLE IF NOT EXISTS ai_hits (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, day TEXT NOT NULL, hits INTEGER NOT NULL DEFAULT 0, paths TEXT DEFAULT '')",
			),
			env.DB.prepare(
				"CREATE TABLE IF NOT EXISTS search_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, day TEXT NOT NULL, keyword TEXT NOT NULL, results INTEGER DEFAULT 0)",
			),
		]).catch((error) => {
			schemaReady = null; // 失败就别缓存，下次重试
			console.warn("自动建表失败", error);
		});
	}
	return schemaReady;
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

function daysAgo(days) {
	return new Date(Date.now() + 8 * 3600 * 1000 - days * 86400000).toISOString().slice(0, 10);
}

/** 管理员 cookie 的值：用 ADMIN_PASSWORD 做 HMAC，密码一换所有旧 cookie 自动失效 */
async function adminCookieValue(password) {
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey("raw", encoder.encode(password), { name: "HMAC", hash: "SHA-256" }, false, [
		"sign",
	]);
	const signature = await crypto.subtle.sign("HMAC", key, encoder.encode("wkb-admin-v1"));
	return Array.from(new Uint8Array(signature))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

function safeEqual(a, b) {
	if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

function readCookie(request, name) {
	const cookie = request.headers.get("cookie") ?? "";
	for (const part of cookie.split(";")) {
		const [key, ...rest] = part.trim().split("=");
		if (key === name) return rest.join("=");
	}
	return "";
}

async function isAdmin(request, env) {
	const password = (env?.ADMIN_PASSWORD ?? "").trim();
	if (!password) return false;
	const expected = await adminCookieValue(password);
	return safeEqual(readCookie(request, "wkb_admin"), expected);
}

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
		const contextPaths = (Array.isArray(payload?.context) ? payload.context : [])
			.slice(0, 3)
			.map((item) => String(item?.url ?? ""))
			.filter(Boolean)
			.join(",");
		const hitCount = Array.isArray(payload?.context) ? payload.context.length : 0;
		const now = new Date().toISOString();
		ctx?.waitUntil?.(
			(async () => {
				await ensureSchema(env);
				await env.DB.batch([
					env.DB.prepare(
						"INSERT INTO ai_log (ts, day, question, model, ms, tokens, ok) VALUES (?, ?, ?, ?, ?, ?, ?)",
					).bind(now, today(), question, model || DEFAULT_MODEL, Date.now() - startedAt, tokens ?? 0, ok),
					env.DB.prepare("INSERT INTO ai_hits (ts, day, hits, paths) VALUES (?, ?, ?, ?)").bind(
						now,
						today(),
						hitCount,
						contextPaths,
					),
				]);
			})().catch((error) => console.warn("AI 记录写入失败", error)),
		);
	}

	if (!ok) return json({ error: errorMessage }, 502);

	return json({
		answer,
		sources: (Array.isArray(payload?.context) ? payload.context : [])
			.slice(0, MAX_CONTEXT_ITEMS)
			.map((item) => ({ title: String(item?.title ?? ""), url: String(item?.url ?? "") })),
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

	let path = String(body?.path ?? "/").split("?")[0].split("#")[0];
	if (!path.startsWith("/") || path.length > 300) return json({ ok: true });
	if (path.startsWith("/admin") || path.startsWith("/api/") || path === "/post-index.json") return json({ ok: true });

	const hour = Number(new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(11, 13));
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
			await env.DB.prepare("INSERT INTO search_log (ts, day, keyword, results) VALUES (?, ?, ?, ?)")
				.bind(new Date().toISOString(), today(), keyword, results)
				.run();
		})().catch(() => {}),
	);

	return json({ ok: true });
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
	if (!expected) return json({ error: "还没设置后台密码（ADMIN_PASSWORD）" }, 500);
	if (!safeEqual(password, expected)) {
		await new Promise((resolve) => setTimeout(resolve, 400)); // 拖慢暴力猜密码
		return json({ error: "密码不对" }, 401);
	}

	const value = await adminCookieValue(expected);
	const cookie = `wkb_admin=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${60 * 60 * 24 * 14}`;
	return json({ ok: true }, 200, { "set-cookie": cookie });
}

async function handleOverview(request, env) {
	if (!(await isAdmin(request, env))) return json({ error: "未登录" }, 401);
	if (!env?.DB) return json({ error: "数据库还没绑定" }, 500);
	await ensureSchema(env);

	const requestUrl = new URL(request.url);
	const rangeParam = Number(requestUrl.searchParams.get("range") ?? 14);
	const range = [7, 14, 30].includes(rangeParam) ? rangeParam : 14;

	const todayStr = today();
	const yesterdayStr = daysAgo(1);
	const fromStr = daysAgo(range - 1);

	const [
		totalViews,
		todayViews,
		yesterdayViews,
		series,
		topPages,
		aiTotal,
		aiToday,
		aiYesterday,
		aiAvg,
		aiTokens,
		aiRecent,
		aiModels,
		aiSeries,
		aiOkTotal,
	] = await env.DB.batch([
		env.DB.prepare("SELECT COALESCE(SUM(count), 0) AS v FROM views"),
		env.DB.prepare("SELECT COALESCE(SUM(count), 0) AS v FROM views WHERE day = ?").bind(todayStr),
		env.DB.prepare("SELECT COALESCE(SUM(count), 0) AS v FROM views WHERE day = ?").bind(yesterdayStr),
		env.DB.prepare("SELECT day, SUM(count) AS v FROM views WHERE day >= ? GROUP BY day ORDER BY day").bind(fromStr),
		env.DB.prepare(
			"SELECT path, SUM(count) AS v FROM views WHERE day >= ? GROUP BY path ORDER BY v DESC LIMIT 60",
		).bind(fromStr),
		env.DB.prepare("SELECT COUNT(*) AS v FROM ai_log"),
		env.DB.prepare("SELECT COUNT(*) AS v FROM ai_log WHERE day = ?").bind(todayStr),
		env.DB.prepare("SELECT COUNT(*) AS v FROM ai_log WHERE day = ?").bind(yesterdayStr),
		env.DB.prepare("SELECT AVG(ms) AS v FROM ai_log WHERE ok = 1 AND day >= ?").bind(fromStr),
		env.DB.prepare("SELECT COALESCE(SUM(tokens), 0) AS v FROM ai_log"),
		env.DB.prepare("SELECT ts, question, model, ms, ok FROM ai_log ORDER BY id DESC LIMIT 30"),
		env.DB.prepare("SELECT model, COUNT(*) AS v FROM ai_log GROUP BY model ORDER BY v DESC LIMIT 5"),
		env.DB.prepare("SELECT day, COUNT(*) AS v FROM ai_log WHERE day >= ? GROUP BY day ORDER BY day").bind(fromStr),
		env.DB.prepare("SELECT COALESCE(SUM(ok), 0) AS v FROM ai_log"),
	]);

	const totalAi = aiTotal?.results?.[0]?.v ?? 0;
	const okAi = aiOkTotal?.results?.[0]?.v ?? 0;

	// 以下统计依赖后加的表，缺了也不该让整个后台挂掉
	let hours = [];
	let searchTop = [];
	let searchTotal = 0;
	let aiZeroHits = 0;
	let aiAvgHits = 0;
	let aiTopPaths = [];
	let calendar = [];
	try {
		const [hourRows, searchRows, searchTotalRow, hitsRow, hitPathRows, calendarRows] = await env.DB.batch([
			env.DB.prepare("SELECT hour, SUM(count) AS v FROM views_hourly WHERE day >= ? GROUP BY hour ORDER BY hour").bind(fromStr),
			env.DB.prepare(
				"SELECT keyword, COUNT(*) AS v FROM search_log WHERE day >= ? GROUP BY keyword ORDER BY v DESC LIMIT 10",
			).bind(fromStr),
			env.DB.prepare("SELECT COUNT(*) AS v FROM search_log WHERE day >= ?").bind(fromStr),
			env.DB.prepare(
				"SELECT COUNT(*) AS n, COALESCE(SUM(hits), 0) AS sum, COALESCE(SUM(CASE WHEN hits = 0 THEN 1 ELSE 0 END), 0) AS zero FROM ai_hits WHERE day >= ?",
			).bind(fromStr),
			env.DB.prepare("SELECT paths FROM ai_hits WHERE day >= ? ORDER BY id DESC LIMIT 500").bind(fromStr),
			// 日历热力图用：最近 20 周每天的阅读量（不受时间范围影响）
			env.DB.prepare("SELECT day, SUM(count) AS v FROM views WHERE day >= ? GROUP BY day ORDER BY day").bind(daysAgo(139)),
		]);

		hours = (hourRows?.results ?? []).map((row) => ({ hour: row.hour, count: row.v }));
		calendar = (calendarRows?.results ?? []).map((row) => ({ day: row.day, count: row.v }));
		searchTop = (searchRows?.results ?? []).map((row) => ({ keyword: row.keyword, count: row.v }));
		searchTotal = searchTotalRow?.results?.[0]?.v ?? 0;

		const hits = hitsRow?.results?.[0] ?? { n: 0, sum: 0, zero: 0 };
		aiZeroHits = hits.zero ?? 0;
		aiAvgHits = hits.n > 0 ? Number((hits.sum / hits.n).toFixed(1)) : 0;

		const counter = new Map();
		for (const row of hitPathRows?.results ?? []) {
			for (const path of String(row.paths ?? "").split(",")) {
				if (!path) continue;
				counter.set(path, (counter.get(path) ?? 0) + 1);
			}
		}
		aiTopPaths = Array.from(counter.entries())
			.sort((a, b) => b[1] - a[1])
			.slice(0, 5)
			.map(([path, count]) => ({ path, count }));
	} catch (error) {
		console.warn("扩展统计不可用（表可能还没建好）", error);
	}

	return json({
		generatedAt: new Date().toISOString(),
		today: todayStr,
		range,
		views: {
			total: totalViews?.results?.[0]?.v ?? 0,
			today: todayViews?.results?.[0]?.v ?? 0,
			yesterday: yesterdayViews?.results?.[0]?.v ?? 0,
			series: (series?.results ?? []).map((row) => ({ day: row.day, count: row.v })),
			top: (topPages?.results ?? []).map((row) => ({ path: row.path, count: row.v })),
			hours,
			calendar,
			search: { total: searchTotal, top: searchTop },
		},
		ai: {
			total: totalAi,
			today: aiToday?.results?.[0]?.v ?? 0,
			yesterday: aiYesterday?.results?.[0]?.v ?? 0,
			avgMs: Math.round(aiAvg?.results?.[0]?.v ?? 0),
			tokens: aiTokens?.results?.[0]?.v ?? 0,
			successRate: totalAi > 0 ? Math.round((okAi / totalAi) * 100) : 100,
			zeroHits: aiZeroHits,
			avgHits: aiAvgHits,
			topPaths: aiTopPaths,
			series: (aiSeries?.results ?? []).map((row) => ({ day: row.day, count: row.v })),
			recent: (aiRecent?.results ?? []).slice(0, 15).map((row) => ({
				ts: row.ts,
				question: row.question,
				model: row.model,
				ms: row.ms,
				ok: row.ok,
			})),
			models: (aiModels?.results ?? []).map((row) => ({ model: row.model, count: row.v })),
		},
	});
}

// ---------------- 入口 ----------------

export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);
		const path = url.pathname;

		if (path.startsWith("/api/")) {
			if (request.method === "OPTIONS") {
				return new Response(null, {
					status: 204,
					headers: { "access-control-allow-headers": "content-type", "access-control-allow-methods": "POST, GET" },
				});
			}

			if (path === "/api/chat") {
				if (request.method !== "POST") return json({ error: "只支持 POST" }, 405);
				return handleChat(request, env, ctx);
			}

			if (path === "/api/hit") {
				if (request.method !== "POST") return json({ error: "只支持 POST" }, 405);
				return handleHit(request, env, ctx);
			}

			if (path === "/api/search-log") {
				if (request.method !== "POST") return json({ error: "只支持 POST" }, 405);
				return handleSearchLog(request, env, ctx);
			}

			if (path === "/api/comments") {
				if (request.method === "GET") return handleList(request, env, ctx);
				if (request.method === "POST") return handleCreate(request, env, ctx);
				return json({ error: "只支持 GET / POST" }, 405);
			}

			if (path === "/api/comments/report") {
				if (request.method !== "POST") return json({ error: "只支持 POST" }, 405);
				return handleReport(request, env, ctx);
			}

			if (path === "/api/admin/login") {
				if (request.method !== "POST") return json({ error: "只支持 POST" }, 405);
				return handleLogin(request, env);
			}

			if (path === "/api/admin/logout") {
				return json({ ok: true }, 200, { "set-cookie": "wkb_admin=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0" });
			}

			if (path === "/api/admin/overview") {
				return handleOverview(request, env);
			}

			return json({ error: "没有这个接口" }, 404);
		}

		return env.ASSETS.fetch(request);
	},
};


