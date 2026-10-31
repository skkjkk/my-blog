import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createD1 } from "../support/d1.mjs";
import { ensureCommentsSchema, getSetting, setSetting } from "../../worker/lib/db.js";

const schemaSql = readFileSync(path.resolve("worker/schema.sql"), "utf8");

test("schema.sql 可重复执行且建出评论相关六张表", () => {
	const db = createD1();
	db.exec(schemaSql);
	db.exec(schemaSql); // 幂等
	const rows = db.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
	const names = rows.map((row) => row.name);
	for (const table of ["comments", "comment_rate", "comment_reports", "comment_keywords", "settings", "audit_log"]) {
		assert.ok(names.includes(table), `缺少表 ${table}`);
	}
});

test("ensureCommentsSchema 在空库上建表，且可重复调用", async () => {
	const env = { DB: createD1() };
	await ensureCommentsSchema(env);
	await ensureCommentsSchema(env);
	const rows = env.DB.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
	assert.ok(rows.some((row) => row.name === "comments"));
});

test("getSetting 取默认值，setSetting 之后能读回", async () => {
	const db = createD1();
	await ensureCommentsSchema({ DB: db });
	assert.equal(await getSetting(db, "comment_mode", "auto"), "auto");
	await setSetting(db, "comment_mode", "hold");
	assert.equal(await getSetting(db, "comment_mode", "auto"), "hold");
});
