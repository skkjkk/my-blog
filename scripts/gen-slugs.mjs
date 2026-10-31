/**
 * 生成英文 slug 映射表：中文文件名/标题 → 干净英文 URL
 *
 * 输出 src/data/post-slugs.ts：
 *   export const postSlugs: Record<string, string> = { "手写LRU算法": "implement-lru-cache", ... }
 *
 * 用法：node scripts/gen-slugs.mjs [--write]
 * 中间进度存 .slug-progress.json（断了重跑会复用已完成的部分）
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const POSTS_DIR = "src/content/posts";
const OUT = "src/data/post-slugs.ts";
const PROGRESS = ".slug-progress.json";
const WRITE = process.argv.includes("--write");

const env = readFileSync(".dev.vars", "utf8");
const pick = (name) => {
	const m = env.match(new RegExp(`^${name}=(.+)$`, "m"));
	return m ? m[1].trim() : "";
};
const KEY = pick("AI_API_KEY");
const BASE = pick("AI_BASE_URL") || "https://api.hcnsec.cn/v1/chat/completions";
const MODEL = pick("AI_MODEL") || "auto";

const slugRe = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/* ---------- 本地文章清单 ---------- */
const items = readdirSync(POSTS_DIR)
	.filter((f) => f.endsWith(".md"))
	.sort()
	.map((f) => {
		const raw = readFileSync(join(POSTS_DIR, f), "utf8");
		const title = (raw.match(/^title:\s*["']?(.+?)["']?\s*$/m) || [])[1] || f;
		return { id: f.replace(/\.md$/, ""), title };
	});

/* ---------- 进度 ---------- */
const progress = existsSync(PROGRESS) ? JSON.parse(readFileSync(PROGRESS, "utf8")) : {};
const save = () => writeFileSync(PROGRESS, JSON.stringify(progress, null, "\t"), "utf8");

const need = items.filter((it) => !(it.id in progress) || !slugRe.test(progress[it.id] || ""));
console.log(`共 ${items.length} 篇，已有 ${items.length - need.length} 篇，待生成 ${need.length} 篇`);

/* ---------- 请求 ---------- */
async function ask(batch) {
	const list = batch.map((it, i) => `${i}. ${it.title}`).join("\n");
	const body = {
		model: MODEL,
		temperature: 0.2,
		messages: [
			{
				role: "system",
				content:
					"You convert Chinese technical blog titles into short English URL slugs. " +
					"Rules: lowercase, words joined by single hyphens, 2-6 words, only [a-z0-9-], " +
					"keep well-known acronyms (jvm, gc, sql, mcp, a2a, rag), each slug must be distinctive. " +
					"Reply with a JSON object only, keys are the given numbers.",
			},
			{
				role: "user",
				content: `把下面标题转成英文 URL slug。返回 JSON 对象，key 是序号（字符串），value 是 slug。必须覆盖全部序号。\n\n${list}`,
			},
		],
	};

	const res = await fetch(BASE, {
		method: "POST",
		headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(150_000),
	});
	if (!res.ok) throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 160)}`);
	const json = await res.json();
	const text = String(json.choices?.[0]?.message?.content ?? "")
		.replace(/```json|```/g, "")
		.trim();
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start < 0) throw new Error(`no json: ${text.slice(0, 120)}`);
	return JSON.parse(text.slice(start, end + 1));
}

const BATCH = 10;
const CONCURRENCY = 3;

const batches = [];
for (let i = 0; i < need.length; i += BATCH) batches.push(need.slice(i, i + BATCH));
console.log(`分 ${batches.length} 批，并发 ${CONCURRENCY}`);

let done = 0;
async function runBatch(batch) {
	for (let attempt = 1; attempt <= 3; attempt++) {
		try {
			const partial = await ask(batch);
			let filled = 0;
			for (const [k, v] of Object.entries(partial)) {
				const idx = Number(k);
				if (!Number.isInteger(idx) || idx < 0 || idx >= batch.length) continue;
				const slug = String(v).toLowerCase().trim();
				if (!slugRe.test(slug)) continue;
				progress[batch[idx].id] = slug;
				filled++;
			}
			if (filled > 0) {
				save();
				done += filled;
				console.log(`  batch +${filled}/${batch.length}  (累计 ${done})`);
			}
			if (filled === batch.length) return;
		} catch (err) {
			console.log(`  batch 第 ${attempt} 次失败：${err.message}`);
		}
	}
	console.log("  batch 有缺口，交给人补");
}

const queue = [...batches];
await Promise.all(
	Array.from({ length: CONCURRENCY }, async () => {
		while (queue.length) {
			const b = queue.shift();
			if (b) await runBatch(b);
		}
	}),
);

/* ---------- 兜底 + 去重 ---------- */
const asciiFallback = (id) => {
	const ascii = id
		.replace(/[^\x00-\x7F]/g, " ")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
	return ascii || "post";
};

const used = new Map();
const dups = [];
for (const it of items) {
	let slug = progress[it.id];
	if (!slug || !slugRe.test(slug)) {
		slug = asciiFallback(it.id);
		console.log(`  fallback: ${it.id} → ${slug}`);
	}
	if (used.has(slug)) {
		dups.push([it.id, slug]);
		let n = 2;
		while (used.has(`${slug}-${n}`)) n++;
		slug = `${slug}-${n}`;
	}
	used.set(slug, it.id);
	progress[it.id] = slug;
}

console.log(`\n共 ${items.length} 篇，slug ${used.size} 个，重名 ${dups.length} 个`);
for (const [id, s] of dups) console.log(`  dup: ${id} ← ${s}`);

/* ---------- 落盘 ---------- */
const lines = items.map((it) => `\t${JSON.stringify(it.id)}: ${JSON.stringify(progress[it.id])},`);
const file = `/**
 * 文章 URL slug 表：中文文件名（内容集合里的 slug）→ 英文 URL 段
 * 由 scripts/gen-slugs.mjs 生成，可手工调整（改完重新构建即可生效）。
 * 没出现在表里的文章会退化为中文 slug。
 */
export const postSlugs: Record<string, string> = {
${lines.join("\n")}
};
`;
if (WRITE) {
	writeFileSync(OUT, file, "utf8");
	console.log(`written → ${OUT}`);
} else {
	console.log("(dry run, 加 --write 落盘)");
}
