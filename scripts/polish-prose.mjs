/**
 * 散文类笔记的轻量润色（没有 1) 2) 编号的那 28 篇）：
 *   - "一句话总结：……" 这类收尾句 → :::tip 提示块
 *   - 结尾的加粗长句单独成段时也包进提示块
 *   - 保证段间空行
 * 用法：node scripts/polish-prose.mjs [--dry]
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DIR = "src/content/posts";
const BACKUP = ".restyle-backup";
const DRY = process.argv.includes("--dry");

const splitFront = (raw) => {
	const m = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
	return m ? { front: m[0], body: raw.slice(m[0].length) } : { front: "", body: raw };
};

if (!DRY) mkdirSync(BACKUP, { recursive: true });

let changed = 0;
for (const file of readdirSync(DIR).filter((f) => f.endsWith(".md")).sort()) {
	const raw = readFileSync(join(DIR, file), "utf8");
	if (!/^section:\s*note\s*$/m.test(raw)) continue;
	const { front, body } = splitFront(raw);
	if (/^##\s/m.test(body)) continue;                       // 已经有小标题，跳过
	if (/^\s*\d{1,2}\s*[)）.、]\s+/m.test(body)) continue;    // 有编号，走另一个脚本

	const paragraphs = body.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
	if (paragraphs.length === 0) continue;

	const out = paragraphs.map((p) => {
		const isQuote = /^>/.test(p);
		const isSummary = /^(一句话总结|一句话|小结|总结)[：:]/.test(p.replace(/^>+\s*/, ""));
		if (isQuote || isSummary) {
			const text = p.replace(/^>+\s*/gm, "").trim();
			return `:::tip\n${text}\n:::`;
		}
		return p;
	});

	const next = `${front}${out.join("\n\n")}\n`;
	if (next === raw) continue;

	if (!DRY) {
		const bak = join(BACKUP, file);
		if (!existsSync(bak)) copyFileSync(join(DIR, file), bak);
		writeFileSync(join(DIR, file), next, "utf8");
	}
	changed++;
	console.log(`${DRY ? "·" : "✓"} ${file.replace(/\.md$/, "")}`);
}

console.log(`\n润色 ${changed} 篇${DRY ? "（dry run）" : ""}`);
