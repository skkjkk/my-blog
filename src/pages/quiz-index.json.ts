import type { APIRoute } from "astro";
import { getSortedPosts } from "../utils/content-utils";
import { postUrlSlug } from "../utils/post-slug";
import { extractQuizCard, NOISE_TAGS } from "../utils/quiz-utils";
import { getPostUrl } from "../utils/url-utils";

/**
 * 生成 /quiz-index.json：题库（section === "note"）的全量刷题数据
 * 用途：① /quiz/ 刷题页的本地题库 ② 数据台的题目标记榜 ③ MCP 的 search 工具
 *
 * 每条是一张「自测卡」：结论 + 要点（带一句展开）+ 常见追问 + 易错点 + 一句话记住。
 * 结构来自 docs/note-standard.md，笔记按那个骨架写，这里就自动答得完整。
 * 144 篇压下来约 300KB，一次拉走、离线可刷。
 */
export const GET: APIRoute = async () => {
	const posts = await getSortedPosts();

	const items = posts
		.filter((post) => !post.data.draft && post.data.section === "note")
		.map((post) => {
			const body = typeof post.body === "string" ? post.body : String(post.body ?? "");
			const card = extractQuizCard(body);

			return {
				slug: postUrlSlug({ title: post.data.title, slug: post.slug }),
				url: getPostUrl({ title: post.data.title, slug: post.slug }),
				title: post.data.title,
				category: (post.data.category ?? "").trim(),
				tags: (post.data.tags ?? []).filter((tag) => !NOISE_TAGS.has(tag)),
				words: body ? body.trim().length : 0,
				...card,
			};
		});

	return new Response(
		JSON.stringify({
			generatedAt: new Date().toISOString(),
			total: items.length,
			items,
		}),
		{
			headers: { "content-type": "application/json; charset=utf-8" },
		},
	);
};
