import test from "node:test";
import assert from "node:assert/strict";
import {
	LIMITS,
	sanitizeText,
	normalizeContent,
	countLinks,
	safeUrl,
	validName,
	normalizeSlug,
} from "../../worker/lib/text.js";

test("sanitizeText 去掉控制字符但保留换行", () => {
	assert.equal(sanitizeText("a\u0000b\u0007c", 100), "abc");
	assert.equal(sanitizeText("第一行\r\n第二行", 100), "第一行\n第二行");
});

test("sanitizeText 折叠三连以上空行并裁剪超长", () => {
	assert.equal(sanitizeText("a\n\n\n\nb", 100), "a\n\nb");
	assert.equal(sanitizeText("x".repeat(50), 10).length, 10);
});

test("normalizeContent 用 LIMITS.content 封顶", () => {
	assert.equal(normalizeContent("y".repeat(5000)).length, LIMITS.content);
});

test("countLinks 只数 http(s) 链接", () => {
	assert.equal(countLinks("看 https://a.com 和 http://b.cn/x"), 2);
	assert.equal(countLinks("ftp://a.com 和 javascript:alert(1)"), 0);
});

test("safeUrl 只放行 http/https，其余返回 null", () => {
	assert.equal(safeUrl("https://ok.com/p"), "https://ok.com/p");
	assert.equal(safeUrl("javascript:alert(1)"), null);
	assert.equal(safeUrl("data:text/html,x"), null);
	assert.equal(safeUrl("not a url"), null);
});

test("validName 拒绝空白与超长，保留中文与 emoji", () => {
	assert.equal(validName("  小明  "), "小明");
	assert.equal(validName("   "), null);
	assert.equal(validName("名".repeat(25)), null);
	assert.equal(validName("🐱猫"), "🐱猫");
});

test("normalizeSlug 拒绝穿越与查询串", () => {
	assert.equal(normalizeSlug("/posts/hello-world/"), "/posts/hello-world/");
	assert.equal(normalizeSlug("/posts/../etc/passwd"), null);
	assert.equal(normalizeSlug("/a?b=1"), null);
});
