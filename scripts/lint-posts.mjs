/**
 * 文章体检：每次写东西之前/之后跑一遍，把「构建不报错但线上会难看」的问题提前揪出来。
 *
 * 用法：
 *   node scripts/lint-posts.mjs           # 只报错（warning 不影响退出码）
 *   node scripts/lint-posts.mjs --strict  # warning 也算失败，适合放进 CI
 *
 * 检查项：
 *   1. frontmatter 必填与格式（title / published / section / category / tags）
 *   2. 标题是否重复（重复会让 URL 表打架）
 *   3. slug 表里有没有登记（没登记会退化成中文 URL，能访问但不好看）
 *   4. markdown 结构：代码围栏配对、`:::` 提示块配对、表格列数一致、别出现一级标题
 *   5. 文件名规范（别用空格、别用大写）
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DIR = "src/content/posts";
const STRICT = process.argv.includes("--strict");

/** 极简 frontmatter 解析：只认 `key: value` / `key: [a, b]` / 引号字符串 */
function parseFrontmatter(raw) {
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
	if (!match) return null;

	const data = {};
	for (const line of match[1].split(/\r?\n/)) {
		const hit = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
		if (!hit) continue;

		const [, key, rawValue] = hit;
		let value = rawValue.trim();

		if (value.startsWith("[") && value.endsWith("]")) {
			value = value
				.slice(1, -1)
				.split(",")
				.map((part) => part.trim().replace(/^["']|["']$/g, ""))
				.filter(Boolean);
		} else if (/^"(.*)"$/.test(value) || /^'(.*)'$/.test(value)) {
			value = value.slice(1, -1).replace(/\\"/g, '"');
		}

		data[key] = value;
	}

	return { data, body: match[2] };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validDate(value) {
	if (!DATE_RE.test(value)) return false;
	const [year, month, day] = value.split("-").map(Number);
	const date = new Date(year, month - 1, day);
	return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

/** 从 post-slugs.ts 里抠出已登记的标题 */
function loadSlugTitles() {
	try {
		const source = readFileSync("src/data/post-slugs.ts", "utf8");
		return new Set([...source.matchAll(/^\s*"((?:[^"\\]|\\.)*)":/gm)].map((hit) => hit[1].replace(/\\"/g, '"')));
	} catch {
		return new Set();
	}
}

const slugTitles = loadSlugTitles();
const files = readdirSync(DIR)
	.filter((name) => name.endsWith(".md"))
	.sort();

const errors = [];
const warnings = [];
const titles = new Map();
let notes = 0;

for (const file of files) {
	const push = (list, message) => list.push(`${file}: ${message}`);
	const raw = readFileSync(join(DIR, file), "utf8");
	const parsed = parseFrontmatter(raw);

	if (!parsed) {
		push(errors, "没有 frontmatter（文件必须以 --- 开头的元信息块起头）");
		continue;
	}

	const { data, body } = parsed;
	const section = data.section || "post";
	if (section === "note") notes++;

	// --- 必填 ---
	if (!data.title) push(errors, "缺 title");
	if (!data.published) push(errors, "缺 published");
	else if (!validDate(String(data.published))) push(errors, `published 不是合法日期：${data.published}`);

	if (!["post", "note"].includes(String(section))) push(errors, `section 只能是 post / note，现在是 ${section}`);
	if (section === "note" && !data.category) push(errors, "笔记缺 category（题库按分类归组）");

	const tags = Array.isArray(data.tags) ? data.tags : [];
	if (tags.length === 0) push(warnings, "tags 为空，归档和标签云里会找不到它");

	if (data.draft !== undefined && !["true", "false"].includes(String(data.draft).toLowerCase())) {
		push(errors, `draft 只能是 true / false，现在是 ${data.draft}`);
	}

	// --- 重复标题 ---
	if (data.title) {
		const same = titles.get(data.title);
		if (same) push(errors, `标题与 ${same} 重复：${data.title}`);
		else titles.set(data.title, file);
	}

	// --- slug 登记 ---
	if (data.title && !slugTitles.has(data.title)) {
		push(warnings, `slug 表里没这个标题，URL 会退化成中文：${data.title.slice(0, 24)}`);
	}

	// --- 文件名 ---
	if (/\s/.test(file)) push(warnings, "文件名带空格");
	// 只对纯英文文件名管大小写：中文名的大小写不影响 URL（URL 来自 slug 表）
	if (/^[\x20-\x7e]+\.md$/.test(file) && /[A-Z]/.test(file)) push(warnings, "文件名带大写字母（URL 会区分大小写）");

	// --- markdown 结构（沿用原 check-notes 的规则） ---
	const fences = (body.match(/^```/gm) || []).length;
	if (fences % 2 !== 0) push(errors, "代码围栏 ``` 不配对");

	const directives = body.split("\n").filter((line) => /^:::/.test(line)).length;
	if (directives % 2 !== 0) push(errors, "::: 提示块不配对");
	if (/^\s*:::([a-zA-Z]+)[ \t]+[^[\s]/m.test(body)) push(errors, "::: 语法错误（参数要写成 {title=...}）");

	for (const [index, line] of body.split("\n").entries()) {
		if (!/^\|/.test(line) || !/^\|[\s:|-]+\|$/.test(line)) continue;
		const pipes = (text) => (text.match(/\|/g) || []).length;
		const head = pipes(body.split("\n")[index - 1] ?? "");
		if (head !== pipes(line)) continue;
		let cursor = index + 1;
		const lines = body.split("\n");
		while (cursor < lines.length && /^\|/.test(lines[cursor])) {
			if (pipes(lines[cursor]) !== head) push(errors, `第 ${cursor + 1} 行表格列数与表头不一致`);
			cursor++;
		}
	}

	if (/^#\s/m.test(body)) push(warnings, "正文里出现一级标题（页面标题由 frontmatter 决定）");
}

const shown = (list) => {
	for (const item of list.slice(0, 25)) console.log(`  ${item}`);
	if (list.length > 25) console.log(`  …… 还有 ${list.length - 25} 条`);
};

console.log(`检查 ${files.length} 篇（其中笔记 ${notes} 篇）`);
console.log(`错误 ${errors.length} 条，提醒 ${warnings.length} 条`);
if (errors.length > 0) {
	console.log("\n错误：");
	shown(errors);
}
if (warnings.length > 0) {
	console.log("\n提醒：");
	shown(warnings);
}

process.exit(errors.length > 0 || (STRICT && warnings.length > 0) ? 1 : 0);
