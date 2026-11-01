import test from "node:test";
import assert from "node:assert/strict";
import { createEnv, makeCaller } from "../support/d1.mjs";
import worker from "../../worker/index.js";

const call = makeCaller(worker);

async function login(env) {
	const response = await call(
		"/api/admin/login",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ password: env.ADMIN_PASSWORD }),
		},
		env,
	);
	const cookie = (response.headers.get("set-cookie") ?? "").split(";")[0];
	return { cookie, status: response.status };
}

function post(path, body) {
	return {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	};
}

test("刷题评分上报：同题同档累加，不覆盖", async () => {
	const env = createEnv();

	for (const grade of [0, 0, 2]) {
		const response = await call("/api/quiz/grade", post("/api/quiz/grade", { slug: "java-cas", grade }), env);
		assert.equal(response.status, 200);
	}

	const rows = await env.DB.prepare("SELECT slug, grade, count FROM quiz_grade ORDER BY grade").all();
	assert.deepEqual(
		rows.results.map((row) => [row.grade, row.count]),
		[
			[0, 2],
			[2, 1],
		],
	);
});

test("刷题评分上报：非法 slug 与档位一律丢弃", async () => {
	const env = createEnv();
	// 先让 ensureSchema 把表建好（非法请求本身不建表，也不该建）
	await call("/api/search-log", post("/api/search-log", { keyword: "warmup", results: 1 }), env);

	await call("/api/quiz/grade", post("/api/quiz/grade", { slug: "../../etc/passwd", grade: 0 }), env);
	await call("/api/quiz/grade", post("/api/quiz/grade", { slug: "ok-slug", grade: 9 }), env);
	await call("/api/quiz/grade", post("/api/quiz/grade", { slug: "", grade: 1 }), env);

	const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM quiz_grade").all();
	assert.equal(rows.results[0].n, 0);
});

test("诊断数据：零结果搜索词只统计 results = 0", async () => {
	const env = createEnv();
	const { cookie } = await login(env);

	// 建表 + 灌数据（先让 overview 跑一次，触发 ensureSchema；search_log 由 /api/search-log 建）
	await call("/api/search-log", post("/api/search-log", { keyword: "Kubernetes", results: 0 }), env);
	await call("/api/search-log", post("/api/search-log", { keyword: "Kubernetes", results: 0 }), env);
	await call("/api/search-log", post("/api/search-log", { keyword: "索引", results: 7 }), env);

	const data = await (await call("/api/admin/overview?range=30", { headers: { cookie } }, env)).json();

	const zero = data.views.search.zero;
	assert.equal(zero.length, 1, "只有零结果的词进榜单");
	assert.equal(zero[0].keyword, "Kubernetes");
	assert.equal(zero[0].count, 2);

	const top = data.views.search.top.map((row) => row.keyword);
	assert.ok(top.includes("索引"), "正常搜索词仍进原来的榜单");
});

test("诊断数据：刷题榜按「不会」次数排序，并带上总数", async () => {
	const env = createEnv();
	const { cookie } = await login(env);

	await call("/api/quiz/grade", post("/api/quiz/grade", { slug: "easy", grade: 2 }), env);
	await call("/api/quiz/grade", post("/api/quiz/grade", { slug: "hard", grade: 0 }), env);
	await call("/api/quiz/grade", post("/api/quiz/grade", { slug: "hard", grade: 0 }), env);
	await call("/api/quiz/grade", post("/api/quiz/grade", { slug: "hard", grade: 1 }), env);

	const data = await (await call("/api/admin/overview?range=30", { headers: { cookie } }, env)).json();

	assert.equal(data.quiz.top[0].slug, "hard");
	assert.equal(data.quiz.top[0].miss, 2);
	assert.equal(data.quiz.top[0].stuck, 1);
	assert.equal(data.quiz.top[0].total, 3);
});

test("诊断数据：overview 带回提问原文供前端聚类", async () => {
	const env = createEnv();
	const { cookie } = await login(env);

	// ai_log 由 /api/chat 写入；这里直接建表灌两条，避免真的去调模型
	await call("/api/admin/overview", { headers: { cookie } }, env);
	await env.DB.prepare(
		"CREATE TABLE IF NOT EXISTS ai_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, day TEXT NOT NULL, question TEXT, model TEXT, ms INTEGER, tokens INTEGER, ok INTEGER)",
	).run();
	const today = new Date().toISOString().slice(0, 10);
	for (const question of ["什么是 MCP？", "什么是MCP"]) {
		await env.DB.prepare(
			"INSERT INTO ai_log (ts, day, question, model, ms, tokens, ok) VALUES (?, ?, ?, 'test', 100, 10, 1)",
		)
			.bind(new Date().toISOString(), today, question)
			.run();
	}

	const data = await (await call("/api/admin/overview?range=30", { headers: { cookie } }, env)).json();
	assert.equal(data.ai.questions.length, 2);
	assert.ok(data.ai.questions.includes("什么是 MCP？"));
});

test("未登录拿不到诊断数据", async () => {
	const env = createEnv();
	const response = await call("/api/admin/overview", {}, env);
	assert.equal(response.status, 401);
});
