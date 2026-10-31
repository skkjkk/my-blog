/**
 * 把 src/data/post-slugs.ts 的 key 从「中文文件名」改成「文章标题」
 * （Astro 的 entry.slug 会把 InnoDB → innodb 之类做 slugify，用文件名当 key 不稳）
 *
 * 用法：node scripts/rekey-slugs.mjs
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DIR = "src/content/posts";
const MAP = "src/data/post-slugs.ts";

const src = readFileSync(MAP, "utf8");
const pairs = [...src.matchAll(/^\t"(.+?)": "(.+?)",$/gm)].map((m) => ({
	from: m[1],
	to: m[2],
}));
const byFile = new Map(pairs.map((p) => [p.from, p.to]));

const files = readdirSync(DIR).filter((f) => f.endsWith(".md"));
const rows = [];
const seen = new Map();
for (const f of files.sort()) {
	const raw = readFileSync(join(DIR, f), "utf8");
	const title = (raw.match(/^title:\s*["']?(.+?)["']?\s*$/m) || [])[1] || f;
	const id = f.replace(/\.md$/, "");
	const slug = byFile.get(id);
	if (!slug) {
		console.log(`缺 slug：${id}`);
		continue;
	}
	if (seen.has(title)) console.log(`标题重复：${title}（${seen.get(title)} / ${id}）`);
	seen.set(title, id);
	rows.push([title, slug]);
}

const dupSlug = new Map();
for (const [, s] of rows) dupSlug.set(s, (dupSlug.get(s) ?? 0) + 1);
for (const [s, n] of dupSlug) if (n > 1) console.log(`slug 重复：${s} ×${n}`);

const out = `/**
 * 文章 URL slug 表：文章标题 → 英文 URL 段
 * 由 scripts/gen-slugs.mjs 生成，可手工调整（改完重新构建即可生效）。
 * 没出现在表里的文章（或标题改了）会退化为中文 slug，不会 404。
 */
export const postSlugs: Record<string, string> = {
${rows.map(([t, s]) => `\t${JSON.stringify(t)}: ${JSON.stringify(s)},`).join("\n")}
};
`;
writeFileSync(MAP, out, "utf8");
console.log(`written → ${MAP}（${rows.length} 条）`);
