/**
 * 新建文章 / 笔记。
 *
 * 用法：
 *   node scripts/new-post.js <文件名>                     # 老用法，最省事
 *   node scripts/new-post.js --title "什么是 GraalVM？" --category Java --tags 基础,面试 --section note
 *   node scripts/new-post.js --title "..." --slug graalvm-what --publish
 *
 * 选项：
 *   --title    标题（默认用文件名）
 *   --slug     英文 URL 段（等于文件名；不给就用文件名参数）
 *   --category 分类
 *   --tags     逗号分隔的标签
 *   --section  note（进题库）或 post（普通文章），默认 note
 *   --publish  直接发布（默认写成 draft: true：本地能看、线上不出现）
 */
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const options = {};
const positional = [];

for (let i = 0; i < args.length; i++) {
	const arg = args[i];
	if (arg === "--publish") {
		options.publish = true;
		continue;
	}
	if (arg.startsWith("--")) {
		options[arg.slice(2)] = args[++i] ?? "";
		continue;
	}
	positional.push(arg);
}

const today = () => {
	const now = new Date();
	const pad = (value) => String(value).padStart(2, "0");
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
};

/** 文件名：优先 --slug，其次文件名参数，最后用标题 */
const rawName = options.slug || positional[0] || options.title || "";
if (!rawName) {
	console.error(`没给文件名也没给标题。

用法：
  node scripts/new-post.js --title "什么是 GraalVM？" --category Java --tags 基础,面试
  node scripts/new-post.js my-first-post`);
	process.exit(1);
}

const fileName = rawName.endsWith(".md") ? rawName : `${rawName}.md`;
const title = options.title || rawName.replace(/\.md$/, "");
const section = options.section === "post" ? "post" : "note";
const tags = (options.tags || "")
	.split(",")
	.map((tag) => tag.trim())
	.filter(Boolean);

const targetDir = "src/content/posts";
const fullPath = path.join(targetDir, fileName);

if (fs.existsSync(fullPath)) {
	console.error(`已经存在：${fullPath}`);
	process.exit(1);
}

const lines = [
	"---",
	`title: ${title}`,
	`published: ${today()}`,
	"description: ''",
	`tags: [${tags.join(", ")}]`,
	`category: ${options.category || ""}`,
	`section: ${section}`,
	`draft: ${options.publish ? "false" : "true"}`,
	"---",
	"",
];

fs.mkdirSync(path.dirname(fullPath), { recursive: true });
fs.writeFileSync(fullPath, lines.join("\n"), "utf8");

console.log(`已创建 ${fullPath}`);
console.log(`  title: ${title}`);
console.log(`  section: ${section}${options.category ? ` · category: ${options.category}` : "（记得补分类）"}`);
console.log(`  draft: ${options.publish ? "false（会发布）" : "true（本地可见、线上不出现，写完改成 false）"}`);
console.log("");
console.log("接下来：");
console.log("  1. 首段写一句话结论（刷题页会把它当「速览答案」），后面用 ## 分点（会变成「要点提纲」）");
console.log("  2. 截图直接跑 node scripts/paste-image.mjs，会给出可粘贴的图片链接");
console.log("  3. 写完跑 node scripts/lint-posts.mjs 体检");
