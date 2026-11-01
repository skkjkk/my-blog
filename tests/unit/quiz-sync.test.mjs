import test from "node:test";
import assert from "node:assert/strict";
import { mergeStates, sameState, emptyState, gradeCard } from "../../src/utils/quiz-store.ts";

const card = (overrides = {}) => ({
	level: 2,
	streak: 1,
	interval: 3,
	due: "2026-11-04",
	seen: 1,
	last: "2026-11-01",
	...overrides,
});

function stateWith(cards, days = {}, goal = 5) {
	return { v: 1, cards, days, goal };
}

test("合并：最后刷的日期更晚的那份说了算", () => {
	const local = stateWith({ a: card({ last: "2026-11-02", streak: 2, interval: 7 }) });
	const remote = stateWith({ a: card({ last: "2026-11-01", streak: 1 }) });

	assert.equal(mergeStates(local, remote).cards.a.last, "2026-11-02");
	assert.equal(mergeStates(remote, local).cards.a.last, "2026-11-02", "顺序无关");
});

test("合并：同一天刷过就取掌握得更好的那条", () => {
	const local = stateWith({ a: card({ streak: 1 }) });
	const remote = stateWith({ a: card({ streak: 3, interval: 21, due: "2026-11-22" }) });

	assert.equal(mergeStates(local, remote).cards.a.streak, 3);
});

test("合并：两边独有的卡片都要留下", () => {
	const local = stateWith({ a: card() });
	const remote = stateWith({ b: card({ last: "2026-10-31" }) });

	const merged = mergeStates(local, remote);
	assert.deepEqual(Object.keys(merged.cards).sort(), ["a", "b"]);
});

test("合并：打卡按天取较大的那个", () => {
	const local = stateWith({}, { "2026-11-01": 3, "2026-11-02": 1 });
	const remote = stateWith({}, { "2026-11-01": 5, "2026-10-31": 8 });

	const merged = mergeStates(local, remote);
	assert.equal(merged.days["2026-11-01"], 5);
	assert.equal(merged.days["2026-11-02"], 1);
	assert.equal(merged.days["2026-10-31"], 8);
});

test("合并：每日目标以本地为准（刚在这台机上调过的值）", () => {
	assert.equal(mergeStates(stateWith({}, {}, 3), stateWith({}, {}, 10)).goal, 3);
	assert.equal(mergeStates(stateWith({}, {}, 7), emptyState()).goal, 7);
});

test("sameState 判断等价", () => {
	const a = stateWith({ a: card() }, { "2026-11-01": 1 }, 5);
	const b = stateWith({ a: card() }, { "2026-11-01": 1 }, 5);
	const c = stateWith({ a: card({ streak: 2 }) }, { "2026-11-01": 1 }, 5);

	assert.equal(sameState(a, b), true);
	assert.equal(sameState(a, c), false);
});

test("合并后刷题进度照常推进（端到端味道）", () => {
	let local = emptyState();
	local = gradeCard(local, "a", 2, "2026-11-01").state;

	let remote = emptyState();
	remote = gradeCard(remote, "a", 0, "2026-11-02").state; // 另一台设备标了不会

	const merged = mergeStates(local, remote);
	assert.equal(merged.cards.a.level, 0, "更晚的评分（不会）应当生效");
	assert.equal(merged.days["2026-11-01"], 1);
	assert.equal(merged.days["2026-11-02"], 1);
});
