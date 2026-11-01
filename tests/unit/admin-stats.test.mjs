/**
 * 数据台 v2：事件埋点 + 卡片接口。
 * 用真实 SQLite（tests/support/d1.mjs）跑，所以断言的是真 SQL 的结果。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import worker from "../../worker/index.js";
import { adminCookieValue } from "../../worker/lib/admin.js";
import { bjDay } from "../../worker/lib/stats.js";
import { createEnv, makeCaller } from "../support/d1.mjs";

const call = makeCaller(worker);
const SCHEMA = readFileSync(new URL("../../worker/schema.sql", import.meta.url), "utf8");

async function setup() {
	const env = createEnv();
	env.DB.exec(SCHEMA);
	const cookie = `wkb_admin=${await adminCookieValue(env.ADMIN_PASSWORD)}`;
	return { env, cookie };
}

/** 直接落一行 ask 事件，省掉跑一遍模型的成本 */
function insertAsk(env, overrides = {}) {
	const row = {
		ts: new Date().toISOString(),
		day: bjDay(0),
		hour: 10,
		dow: 2,
		vid: "v1",
		sid: "s1",
		type: "ask",
		path: "/posts/cas/",
		ms: 3000,
		ttft: 800,
		tokens: 100,
		ok: 1,
		err: "",
		n: 0,
		hits: 2,
		tag: "auto",
		text: "CAS 有什么缺点",
		meta: "",
		...overrides,
	};
	return env.DB.prepare(
		`INSERT INTO events (ts, day, hour, dow, vid, sid, type, path, ms, ttft, tokens, ok, err, n, hits, tag, text, meta)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(
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
		)
		.run();
}

const post = (path, body) => ({
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify(body),
});

test("POST /api/track 落库，且原始 vid 不会进数据库", async () => {
	const { env } = await setup();

	const response = await call("/api/track", post("/api/track", {
		type: "panel_open",
		path: "/posts/cas/",
		vid: "raw-visitor-id",
		sid: "raw-session-id",
	}), env);
	assert.equal(response.status, 200);

	const row = await env.DB.prepare("SELECT * FROM events WHERE type = 'panel_open'").first();
	assert.ok(row, "应该有事件落库");
	assert.notEqual(row.vid, "raw-visitor-id", "vid 必须哈希后入库");
	assert.equal(row.vid.length, 16);
	assert.equal(row.path, "/posts/cas/");
	assert.equal(row.ok, 1);
});

test("POST /api/track 拒绝未知事件类型", async () => {
	const { env } = await setup();
	await call("/api/track", post("/api/track", { type: "steal_cookie", vid: "v1" }), env);
	const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM events").first();
	assert.equal(row.n, 0);
});

test("POST /api/hit 双写：聚合表给趋势，事件表给漏斗", async () => {
	const { env } = await setup();

	await call("/api/hit", post("/api/hit", { path: "/posts/cas/", vid: "v1", sid: "s1" }), env);
	await call("/api/hit", post("/api/hit", { path: "/posts/cas/", vid: "v1", sid: "s1" }), env);

	const views = await env.DB.prepare("SELECT count FROM views WHERE path = '/posts/cas/'").first();
	assert.equal(views.count, 2);
	const events = await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'page_view'").first();
	assert.equal(events.n, 2, "每次访问也要有事件行（漏斗第一级）");
});

test("GET /api/admin/stats 未登录拒绝", async () => {
	const { env } = await setup();
	const response = await call("/api/admin/stats?page=ai", {}, env);
	assert.equal(response.status, 401);
});

test("GET /api/admin/stats 返回卡片，KPI 与日志数量对得上", async () => {
	const { env, cookie } = await setup();

	// 三个提问：两个成功一个失败，其中一个是追问
	await insertAsk(env, { vid: "v1", sid: "s1", ok: 1, ttft: 800, ms: 3000, tokens: 100, hits: 2 });
	await insertAsk(env, { vid: "v2", sid: "s2", ok: 0, err: "超时", ttft: 0, ms: 9000, hits: 0, text: "生僻问题" });
	await insertAsk(env, { vid: "v1", sid: "s1", ok: 1, ttft: 1200, ms: 4000, tokens: 200, hits: 1, n: 1 });

	const response = await call("/api/admin/stats?page=ai&range=7", { headers: { cookie } }, env);
	assert.equal(response.status, 200);
	const body = await response.json();

	assert.equal(body.range, 7);
	const ids = body.cards.map((card) => card.id);
	for (const id of ["kpis", "trend", "funnel", "latency", "heatmap", "tokens", "models", "modelTable", "log"]) {
		assert.ok(ids.includes(id), `缺少卡片：${id}`);
	}

	const kpis = body.cards.find((card) => card.id === "kpis").data.items;
	const byKey = new Map(kpis.map((item) => [item.key, item]));
	assert.equal(byKey.get("queries").value, 3, "提问总数");
	assert.equal(byKey.get("users").value, 2, "独立访客去重");
	assert.equal(byKey.get("sessions").value, 2, "独立会话去重");
	assert.equal(byKey.get("perUser").value, 1.5, "人均提问");
	assert.equal(byKey.get("success").value, 66.7, "成功率");
	assert.equal(byKey.get("ttft").value, 800, "首字延迟 P50");

	const funnel = body.cards.find((card) => card.id === "funnel").data.steps;
	assert.equal(funnel.length, 5);
	assert.equal(funnel[0].label, "打开笔记");

	const log = body.cards.find((card) => card.id === "log").data.rows;
	assert.equal(log.length, 3);
	assert.equal(log[0].text, "CAS 有什么缺点", "最新的一条在最前");

	const zero = body.cards.find((card) => card.id === "zeroHits").data.rows;
	assert.equal(zero.length, 1, "零命中的问题要能被单独列出来");
	assert.equal(zero[0].label, "生僻问题");
});

test("GET /api/admin/stats 的失败原因按 err 归类", async () => {
	const { env, cookie } = await setup();
	await insertAsk(env, { ok: 0, err: "超时", ttft: 0 });
	await insertAsk(env, { ok: 0, err: "超时", ttft: 0 });
	await insertAsk(env, { ok: 0, err: "上游异常", ttft: 0 });

	const body = await (await call("/api/admin/stats?page=ai&range=7", { headers: { cookie } }, env)).json();
	const errors = body.cards.find((card) => card.id === "errors").data.rows;
	assert.deepEqual(errors, [
		{ label: "超时", count: 2 },
		{ label: "上游异常", count: 1 },
	]);
});

test("GET /api/admin/stats 没数据时也返回完整结构（不能 500）", async () => {
	const { env, cookie } = await setup();
	const response = await call("/api/admin/stats?page=ai&range=30", { headers: { cookie } }, env);
	assert.equal(response.status, 200);
	const body = await response.json();
	assert.ok(Array.isArray(body.cards) && body.cards.length > 0);
	assert.equal(body.coverage.since, null, "没有 ask 事件时应标记数据尚未开始累积");
});
