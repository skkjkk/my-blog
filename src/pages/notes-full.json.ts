import type { APIRoute } from "astro";
import { getSortedPosts } from "../utils/content-utils";
import { postUrlSlug } from "../utils/post-slug";
import { extractQuizAnswer, NOISE_TAGS, toPlainText } from "../utils/quiz-utils";
import { getPostUrl } from "../utils/url-utils";

/** 正文最多留多少字给检索用，够用又不至于把索引撑到几 MB */
const MAX_TEXT = 6000;

/**
 * 生成 /notes-full.json：题库的全文（纯文本），供 /mcp 的检索与读取工具使用
 *
 * 为什么单独一个文件：/quiz-index.json 只有「速览答案」，做问答检索不够；
 * 而 Worker 运行时读不到 markdown 源文件，只能从这里拿。
 */
export const GET: APIRoute = async () => {
	const posts = await getSortedPosts();

	const items = posts
		.filter((post) => !post.data.draft)
		.map((post) => {
			const body = typeof post.body === "string" ? post.body : String(post.body ?? "");
			const { outline } = extractQuizAnswer(body, { minAnswerChars: 0, maxAnswerChars: 0 });

			return {
				slug: postUrlSlug({ title: post.data.title, slug: post.slug }),
				url: getPostUrl({ title: post.data.title, slug: post.slug }),
				title: post.data.title,
				category: (post.data.category ?? "").trim(),
				tags: (post.data.tags ?? []).filter((tag) => !NOISE_TAGS.has(tag)),
				section: post.data.section ?? "post",
				outline,
				text: toPlainText(body).slice(0, MAX_TEXT),
			};
		});

	return new Response(JSON.stringify({ generatedAt: new Date().toISOString(), total: items.length, items }), {
		headers: { "content-type": "application/json; charset=utf-8" },
	});
};
