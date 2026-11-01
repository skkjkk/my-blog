import { initStatsBoard } from "../core/board";

/** 数据台 · 参与：他们做了什么——搜什么、问什么、刷什么、评什么 */
export function initEngagementBoard(): boolean {
	return initStatsBoard({
		page: "engagement",
		spans: {
			kpis: 12,
			depth: 4,
			composition: 4,
			quiz: 4,
			searches: 6,
			zeroSearch: 6,
		},
	});
}
