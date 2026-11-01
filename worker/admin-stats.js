/**
 * GET /api/admin/stats?page=ai|overview|audience|engagement|content&range=30
 *
 * 数据台 v2 接口：按「卡片」返回，而不是按数据表返回。
 * 前端只认 kind，不关心 SQL；后端只关心卡片 id。
 * 加一张卡 = 这里加一条声明。
 */

import {
	audienceCards,
	contentCards,
	engagementCards,
	overviewCards,
} from "./admin-pages.js";
import { isAdmin } from "./lib/admin.js";
import { ensureCommentsSchema } from "./lib/db.js";
import { ensureSchema } from "./lib/schema.js";
import {
	bjDay,
	bucketCount,
	bucketize,
	dailyAgg,
	delta,
	funnel,
	groupCount,
	heatmap,
	percentile,
	periodAgg,
	rangeOf,
	ratio,
	retention,
} from "./lib/stats.js";

const FUNNEL_STEPS = [
	{
		key: "read",
		label: "打开笔记",
		sql: "SELECT COUNT(DISTINCT NULLIF(vid, '')) FROM events WHERE type = 'page_view' AND vid <> '' AND path LIKE '/posts/%' AND day BETWEEN ? AND ?",
	},
	{
		key: "open",
		label: "打开 AI 面板",
		sql: "SELECT COUNT(DISTINCT NULLIF(vid, '')) FROM events WHERE type = 'panel_open' AND vid <> '' AND day BETWEEN ? AND ?",
	},
	{
		key: "ask",
		label: "发出提问",
		sql: "SELECT COUNT(DISTINCT NULLIF(vid, '')) FROM events WHERE type = 'ask' AND vid <> '' AND day BETWEEN ? AND ?",
	},
	{
		key: "answer",
		label: "拿到回答",
		sql: "SELECT COUNT(DISTINCT NULLIF(vid, '')) FROM events WHERE type = 'ask' AND ok = 1 AND vid <> '' AND day BETWEEN ? AND ?",
	},
	{
		key: "follow",
		label: "继续追问",
		sql: "SELECT COUNT(DISTINCT NULLIF(vid, '')) FROM events WHERE type = 'ask' AND n > 0 AND vid <> '' AND day BETWEEN ? AND ?",
	},
];

const DEPTH_BUCKETS = [
	{ label: "只问 1 句", min: 1, max: 1 },
	{ label: "2–3 句", min: 2, max: 3 },
	{ label: "4–6 句", min: 4, max: 6 },
	{ label: "7 句以上", min: 7 },
];

const USER_BUCKETS = [
	{ label: "1 次", min: 1, max: 1 },
	{ label: "2–5 次", min: 2, max: 5 },
	{ label: "6–20 次", min: 6, max: 20 },
	{ label: "20 次以上", min: 21 },
];

const TTFT_EDGES = [1000, 2000, 3000, 5000, 8000, 12000];

function json(body, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
		},
	});
}

/** 摘要里的路径 → 可读标题由前端拿 /post-index.json 换，这里只给 path */
function shortPath(path) {
	return String(path ?? "")
		.replace(/^\/posts\//, "")
		.replace(/\/$/, "");
}

async function aiCards(env, range) {
	const { from, to, prevFrom, prevTo, days } = range;

	const [
		daily,
		current,
		previous,
		latency,
		heat,
		steps,
		sessionDepth,
		userTiers,
		models,
		modelRows,
		topNotes,
		zeroHits,
		recent,
		keep,
	] = await Promise.all([
		dailyAgg(env, { type: "ask", from, to }),
		periodAgg(env, { type: "ask", from, to }),
		periodAgg(env, { type: "ask", from: prevFrom, to: prevTo }),
		percentile(env, { type: "ask", from, to, field: "ttft", ps: [50, 90, 99] }),
		heatmap(env, { type: "ask", from, to }),
		funnel(env, { from, to, steps: FUNNEL_STEPS }),
		bucketCount(env, {
			type: "ask",
			from,
			to,
			field: "sid",
			buckets: DEPTH_BUCKETS,
		}),
		bucketCount(env, {
			type: "ask",
			from,
			to,
			field: "vid",
			buckets: USER_BUCKETS,
		}),
		groupCount(env, { type: "ask", from, to, field: "tag", limit: 6 }),
		env.DB.prepare(
			`SELECT tag AS model, COUNT(*) AS total, COALESCE(SUM(ok), 0) AS ok,
				COALESCE(AVG(NULLIF(ttft, 0)), 0) AS ttft, COALESCE(AVG(ms), 0) AS ms,
				COALESCE(AVG(NULLIF(tokens, 0)), 0) AS tokens
			 FROM events WHERE type = 'ask' AND day BETWEEN ? AND ?
			 GROUP BY tag ORDER BY total DESC LIMIT 8`,
		)
			.bind(from, to)
			.all(),
		env.DB.prepare(
			`SELECT path AS k, COUNT(*) AS v FROM events
			 WHERE type = 'ask' AND day BETWEEN ? AND ? AND path <> ''
			 GROUP BY path ORDER BY v DESC LIMIT 8`,
		)
			.bind(from, to)
			.all(),
		env.DB.prepare(
			`SELECT text AS k, COUNT(*) AS v, MAX(ts) AS last FROM events
			 WHERE type = 'ask' AND hits = 0 AND text <> '' AND day BETWEEN ? AND ?
			 GROUP BY text ORDER BY v DESC LIMIT 8`,
		)
			.bind(from, to)
			.all(),
		env.DB.prepare(
			`SELECT ts, path, text, tag, ms, ttft, tokens, ok, err, n, hits FROM events
			 WHERE type = 'ask' AND day BETWEEN ? AND ?
			 ORDER BY id DESC LIMIT 60`,
		)
			.bind(from, to)
			.all(),
		retention(env, { type: "ask", from, to, offsets: [1, 7, 30] }),
	]);

	const queries = current.total ?? 0;
	const prevQueries = previous.total ?? 0;
	const perUser =
		current.users > 0 ? Number((queries / current.users).toFixed(1)) : 0;
	const prevPerUser =
		previous.users > 0 ? Number((prevQueries / previous.users).toFixed(1)) : 0;
	const successRate = ratio(current.ok ?? 0, queries);
	const prevSuccess = ratio(previous.ok ?? 0, prevQueries);

	const filled = Array.from({ length: days }, (_, index) => {
		const day = new Date(
			new Date(`${from}T00:00:00Z`).getTime() + index * 86_400_000,
		)
			.toISOString()
			.slice(0, 10);
		const hit = daily.find((row) => row.day === day);
		return (
			hit ?? {
				day,
				total: 0,
				ok: 0,
				users: 0,
				sessions: 0,
				tokens: 0,
				avgTtft: 0,
				avgMs: 0,
			}
		);
	});
	const pick = (field) => filled.map((row) => Number(row[field] ?? 0));
	const byDayField = (field) =>
		filled.map((row) => ({ day: row.day, count: Number(row[field] ?? 0) }));

	const avgTokens =
		queries > 0 ? Math.round(Number(current.tokens ?? 0) / queries) : 0;

	const kpis = [
		{
			key: "users",
			label: "活跃用户",
			value: current.users ?? 0,
			delta: delta(current.users, previous.users),
			spark: byDayField("users").map((row) => row.count),
			note: "有提问的独立访客",
		},
		{
			key: "queries",
			label: "提问数",
			value: queries,
			delta: delta(queries, prevQueries),
			spark: pick("total"),
			note: "区间内提交的提问",
		},
		{
			key: "sessions",
			label: "会话数",
			value: current.sessions ?? 0,
			delta: delta(current.sessions, previous.sessions),
			spark: byDayField("sessions").map((row) => row.count),
			note: "按会话去重",
		},
		{
			key: "perUser",
			label: "人均提问",
			value: perUser,
			decimals: 1,
			delta: delta(perUser, prevPerUser),
			spark: filled.map((row) => {
				const users = Number(row.users ?? 0);
				return users > 0
					? Number((Number(row.total ?? 0) / users).toFixed(1))
					: 0;
			}),
			note: "粘性强度",
		},
		{
			key: "success",
			label: "成功率",
			value: successRate,
			unit: "%",
			decimals: 1,
			delta: delta(successRate, prevSuccess),
			spark: daily.map((row) => ratio(row.ok ?? 0, row.total ?? 0)),
			note: "拿到正文回答的比例",
		},
		{
			key: "ttft",
			label: "首字延迟 P50",
			value: latency.p50 ?? 0,
			unit: "ms",
			delta: null,
			spark: daily.map((row) => Math.round(Number(row.avgTtft ?? 0))),
			note: "体感快慢，比总耗时准",
		},
	];

	const failureRows = await env.DB.prepare(
		`SELECT COALESCE(NULLIF(err, ''), '空回答') AS k, COUNT(*) AS v FROM events
		 WHERE type = 'ask' AND ok = 0 AND day BETWEEN ? AND ? GROUP BY k ORDER BY v DESC LIMIT 6`,
	)
		.bind(from, to)
		.all();

	const errors = (failureRows?.results ?? []).map((row) => ({
		label: row.k,
		count: row.v,
	}));

	return [
		{ id: "kpis", kind: "kpi", title: "核心指标", data: { items: kpis } },
		{
			id: "trend",
			kind: "area",
			title: "提问趋势",
			note: "柱：提问数　线：活跃用户",
			data: {
				labels: filled.map((row) => row.day),
				bars: pick("total"),
				line: byDayField("users").map((row) => row.count),
				lineLabel: "活跃用户",
				barLabel: "提问数",
			},
		},
		{
			id: "funnel",
			kind: "funnel",
			title: "从读到问的转化",
			note: "按独立访客计",
			data: { steps },
		},
		{
			id: "latency",
			kind: "histogram",
			title: "首字延迟分布",
			note: `P50 ${latency.p50 ?? 0}ms · P90 ${latency.p90 ?? 0}ms · P99 ${latency.p99 ?? 0}ms`,
			data: {
				buckets: bucketize(latency.values, TTFT_EDGES),
				marks: [
					{ label: "P50", value: latency.p50 ?? 0 },
					{ label: "P90", value: latency.p90 ?? 0 },
					{ label: "P99", value: latency.p99 ?? 0 },
				],
				unit: "ms",
			},
		},
		{
			id: "tokens",
			kind: "area",
			title: "tokens 消耗",
			note: `平均每次 ${avgTokens} tokens`,
			data: {
				labels: filled.map((row) => row.day),
				bars: pick("tokens"),
				line: [],
				barLabel: "当天 tokens",
			},
		},
		{
			id: "heatmap",
			kind: "heatmap",
			title: "提问时段分布",
			note: "周 × 小时，颜色越深越忙",
			data: heat,
		},
		{
			id: "depth",
			kind: "bars",
			title: "会话深度",
			note: "一次会话问了几句",
			data: { rows: sessionDepth },
		},
		{
			id: "tiers",
			kind: "bars",
			title: "用户分层",
			note: "一个人问了几次",
			data: { rows: userTiers },
		},
		{
			id: "models",
			kind: "donut",
			title: "模型分布",
			note: "auto 路由到了谁",
			data: { rows: models.map((row) => ({ label: row.k, count: row.v })) },
		},
		{
			id: "modelTable",
			kind: "table",
			title: "模型对比",
			note: "决定要不要钉死 AI_MODEL",
			data: {
				columns: [
					"模型",
					"次数",
					"成功率",
					"首字 P50",
					"平均耗时",
					"平均 tokens",
				],
				rows: (modelRows?.results ?? []).map((row) => [
					row.model || "unknown",
					String(row.total ?? 0),
					`${ratio(row.ok ?? 0, row.total ?? 0)}%`,
					`${Math.round(row.ttft ?? 0)}ms`,
					`${((row.ms ?? 0) / 1000).toFixed(1)}s`,
					String(Math.round(row.tokens ?? 0)),
				]),
			},
		},
		{
			id: "keep",
			kind: "bars",
			title: "留存",
			note: "首次提问后第 N 天还回来（需累积数据）",
			data: {
				rows: [
					{ label: "首次", count: keep.users ?? 0, hint: "基准" },
					...keep.offsets.map((item) => ({
						label: `第 ${item.offset} 天`,
						count: item.count,
						hint: `${item.rate}%`,
					})),
				],
			},
		},
		{
			id: "errors",
			kind: "bars",
			title: "失败原因",
			note: "成功率掉下去时看这里",
			data: { rows: errors },
			empty: "没有失败记录",
		},
		{
			id: "topNotes",
			kind: "rank",
			title: "被问最多的笔记",
			note: "哪篇最需要补充内容",
			data: {
				rows: (topNotes?.results ?? []).map((row) => ({
					label: shortPath(row.k),
					href: row.k,
					count: row.v,
				})),
			},
		},
		{
			id: "zeroHits",
			kind: "rank",
			title: "站内没答案的问题",
			note: "直接就是选题清单",
			data: {
				rows: (zeroHits?.results ?? []).map((row) => ({
					label: row.k,
					count: row.v,
				})),
				text: true,
			},
		},
		{
			id: "log",
			kind: "log",
			title: "提问日志",
			note: "最近 60 条",
			data: {
				rows: (recent?.results ?? []).map((row) => ({
					ts: row.ts,
					text: row.text,
					path: row.path,
					model: row.tag,
					ms: row.ms,
					ttft: row.ttft,
					tokens: row.tokens,
					ok: row.ok,
					err: row.err,
					depth: row.n,
					hits: row.hits,
				})),
			},
		},
	];
}

const PAGES = {
	ai: aiCards,
	overview: overviewCards,
	audience: audienceCards,
	engagement: engagementCards,
	content: contentCards,
};

export async function handleAdminStats(request, env) {
	if (!(await isAdmin(request, env))) return json({ error: "未登录" }, 401);
	if (!env?.DB) return json({ error: "数据库还没绑定" }, 500);

	const url = new URL(request.url);
	const page = String(url.searchParams.get("page") ?? "ai");
	const range = rangeOf(url.searchParams);

	const build = PAGES[page];
	if (!build) return json({ error: `没有这个页面：${page}` }, 404);

	// 新环境可能还没跑过 schema.sql：读之前先兜底建表（含评论表），别让看板 500
	await ensureSchema(env);
	await ensureCommentsSchema(env);

	try {
		const cards = await build(env, range);
		// 事件流的起点：页面据此说明「漏斗/留存从哪天开始才有意义」
		const first = await env.DB.prepare(
			"SELECT MIN(day) AS d, COUNT(*) AS n FROM events",
		)
			.first()
			.catch(() => null);

		return json({
			page,
			range: range.range,
			from: range.from,
			to: range.to,
			today: bjDay(0),
			generatedAt: new Date().toISOString(),
			coverage: { since: first?.d ?? null, total: first?.n ?? 0 },
			cards,
		});
	} catch (error) {
		console.warn("admin stats 失败", error);
		return json({ error: "统计数据读取失败（可能还没有事件数据）" }, 500);
	}
}
