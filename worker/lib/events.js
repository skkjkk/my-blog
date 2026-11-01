/**
 * 全站事件埋点。
 *
 * 设计要点：
 *   1. 一张 events 表装下所有行为（阅读 / 打开 AI / 提问 / 搜索 / 刷题 / 评论），
 *      聚合靠 worker/lib/stats.js 的通用原语，不再为每个功能单独建表。
 *   2. 隐私：访客 id / 会话 id 由前端随机生成（localStorage / sessionStorage），
 *      入库前再用 IP_SALT 做一次不可逆哈希。不存 IP、不存 UA、不存 raw id。
 *   3. 写入永远走 ctx.waitUntil，绝不拖慢用户请求；失败只 warn。
 */

import { sha256Hex } from "./crypto.js";

/** 允许的事件类型。前后端共用，前端乱传的一律丢弃 */
export const EVENT_TYPES = [
	"page_view", // 打开页面
	"panel_open", // 打开 AI 面板
	"ask", // 提交一个提问（成功与否都记）
	"search", // 站内搜索
	"quiz", // 刷题评分
	"comment", // 发评论
];

const TYPE_SET = new Set(EVENT_TYPES);
const MAX_TEXT = 240;

export const EVENTS_DDL = [
	`CREATE TABLE IF NOT EXISTS events (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		ts TEXT NOT NULL,
		day TEXT NOT NULL,
		hour INTEGER NOT NULL DEFAULT 0,
		dow INTEGER NOT NULL DEFAULT 0,
		vid TEXT DEFAULT '',
		sid TEXT DEFAULT '',
		type TEXT NOT NULL,
		path TEXT DEFAULT '',
		ms INTEGER DEFAULT 0,
		ttft INTEGER DEFAULT 0,
		tokens INTEGER DEFAULT 0,
		ok INTEGER NOT NULL DEFAULT 1,
		err TEXT DEFAULT '',
		n INTEGER DEFAULT 0,
		hits INTEGER DEFAULT 0,
		tag TEXT DEFAULT '',
		text TEXT DEFAULT '',
		meta TEXT DEFAULT ''
	)`,
	"CREATE INDEX IF NOT EXISTS idx_events_type_day ON events (type, day)",
	"CREATE INDEX IF NOT EXISTS idx_events_day ON events (day)",
	"CREATE INDEX IF NOT EXISTS idx_events_vid ON events (vid, day)",
	"CREATE INDEX IF NOT EXISTS idx_events_sid ON events (sid)",
];

const ready = new WeakMap();

/** 第一次用到时建表；失败不缓存，下次重试 */
export function ensureEvents(env) {
	if (!env?.DB) return Promise.resolve();
	const cached = ready.get(env.DB);
	if (cached) return cached;

	const promise = (async () => {
		for (const sql of EVENTS_DDL) await env.DB.prepare(sql).run();
	})().catch((error) => {
		ready.delete(env.DB);
		console.warn("events 建表失败", error);
	});

	ready.set(env.DB, promise);
	return promise;
}

const text = (value, limit = MAX_TEXT) => String(value ?? "").slice(0, limit);
const int = (value, limit = 2_000_000_000) => {
	const n = Math.round(Number(value) || 0);
	if (!Number.isFinite(n)) return 0;
	return Math.max(0, Math.min(limit, n));
};

/** 北京时间分片：day / hour / dow(0=周一) */
export function sliceOf(date = new Date()) {
	const shifted = new Date(date.getTime() + 8 * 3600 * 1000);
	const iso = shifted.toISOString();
	const dow = (shifted.getUTCDay() + 6) % 7;
	return {
		day: iso.slice(0, 10),
		hour: Number(iso.slice(11, 13)),
		dow,
	};
}

async function hashed(salt, kind, raw) {
	const value = String(raw ?? "").trim();
	if (!value) return "";
	return (await sha256Hex(`${salt}${kind}:${value}`)).slice(0, 16);
}

/**
 * 把一次事件整理成可直接 bind 的行（含哈希与时间片）。
 * 返回 null 表示这条事件不合法，调用方直接忽略。
 */
export async function buildEvent(env, input) {
	const type = text(input?.type, 24);
	if (!TYPE_SET.has(type)) return null;

	const salt = String(env?.IP_SALT ?? "wkb-local");
	const now = new Date();
	const { day, hour, dow } = sliceOf(now);

	return {
		ts: now.toISOString(),
		day,
		hour,
		dow,
		vid: await hashed(salt, "vid", input?.vid),
		sid: await hashed(salt, "sid", input?.sid),
		type,
		path: text(input?.path, 300),
		ms: int(input?.ms),
		ttft: int(input?.ttft),
		tokens: int(input?.tokens),
		ok: input?.ok === false || input?.ok === 0 ? 0 : 1,
		err: text(input?.err, 80),
		n: int(input?.n),
		hits: int(input?.hits),
		tag: text(input?.tag, 80),
		text: text(input?.text),
		meta: text(input?.meta ? JSON.stringify(input.meta) : "", 1200),
	};
}

const INSERT_SQL = `INSERT INTO events
	(ts, day, hour, dow, vid, sid, type, path, ms, ttft, tokens, ok, err, n, hits, tag, text, meta)
	VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

function bindRow(env, row) {
	return env.DB.prepare(INSERT_SQL).bind(
		row.ts,
		row.day,
		row.hour,
		row.dow,
		row.vid,
		row.sid,
		row.type,
		row.path,
		row.ms,
		row.ttft,
		row.tokens,
		row.ok,
		row.err,
		row.n,
		row.hits,
		row.tag,
		row.text,
		row.meta,
	);
}

/**
 * 记一条事件。永不抛错、永不阻塞：调用方既可以直接 await（测试里方便），
 * 也可以塞进 ctx.waitUntil。
 */
export async function recordEvent(env, input) {
	if (!env?.DB) return false;
	try {
		const row = await buildEvent(env, input);
		if (!row) return false;
		await ensureEvents(env);
		await bindRow(env, row).run();
		return true;
	} catch (error) {
		console.warn("事件写入失败", error);
		return false;
	}
}

/**
 * 把 vid / sid 直接塞进一批已整理好的行（ask.js 那种需要在流结束时补记的场景）。
 */
export async function recordBuiltEvent(env, row) {
	if (!env?.DB || !row) return false;
	try {
		await ensureEvents(env);
		await bindRow(env, row).run();
		return true;
	} catch (error) {
		console.warn("事件写入失败", error);
		return false;
	}
}
