/**
 * 近似重复检测：题库里两篇讲同一件事，刷题时会「刷到两道一模一样的题」。
 *
 * 做法：标题 + 正文开头做字符三元组（3-gram）余弦相似度，超过阈值就列出来，
 * 人再决定合并还是留一篇当不同角度。纯本地计算，不联网。
 *
 * 用法：
 *   node scripts/check-duplicates.mjs              # 阈值 0.5
 *   node scripts/check-duplicates.mjs --min 0.35   # 调低更敏感
 *   node scripts/check-duplicates.mjs --strict     # 有命中就退出码 1（CI 用）
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = "src/content/posts";
const args = process.argv.slice(2);
const min = Number(args.includes("--min") ? args[args.indexOf("--min") + 1] : "0.5");

/** 只保留中文/英文/数字，压成无空白串 */
const normalize = (text) => text.toLowerCase().replace(/[^\u4e00-\u9fa5a-z0-9]/g, "");

function trigrams(text) {
	const set = new Map();
	const clean = normalize(text);
	for (let i = 0; i + 3 <= clean.length; i++) {
		const gram = clean.slice(i, i + 3);
		set.set(gram, (set.get(gram) ?? 0) + 1);
	}
	return set;
}

function cosine(a, b) {
	let dot = 0;
	for (const [gram, count] of a) {
		const other = b.get(gram);
		if (other) dot += count * other;
	}
	const norm = (map) => Math.sqrt([...map.values()].reduce((sum, value) => sum + value * value, 0));
	const denominator = norm(a) * norm(b);
	return denominator === 0 ? 0 : dot / denominator;
}

const notes = [];
for (const file of readdirSync(DIR).filter((name) => name.endsWith(".md")).sort()) {
	const raw = readFileSync(join(DIR, file), "utf8");
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
	if (!match) continue;
	if (!/^section:\s*note\s*$/m.test(match[1])) continue;
	const title = /^title:\s*(.+)$/m.exec(match[1])?.[1]?.trim() ?? file;
	// 标题权重高：标题相似基本就是同一道题
	notes.push({ file, title, grams: trigrams(`${title} ${title} ${match[2].slice(0, 600)}`) });
}

const pairs = [];
for (let i = 0; i < notes.length; i++) {
	for (let j = i + 1; j < notes.length; j++) {
		const score = cosine(notes[i].grams, notes[j].grams);
		if (score >= min) pairs.push({ a: notes[i], b: notes[j], score });
	}
}

pairs.sort((x, y) => y.score - x.score);
console.log(`比对 ${notes.length} 篇，相似度 ≥ ${min} 的有 ${pairs.length} 对\n`);
for (const pair of pairs.slice(0, 20)) {
	console.log(`${pair.score.toFixed(3)}  ${pair.a.file}`);
	console.log(`       ${pair.b.file}`);
}

if (args.includes("--strict") && pairs.length > 0) process.exit(1);
