/**
 * 把 interview-notes 笔记库导入成博客文章
 *
 * 来源约定（见其 README）：每个 md = "# 问题" + "## 答案" + 正文
 * 目标：src/content/posts/<slug>.md，frontmatter 符合 src/content/config.ts
 *
 * 运行：node scripts/import-interview-notes.mjs [源目录]
 * 默认源目录：D:/06-Agentworkspace/DeepSeek-harness/interview-notes
 */

import { readdir, readFile, writeFile, stat, mkdir } from "node:fs/promises";
import path from "node:path";

const SRC = process.argv[2] ?? "D:/06-Agentworkspace/DeepSeek-harness/interview-notes";
const OUT = path.join(process.cwd(), "src/content/posts");

/** 递归收集 md 文件 */
async function walk(dir, base = dir) {
	const out = [];
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...(await walk(full, base)));
		else if (entry.name.toLowerCase().endsWith(".md")) {
			out.push({ full, rel: path.relative(base, full).split(path.sep) });
		}
	}
	return out;
}

/** 取一级目录/二级目录 */
const categoryOf = (rel) => rel[0].replace(/\.md$/i, "");
const subtopicOf = (rel) => (rel.length > 2 ? rel[1] : "");

/** 去掉 markdown 记号，做纯文本摘要 */
function plain(text) {
	return text
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/^>.*$/gm, " ")
		.replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/[*_`#|]+/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

/** 摘要：按句累加到 42~78 字，句子太长就在句中断开并补省略号 */
function makeDescription(body, title) {
	const text = plain(body);
	if (!text) return `面试高频题：${title}`;
	const sentences = text.split(/(?<=[。！？；])/).filter(Boolean);
	const LIMIT = 78;
	let desc = "";
	for (const sentence of sentences) {
		if (desc.length >= 42) break;
		if (desc.length + sentence.length <= LIMIT) {
			desc += sentence;
			continue;
		}
		const room = LIMIT - desc.length;
		if (room > 18) desc += `${sentence.slice(0, room - 1)}…`;
		break;
	}
	if (!desc) desc = `${text.slice(0, 60)}…`;
	if (!desc.endsWith("…")) desc = desc.replace(/[。；，、]+$/, "");
	return desc;
}

const isoDate = (date) => {
	const d = new Date(date);
	const pad = (n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** frontmatter 里的字符串要安全：含冒号/引号/井号时用双引号包起来 */
const yamlStr = (value) => {
	const text = String(value ?? "").replace(/\r?\n/g, " ").trim();
	if (text === "") return '""';
	if (/^[\w\u4e00-\u9fa5][^:#"'\n]*$/.test(text)) return text;
	return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
};

await mkdir(OUT, { recursive: true });

const files = (await walk(SRC)).filter((file) => file.rel.length > 1 || file.rel[0].toLowerCase() !== "readme.md");
const used = new Map();
const report = [];

for (const file of files) {
	const raw = (await readFile(file.full, "utf8")).replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
	const stem = path.basename(file.full).replace(/\.md$/i, "");

	// 标题：第一个 # 标题
	const titleMatch = raw.match(/^#\s+(.+)$/m);
	const title = (titleMatch?.[1] ?? stem).trim();

	// 正文：## 答案 之后
	const answerIndex = raw.search(/^##\s*答案\s*$/m);
	let body = answerIndex >= 0 ? raw.slice(raw.indexOf("\n", answerIndex) + 1) : raw.replace(/^#.*$/m, "");
	body = body.replace(/^\s*\n+/, "").replace(/\s+$/, "");

	const category = categoryOf(file.rel);
	const subtopic = subtopicOf(file.rel);
	const tags = subtopic ? [subtopic, "面试"] : ["面试"];

	// slug：文件名；跨目录重名时补上级目录
	let slug = stem;
	if (used.has(slug)) {
		slug = `${stem}-${category}`;
		let n = 2;
		while (used.has(slug)) slug = `${stem}-${category}-${n++}`;
	}
	used.set(slug, true);

	const published = isoDate((await stat(file.full)).mtime);
	const description = makeDescription(body, title);

	const frontmatter = [
		"---",
		`title: ${yamlStr(title)}`,
		`published: ${published}`,
		`description: ${yamlStr(description)}`,
		`tags: [${tags.map(yamlStr).join(", ")}]`,
		`category: ${yamlStr(category)}`,
		"draft: false",
		"---",
		"",
	].join("\n");

	await writeFile(path.join(OUT, `${slug}.md`), frontmatter + body + "\n", "utf8");
	report.push({ slug, category, published, chars: body.length });
}

report.sort((a, b) => (a.published < b.published ? -1 : 1));
const byCategory = report.reduce((acc, row) => {
	acc[row.category] = (acc[row.category] ?? 0) + 1;
	return acc;
}, {});

console.log(`导入 ${report.length} 篇`);
console.log("按分类：", byCategory);
console.log("日期范围：", report[0]?.published, "→", report[report.length - 1]?.published);
const short = report.filter((row) => row.chars < 150).length;
if (short) console.log(`提醒：${short} 篇正文短于 150 字`);
