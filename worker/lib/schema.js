/**
 * 建表自愈。
 *
 * 所有 DDL 都是 IF NOT EXISTS，可重复执行；每个 Worker 实例第一次碰到数据库时跑一遍，
 * 这样即便忘了手动执行 schema.sql，统计表也会自动出现（数据台读接口也靠它兜底）。
 *
 * 缓存在 DB 对象上而不是模块级单例：同一个 Worker 实例可能换绑库，测试里也会同时存在多套库。
 */

import { EVENTS_DDL } from "./events.js";

const BASE_DDL = [
	"CREATE TABLE IF NOT EXISTS views (day TEXT NOT NULL, path TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, path))",
	"CREATE TABLE IF NOT EXISTS ai_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, day TEXT NOT NULL, question TEXT NOT NULL, model TEXT, ms INTEGER, tokens INTEGER, ok INTEGER NOT NULL DEFAULT 1)",
	"CREATE TABLE IF NOT EXISTS views_hourly (day TEXT NOT NULL, hour INTEGER NOT NULL, count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, hour))",
	"CREATE TABLE IF NOT EXISTS ai_hits (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, day TEXT NOT NULL, hits INTEGER NOT NULL DEFAULT 0, paths TEXT DEFAULT '')",
	"CREATE TABLE IF NOT EXISTS search_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, day TEXT NOT NULL, keyword TEXT NOT NULL, results INTEGER DEFAULT 0)",
	"CREATE TABLE IF NOT EXISTS quiz_grade (slug TEXT NOT NULL, grade INTEGER NOT NULL, count INTEGER NOT NULL DEFAULT 0, updated TEXT NOT NULL, PRIMARY KEY (slug, grade))",
	"CREATE TABLE IF NOT EXISTS quiz_state (id INTEGER PRIMARY KEY CHECK (id = 1), payload TEXT NOT NULL, updated TEXT NOT NULL)",
];

const ready = new WeakMap();

export function ensureSchema(env) {
	if (!env?.DB) return Promise.resolve();

	const cached = ready.get(env.DB);
	if (cached) return cached;

	const promise = env.DB.batch([
		...BASE_DDL.map((sql) => env.DB.prepare(sql)),
		// 数据台 v2：全站事件表（聚合逻辑见 worker/lib/stats.js）
		...EVENTS_DDL.map((sql) => env.DB.prepare(sql)),
	]).catch((error) => {
		ready.delete(env.DB); // 失败就别缓存，下次重试
		console.warn("自动建表失败", error);
	});

	ready.set(env.DB, promise);
	return promise;
}
