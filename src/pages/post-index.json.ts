import type { APIRoute } from "astro";
import { getSortedPosts } from "../utils/content-utils";
import { getPostUrlBySlug } from "../utils/url-utils";

/**
 * 生成 /post-index.json：所有已发布文章的标题 + 链接 + 摘要
 * 给右下角 AI 问答当「站点目录」用——有人问"你写了什么"时，模型能看到全貌，
 * 而不是只靠关键词检索到的那一两段。
 */
export const GET: APIRoute = async () => {
	const posts = await getSortedPosts();
	const data = posts
		.filter((post) => !post.data.draft)
		.map((post) => ({
			title: post.data.title,
			url: getPostUrlBySlug(post.slug),
			description: post.data.description ?? "",
		}));

	return new Response(JSON.stringify(data), {
		headers: { "content-type": "application/json; charset=utf-8" },
	});
};
