/**
 * 给面试笔记批量打上 section: note / 给 hello-world 打 pinned
 * 幂等：已有字段就跳过。用法：node scripts/tag-sections.mjs
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DIR = "src/content/posts";
const files = readdirSync(DIR).filter((f) => f.endsWith(".md"));

let changed = 0;
for (const f of files) {
	const p = join(DIR, f);
	let raw = readFileSync(p, "utf8");
	const title = (raw.match(/^title:\s*["']?(.+?)["']?\s*$/m) || [])[1] || f;
	const isNote = f !== "hello-world.md";
	let next = raw;

	if (isNote && !/^section:/m.test(next)) {
		next = next.replace(/^(category:.*)$/m, "$1\nsection: note");
	}
	if (!isNote && !/^pinned:/m.test(next)) {
		next = next.replace(/^(draft:.*)$/m, "$1\npinned: true");
	}

	if (next !== raw) {
		writeFileSync(p, next, "utf8");
		changed++;
	}
	console.log(`${changed ? "·" : " "} ${title} ${isNote ? "[note]" : "[post]"}`);
}
console.log(`\n改动 ${changed} 个文件`);
