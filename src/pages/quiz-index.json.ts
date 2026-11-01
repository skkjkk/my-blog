import type { APIRoute } from "astro";
import { getSortedPosts } from "../utils/content-utils";
import { postUrlSlug } from "../utils/post-slug";
import { extractQuizAnswer, NOISE_TAGS } from "../utils/quiz-utils";
import { getPostUrl } from "../utils/url-utils";

/**
 * 生成 /quiz-index.json：题库（section === "note"）的全量刷题数据
 * 用途：① /quiz/ 刷题页的本地题库 ② 数据台的题目标记榜 ③ MCP 的 search 工具
 *
 * 每条都带「速览答案」和「要点提纲」，前端不再需要请求原文，
 * 144 篇压下来约 100KB，一次拉走、离线可刷。
 */
export const GET: APIRoute = async () => {
	const posts = await getSortedPosts();

	const items = posts
		.filter((post) => !post.data.draft && post.data.section === "note")
		.map((post) => {
			const { answer, outline } = extractQuizAnswer(
				typeof post.body === "string" ? post.body : String(post.body ?? ""),
			);

			return {
				slug: postUrlSlug({ title: post.data.title, slug: post.slug }),
				url: getPostUrl({ title: post.data.title, slug: post.slug }),
				title: post.data.title,
				category: (post.data.category ?? "").trim(),
				tags: (post.data.tags ?? []).filter((tag) => !NOISE_TAGS.has(tag)),
				words: post.body ? post.body.trim().length : 0,
				answer,
				outline,
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
