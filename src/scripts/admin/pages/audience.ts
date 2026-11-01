import { initStatsBoard } from "../core/board";

/** 数据台 · 受众：谁在来、什么时候来、还回不回来 */
export function initAudienceBoard(): boolean {
	return initStatsBoard({
		page: "audience",
		spans: {
			kpis: 12,
			trend: 8,
			heatmap: 4,
			hours: 4,
			keep: 4,
			mix: 4,
			pages: 8,
		},
	});
}
