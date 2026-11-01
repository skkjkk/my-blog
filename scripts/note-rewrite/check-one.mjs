/**
 * 单篇校验：给改写稿打分，用于子智能体自检（不改任何文件）。
 *
 * 用法：node .tmp/rewrite/check-one.mjs <改写稿路径>
 * 退出码：0 达标（≥85 分且无红线）；1 不达标
 */
import { readFileSync } from "node:fs";
import { inspectNote } from "../lib/note-parse.mjs";

const path = process.argv[2];
if (!path) {
	console.error("用法：node .tmp/rewrite/check-one.mjs <改写稿路径>");
	process.exit(1);
}

const note = inspectNote(readFileSync(path, "utf8"));
const m = note.metrics;

console.log(`分数 ${note.score}（${note.grade}）`);
console.log(
	`首段 ${m.leadChars} 字 · 小节 ${m.sections}（实心 ${m.solidSections}）· 要点 ${m.bullets} 条 · 正文 ${m.totalChars} 字`,
);
console.log(
	`追问 ${m.hasFollowUp ? "有" : "缺"} · 易错点 ${m.hasPitfall ? "有" : "缺"} · 一句话记住 ${m.hasSummary ? "有" : "缺"} · 例子 ${m.hasCode ? "代码" : m.hasTable ? "表格" : "无"}`,
);
if (note.redlines.length) console.log(`红线：\n${note.redlines.map((r) => `  ! ${r}`).join("\n")}`);
if (note.problems.length) console.log(`待改：\n${note.problems.map((p) => `  - ${p}`).join("\n")}`);

process.exit(note.score >= 85 && note.redlines.length === 0 ? 0 : 1);

