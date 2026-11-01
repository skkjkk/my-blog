import test from "node:test";
import assert from "node:assert/strict";
import { linkify, formatRelative, draftKey } from "../../src/scripts/comment-utils.mjs";

test("纯文本原样返回", () => {
	assert.deepEqual(linkify("你好\n世界"), [{ text: "你好\n世界" }]);
});

test("识别 http(s) 链接并拆段", () => {
	assert.deepEqual(linkify("看 https://a.com 哦"), [
		{ text: "看 " },
		{ text: "https://a.com", url: "https://a.com" },
		{ text: " 哦" },
	]);
});

test("HTML 与脚本不进 url，留在文本里", () => {
	const parts = linkify("<img src=x onerror=alert(1)><script>alert(1)</script>");
	assert.equal(parts.length, 1);
	assert.equal(parts[0].url, undefined);
	assert.ok(parts[0].text.includes("<script>"));
});

test("javascript: 不被识别为链接", () => {
	assert.deepEqual(linkify("javascript:alert(1)"), [{ text: "javascript:alert(1)" }]);
});

test("链接尾部的标点留在文本里", () => {
	assert.deepEqual(linkify("见 https://a.com。"), [{ text: "见 " }, { text: "https://a.com", url: "https://a.com" }, { text: "。" }]);
});

test("空串返回单段空文本", () => {
	assert.deepEqual(linkify(""), [{ text: "" }]);
});

test("formatRelative 讲人话", () => {
	const now = Date.parse("2026-11-01T12:00:00Z");
	assert.equal(formatRelative("2026-11-01T11:59:30Z", now), "刚刚");
	assert.equal(formatRelative("2026-11-01T11:30:00Z", now), "30 分钟前");
	assert.equal(formatRelative("2026-11-01T09:00:00Z", now), "3 小时前");
	assert.equal(formatRelative("2026-10-30T12:00:00Z", now), "2 天前");
	assert.equal(formatRelative("2026-08-01T12:00:00Z", now), "2026-08-01");
});

test("draftKey 带 slug", () => {
	assert.equal(draftKey("/posts/a/"), "comment-draft:/posts/a/");
});
