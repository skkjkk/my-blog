import test from "node:test";
import assert from "node:assert/strict";
import {
	extractQuizAnswer,
	extractQuizCard,
	toPlainText,
	todayKey,
	addDays,
	diffDays,
} from "../../src/utils/quiz-utils.ts";

test("toPlainText 去掉 markdown 标记，保留文字", () => {
	assert.equal(toPlainText("**加粗**和`代码`和[链接](https://a.b)"), "加粗和代码和链接");
	assert.equal(toPlainText("- 第一项\n- 第二项"), "第一项 第二项");
	assert.equal(toPlainText(":::tip\n内容是重点\n:::"), "内容是重点");
	assert.equal(toPlainText("![图](./a.png)正文"), "正文");
});

test("toPlainText 保留 snake_case 里的下划线", () => {
	assert.equal(toPlainText("`binlog_redo_log` 与 undo log"), "binlog_redo_log 与 undo log");
});

test("toPlainText 去掉首段手滑打出的句号", () => {
	assert.equal(toPlainText("。JDK 里通过 Unsafe 实现"), "JDK 里通过 Unsafe 实现");
});

test("extractQuizAnswer 取第一个 H2 之前的正文作答案", () => {
	const body =
		"CAS 是一条 CPU 级别的原子指令。\n\n## 基本用法\n\n。JDK 中通过 Unsafe 实现。\n\n## 核心问题是 ABA\n\n版本号能解决。";
	const { answer, outline } = extractQuizAnswer(body, { minAnswerChars: 0 });

	assert.equal(answer, "CAS 是一条 CPU 级别的原子指令。");
	assert.deepEqual(outline, ["基本用法", "核心问题是 ABA"]);
});

test("extractQuizAnswer 默认会把过短的首段补长", () => {
	const body = "CAS 是一条原子指令。\n\n## 基本用法\n\nJDK 中通过 Unsafe 实现，失败重试。";
	const short = extractQuizAnswer(body, { minAnswerChars: 0 }).answer;
	const topped = extractQuizAnswer(body).answer;

	assert.equal(short, "CAS 是一条原子指令。");
	assert.ok(topped.length > short.length, "默认应往下补段");
	assert.ok(topped.startsWith(short), "补段是在原答案后面追加");
});

test("extractQuizAnswer 答案过短时往下补段", () => {
	const body = "短答案。\n\n## 第一节\n\n这一段要补进来凑够长度，否则单靠一句话没法自测。".padEnd(200, "字");
	const { answer } = extractQuizAnswer(body);

	assert.ok(answer.length >= 120, `补段后应 >= 120 字，实际 ${answer.length}`);
});

test("extractQuizAnswer 没有小标题时退化为取正文开头", () => {
	const body = "第一段结论。\n\n第二段展开说明。";
	const { answer, outline } = extractQuizAnswer(body);

	assert.equal(answer, "第一段结论。 第二段展开说明。");
	assert.deepEqual(outline, []);
});

test("extractQuizAnswer 代码围栏里的井号不算标题", () => {
	const body = "结论在这里。\n\n```bash\n## 这不是标题\n```\n\n## 真标题\n\n内容。";
	const { outline } = extractQuizAnswer(body);

	assert.deepEqual(outline, ["真标题"]);
});

test("extractQuizAnswer 超长答案在句号处收尾并封顶", () => {
	const body = `${"一".repeat(500)}。${"二".repeat(500)}。`;
	const { answer } = extractQuizAnswer(body);

	assert.ok(answer.length <= 601, `封顶后应 <= 601，实际 ${answer.length}`);
	assert.ok(answer.endsWith("。"), "应在句号处收尾");
});

test("extractQuizAnswer 空正文不炸", () => {
	const { answer, outline } = extractQuizAnswer("");
	assert.equal(answer, "");
	assert.deepEqual(outline, []);
});

test("日期工具：addDays / diffDays / todayKey", () => {
	assert.equal(todayKey(new Date(2026, 10, 1)), "2026-11-01");
	assert.equal(addDays("2026-11-01", 3), "2026-11-04");
	assert.equal(addDays("2026-12-31", 1), "2027-01-01");
	assert.equal(diffDays("2026-11-01", "2026-11-08"), 7);
	assert.equal(diffDays("2026-11-08", "2026-11-01"), -7);
});

/* ---------------- 刷题卡片 extractQuizCard ---------------- */

const CARD_NOTE = `CAS 是比较并交换的原子指令，是 Java 无锁并发的地基。

## 它解决什么问题

用 synchronized 更新共享变量要阻塞线程，CAS 让无竞争时几乎没有开销。

## 怎么用

- AtomicInteger 内部就是 CAS 自旋
- LongAdder 用分散热点降低争抢
- AtomicStampedReference 解决 ABA

## 常见追问

- **问：** CAS 有什么缺点？
  **答：** ABA、自旋开销、只能保证一个变量。

- **问：** 和 synchronized 怎么选？
  **答：** 临界区短用 CAS，临界区长用锁。

## 易错点

- 以为 CAS 是加锁：其实是无锁指令
- 忽略 ABA：值相等不代表没被改过

## 一句话记住

:::tip
CAS 是无锁的地基，代价是 ABA 和自旋。
:::
`;

test("extractQuizCard 抽出结论 / 要点 / 追问 / 易错点 / 一句话", () => {
	const card = extractQuizCard(CARD_NOTE);

	assert.match(card.answer, /^CAS 是比较并交换的原子指令/);
	assert.deepEqual(
		card.points.map((point) => point.heading),
		["它解决什么问题", "怎么用"],
		"结论之外的小节都应成为要点，追问/易错点不算要点",
	);
	assert.ok(card.points[0].detail.includes("synchronized"), "要点要带一句展开，不能只有标题");
	assert.equal(card.followUps.length, 2);
	assert.equal(card.followUps[0].q, "CAS 有什么缺点？");
	assert.ok(card.followUps[0].a.includes("ABA"));
	assert.equal(card.pitfalls.length, 2);
	assert.ok(card.pitfalls[0].includes("以为 CAS 是加锁"));
	assert.ok(card.memory.includes("无锁的地基"), "一句话记住要抽出 tip 的内容");
	assert.deepEqual(card.outline, ["它解决什么问题", "怎么用", "常见追问", "易错点"]);
});

test("extractQuizCard 对没有小标题的老笔记不退化成空答案", () => {
	const card = extractQuizCard("只有一段结论，没有小标题。第二句补充说明。");
	assert.ok(card.answer.length > 0);
	assert.deepEqual(card.points, []);
	assert.deepEqual(card.followUps, []);
	assert.equal(card.memory, "");
});

test("extractQuizCard 兼容 **Q：** / A： 写法", () => {
	const card = extractQuizCard(`结论一句话。

## 常见追问

**Q：** 为什么快？
A：因为不阻塞。

**Q：** 会死锁吗？
A：不会死锁，但会自旋。
`);
	assert.equal(card.followUps.length, 2);
	assert.equal(card.followUps[1].q, "会死锁吗？");
});

test("extractQuizCard 代码围栏里的 ## 不算小标题", () => {
	const card = extractQuizCard("结论。\n\n```bash\n## 注释\n```\n\n## 真小节\n\n内容在。");
	assert.deepEqual(card.points.map((point) => point.heading), ["真小节"]);
});

test("extractQuizCard 超长结论会被收口，空正文不炸", () => {
	const long = `${"字".repeat(2000)}。`;
	const card = extractQuizCard(long);
	assert.ok(card.answer.length <= 421, `答案应封顶，实际 ${card.answer.length}`);

	const empty = extractQuizCard("");
	assert.equal(empty.answer, "");
	assert.deepEqual(empty.points, []);
});

test("extractQuizCard 兼容「1. **问：…** 答案同行」与「**Q1：…**」两种写法", () => {
	const inline = extractQuizCard(`结论。

## 常见追问

1. **问：A2A 会取代 MCP 吗？** 不会，两者在不同层。
2. **问：什么时候值得引入 A2A？** 跨组织协作时。

## 易错点

- 把 A2A 当 RPC 用
`);
	assert.equal(inline.followUps.length, 2);
	assert.equal(inline.followUps[0].q, "A2A 会取代 MCP 吗？");
	assert.ok(inline.followUps[0].a.startsWith("不会"));

	const numbered = extractQuizCard(`结论。

## 常见追问与面试怎么答

**Q1：ls -l 和 du 为什么不一样？**
A：一个给逻辑长度，一个按磁盘块统计。
`);
	assert.equal(numbered.followUps.length, 1);
	assert.equal(numbered.followUps[0].q, "ls -l 和 du 为什么不一样？");
});

test("extractQuizCard 从多个候选小节里合并追问（面试怎么答 + 常见追问）", () => {
	const card = extractQuizCard(`结论。

## 面试怎么答

1. 先讲定位
2. 再讲机制

## 常见追问

**问：会不会取代 MCP？**
**答：** 不会。

**问：值得引入吗？**
**答：** 跨组织才值得。
`);
	assert.equal(card.followUps.length, 2, "要点罗列的「面试怎么答」不该污染问答对");
});
