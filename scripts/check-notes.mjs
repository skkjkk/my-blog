import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DIR = "src/content/posts";
let files = 0,
	fails = 0;
const issues = [];

for (const f of readdirSync(DIR).filter((x) => x.endsWith(".md"))) {
	const raw = readFileSync(join(DIR, f), "utf8");
	if (!/^section:\s*note\s*$/m.test(raw)) continue;
	files++;
	const md = raw.replace(/^---[\s\S]*?---\n/, "");
	const p = [];

	if ((md.match(/```/g) || []).length % 2 !== 0) p.push("代码围栏不配对");
	const directs = md.split("\n").filter((l) => /^:::/.test(l)).length;
	if (directs % 2 !== 0) p.push("::: 提示块不配对");
	if (/^\s*:::([a-zA-Z]+)[ \t]+[^[\s]/m.test(md)) p.push("::: 语法错误");

	// 表格：分隔行与后续行 pipe 数一致
	const lines = md.split("\n");
	for (let i = 1; i < lines.length; i++) {
		if (!/^\|/.test(lines[i]) || !/^\|[\s:|-]+\|$/.test(lines[i])) continue;
		const cols = (l) => (l.match(/\|/g) || []).length;
		const head = cols(lines[i - 1]);
		if (head !== cols(lines[i])) continue; // 分隔行列数与表头不一致，交给下一行判断
		let j = i + 1;
		while (j < lines.length && /^\|/.test(lines[j])) {
			if (cols(lines[j]) !== head) p.push(`第 ${j + 1} 行表格列数不一致`);
			j++;
		}
	}
	if (/^#\s/m.test(md)) p.push("出现一级标题");
	if (/^\s*\d{1,2}[)）]\s/m.test(md)) p.push("残留 1) 编号");

	if (p.length) {
		fails++;
		issues.push(`${f}: ${p.join("；")}`);
	}
}

console.log(`检查 ${files} 篇笔记，有问题 ${fails} 篇`);
for (const i of issues.slice(0, 15)) console.log("  " + i);
