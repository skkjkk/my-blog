/**
 * 数据台 v2：概览 / 受众 / 参与 / 内容 四个页面的卡片构建器。
 *
 * 两套数据源各管一段，别混着看：
 *   - views / views_hourly / search_log / quiz_grade：历史完整，负责「阅读量与搜索」
 *   - events：只有埋点上线后才有，负责「人、会话、漏斗、留存」
 * 页面上的卡片会自己标注口径，避免把两边数字对不上当成 bug。
 */

import {
	bjDay,
	dailyAgg,
	delta,
	fillDays,
	funnel,
	heatmap,
	percentile,
	periodAgg,
	retention,
} from "./lib/stats.js";

const DAY_MS = 86_400_000;

const shortPath = (path) =>
	String(path ?? "")
		.replace(/^\/posts\//, "")
		.replace(/\/$/, "");

function dayList(from, days) {
	return Array.from({ length: days }, (_, index) =>
		new Date(new Date(`${from}T00:00:00Z`).getTime() + index * DAY_MS)
			.toISOString()
			.slice(0, 10),
	);
}

/* ---------------- 阅读量（聚合表） ---------------- */

async function viewsDaily(env, from, to) {
	const { results } = await env.DB.prepare(
		"SELECT day, SUM(count) AS v FROM views WHERE day BETWEEN ? AND ? GROUP BY day ORDER BY day",
	)
		.bind(from, to)
		.all();
	return results ?? [];
}

async function viewsTotal(env, from, to) {
	const row = await env.DB.prepare(
		"SELECT COALESCE(SUM(count), 0) AS v FROM views WHERE day BETWEEN ? AND ?",
	)
		.bind(from, to)
		.first();
	return row?.v ?? 0;
}

async function viewsTop(env, from, to, limit = 8) {
	const { results } = await env.DB.prepare(
		"SELECT path, SUM(count) AS v FROM views WHERE day BETWEEN ? AND ? GROUP BY path ORDER BY v DESC LIMIT ?",
	)
		.bind(from, to, limit)
		.all();
	return (results ?? []).map((row) => ({
		label: shortPath(row.path),
		href: row.path,
		count: row.v,
	}));
}

async function hours24(env, from, to) {
	const { results } = await env.DB.prepare(
		"SELECT hour, SUM(count) AS v FROM views_hourly WHERE day BETWEEN ? AND ? GROUP BY hour ORDER BY hour",
	)
		.bind(from, to)
		.all();
	const map = new Map((results ?? []).map((row) => [row.hour, row.v]));
	return Array.from({ length: 24 }, (_, hour) => ({
		label: `${String(hour).padStart(2, "0")}时`,
		count: map.get(hour) ?? 0,
	}));
}

/* ---------------- 概览 ---------------- */

export async function overviewCards(env, range) {
	const { from, to, prevFrom, prevTo, days } = range;

	const [
		daily,
		prevTotal,
		todayTotal,
		askDaily,
		askNow,
		keep,
		topPages,
		steps,
		calendarRows,
		latency,
	] = await Promise.all([
		viewsDaily(env, from, to),
		viewsTotal(env, prevFrom, prevTo),
		viewsTotal(env, bjDay(0), bjDay(0)),
		dailyAgg(env, { type: "ask", from, to }),
		periodAgg(env, { type: "ask", from, to }),
		retention(env, { type: "page_view", from, to, offsets: [1, 7, 30] }),
		viewsTop(env, from, to, 8),
		funnel(env, {
			from,
			to,
			steps: [
				{
					key: "read",
					label: "浏览页面",
					sql: "SELECT COUNT(DISTINCT NULLIF(vid, '')) FROM events WHERE type = 'page_view' AND vid <> '' AND day BETWEEN ? AND ?",
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
					key: "follow",
					label: "继续追问",
					sql: "SELECT COUNT(DISTINCT NULLIF(vid, '')) FROM events WHERE type = 'ask' AND n > 0 AND vid <> '' AND day BETWEEN ? AND ?",
				},
			],
		}),
		env.DB.prepare(
			"SELECT day, SUM(count) AS v FROM views WHERE day >= ? GROUP BY day ORDER BY day",
		)
			.bind(bjDay(139))
			.all(),
		percentile(env, { type: "ask", from, to, field: "ttft", ps: [50, 90] }),
	]);

	const total = daily.reduce((acc, row) => acc + Number(row.v ?? 0), 0);
	const asks = askNow.total ?? 0;
	const days365 = dayList(from, days);
	const viewMap = new Map(daily.map((row) => [row.day, Number(row.v ?? 0)]));
	const askMap = new Map(
		askDaily.map((row) => [row.day, Number(row.total ?? 0)]),
	);
	const viewsSeries = days365.map((day) => viewMap.get(day) ?? 0);

	const calendarMap = new Map(
		(calendarRows?.results ?? []).map((row) => [row.day, Number(row.v ?? 0)]),
	);

	return [
		{
			id: "kpis",
			kind: "kpi",
			title: "核心指标",
			data: {
				items: [
					{
						key: "views",
						label: "阅读次数",
						value: total,
						delta: delta(total, prevTotal),
						spark: viewsSeries,
						note: "来自阅读聚合表（历史完整）",
					},
					{
						key: "today",
						label: "今日阅读",
						value: todayTotal,
						delta: null,
						spark: viewsSeries.slice(-7),
						note: "今天零点到现在",
					},
					{
						key: "asks",
						label: "提问数",
						value: asks,
						delta: null,
						spark: days365.map((day) => askMap.get(day) ?? 0),
						note: "来自事件流（埋点上线起）",
					},
					{
						key: "perThousand",
						label: "AI 渗透率",
						value: total > 0 ? Number(((asks / total) * 100).toFixed(1)) : 0,
						unit: "%",
						decimals: 1,
						delta: null,
						spark: days365.map((day) => {
							const view = viewMap.get(day) ?? 0;
							return view > 0
								? Number((((askMap.get(day) ?? 0) / view) * 100).toFixed(1))
								: 0;
						}),
						note: "提问数 ÷ 阅读次数",
					},
					{
						key: "ttft",
						label: "首字延迟 P50",
						value: latency.p50 ?? 0,
						unit: "ms",
						delta: null,
						spark: [],
						note: "体感快慢",
					},
					{
						key: "keep7",
						label: "7 日留存",
						value: keep.offsets.find((item) => item.offset === 7)?.rate ?? 0,
						unit: "%",
						decimals: 1,
						delta: null,
						spark: [],
						note: "首次访问后第 7 天还回来",
					},
				],
			},
		},
		{
			id: "trend",
			kind: "area",
			title: "阅读与提问",
			note: "柱：阅读次数　线：AI 提问",
			data: {
				labels: days365,
				bars: viewsSeries,
				line: days365.map((day) => askMap.get(day) ?? 0),
				barLabel: "阅读次数",
				lineLabel: "AI 提问",
			},
		},
		{
			id: "funnel",
			kind: "funnel",
			title: "读者走到哪一步",
			note: "按独立访客计（埋点上线起）",
			data: { steps },
		},
		{
			id: "calendar",
			kind: "calendar",
			title: "阅读热度日历",
			note: "最近 20 周",
			data: {
				days: Array.from(calendarMap.entries()).map(([day, count]) => ({
					day,
					count,
				})),
			},
		},
		{
			id: "pages",
			kind: "rank",
			title: "热门页面",
			note: "按阅读次数",
			data: { rows: topPages },
		},
	];
}

/* ---------------- 受众 ---------------- */

export async function audienceCards(env, range) {
	const { from, to, prevFrom, prevTo, days } = range;

	const [
		dailyViews,
		prevViews,
		dailyVisit,
		heat,
		keep,
		newOld,
		boards,
		hours,
		topPages,
		sticky,
	] = await Promise.all([
		viewsDaily(env, from, to),
		viewsTotal(env, prevFrom, prevTo),
		dailyAgg(env, { type: "page_view", from, to }),
		heatmap(env, { type: "page_view", from, to }),
		retention(env, { type: "page_view", from, to, offsets: [1, 7, 30] }),
		env.DB.prepare(
			`WITH f AS (
					SELECT vid, MIN(day) AS d FROM events
					WHERE type = 'page_view' AND vid <> '' GROUP BY vid
				 )
				 SELECT COUNT(*) AS total,
					COALESCE(SUM(CASE WHEN d BETWEEN ? AND ? THEN 1 ELSE 0 END), 0) AS fresh
				 FROM f WHERE d <= ?`,
		)
			.bind(from, to, to)
			.first(),
		env.DB.prepare(
			`WITH f AS (
					SELECT vid, MIN(day) AS d FROM events
					WHERE type = 'page_view' AND vid <> '' GROUP BY vid
				 )
				 SELECT COUNT(*) AS v FROM f WHERE d BETWEEN ? AND ?`,
		)
			.bind(from, to)
			.first(),
		hours24(env, from, to),
		viewsTop(env, from, to, 8),
		env.DB.prepare(
			`SELECT AVG(c) AS v FROM (
					SELECT vid, COUNT(DISTINCT day) AS c FROM events
					WHERE type = 'page_view' AND vid <> '' AND day BETWEEN ? AND ?
					GROUP BY vid
				 )`,
		)
			.bind(from, to)
			.first(),
	]);

	const labels = dayList(from, days);
	const viewMap = new Map(
		dailyViews.map((row) => [row.day, Number(row.v ?? 0)]),
	);
	const visitMap = new Map(
		dailyVisit.map((row) => [row.day, Number(row.users ?? 0)]),
	);
	const viewSeries = labels.map((day) => viewMap.get(day) ?? 0);
	const visitSeries = labels.map((day) => visitMap.get(day) ?? 0);
	const total = viewSeries.reduce((acc, value) => acc + value, 0);

	const totalVisitors = newOld?.total ?? 0;
	const fresh = newOld?.fresh ?? 0;
	const inRange = boards?.v ?? 0;

	return [
		{
			id: "kpis",
			kind: "kpi",
			title: "核心指标",
			data: {
				items: [
					{
						key: "readers",
						label: "区间访客",
						value: inRange,
						delta: null,
						spark: visitSeries,
						note: "区间内浏览过页面的独立访客",
					},
					{
						key: "fresh",
						label: "新访客",
						value: fresh,
						delta: null,
						spark: [],
						note: "第一次来就在这个区间",
					},
					{
						key: "views",
						label: "阅读次数",
						value: total,
						delta: delta(total, prevViews),
						spark: viewSeries,
						note: "聚合表口径",
					},
					{
						key: "per",
						label: "人均阅读",
						value: inRange > 0 ? Number((total / inRange).toFixed(1)) : 0,
						decimals: 1,
						delta: null,
						spark: [],
						note: "阅读次数 ÷ 区间访客",
					},
					{
						key: "sticky",
						label: "平均活跃天数",
						value: Number((sticky?.v ?? 0).toFixed(1)),
						decimals: 1,
						delta: null,
						spark: [],
						note: "一个人在这段时间里来过几天",
					},
					{
						key: "return",
						label: "回访占比",
						value:
							totalVisitors > 0
								? Number(
										(((totalVisitors - fresh) / totalVisitors) * 100).toFixed(
											1,
										),
									)
								: 0,
						unit: "%",
						decimals: 1,
						delta: null,
						spark: [],
						note: "以前来过、这次又来的比例",
					},
				],
			},
		},
		{
			id: "trend",
			kind: "area",
			title: "访客与阅读",
			note: "柱：阅读次数　线：独立访客",
			data: {
				labels,
				bars: viewSeries,
				line: visitSeries,
				barLabel: "阅读次数",
				lineLabel: "独立访客",
			},
		},
		{
			id: "heatmap",
			kind: "heatmap",
			title: "访问时段分布",
			note: "周 × 小时（埋点上线起）",
			data: heat,
		},
		{
			id: "hours",
			kind: "bars",
			title: "24 小时分布",
			note: "聚合表口径，历史完整",
			data: { rows: hours.filter((row) => row.count > 0) },
		},
		{
			id: "keep",
			kind: "bars",
			title: "留存",
			note: "首次访问后第 N 天还回来",
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
			id: "mix",
			kind: "donut",
			title: "新老访客",
			note: "按区间内全部访客",
			data: {
				rows: [
					{ label: "首次到访", count: fresh },
					{ label: "回访", count: Math.max(0, totalVisitors - fresh) },
				],
			},
		},
		{
			id: "pages",
			kind: "rank",
			title: "热门页面",
			note: "按阅读次数",
			data: { rows: topPages },
		},
	];
}

/* ---------------- 参与 ---------------- */

export async function engagementCards(env, range) {
	const { from, to } = range;

	const [
		searchTop,
		searchZero,
		searchTotal,
		quiz,
		composition,
		depth,
		comments,
		askTotal,
		views,
	] = await Promise.all([
		env.DB.prepare(
			"SELECT keyword AS k, COUNT(*) AS v FROM search_log WHERE day BETWEEN ? AND ? GROUP BY keyword ORDER BY v DESC LIMIT 8",
		)
			.bind(from, to)
			.all(),
		env.DB.prepare(
			"SELECT keyword AS k, COUNT(*) AS v FROM search_log WHERE results = 0 AND day BETWEEN ? AND ? GROUP BY keyword ORDER BY v DESC LIMIT 8",
		)
			.bind(from, to)
			.all(),
		env.DB.prepare(
			"SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN results = 0 THEN 1 ELSE 0 END), 0) AS zero FROM search_log WHERE day BETWEEN ? AND ?",
		)
			.bind(from, to)
			.first(),
		env.DB.prepare(
			"SELECT grade, COALESCE(SUM(count), 0) AS v FROM quiz_grade GROUP BY grade ORDER BY grade",
		).all(),
		env.DB.prepare(
			"SELECT type AS k, COUNT(*) AS v FROM events WHERE day BETWEEN ? AND ? GROUP BY type ORDER BY v DESC",
		)
			.bind(from, to)
			.all(),
		env.DB.prepare(
			`SELECT c, COUNT(*) AS v FROM (
					SELECT sid, COUNT(*) AS c FROM events
					WHERE type = 'ask' AND sid <> '' AND day BETWEEN ? AND ?
					GROUP BY sid
				 ) GROUP BY c ORDER BY c`,
		)
			.bind(from, to)
			.all(),
		env.DB.prepare(
			"SELECT COUNT(*) AS n FROM comments WHERE substr(created_at, 1, 10) BETWEEN ? AND ? AND deleted_at IS NULL",
		)
			.bind(from, to)
			.first(),
		periodAgg(env, { type: "ask", from, to }),
		viewsTotal(env, from, to),
	]);

	const gradeLabel = { 0: "不会", 1: "有点卡", 2: "会了" };
	const quizRows = (quiz?.results ?? []).map((row) => ({
		label: gradeLabel[row.grade] ?? `评分 ${row.grade}`,
		count: row.v ?? 0,
	}));

	const depthRows = (depth?.results ?? [])
		.filter((row) => Number(row.c ?? 0) > 0)
		.map((row) => ({ label: `问 ${row.c} 句`, count: row.v ?? 0 }));

	const searched = searchTotal?.n ?? 0;
	const zero = searchTotal?.zero ?? 0;
	const asks = askTotal.total ?? 0;

	return [
		{
			id: "kpis",
			kind: "kpi",
			title: "核心指标",
			data: {
				items: [
					{
						key: "search",
						label: "站内搜索",
						value: searched,
						delta: null,
						spark: [],
						note: "有结果的搜索次数",
					},
					{
						key: "zero",
						label: "搜不到的比例",
						value:
							searched > 0 ? Number(((zero / searched) * 100).toFixed(1)) : 0,
						unit: "%",
						decimals: 1,
						delta: null,
						spark: [],
						note: "零结果 ÷ 全部搜索",
					},
					{
						key: "asks",
						label: "AI 提问",
						value: asks,
						delta: null,
						spark: [],
						note: "事件流口径",
					},
					{
						key: "quiz",
						label: "刷题评分",
						value: quizRows.reduce((acc, row) => acc + row.count, 0),
						delta: null,
						spark: [],
						note: "累计打分次数",
					},
					{
						key: "comments",
						label: "评论",
						value: comments?.n ?? 0,
						delta: null,
						spark: [],
						note: "区间内新留言",
					},
					{
						key: "perView",
						label: "每千次阅读的提问",
						value: views > 0 ? Number(((asks / views) * 1000).toFixed(1)) : 0,
						decimals: 1,
						delta: null,
						spark: [],
						note: "AI 使用密度",
					},
				],
			},
		},
		{
			id: "depth",
			kind: "bars",
			title: "一次会话问几句",
			note: "会话深度",
			data: { rows: depthRows },
		},
		{
			id: "composition",
			kind: "bars",
			title: "行为构成",
			note: "区间内各类事件量（埋点上线起）",
			data: {
				rows: (composition?.results ?? []).map((row) => ({
					label:
						{
							page_view: "浏览",
							panel_open: "开面板",
							ask: "提问",
							search: "搜索",
							quiz: "刷题",
							comment: "评论",
						}[row.k] ?? row.k,
					count: row.v ?? 0,
				})),
			},
		},
		{
			id: "searches",
			kind: "rank",
			title: "读者在搜什么",
			note: "站内搜索词",
			data: {
				rows: (searchTop?.results ?? []).map((row) => ({
					label: row.k,
					count: row.v,
				})),
				text: true,
			},
		},
		{
			id: "zeroSearch",
			kind: "rank",
			title: "搜了却没有的",
			note: "零结果搜索词 = 选题清单",
			data: {
				rows: (searchZero?.results ?? []).map((row) => ({
					label: row.k,
					count: row.v,
				})),
				text: true,
			},
		},
		{
			id: "quiz",
			kind: "bars",
			title: "刷题自评",
			note: "累计评分分布，不会的最多就说明答案要重写",
			data: { rows: quizRows },
		},
	];
}

/* ---------------- 内容 ---------------- */

export async function contentCards(env, range) {
	const { from, to } = range;

	const [viewRows, askRows, commentRows, quizRows, monthRows] =
		await Promise.all([
			env.DB.prepare(
				"SELECT path, SUM(count) AS v FROM views WHERE day BETWEEN ? AND ? AND path LIKE '/posts/%' GROUP BY path",
			)
				.bind(from, to)
				.all(),
			env.DB.prepare(
				"SELECT path, COUNT(*) AS v FROM events WHERE type = 'ask' AND day BETWEEN ? AND ? AND path LIKE '/posts/%' GROUP BY path",
			)
				.bind(from, to)
				.all(),
			env.DB.prepare(
				`SELECT slug, COUNT(*) AS v FROM comments
			 WHERE deleted_at IS NULL AND status <> 'spam'
			 GROUP BY slug`,
			).all(),
			env.DB.prepare(
				`SELECT slug,
				COALESCE(SUM(CASE WHEN grade = 0 THEN count ELSE 0 END), 0) AS miss,
				COALESCE(SUM(CASE WHEN grade = 1 THEN count ELSE 0 END), 0) AS stuck,
				COALESCE(SUM(count), 0) AS total
			 FROM quiz_grade GROUP BY slug ORDER BY miss DESC, total DESC LIMIT 10`,
			).all(),
			env.DB.prepare(
				"SELECT day, SUM(count) AS v FROM views WHERE day BETWEEN ? AND ? GROUP BY day ORDER BY day",
			)
				.bind(from, to)
				.all(),
		]);

	const viewMap = new Map(
		(viewRows?.results ?? []).map((row) => [row.path, row.v ?? 0]),
	);
	const askMap = new Map(
		(askRows?.results ?? []).map((row) => [row.path, row.v ?? 0]),
	);
	const commentMap = new Map(
		(commentRows?.results ?? []).map((row) => [row.slug, row.v ?? 0]),
	);

	const paths = new Set([...viewMap.keys(), ...askMap.keys()]);
	const rows = Array.from(paths)
		.map((path) => {
			const slug = shortPath(path);
			return {
				label: slug,
				href: path,
				views: Number(viewMap.get(path) ?? 0),
				asks: Number(askMap.get(path) ?? 0),
				comments: Number(commentMap.get(slug) ?? 0),
			};
		})
		.sort((a, b) => b.views - a.views)
		.slice(0, 15);

	return [
		{
			id: "table",
			kind: "table",
			title: "文章表现",
			note: "阅读 / 提问 / 评论（区间内）",
			data: {
				columns: ["文章", "阅读", "提问", "评论", "提问率"],
				rows: rows.map((row) => [
					row.label,
					String(row.views),
					String(row.asks),
					String(row.comments),
					`${row.views > 0 ? ((row.asks / row.views) * 100).toFixed(1) : "0.0"}%`,
				]),
			},
		},
		{
			id: "views",
			kind: "area",
			title: "阅读节奏",
			note: "每天被读了多少次",
			data: {
				labels: dayList(from, range.days),
				bars: fillDays(
					(monthRows?.results ?? []).map((row) => ({
						day: row.day,
						count: row.v,
					})),
					from,
					range.days,
				).map((row) => row.count),
				line: [],
				barLabel: "阅读次数",
			},
		},
		{
			id: "quiz",
			kind: "rank",
			title: "总记不住的题",
			note: "被标「不会」最多的，答案该重写",
			data: {
				rows: (quizRows?.results ?? [])
					.filter((row) => Number(row.miss ?? 0) > 0)
					.map((row) => ({ label: row.slug, count: row.miss ?? 0 })),
			},
		},
	];
}
