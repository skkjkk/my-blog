/**
 * 滑动窗口限流：判定逻辑是纯函数（好测），计数读写走 D1。
 * 桶形如 `ip:<hash>` / `id:<hash>` / `site`。
 */

export const WINDOW_MS = Object.freeze({
	"30s": 30_000,
	"1h": 3_600_000,
	"1d": 86_400_000,
});

export const RATE_LIMITS = Object.freeze({
	"ip:30s": 1,
	"ip:1h": 10,
	"ip:1d": 30,
	"id:30s": 1,
	"id:1h": 20,
	"site:1h": 200,
});

export function scopeKey(scope, value) {
	return value ? `${scope}:${value}` : scope;
}

/**
 * groups: [{ scope, window, count, firstTs }]
 * 返回 { allowed: true } 或 { allowed: false, scope, window, retryAfter }（秒）。
 */
export function rateVerdict(groups, now) {
	let worst = null;
	for (const group of groups ?? []) {
		const limit = RATE_LIMITS[`${group.scope}:${group.window}`];
		if (!limit) continue;
		if (Number(group.count) < limit) continue;
		const windowMs = WINDOW_MS[group.window];
		const firstTs = Number(group.firstTs);
		const remainMs = Number.isFinite(firstTs) ? firstTs + windowMs - now : windowMs;
		const retryAfter = Math.max(1, Math.ceil(remainMs / 1000));
		if (!worst || retryAfter > worst.retryAfter) {
			worst = { allowed: false, scope: group.scope, window: group.window, retryAfter };
		}
	}
	return worst ?? { allowed: true };
}

/**
 * 查最近 1d 内的计数并按窗口聚合成 rateVerdict 的输入。
 * 查询出错时放行（可用性优先），并标记 degraded 供上层记日志。
 */
export async function rateCheck(db, buckets, now) {
	const scopes = new Set(buckets.map((item) => item.scope));
	const since = new Date(now - WINDOW_MS["1d"]).toISOString();
	const groups = [];
	try {
		for (const bucket of buckets) {
			const { results } = await db
				.prepare(
					"SELECT window, COUNT(*) AS count, MIN(ts) AS first FROM comment_rate WHERE bucket = ? AND ts > ? GROUP BY window",
				)
				.bind(scopeKey(bucket.scope, bucket.value), since)
				.all();
			for (const row of results ?? []) {
				groups.push({ scope: bucket.scope, window: row.window, count: row.count, firstTs: Date.parse(row.first) });
			}
		}
	} catch (error) {
		console.warn("限流查询失败，本次放行", error);
		return { allowed: true, degraded: true };
	}
	void scopes;
	return rateVerdict(groups, now);
}

/** 记一笔访问：每个桶 × 每个窗口一行 */
export async function rateRecord(db, buckets, now) {
	const ts = new Date(now).toISOString();
	const statements = [];
	for (const bucket of buckets) {
		const key = scopeKey(bucket.scope, bucket.value);
		for (const window of Object.keys(WINDOW_MS)) {
			statements.push(db.prepare("INSERT INTO comment_rate (bucket, window, ts) VALUES (?, ?, ?)").bind(key, window, ts));
		}
	}
	if (statements.length === 0) return;
	await db.batch(statements);
}

/** 清掉 2 天前的计数行（由写路径顺手触发，不需要 cron） */
export async function ratePrune(db, now) {
	const before = new Date(now - 2 * WINDOW_MS["1d"]).toISOString();
	await db.prepare("DELETE FROM comment_rate WHERE ts < ?").bind(before).run();
}
