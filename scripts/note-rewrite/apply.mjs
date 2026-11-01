/**
 * 把 .tmp/rewrite/ 下的改写稿落盘到 src/content/posts/。
 *
 * 只做一件事，但每一关都卡住：
 *   1. 文件名必须能对上现有的 src/content/posts/<同名文件>
 *   2. frontmatter 除 description 外一字不能变（防模型手滑改标题/日期/分类）
 *   3. 必须过 verifyRewrite（分数不降、正文不变短、小节不变少、无红线）
 *   4. 通过才写，写前备份到 .tmp/enrich-backup/，并把改写稿挪到 .tmp/rewrite-applied/
 *
 * 用法：
 *   node .tmp/rewrite/apply.mjs           # 全量落盘
 *   node .tmp/rewrite/apply.mjs --dry     # 只校验不落盘
 *   node .tmp/rewrite/apply.mjs --file X  # 只处理某篇
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inspectNote, splitNote, verifyRewrite } from "../lib/note-parse.mjs";

const SRC = "src/content/posts";
const DRAFT = ".tmp/rewrite";
const APPLIED = ".tmp/rewrite-applied";
const BACKUP = ".tmp/enrich-backup";

const args = process.argv.slice(2);
const DRY = args.includes("--dry");
const onlyFile = args.includes("--file") ? args[args.indexOf("--file") + 1] : "";
/** --force：允许合理重构（合并小节），只保留 frontmatter / 红线 / 篇幅 / 分数 这些硬关卡 */
const FORCE = args.includes("--force");

const KEEP_FIELDS = ["title", "published", "tags", "category", "section", "draft"];

mkdirSync(APPLIED, { recursive: true });
mkdirSync(BACKUP, { recursive: true });

let applied = 0;
const rejected = [];

const drafts = readdirSync(DRAFT)
	.filter((name) => name.endsWith(".md") && name !== "TASK.md")
	.filter((name) => !onlyFile || name.includes(onlyFile))
	.sort();

for (const name of drafts) {
	const draftPath = join(DRAFT, name);
	const srcPath = join(SRC, name);
	if (!existsSync(srcPath)) {
		rejected.push(`${name}: src 里没有同名文件`);
		continue;
	}

	const beforeRaw = readFileSync(srcPath, "utf8");
	const afterRaw = readFileSync(draftPath, "utf8");
	const before = inspectNote(beforeRaw);
	const after = inspectNote(afterRaw);

	const issues = [];

	// frontmatter 关键字段必须原样
	const beforeData = splitNote(beforeRaw).data;
	const afterData = splitNote(afterRaw).data;
	for (const key of KEEP_FIELDS) {
		const a = JSON.stringify(beforeData[key] ?? "");
		const b = JSON.stringify(afterData[key] ?? "");
		if (a !== b) issues.push(`frontmatter「${key}」被改动：${a} → ${b}`);
	}

	if (!String(afterData.description ?? "").trim()) issues.push("description 是空的");

	const check = verifyRewrite(before, afterRaw);
	const merged = FORCE ? check.issues.filter((issue) => !issue.startsWith("实心小节变少")) : check.issues;
	issues.push(...merged);

	if (issues.length > 0) {
		rejected.push(`${name}:\n      - ${issues.join("\n      - ")}`);
		continue;
	}

	if (!DRY) {
		const backup = join(BACKUP, name);
		if (!existsSync(backup)) copyFileSync(srcPath, backup);
		writeFileSync(srcPath, afterRaw.endsWith("\n") ? afterRaw : `${afterRaw}\n`, "utf8");
		renameSync(draftPath, join(APPLIED, name));
	}

	applied++;
	console.log(`✓ ${name}  ${before.score} → ${after.score} 分 · ${before.metrics.totalChars} → ${after.metrics.totalChars} 字`);
}

console.log(`\n落盘 ${applied} 篇${DRY ? "（dry run，未写）" : ""}，拒收 ${rejected.length} 篇`);
for (const item of rejected) console.log(`  ✗ ${item}`);
if (rejected.length > 0) process.exitCode = 1;



