/**
 * 笔记体检：按 docs/note-standard.md 给每篇笔记打分，指出刷题会踩的坑。
 *
 * 用法：
 *   node scripts/note-quality.mjs                # 全量报告（C 级明细 + B 级清单）
 *   node scripts/note-quality.mjs --top 30       # 只看最该改的 N 篇
 *   node scripts/note-quality.mjs --only CAS     # 只看标题/文件名含关键字的
 *   node scripts/note-quality.mjs --grade C      # 只看某一等级
 *   node scripts/note-quality.mjs --json         # 输出 JSON（供 enrich 脚本/CI 用）
 *   node scripts/note-quality.mjs --strict       # 有 C 级就退出码 1（给 CI 用）
 *
 * 与 lint-posts.mjs 的分工：那个查「能不能构建」，这个查「刷题时答得对不对」。
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inspectNote } from "./lib/note-parse.mjs";

const DIR = "src/content/posts";
const OUT = ".tmp/note-quality.json";

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const value = (flag, fallback = "") => (has(flag) ? (args[args.indexOf(flag) + 1] ?? fallback) : fallback);

const only = value("--only");
const gradeFilter = value("--grade");
const top = Number(value("--top", "0")) || 0;
const jsonOnly = has("--json");

const files = readdirSync(DIR)
	.filter((name) => name.endsWith(".md"))
	.sort();

const rows = [];
for (const file of files) {
	const raw = readFileSync(join(DIR, file), "utf8");
	const note = inspectNote(raw);
	if (String(note.parsed.data.section ?? "post") !== "note") continue;
	if (only && !file.includes(only) && !String(note.parsed.data.title ?? "").includes(only)) continue;
	if (gradeFilter && note.grade !== gradeFilter) continue;
	rows.push({
		file,
		title: String(note.parsed.data.title ?? ""),
		category: String(note.parsed.data.category ?? ""),
		score: note.score,
		grade: note.grade,
		metrics: note.metrics,
		problems: note.problems,
		redlines: note.redlines,
	});
}

rows.sort((a, b) => a.score - b.score);
const shown = top > 0 ? rows.slice(0, top) : rows;

const out = {
	generatedAt: new Date().toISOString(),
	total: rows.length,
	byGrade: {
		A: rows.filter((row) => row.grade === "A").length,
		B: rows.filter((row) => row.grade === "B").length,
		C: rows.filter((row) => row.grade === "C").length,
	},
	average: rows.length ? Math.round(rows.reduce((sum, row) => sum + row.score, 0) / rows.length) : 0,
	items: shown,
};

mkdirSync(".tmp", { recursive: true });
writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`, "utf8");

if (jsonOnly) {
	console.log(JSON.stringify(out, null, 2));
} else {
	console.log(
		`体检 ${out.total} 篇笔记：A ${out.byGrade.A} · B ${out.byGrade.B} · C ${out.byGrade.C}，平均 ${out.average} 分`,
	);
	console.log(`报告已写入 ${OUT}\n`);

	for (const row of shown) {
		console.log(`${row.grade}  ${String(row.score).padStart(3)}  ${row.file}`);
		console.log(
			`      首段 ${row.metrics.leadChars} 字 · 小节 ${row.metrics.sections}（实心 ${row.metrics.solidSections}）· 要点 ${row.metrics.bullets} 条 · 正文 ${row.metrics.totalChars} 字`,
		);
		for (const problem of row.problems.slice(0, 6)) console.log(`      - ${problem}`);
		if (row.problems.length > 6) console.log(`      - …… 还有 ${row.problems.length - 6} 条`);
		if (row.redlines.length) console.log(`      ! ${row.redlines.join("；")}`);
	}
}

if (has("--strict") && out.byGrade.C > 0) process.exit(1);
