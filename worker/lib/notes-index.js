/**
 * 站点笔记索引：MCP Server 和 AI 问答共用。
 *
 * 数据源是构建产物 /notes-full.json（Astro 生成的全文纯文本），
 * Worker 运行时读不到 markdown 源文件，只能从这里拿。
 * 同一个 isolate 里只读一次，后面都走缓存。
 */

let indexCache = null;

export function resetIndexCache() {
	indexCache = null;
}

export async function loadIndex(env, requestUrl) {
	if (indexCache) return indexCache;
	if (!env?.ASSETS?.fetch) return [];

	const target = new URL("/notes-full.json", requestUrl);
	const response = await env.ASSETS.fetch(
		new Request(target.toString(), { headers: { accept: "application/json" } }),
	);
	if (!response.ok) return [];

	const data = await response.json();
	indexCache = Array.isArray(data?.items) ? data.items : [];
	return indexCache;
}

/** 关键词打分：标题 > 标签/分类 > 正文，多词全中再加权 */
export function scoreItem(item, needle) {
	const title = String(item.title ?? "").toLowerCase();
	const body = String(item.text ?? "").toLowerCase();
	const category = String(item.category ?? "").toLowerCase();
	const tags = (item.tags ?? []).join(" ").toLowerCase();

	let score = 0;
	if (title.includes(needle)) score += 50;
	if (title.startsWith(needle)) score += 30;
	if (category.includes(needle)) score += 12;
	if (tags.includes(needle)) score += 15;
	if (body.includes(needle)) score += 20;

	const words = needle.split(/\s+/).filter(Boolean);
	if (
		words.length > 1 &&
		words.every((word) => `${title} ${body}`.includes(word))
	)
		score += 25;

	return score;
}

/** 检索：返回 [{ item, snippet }]，按相关度倒序 */
export function searchNotes(items, query, limit = 5) {
	const needle = String(query ?? "")
		.toLowerCase()
		.trim();
	if (!needle) return [];

	const max = Math.min(Math.max(Math.round(Number(limit) || 5), 1), 20);

	return items
		.map((item) => ({ item, score: scoreItem(item, needle) }))
		.filter((row) => row.score > 0)
		.sort((a, b) => b.score - a.score)
		.slice(0, max)
		.map((row) => ({ item: row.item, snippet: snippet(row.item, query) }));
}

/** 命中关键词前后各取一点，给模型看上下文 */
export function snippet(item, keyword) {
	const source = String(item?.text ?? "");
	const needle = String(keyword ?? "").toLowerCase();
	if (!needle) return source.slice(0, 200);

	const index = source.toLowerCase().indexOf(needle);
	if (index < 0) return source.slice(0, 200);

	const start = Math.max(0, index - 80);
	return `${start > 0 ? "…" : ""}${source.slice(start, start + 260)}${
		start + 260 < source.length ? "…" : ""
	}`;
}

/** 按 slug / 标题 / 部分匹配找一篇笔记 */
export function findNote(items, key) {
	const raw = String(key ?? "").trim();
	if (!raw) return null;
	const needle = raw.toLowerCase();

	return (
		items.find((entry) => entry.slug === raw) ??
		items.find((entry) => String(entry.title ?? "").toLowerCase() === needle) ??
		items.find((entry) =>
			String(entry.title ?? "")
				.toLowerCase()
				.includes(needle),
		) ??
		items.find((entry) => String(entry.slug ?? "").toLowerCase() === needle) ??
		items.find((entry) => String(entry.slug ?? "").includes(needle)) ??
		null
	);
}

/** 同分类或同标签的相近笔记 */
export function relatedNotes(items, current, limit = 4) {
	if (!current) return [];
	const tags = new Set(
		(current.tags ?? []).map((tag) => String(tag).toLowerCase()),
	);

	const scored = items
		.filter((item) => item.slug !== current.slug)
		.map((item) => {
			let score = 0;
			if (current.category && item.category === current.category) score += 3;
			for (const tag of item.tags ?? []) {
				if (tags.has(String(tag).toLowerCase())) score += 2;
			}
			return { item, score };
		})
		.filter((row) => row.score > 0)
		.sort((a, b) => b.score - a.score)
		.slice(0, Math.min(Math.max(Math.round(Number(limit) || 4), 1), 10));

	return scored.map((row) => row.item);
}

/** 一篇笔记喂给模型的纯文本（带标题、链接、提纲） */
export function noteAsContext(item, maxChars = 6000) {
	const outline =
		(item?.outline ?? []).length > 0
			? item.outline.map((point) => `- ${point}`).join("\n")
			: "（无小标题）";
	const body = String(item?.text ?? "").slice(0, maxChars);

	return [
		`标题：${item?.title ?? ""}`,
		`链接：${item?.url ?? ""}`,
		`分类：${item?.category || "未分类"}${(item?.tags ?? []).length ? `　标签：${item.tags.join("、")}` : ""}`,
		"",
		"要点提纲：",
		outline,
		"",
		"正文：",
		body,
	]
		.filter((line) => line !== undefined)
		.join("\n");
}
