import test from "node:test";
import assert from "node:assert/strict";
import { RATE_LIMITS, WINDOW_MS, rateVerdict, scopeKey } from "../../worker/lib/rate.js";

const now = 1_700_000_000_000;

test("无记录时放行", () => {
	assert.deepEqual(rateVerdict([], now), { allowed: true });
});

test("30 秒窗口内第二条被拒并给出 retryAfter", () => {
	const groups = [{ scope: "ip", window: "30s", count: 1, firstTs: now - 5_000 }];
	const v = rateVerdict(groups, now);
	assert.equal(v.allowed, false);
	assert.equal(v.window, "30s");
	assert.equal(v.retryAfter, 25);
});

test("未到阈值时放行", () => {
	assert.equal(rateVerdict([{ scope: "ip", window: "1h", count: 9, firstTs: now - 60_000 }], now).allowed, true);
});

test("达到阈值即拒", () => {
	assert.equal(rateVerdict([{ scope: "ip", window: "1h", count: 10, firstTs: now - 60_000 }], now).allowed, false);
});

test("全站闸门", () => {
	assert.equal(rateVerdict([{ scope: "site", window: "1h", count: 200, firstTs: now }], now).allowed, false);
});

test("多组同时命中时取最长等待", () => {
	const groups = [
		{ scope: "ip", window: "30s", count: 1, firstTs: now - 1_000 },
		{ scope: "id", window: "1h", count: 20, firstTs: now - 600_000 },
	];
	const v = rateVerdict(groups, now);
	assert.equal(v.allowed, false);
	assert.equal(v.retryAfter, 3000);
});

test("窗口常量齐全", () => {
	assert.deepEqual(Object.keys(WINDOW_MS).sort(), ["1d", "1h", "30s"]);
	assert.equal(RATE_LIMITS["site:1h"], 200);
});

test("scopeKey 拼出桶名", () => {
	assert.equal(scopeKey("ip", "abc123"), "ip:abc123");
	assert.equal(scopeKey("site", ""), "site");
});
