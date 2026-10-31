import test from "node:test";
import assert from "node:assert/strict";
import { detectBot, classifyComment } from "../../worker/lib/classify.js";

const base = {
	content: "写得真好，学到了",
	name: "访客",
	website: null,
	isAdmin: false,
	mode: "auto",
	keywordHit: false,
	recentSameHash: false,
	priorReports: 0,
	linkCount: 0,
};

test("蜜罐有值即判机器人", () => {
	assert.deepEqual(detectBot({ honey: "x", elapsed: 9000 }), { bot: true, reason: "honeypot" });
});

test("过快提交判机器人", () => {
	assert.deepEqual(detectBot({ honey: "", elapsed: 800 }), { bot: true, reason: "too_fast" });
});

test("elapsed 缺失不算机器人", () => {
	assert.deepEqual(detectBot({ honey: "", elapsed: undefined }), { bot: false });
	assert.deepEqual(detectBot({ honey: "", elapsed: "abc" }), { bot: false });
	assert.deepEqual(detectBot({ honey: "", elapsed: "" }), { bot: false });
});

test("正常评论直接通过", () => {
	assert.deepEqual(classifyComment(base), { status: "approved", reasons: [] });
});

test("博主自己的评论永远通过，忽略 hold 模式", () => {
	assert.deepEqual(classifyComment({ ...base, isAdmin: true, mode: "hold" }), { status: "approved", reasons: [] });
});

test("hold 模式全部待审", () => {
	assert.deepEqual(classifyComment({ ...base, mode: "hold" }), { status: "pending", reasons: ["hold_mode"] });
});

test("两条以上链接待审", () => {
	assert.deepEqual(classifyComment({ ...base, linkCount: 2 }), { status: "pending", reasons: ["too_many_links"] });
});

test("命中屏蔽词、重复内容、被举报过的身份都待审", () => {
	assert.equal(classifyComment({ ...base, keywordHit: true }).status, "pending");
	assert.equal(classifyComment({ ...base, recentSameHash: true }).status, "pending");
	assert.equal(classifyComment({ ...base, priorReports: 2 }).status, "pending");
});

test("多个原因按固定顺序列出", () => {
	assert.deepEqual(classifyComment({ ...base, linkCount: 3, keywordHit: true, recentSameHash: true, priorReports: 5 }).reasons, [
		"too_many_links",
		"keyword",
		"duplicate",
		"reported",
	]);
});
