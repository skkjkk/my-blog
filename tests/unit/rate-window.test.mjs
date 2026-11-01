import test from "node:test";
import assert from "node:assert/strict";
import { createEnv } from "../support/d1.mjs";
import { ensureCommentsSchema } from "../../worker/lib/db.js";
import { rateCheck, rateRecord } from "../../worker/lib/rate.js";

const t0 = Date.parse("2026-01-01T00:00:00.000Z");
const buckets = [
	{ scope: "ip", value: "abc" },
	{ scope: "id", value: "xyz" },
	{ scope: "site", value: "" },
];

async function envWithHistory(count) {
	const env = createEnv();
	await ensureCommentsSchema(env);
	for (let index = 0; index < count; index++) {
		await rateRecord(env.DB, buckets, t0 + index * 1000);
	}
	return env;
}

test("刚发完立刻再发被拒", async () => {
	const env = await envWithHistory(1);
	const verdict = await rateCheck(env.DB, buckets, t0 + 1000);
	assert.equal(verdict.allowed, false);
	assert.ok(verdict.retryAfter > 0);
});

test("30 秒窗口过期后可以再发（不能永久锁死）", async () => {
	const env = await envWithHistory(1);
	const verdict = await rateCheck(env.DB, buckets, t0 + 31_000);
	assert.equal(verdict.allowed, true, "30 秒窗口应当已经滑出");
});

test("1 小时窗口仍然数满 10 条时才拒", async () => {
	const env = await envWithHistory(9);
	assert.equal((await rateCheck(env.DB, buckets, t0 + 61_000)).allowed, true);
	await rateRecord(env.DB, buckets, t0 + 62_000);
	const verdict = await rateCheck(env.DB, buckets, t0 + 63_000);
	assert.equal(verdict.allowed, false);
	assert.equal(verdict.window, "1h");
});

test("1 小时窗口真的过期后才放行", async () => {
	const env = await envWithHistory(10);
	assert.equal((await rateCheck(env.DB, buckets, t0 + 63_000)).allowed, false);
	const later = await rateCheck(env.DB, buckets, t0 + 3_600_001);
	assert.equal(later.allowed, true);
});
