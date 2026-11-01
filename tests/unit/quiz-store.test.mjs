import test from "node:test";
import assert from "node:assert/strict";
import {
	DEFAULT_GOAL,
	dueSlugs,
	emptyState,
	gradeCard,
	loadState,
	serializeState,
	shuffle,
	streakDays,
	todayCount,
	totalSeen,
	unseenSlugs,
	wrongSlugs,
} from "../../src/utils/quiz-store.ts";

const TODAY = "2026-11-01";

function graded(slug, grade, today = TODAY, state = emptyState()) {
	return gradeCard(state, slug, grade, today);
}

test("空状态：没有卡片、没有打卡、目标默认 5", () => {
	const state = emptyState();
	assert.equal(state.goal, DEFAULT_GOAL);
	assert.deepEqual(state.cards, {});
	assert.equal(streakDays(state, TODAY), 0);
	assert.equal(todayCount(state, TODAY), 0);
});

test("评「会」：间隔从 3 天起步，逐次拉长", () => {
	let state = emptyState();
	const intervals = [];

	for (const today of ["2026-11-01", "2026-11-04", "2026-11-11", "2026-12-02"]) {
		const result = graded("a", 2, today, state);
		state = result.state;
		intervals.push(result.card.interval);
	}

	assert.deepEqual(intervals, [3, 7, 21, 60]);
	assert.equal(state.cards.a.streak, 4);
	assert.equal(state.cards.a.seen, 4);
});

test("评「卡住」：明天再来，连对次数退一级", () => {
	let state = graded("a", 2).state;
	state = graded("a", 2, "2026-11-04", state).state;
	assert.equal(state.cards.a.streak, 2);

	const result = graded("a", 1, "2026-11-11", state);
	assert.equal(result.card.interval, 1);
	assert.equal(result.card.due, "2026-11-12");
	assert.equal(result.card.streak, 1);
});

test("评「不会」：清零连对次数，due 就是今天", () => {
	const result = graded("a", 0);
	assert.equal(result.card.level, 0);
	assert.equal(result.card.streak, 0);
	assert.equal(result.card.due, TODAY);
});

test("评分不修改传入的状态（不可变更新）", () => {
	const state = emptyState();
	const { state: next } = graded("a", 2, TODAY, state);

	assert.deepEqual(state.cards, {}, "原状态不应被写入");
	assert.ok(next.cards.a, "新状态应有该卡片");
	assert.notEqual(next.cards, state.cards);
});

test("dueSlugs 只挑到期的，逾期的排前面，不会的优先", () => {
	let state = emptyState();
	state = graded("late", 2, "2026-10-20", state).state; // 3 天后到期 → 早就逾期
	state = graded("today", 0, TODAY, state).state; // 今天到期
	state = graded("future", 2, TODAY, state).state; // 3 天后才到期

	const due = dueSlugs(state, TODAY);
	assert.deepEqual(due, ["late", "today"]);
	assert.ok(!due.includes("future"));
});

test("连续天数：今天没刷就从昨天往回数", () => {
	let state = emptyState();
	state = graded("a", 2, "2026-10-30", state).state;
	state = graded("b", 2, "2026-10-31", state).state;

	assert.equal(streakDays(state, TODAY), 2, "今天还没刷，昨天算起");

	state = graded("c", 2, TODAY, state).state;
	assert.equal(streakDays(state, TODAY), 3);

	state = graded("d", 2, "2026-11-03", state).state;
	assert.equal(streakDays(state, "2026-11-03"), 1, "断了就从当天重新算");
});

test("同一天刷多题只累加当天计数", () => {
	let state = emptyState();
	state = graded("a", 2).state;
	state = graded("b", 1, TODAY, state).state;

	assert.equal(todayCount(state, TODAY), 2);
	assert.equal(totalSeen(state), 2);
	assert.equal(streakDays(state, TODAY), 1);
});

test("错题与未刷列表", () => {
	let state = emptyState();
	state = graded("a", 0).state;
	state = graded("b", 2, TODAY, state).state;

	assert.deepEqual(wrongSlugs(state), ["a"]);
	assert.deepEqual(unseenSlugs(state, ["a", "b", "c"]), ["c"]);
});

test("loadState 容错：坏 JSON / 坏字段都退化成可用状态", () => {
	assert.equal(loadState(null).goal, DEFAULT_GOAL);
	assert.equal(loadState("{不是 JSON").goal, DEFAULT_GOAL);

	const state = loadState(
		JSON.stringify({
			v: 1,
			cards: { good: { level: 2, streak: 1, interval: 3, due: TODAY, seen: 1, last: TODAY }, bad: 42 },
			days: { [TODAY]: 3, "2026-13-99": 5, "2026-10-31": 0 },
			goal: 999,
		}),
	);

	assert.deepEqual(Object.keys(state.cards), ["good"]);
	assert.deepEqual(Object.keys(state.days), [TODAY]);
	assert.equal(state.goal, DEFAULT_GOAL, "越界的目标值退回默认");
});

test("serializeState 存了再读要一模一样", () => {
	const state = graded("a", 2).state;
	const round = loadState(serializeState(state));
	assert.deepEqual(round.cards, state.cards);
	assert.equal(round.goal, state.goal);
});

test("shuffle 不改原数组，同 seed 结果可复现", () => {
	const source = ["a", "b", "c", "d"];
	const random = () => 0.42;

	assert.deepEqual(shuffle(source, random), shuffle(source, random));
	assert.deepEqual(source, ["a", "b", "c", "d"]);
	assert.equal(shuffle(source).length, 4);
});
