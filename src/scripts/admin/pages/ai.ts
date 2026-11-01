import { initStatsBoard } from "../core/board";

/** 数据台 · AI：谁在用、用得多深、答得够不够快、钱花在哪个模型上 */
export function initAiBoard(): boolean {
	return initStatsBoard({
		page: "ai",
		spans: {
			kpis: 12,
			trend: 8,
			tokens: 4,
			funnel: 4,
			latency: 4,
			heatmap: 4,
			depth: 4,
			tiers: 6,
			models: 6,
			modelTable: 6,
			keep: 6,
			errors: 6,
			topNotes: 6,
			zeroHits: 6,
			log: 12,
		},
	});
}
