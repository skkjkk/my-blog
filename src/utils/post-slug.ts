import { postSlugs } from "../data/post-slugs";

/**
 * 文章 URL 段：优先按标题查表（src/data/post-slugs.ts），
 * 查不到就退回内容集合里的原始 slug（中文文件名）。
 *
 * 这样两种写法都安全：postUrlSlug({ title, slug }) 和 postUrlSlug({ slug })。
 */
export function postUrlSlug(post: { title?: string; slug?: string }): string {
	const title = post.title?.trim();
	if (title && postSlugs[title]) return postSlugs[title];
	const slug = post.slug ?? "";
	return postSlugs[slug] ?? slug;
}
