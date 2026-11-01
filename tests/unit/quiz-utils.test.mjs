import test from "node:test";
import assert from "node:assert/strict";
import {
	extractQuizAnswer,
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
