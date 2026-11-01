/**
 * 数据台页面注册表。
 *
 * AdminLayout 只负责给出当前页名，具体初始化哪个模块在这里决定。
 * 用动态 import：评论页不会白下载一堆图表代码。
 */

type Init = () => boolean;

const ROUTES: Record<string, () => Promise<Init>> = {
	overview: () =>
		import("./pages/overview").then((mod) => mod.initOverviewBoard),
	audience: () =>
		import("./pages/audience").then((mod) => mod.initAudienceBoard),
	engagement: () =>
		import("./pages/engagement").then((mod) => mod.initEngagementBoard),
	content: () => import("./pages/content").then((mod) => mod.initContentBoard),
	ai: () => import("./pages/ai").then((mod) => mod.initAiBoard),
	comments: () =>
		import("./pages/comments").then((mod) => mod.initCommentsBoard),
};

export async function initAdminPage(page: string): Promise<boolean> {
	const load = ROUTES[page];
	if (!load) return false;
	const init = await load();
	return init();
}
