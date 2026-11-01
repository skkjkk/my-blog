import assert from "node:assert/strict";
import test from "node:test";
import worker from "../../worker/index.js";
import { createEnv, makeCaller } from "../support/d1.mjs";

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
		const response = await call(
			"/api/quiz/grade",
			post("/api/quiz/grade", { slug: "java-cas", grade }),
			env,
		);
		assert.equal(response.status, 200);
	}

	const rows = await env.DB.prepare(
		"SELECT slug, grade, count FROM quiz_grade ORDER BY grade",
	).all();
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
	await call(
		"/api/search-log",
		post("/api/search-log", { keyword: "warmup", results: 1 }),
		env,
	);

	await call(
		"/api/quiz/grade",
		post("/api/quiz/grade", { slug: "../../etc/passwd", grade: 0 }),
		env,
	);
	await call(
		"/api/quiz/grade",
		post("/api/quiz/grade", { slug: "ok-slug", grade: 9 }),
		env,
	);
	await call(
		"/api/quiz/grade",
		post("/api/quiz/grade", { slug: "", grade: 1 }),
		env,
	);

	const rows = await env.DB.prepare(
		"SELECT COUNT(*) AS n FROM quiz_grade",
	).all();
	assert.equal(rows.results[0].n, 0);
});

test("诊断数据：零结果搜索词单独成榜，正常搜索词也还在", async () => {
	const env = createEnv();
	const { cookie } = await login(env);

	await call(
		"/api/search-log",
		post("/api/search-log", { keyword: "Kubernetes", results: 0 }),
		env,
	);
	await call(
		"/api/search-log",
		post("/api/search-log", { keyword: "Kubernetes", results: 0 }),
		env,
	);
	await call(
		"/api/search-log",
		post("/api/search-log", { keyword: "索引", results: 7 }),
		env,
	);

	const body = await (
		await call(
			"/api/admin/stats?page=engagement&range=30",
			{ headers: { cookie } },
			env,
		)
	).json();

	const zero = body.cards.find((card) => card.id === "zeroSearch").data.rows;
	assert.equal(zero.length, 1, "只有零结果的词进「搜了却没有」");
	assert.equal(zero[0].label, "Kubernetes");
	assert.equal(zero[0].count, 2);

	const top = body.cards
		.find((card) => card.id === "searches")
		.data.rows.map((row) => row.label);
	assert.ok(top.includes("索引"), "正常搜索词仍进搜索榜");
});

test("诊断数据：刷题榜按「不会」次数排序", async () => {
	const env = createEnv();
	const { cookie } = await login(env);

	await call(
		"/api/quiz/grade",
		post("/api/quiz/grade", { slug: "easy", grade: 2 }),
		env,
	);
	await call(
		"/api/quiz/grade",
		post("/api/quiz/grade", { slug: "hard", grade: 0 }),
		env,
	);
	await call(
		"/api/quiz/grade",
		post("/api/quiz/grade", { slug: "hard", grade: 0 }),
		env,
	);
	await call(
		"/api/quiz/grade",
		post("/api/quiz/grade", { slug: "hard", grade: 1 }),
		env,
	);

	const body = await (
		await call(
			"/api/admin/stats?page=content&range=30",
			{ headers: { cookie } },
			env,
		)
	).json();

	const rows = body.cards.find((card) => card.id === "quiz").data.rows;
	assert.equal(rows[0].label, "hard", "被标「不会」最多的排第一");
	assert.equal(rows[0].count, 2);
});

test("诊断数据：AI 页把「零命中」的提问单独列出来", async () => {
	const env = createEnv();
	const { cookie } = await login(env);

	// 先用 /api/track 把 events 表建出来，再手动灌一条零命中的提问
	await call(
		"/api/track",
		post("/api/track", { type: "panel_open", path: "/posts/x/" }),
		env,
	);
	const today = new Date(Date.now() + 8 * 3600 * 1000)
		.toISOString()
		.slice(0, 10);
	await env.DB.prepare(
		"INSERT INTO events (ts, day, hour, dow, vid, sid, type, path, ms, ttft, tokens, ok, err, n, hits, tag, text, meta) VALUES (?, ?, 10, 2, 'v1', 's1', 'ask', '/posts/x/', 3000, 900, 100, 1, '', 0, 0, 'auto', ?, '')",
	)
		.bind(new Date().toISOString(), today, "这个问题笔记里没写")
		.run();

	const body = await (
		await call("/api/admin/stats?page=ai&range=7", { headers: { cookie } }, env)
	).json();

	const zero = body.cards.find((card) => card.id === "zeroHits").data.rows;
	assert.equal(zero.length, 1);
	assert.equal(zero[0].label, "这个问题笔记里没写");
});

test("未登录拿不到诊断数据", async () => {
	const env = createEnv();
	const response = await call("/api/admin/stats?page=overview", {}, env);
	assert.equal(response.status, 401);
});
