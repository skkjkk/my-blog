import { initStatsBoard } from "../core/board";

/** 数据台 · 概览：今天怎么样，先看这一页 */
export function initOverviewBoard(): boolean {
	return initStatsBoard({
		page: "overview",
		spans: {
			kpis: 12,
			trend: 8,
			funnel: 4,
			calendar: 8,
			pages: 4,
		},
	});
}
