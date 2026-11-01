import assert from "node:assert/strict";
import test from "node:test";
import {
	chunkText,
	noteAsContext,
	queryTerms,
	scoreItem,
	searchNotes,
} from "../../worker/lib/notes-index.js";

const ITEMS = [
	{
		slug: "mysql-lost-update",
		title: "MySQL 更新丢失与并发控制",
		category: "数据库",
		tags: ["MySQL", "并发"],
		text:
			"并发写入时可能出现更新丢失。" +
			"可以用乐观锁、悲观锁或版本号避免覆盖。".repeat(12),
	},
	{
		slug: "java-cas",
		title: "什么是 Java 的 CAS 操作？",
		category: "Java",
		tags: ["并发编程"],
		text: "CAS 是一条 CPU 级别的原子指令，比较并交换；缺点是自旋耗 CPU 和 ABA 问题。".repeat(8),
	},
	{
		slug: "network-http",
		title: "HTTP 和 HTTPS 有什么区别？",
		category: "网络",
		tags: ["HTTP"],
		text: "HTTPS 在 HTTP 和 TCP 之间加了 TLS，提供加密、完整性和身份认证。".repeat(8),
	},
];

test("queryTerms 拆出中英文检索词并去掉问句客套", () => {
	const terms = queryTerms("请问怎么避免更新丢失？");
	assert.ok(terms.includes("更新"));
	assert.ok(terms.includes("丢失"));
	assert.ok(!terms.includes("请问"));
	assert.ok(!terms.includes("怎么"));

	const mixed = queryTerms("volatile 和 CAS 有什么区别");
	assert.ok(mixed.includes("volatile"));
	assert.ok(mixed.includes("cas"));
});

test("chunkText 切成带重叠的窗口，不丢结尾", () => {
	const text = "第一段。".repeat(300);
	const chunks = chunkText(text, 200, 40);
	assert.ok(chunks.length > 2);
	assert.equal(chunks.join("").includes("第一段。第一段。"), true);
	assert.ok(chunks.at(-1).endsWith("。"));
});

test("中文近义问句能命中没出现完整问法的段落", () => {
	const hits = searchNotes(ITEMS, "怎么避免更新丢失", 3);
	assert.equal(hits[0]?.item.slug, "mysql-lost-update");
	assert.ok(hits[0].score > 0);
	assert.match(hits[0].snippet, /更新丢失|覆盖/);
});

test("标题命中优先，短查询也能找到 CAS", () => {
	const hits = searchNotes(ITEMS, "CAS 有什么缺点", 3);
	assert.equal(hits[0]?.item.slug, "java-cas");
	assert.match(hits[0].snippet, /CAS|原子指令/);
});

test("没有任何有效词或相关性不足时返回空，不硬凑结果", () => {
	assert.deepEqual(searchNotes(ITEMS, "今天天气怎么样", 3), []);
	assert.deepEqual(searchNotes(ITEMS, "   ", 3), []);
});

test("scoreItem 保留旧接口，并给出同一套分数", () => {
	assert.ok(scoreItem(ITEMS[0], "更新丢失") > 0);
	assert.equal(scoreItem(ITEMS[0], "完全无关的词汇"), 0);
});

test("noteAsContext 带资料编号、提纲和正文", () => {
	const text = noteAsContext(
		{ ...ITEMS[1], outline: ["自旋", "ABA"] },
		100,
		"N3",
	);
	assert.match(text, /资料编号：N3/);
	assert.match(text, /标题：什么是 Java 的 CAS 操作/);
	assert.match(text, /- 自旋/);
	assert.match(text, /正文：/);
});
