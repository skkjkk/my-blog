/**
 * 站点笔记索引：MCP Server 和 AI 问答共用。
 *
 * 数据源是构建产物 /notes-full.json（Astro 生成的全文纯文本），
 * Worker 运行时读不到 markdown 源文件，只能从这里拿。
 * 同一个 isolate 里只读一次，后面都走缓存。
 *
 * 检索不追求「向量库」：先把问题拆成中英文检索词，再按 360 字滑窗给段落打分。
 * 这样「怎么避免更新丢失」能命中写着「并发更新可能丢失」的段落，
 * 而不是要求正文里出现完整问句。
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

const STOP_PHRASES = [
	"请问",
	"请帮我",
	"帮我",
	"麻烦",
	"解释一下",
	"介绍一下",
	"说一下",
	"讲一下",
	"能不能",
	"可不可以",
	"什么是",
	"是什么",
	"有什么",
	"有些什么",
	"怎么样",
	"怎么",
	"如何",
	"为什么",
	"有哪些",
	"哪个",
	"是否",
	"以及",
	"相关",
	"一下",
	"区别",
	"对比",
	"比较",
	"原理",
	"作用",
	"机制",
	"实现方式",
	"解决方法",
	"解决方案",
];

const STOP_TERMS = new Set([
	"什么",
	"怎么",
	"如何",
	"为什么",
	"有什",
	"么缺",
	"哪些",
	"哪个",
	"可以",
	"是否",
	"以及",
	"相关",
	"一下",
	"区别",
	"对比",
	"比较",
	"问题",
	"内容",
	"东西",
	"时候",
]);

const PUNCT = /[\s，。！？、；：,.!?;:()（）[\]【】"“”'‘’`~…—\-_/\\|]+/;

function lower(value) {
	return String(value ?? "").toLowerCase();
}

/** 问题 → 检索词：英文标识符、中文词块和二字片段 */
export function queryTerms(query) {
	const raw = lower(query).trim();
	if (!raw) return [];

	let core = raw;
	for (const phrase of STOP_PHRASES) core = core.split(phrase).join(" ");

	const terms = new Set();
	for (const word of core.match(/[a-z][a-z0-9_+.#-]{1,}/g) ?? []) {
		if (!STOP_TERMS.has(word)) terms.add(word);
	}

	for (const run of core.match(/[\u4e00-\u9fff]{2,}/g) ?? []) {
		if (run.length <= 8) terms.add(run);
		for (let i = 0; i + 2 <= run.length; i += 1) {
			const term = run.slice(i, i + 2);
			if (!STOP_TERMS.has(term)) terms.add(term);
		}
	}

	return [...terms]
		.map((term) => term.trim())
		.filter((term) => term.length >= 2 && !STOP_TERMS.has(term))
		.slice(0, 32);
}

/** 把长正文切成有重叠的窗口，保证跨句子的关键词也能落在同一段 */
export function chunkText(text, size = 360, overlap = 90) {
	const source = String(text ?? "");
	if (!source) return [];
	if (source.length <= size) return [source];

	const chunks = [];
	let start = 0;
	while (start < source.length) {
		let end = Math.min(source.length, start + size);
		// 尽量在标点处断开，别把「更新丢失」切成「更新丢 / 失」
		if (end < source.length) {
			const tail = source.slice(start + Math.floor(size * 0.6), end);
			const mark = Math.max(
				tail.lastIndexOf("。"),
				tail.lastIndexOf("！"),
				tail.lastIndexOf("？"),
				tail.lastIndexOf("\n"),
				tail.lastIndexOf("；"),
			);
			if (mark >= 0)
				end = start + Math.floor(size * 0.6) + mark + 1;
		}
		const chunk = source.slice(start, end).trim();
		if (chunk) chunks.push(chunk);
		if (end >= source.length) break;
		start = Math.max(start + 1, end - overlap);
	}
	return chunks;
}

/** 标题、分类、标签这些结构化字段的命中权重最高 */
function metaText(item) {
	return lower(
		[item?.title, item?.category, ...(item?.tags ?? [])]
			.filter(Boolean)
			.join(" "),
	);
}

/**
 * 给一个窗口打分。返回 0 表示「这段不算命中」。
 * 规则：长问题至少命中两个词；四个词以上还要求覆盖率 30%，避免只中一个「的」就返回。
 */
export function scorePassage(passage, item, terms, fullQuery = "") {
	const text = lower(passage);
	const meta = metaText(item);
	let hits = 0;
	let score = 0;

	for (const term of terms) {
		let count = 0;
		let at = text.indexOf(term);
		while (at >= 0 && count < 3) {
			count += 1;
			at = text.indexOf(term, at + term.length);
		}
		if (!count) continue;

		hits += 1;
		score += term.length >= 4 ? 5 : 3;
		score += Math.min(count, 2) * 0.5;
		if (meta.includes(term)) score += 6;
	}

	if (!hits) return 0;
	const required = terms.length >= 3 ? 2 : 1;
	if (hits < required) return 0;
	const coverage = hits / terms.length;
	if (terms.length >= 4 && coverage < 0.3) return 0;

	const full = lower(fullQuery).trim();
	if (full.length >= 2 && text.includes(full)) score += 18;
	score += coverage * 12;

	return score;
}

/** 关键词打分：保留旧导出，MCP 与既有测试仍可调用 */
export function scoreItem(item, needle) {
	const terms = queryTerms(needle);
	if (terms.length === 0) return 0;
	const text = String(item?.text ?? "");
	const passages = chunkText(text);
	let best = 0;
	for (const passage of passages)
		best = Math.max(best, scorePassage(passage, item, terms, needle));
	return best;
}

/** 命中词附近取上下文；优先围绕第一个命中的检索词 */
export function snippet(item, keyword, passage = "") {
	const source = String(passage || item?.text || "");
	const terms = queryTerms(keyword);
	const lowered = lower(source);

	let index = -1;
	for (const term of terms) {
		index = lowered.indexOf(term);
		if (index >= 0) break;
	}
	if (index < 0) return source.slice(0, 220);

	const start = Math.max(0, index - 90);
	return `${start > 0 ? "…" : ""}${source.slice(start, start + 240)}${
		start + 240 < source.length ? "…" : ""
	}`;
}

/**
 * 检索：返回 [{ item, snippet, score }]，按相关度倒序。
 * 同一篇笔记只保留得分最高的那个窗口，避免一次搜索里出现五段同一篇文章。
 */
export function searchNotes(items, query, limit = 5) {
	const needle = String(query ?? "").trim();
	if (!needle) return [];

	const terms = queryTerms(needle);
	if (terms.length === 0) return [];

	const max = Math.min(Math.max(Math.round(Number(limit) || 5), 1), 20);
	const rows = [];

	for (const item of items) {
		const chunks = chunkText(String(item?.text ?? ""));
		let best = null;
		for (const chunk of chunks) {
			const score = scorePassage(chunk, item, terms, needle);
			if (!best || score > best.score) best = { chunk, score };
		}
		if (!best || best.score <= 0) continue;
		rows.push({
			item,
			passage: best.chunk,
			score: best.score,
		});
	}

	return rows
		.sort((a, b) => {
			if (b.score !== a.score) return b.score - a.score;
			return String(a.item?.title ?? "").localeCompare(
				String(b.item?.title ?? ""),
				"zh",
			);
		})
		.slice(0, max)
		.map((row) => ({
			item: row.item,
			score: row.score,
			snippet: snippet(row.item, query, row.passage),
		}));
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
export function noteAsContext(item, maxChars = 6000, ref = "") {
	const outline =
		(item?.outline ?? []).length > 0
			? item.outline.map((point) => `- ${point}`).join("\n")
			: "（无小标题）";
	const body = String(item?.text ?? "").slice(0, maxChars);

	return [
		ref ? `资料编号：${ref}` : "",
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
		.filter((line) => line !== "")
		.join("\n");
}

export { PUNCT };
