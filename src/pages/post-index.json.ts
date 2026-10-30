import type { APIRoute } from "astro";
import { getSortedPosts } from "../utils/content-utils";
import { getPostUrlBySlug } from "../utils/url-utils";
import { formatDateToYYYYMMDD } from "../utils/date-utils";

/**
 * 生成 /post-index.json：所有已发布文章的元信息
 * 用途：① 右下角 AI 问答的「站点目录」 ② 后台 dashboard 统计文章/标签/分类数量
 */
export const GET: APIRoute = async () => {
	const posts = await getSortedPosts();
	const data = posts
		.filter((post) => !post.data.draft)
		.map((post) => ({
			title: post.data.title,
			url: getPostUrlBySlug(post.slug),
			description: post.data.description ?? "",
			tags: post.data.tags ?? [],
			category: post.data.category ?? "",
			published: post.data.published ? formatDateToYYYYMMDD(post.data.published) : "",
			words: post.body ? post.body.trim().length : 0,
		}));

	return new Response(JSON.stringify(data), {
		headers: { "content-type": "application/json; charset=utf-8" },
	});
};
