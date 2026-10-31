/**
 * 本地测试用的 D1 替身：把 Cloudflare 的 D1 API 落到 node:sqlite 上（真实 SQLite 语义）。
 *
 * 为什么需要它：本环境装不了 wrangler（npx 拉包被沙箱拒绝），`wrangler dev` 的
 * 端到端验证走不通。用 node:sqlite 执行真实 SQL，可以把 worker 的请求处理器原样跑起来。
 *
 * 只实现 worker 用到的子集：prepare().bind().first()/all()/run()、batch()、exec()。
 */
import { DatabaseSync } from "node:sqlite";

function toPlain(row) {
	if (!row || typeof row !== "object") return row;
	return { ...row };
}

function normalizeArg(value) {
	if (value === undefined) return null;
	if (typeof value === "boolean") return value ? 1 : 0;
	return value;
}

class D1Statement {
	constructor(database, sql, args = []) {
		this.database = database;
		this.sql = sql;
		this.args = args;
	}

	bind(...args) {
		return new D1Statement(this.database, this.sql, args.map(normalizeArg));
	}

	async all() {
		const rows = this.database.db.prepare(this.sql).all(...this.args);
		return { results: rows.map(toPlain), success: true, meta: {} };
	}

	async first(column) {
		const row = this.database.db.prepare(this.sql).get(...this.args);
		if (!row) return null;
		return column ? row[column] : toPlain(row);
	}

	async run() {
		const info = this.database.db.prepare(this.sql).run(...this.args);
		return { success: true, meta: { changes: info.changes, last_row_id: info.lastInsertRowid } };
	}
}

export function createD1() {
	const database = {
		db: new DatabaseSync(":memory:"),
		prepare(sql) {
			return new D1Statement(database, sql);
		},
		async batch(statements) {
			const results = [];
			database.db.exec("BEGIN");
			try {
				for (const statement of statements) results.push(await statement.run());
				database.db.exec("COMMIT");
			} catch (error) {
				database.db.exec("ROLLBACK");
				throw error;
			}
			return results;
		},
		/** 只给测试用：直接执行多语句脚本（建表） */
		exec(sql) {
			database.db.exec(sql);
		},
	};
	return database;
}

/** 造一个够用的 env：DB + 密钥 + 假 ASSETS */
export function createEnv(overrides = {}) {
	return {
		DB: createD1(),
		ASSETS: { fetch: async () => new Response("asset", { status: 200 }) },
		ADMIN_PASSWORD: "test-pass",
		IP_SALT: "test-ip-salt",
		COMMENT_COOKIE_SECRET: "test-cookie-secret",
		...overrides,
	};
}

/** 直接调 worker 的入口，模拟 Cloudflare 的 fetch(request, env, ctx) */
export function makeCaller(worker) {
	return async (path, init = {}, env) => {
		const request = new Request(`https://blog.test${path}`, init);
		const context = { waitUntil: (promise) => promise, passThroughOnException: () => {} };
		return worker.fetch(request, env, context);
	};
}
