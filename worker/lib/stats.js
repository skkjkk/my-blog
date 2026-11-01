/**
 * 数据台聚合原语。
 *
 * 页面不再自己写 SQL：每个指标都是下面某个原语的一次调用，
 * 所以新增一张卡片 ≈ 新增一行声明，而不是新增一段查询。
 *
 * 所有 SQL 里的 type / 字段名都来自服务端常量，不拼接用户输入；
 * 时间范围一律走 bind。
 */

const DAY_MS = 86_400_000;

export function bjDay(offsetDays = 0, base = Date.now()) {
	return new Date(base + 8 * 3600 * 1000 - offsetDays * DAY_MS)
		.toISOString()
		.slice(0, 10);
}

/** 解析 ?range=7|14|30|90，并算出上一周期用于对比 */
export function rangeOf(searchParams, allowed = [7, 14, 30, 90]) {
	const raw = Number(searchParams?.get?.("range") ?? 14);
	const range = allowed.includes(raw) ? raw : 14;
	const to = bjDay(0);
	const from = bjDay(range - 1);
	const prevTo = bjDay(range);
	const prevFrom = bjDay(range * 2 - 1);
	return { range, from, to, prevFrom, prevTo, days: range };
}

/** 补齐成连续的 N 天序列，缺的那天补 0（画图不能有断点） */
export function fillDays(rows, from, days, field = "count") {
	const map = new Map(
		(rows ?? []).map((row) => [row.day, Number(row[field] ?? 0)]),
	);
	const out = [];
	const start = new Date(`${from}T00:00:00Z`).getTime();
	for (let i = 0; i < days; i++) {
		const day = new Date(start + i * DAY_MS).toISOString().slice(0, 10);
		out.push({ day, count: map.get(day) ?? 0 });
	}
	return out;
}

const safeRatio = (a, b) => (b > 0 ? Number(((a / b) * 100).toFixed(1)) : 0);

/** 每天一行：次数 / 成功数 / 独立访客 / 独立会话 / 平均首字 / tokens */
export async function dailyAgg(env, { type, from, to, extraWhere = "" }) {
	const { results } = await env.DB.prepare(
		`SELECT day,
			COUNT(*) AS total,
			COALESCE(SUM(ok), 0) AS ok,
			COUNT(DISTINCT NULLIF(vid, '')) AS users,
			COUNT(DISTINCT NULLIF(sid, '')) AS sessions,
			COALESCE(SUM(tokens), 0) AS tokens,
			COALESCE(AVG(NULLIF(ttft, 0)), 0) AS avgTtft,
			COALESCE(AVG(ms), 0) AS avgMs
		FROM events
		WHERE type = ? AND day BETWEEN ? AND ?${extraWhere}
		GROUP BY day ORDER BY day`,
	)
		.bind(type, from, to)
		.all();
	return results ?? [];
}

/** 周期汇总（不分组），用于「本期 vs 上期」 */
export async function periodAgg(env, { type, from, to, extraWhere = "" }) {
	const row = await env.DB.prepare(
		`SELECT COUNT(*) AS total,
			COALESCE(SUM(ok), 0) AS ok,
			COUNT(DISTINCT NULLIF(vid, '')) AS users,
			COUNT(DISTINCT NULLIF(sid, '')) AS sessions,
			COALESCE(SUM(tokens), 0) AS tokens,
			COALESCE(AVG(NULLIF(ttft, 0)), 0) AS avgTtft,
			COALESCE(AVG(ms), 0) AS avgMs
		FROM events
		WHERE type = ? AND day BETWEEN ? AND ?${extraWhere}`,
	)
		.bind(type, from, to)
		.first();
	return (
		row ?? {
			total: 0,
			ok: 0,
			users: 0,
			sessions: 0,
			tokens: 0,
			avgTtft: 0,
			avgMs: 0,
		}
	);
}

/** 周期内去重计数（访客 / 会话） */
export async function uniqCount(env, { type, from, to, field = "vid" }) {
	const column = field === "sid" ? "sid" : "vid";
	const row = await env.DB.prepare(
		`SELECT COUNT(DISTINCT NULLIF(${column}, '')) AS v
		 FROM events WHERE type = ? AND day BETWEEN ? AND ?`,
	)
		.bind(type, from, to)
		.first();
	return row?.v ?? 0;
}

/** 某字段的取值分布（模型、来源页、错误类型…） */
export async function groupCount(
	env,
	{ type, from, to, field = "tag", limit = 8, extraWhere = "" },
) {
	const allowed = new Set(["tag", "path", "err", "day"]);
	const column = allowed.has(field) ? field : "tag";
	const { results } = await env.DB.prepare(
		`SELECT ${column} AS k, COUNT(*) AS v
		 FROM events WHERE type = ? AND day BETWEEN ? AND ?${extraWhere}
		 GROUP BY ${column} ORDER BY v DESC LIMIT ?`,
	)
		.bind(type, from, to, limit)
		.all();
	return (results ?? []).filter((row) => row.k);
}

/** 分位数：ttft / ms / tokens */
export async function percentile(
	env,
	{ type, from, to, field = "ttft", ps = [50, 90, 99] },
) {
	const column = ["ttft", "ms", "tokens"].includes(field) ? field : "ttft";
	const { results } = await env.DB.prepare(
		`SELECT ${column} AS v FROM events
		 WHERE type = ? AND day BETWEEN ? AND ? AND ${column} > 0 AND ok = 1
		 ORDER BY ${column} LIMIT 5000`,
	)
		.bind(type, from, to)
		.all();
	const values = (results ?? [])
		.map((row) => Number(row.v))
		.filter((n) => n > 0);
	const out = {};
	for (const p of ps) {
		if (values.length === 0) {
			out[`p${p}`] = 0;
			continue;
		}
		const index = Math.min(
			values.length - 1,
			Math.max(0, Math.ceil((p / 100) * values.length) - 1),
		);
		out[`p${p}`] = values[index];
	}
	out.values = values;
	return out;
}

/** 直方图：把 values 按 edges 分桶（edges 最后一段是开区间） */
export function bucketize(values, edges) {
	// 标签用秒，手机上标签才不会挤成一团
	const fmt = (ms) => (ms >= 1000 ? `${Math.round(ms / 1000)}s` : `${ms}ms`);
	const buckets = edges.map((edge, index) => ({
		label:
			index === 0
				? `<${fmt(edges[0])}`
				: index === edges.length - 1
					? `≥${fmt(edges[index - 1])}`
					: `${fmt(edges[index - 1])}–${fmt(edge)}`,
		from: index === 0 ? 0 : edges[index - 1],
		to: edge,
		count: 0,
	}));
	for (const value of values ?? []) {
		const n = Number(value);
		let placed = false;
		for (let i = 0; i < edges.length; i++) {
			if (n < edges[i]) {
				buckets[i].count += 1;
				placed = true;
				break;
			}
		}
		if (!placed) buckets[buckets.length - 1].count += 1;
	}
	return buckets.map((bucket) => ({
		label: bucket.label,
		count: bucket.count,
	}));
}

/** 星期 × 小时热力图（dow: 0=周一 … 6=周日） */
export async function heatmap(env, { type, from, to }) {
	const { results } = await env.DB.prepare(
		`SELECT dow, hour, COUNT(*) AS v FROM events
		 WHERE type = ? AND day BETWEEN ? AND ? GROUP BY dow, hour`,
	)
		.bind(type, from, to)
		.all();
	const cells = (results ?? []).map((row) => ({
		dow: row.dow ?? 0,
		hour: row.hour ?? 0,
		count: row.v ?? 0,
	}));
	const max = cells.reduce((acc, cell) => Math.max(acc, cell.count), 0);
	return { cells, max };
}

/**
 * 漏斗：steps = [{key, label, sql}]
 * 每一步都按「独立访客」计数，step.sql 里用 ? AND ? 占位 from/to。
 */
export async function funnel(env, { from, to, steps }) {
	const selects = steps
		.map((step) => `(${step.sql}) AS "${step.key}"`)
		.join(",\n");
	const binds = steps.flatMap(() => [from, to]);
	const row = await env.DB.prepare(`SELECT ${selects}`)
		.bind(...binds)
		.first();

	const first = Number(row?.[steps[0]?.key] ?? 0);
	return steps.map((step, index) => {
		const value = Number(row?.[step.key] ?? 0);
		return {
			key: step.key,
			label: step.label,
			value,
			/* 相对第一步的转化率，以及相对上一步的流失率 */
			rate: safeRatio(value, first),
			stepRate:
				index === 0
					? 100
					: safeRatio(value, Number(row?.[steps[index - 1].key] ?? 0)),
		};
	});
}

/** 会话深度 / 用户分层：把「每人多少次」这种分布按档位聚起来 */
export async function bucketCount(
	env,
	{ type, from, to, field = "sid", buckets },
) {
	const column = field === "vid" ? "vid" : "sid";
	const { results } = await env.DB.prepare(
		`SELECT c, COUNT(*) AS v FROM (
			SELECT ${column} AS k, COUNT(*) AS c FROM events
			WHERE type = ? AND day BETWEEN ? AND ? AND ${column} <> ''
			GROUP BY ${column}
		 ) GROUP BY c ORDER BY c`,
	)
		.bind(type, from, to)
		.all();

	const rows = results ?? [];
	return buckets.map((bucket) => ({
		label: bucket.label,
		count: rows
			.filter(
				(row) =>
					row.c >= bucket.min &&
					(bucket.max === undefined || row.c <= bucket.max),
			)
			.reduce((acc, row) => acc + row.v, 0),
	}));
}

/**
 * 留存：按「首次出现的那天」分群，看第 N 天还回来的比例。
 * 只有带 vid 的事件才算，所以上线前的历史数据不参与（页面会标注）。
 */
export async function retention(env, { type, from, to, offsets = [1, 7, 30] }) {
	const { results } = await env.DB.prepare(
		`WITH first_seen AS (
			SELECT vid, MIN(day) AS cohort FROM events
			WHERE type = ? AND day BETWEEN ? AND ? AND vid <> ''
			GROUP BY vid
		 )
		 SELECT f.cohort AS cohort,
			julianday(e.day) - julianday(f.cohort) AS off,
			COUNT(DISTINCT e.vid) AS v
		 FROM first_seen f
		 JOIN events e ON e.vid = f.vid AND e.day >= f.cohort
		 WHERE e.type = ? AND e.vid <> ''
		 GROUP BY f.cohort, off`,
	)
		.bind(type, from, to, type)
		.all();

	const rows = results ?? [];
	const sizes = new Map();
	for (const row of rows) {
		if ((row.off ?? 0) === 0) sizes.set(row.cohort, row.v ?? 0);
	}
	const totalUsers = Array.from(sizes.values()).reduce((acc, n) => acc + n, 0);

	return {
		cohorts: sizes.size,
		users: totalUsers,
		offsets: offsets.map((offset) => {
			const returned = rows
				.filter((row) => (row.off ?? 0) === offset)
				.reduce((acc, row) => acc + (row.v ?? 0), 0);
			return { offset, count: returned, rate: safeRatio(returned, totalUsers) };
		}),
	};
}

/** 增长率：本期 vs 上期（分母 0 时返回 null，前端显示 —） */
export function delta(current, previous) {
	const now = Number(current) || 0;
	const before = Number(previous) || 0;
	if (before === 0) return now === 0 ? 0 : null;
	return Number((((now - before) / before) * 100).toFixed(1));
}

export function ratio(a, b, digits = 1) {
	if (!b) return 0;
	return Number(((a / b) * 100).toFixed(digits));
}

export function median(values) {
	const list = (values ?? [])
		.map(Number)
		.filter((n) => Number.isFinite(n))
		.sort((a, b) => a - b);
	if (list.length === 0) return 0;
	return list[Math.floor(list.length / 2)];
}
