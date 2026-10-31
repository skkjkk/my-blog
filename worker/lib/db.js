/**
 * 评论区的表结构自愈与设置读写。
 * 与 worker/schema.sql 保持一致：所有语句 IF NOT EXISTS，可重复执行。
 * 第一个用到数据库的请求会跑一遍，失败不缓存（下次重试），避免"一次抖动永久坏掉"。
 */

const CREATE_STATEMENTS = [
	`CREATE TABLE IF NOT EXISTS comments (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id       TEXT    NOT NULL,
    slug          TEXT    NOT NULL,
    parent_id     INTEGER,
    root_id       INTEGER,
    depth         INTEGER NOT NULL DEFAULT 0,
    name          TEXT    NOT NULL,
    email_hash    TEXT,
    website       TEXT,
    content       TEXT    NOT NULL,
    content_hash  TEXT    NOT NULL,
    status        TEXT    NOT NULL DEFAULT 'pending',
    is_admin      INTEGER NOT NULL DEFAULT 0,
    pinned        INTEGER NOT NULL DEFAULT 0,
    report_count  INTEGER NOT NULL DEFAULT 0,
    identity_hash TEXT    NOT NULL,
    ip_hash       TEXT,
    ua_hash       TEXT,
    client_id     TEXT    NOT NULL,
    created_at    TEXT    NOT NULL,
    updated_at    TEXT,
    deleted_at    TEXT
  )`,
	"CREATE UNIQUE INDEX IF NOT EXISTS idx_comments_client ON comments (client_id)",
	"CREATE INDEX IF NOT EXISTS idx_comments_post ON comments (post_id, status, created_at)",
	"CREATE INDEX IF NOT EXISTS idx_comments_slug ON comments (slug, status, created_at)",
	"CREATE INDEX IF NOT EXISTS idx_comments_identity ON comments (identity_hash, created_at)",
	"CREATE INDEX IF NOT EXISTS idx_comments_root ON comments (root_id)",
	"CREATE INDEX IF NOT EXISTS idx_comments_status ON comments (status, created_at)",
	"CREATE TABLE IF NOT EXISTS comment_rate (bucket TEXT NOT NULL, window TEXT NOT NULL, ts TEXT NOT NULL)",
	"CREATE INDEX IF NOT EXISTS idx_rate_bucket ON comment_rate (bucket, ts)",
	"CREATE INDEX IF NOT EXISTS idx_rate_ts ON comment_rate (ts)",
	`CREATE TABLE IF NOT EXISTS comment_reports (
    comment_id INTEGER NOT NULL,
    ip_hash    TEXT    NOT NULL,
    ts         TEXT    NOT NULL,
    PRIMARY KEY (comment_id, ip_hash)
  )`,
	"CREATE TABLE IF NOT EXISTS comment_keywords (id INTEGER PRIMARY KEY AUTOINCREMENT, word TEXT NOT NULL UNIQUE, ts TEXT NOT NULL)",
	"CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
	"CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, action TEXT NOT NULL, target TEXT, detail TEXT)",
];

const readyByDb = new WeakMap();

export function ensureCommentsSchema(env) {
	const db = env?.DB;
	if (!db) return Promise.resolve();
	const cached = readyByDb.get(db);
	if (cached) return cached;
	const pending = db.batch(CREATE_STATEMENTS.map((sql) => db.prepare(sql))).catch((error) => {
		readyByDb.delete(db); // 失败不缓存，下次重试
		throw error;
	});
	readyByDb.set(db, pending);
	return pending;
}

export const DEFAULT_SETTINGS = Object.freeze({ comment_mode: "auto" });

export async function getSetting(db, key, fallback) {
	if (!db) return fallback;
	try {
		const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first();
		return row?.value ?? fallback;
	} catch (error) {
		console.warn("读取设置失败，用默认值", key, error);
		return fallback;
	}
}

export async function setSetting(db, key, value) {
	await db
		.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
		.bind(key, String(value))
		.run();
}

export async function getCommentMode(db) {
	const mode = await getSetting(db, "comment_mode", DEFAULT_SETTINGS.comment_mode);
	return mode === "hold" ? "hold" : "auto";
}

export async function writeAudit(db, action, target, detail) {
	if (!db) return;
	try {
		await db
			.prepare("INSERT INTO audit_log (ts, action, target, detail) VALUES (?, ?, ?, ?)")
			.bind(new Date().toISOString(), String(action), target === undefined || target === null ? null : String(target), detail ?? null)
			.run();
	} catch (error) {
		console.warn("审计日志写入失败", error);
	}
}
