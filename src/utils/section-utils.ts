import { getSortedPosts } from "./content-utils";
import { getPostUrl } from "./url-utils";

/** 笔记在目录/首页里的最小信息 */
export type NoteItem = {
	title: string;
	url: string;
	category: string;
	tags: string[];
	date: Date;
	words: number;
};

export type NoteGroup = {
	/** 子标签，没有子标签时为空字符串 */
	tag: string;
	items: NoteItem[];
};

export type NoteCategory = {
	id: string;
	name: string;
	count: number;
	/** 按子标签（如 Java 下的 基础 / 集合 / 并发编程 / JVM）分组 */
	groups: NoteGroup[];
	/** 最近更新的几题，给首页卡片用 */
	recent: NoteItem[];
};

export type NoteIndex = {
	total: number;
	words: number;
	categories: NoteCategory[];
	latest: NoteItem[];
};

/** 分类 → URL 锚点 id（给 /notes/#cat-java 这类链接用） */
const CATEGORY_IDS: Record<string, string> = {
	Java: "java",
	数据库: "database",
	"Agent与LLM应用": "agent-llm",
	计算机网络: "network",
	系统设计: "system-design",
	操作系统: "os",
	算法与数据结构: "algorithm",
	站务: "meta",
};

/** 这些标签对所有笔记都成立，分组时忽略 */
const NOISE_TAGS = new Set(["面试"]);

export async function getNoteIndex(): Promise<NoteIndex> {
	const posts = await getSortedPosts();

	const items: NoteItem[] = posts
		.filter((post) => !post.data.draft && post.data.section === "note")
		.map((post) => ({
			title: post.data.title,
			url: getPostUrl({ title: post.data.title, slug: post.slug }),
			category: (post.data.category ?? "").trim(),
			tags: (post.data.tags ?? []).filter((t) => !NOISE_TAGS.has(t)),
			date: post.data.published,
			words: post.body ? post.body.trim().length : 0,
		}));

	const byCategory = new Map<string, NoteItem[]>();
	for (const item of items) {
		const key = item.category || "未分类";
		if (!byCategory.has(key)) byCategory.set(key, []);
		byCategory.get(key)?.push(item);
	}

	// 目录按标题排序（中文按拼音），比按日期更好翻查
	const byTitle = (a: NoteItem, b: NoteItem) =>
		a.title.localeCompare(b.title, "zh-Hans-CN");

	const categories: NoteCategory[] = [...byCategory.entries()]
		.sort((a, b) => b[1].length - a[1].length)
		.map(([name, list], index) => {
			const byTag = new Map<string, NoteItem[]>();
			for (const item of list) {
				const tag = item.tags[0] ?? "";
				if (!byTag.has(tag)) byTag.set(tag, []);
				byTag.get(tag)?.push(item);
			}
			const groups: NoteGroup[] = [...byTag.entries()]
				.sort((a, b) => b[1].length - a[1].length)
				.map(([tag, groupItems]) => ({ tag, items: [...groupItems].sort(byTitle) }));

			return {
				id: CATEGORY_IDS[name] ?? `cat-${index + 1}`,
				name,
				count: list.length,
				groups,
				recent: list.slice(0, 3),
			};
		});

	return {
		total: items.length,
		words: items.reduce((sum, item) => sum + item.words, 0),
		categories,
		latest: items.slice(0, 10),
	};
}
