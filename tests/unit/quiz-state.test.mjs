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
	return (response.headers.get("set-cookie") ?? "").split(";")[0];
}

const put = (payload, cookie) => ({
	method: "POST",
	headers: { "content-type": "application/json", cookie },
	body: JSON.stringify({ payload }),
});

test("云端进度：没登录时读和写都拒绝", async () => {
	const env = createEnv();

	const read = await call("/api/quiz/state", {}, env);
	assert.equal(read.status, 401);

	const write = await call("/api/quiz/state", put('{"v":1}', ""), env);
	assert.equal(write.status, 401);
});

test("云端进度：写入后能读回同一份", async () => {
	const env = createEnv();
	const cookie = await login(env);

	const payload = JSON.stringify({
		v: 1,
		cards: { "java-cas": { level: 2, streak: 2, interval: 7, due: "2026-11-08", seen: 3, last: "2026-11-01" } },
		days: { "2026-11-01": 3 },
		goal: 5,
	});

	const saved = await call("/api/quiz/state", put(payload, cookie), env);
	assert.equal(saved.status, 200);
	assert.equal((await saved.json()).ok, true);

	const read = await (await call("/api/quiz/state", { headers: { cookie } }, env)).json();
	assert.equal(read.ok, true);
	assert.equal(read.payload, payload);
	assert.ok(read.updated);
});

test("云端进度：没写过时返回 payload: null（客户端据此不合并）", async () => {
	const env = createEnv();
	const cookie = await login(env);

	const read = await (await call("/api/quiz/state", { headers: { cookie } }, env)).json();
	assert.equal(read.ok, true);
	assert.equal(read.payload, null);
});

test("云端进度：重复写入是覆盖而不是追加", async () => {
	const env = createEnv();
	const cookie = await login(env);

	await call("/api/quiz/state", put('{"v":1,"goal":3}', cookie), env);
	await call("/api/quiz/state", put('{"v":1,"goal":9}', cookie), env);

	const read = await (await call("/api/quiz/state", { headers: { cookie } }, env)).json();
	assert.equal(JSON.parse(read.payload).goal, 9);

	const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM quiz_state").all();
	assert.equal(rows.results[0].n, 1, "只保留一行");
});

test("云端进度：空内容与超大内容被拒", async () => {
	const env = createEnv();
	const cookie = await login(env);

	const empty = await call("/api/quiz/state", put("", cookie), env);
	assert.equal(empty.status, 400);

	const huge = await call("/api/quiz/state", put(`{"v":1,"pad":"${"x".repeat(2_000_100)}"}`, cookie), env);
	assert.equal(huge.status, 413);
});
