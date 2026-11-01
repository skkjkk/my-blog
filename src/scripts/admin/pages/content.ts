import { drawDonut, drawScatter } from "../charts/plots";
import { cardShell, initStatsBoard, loadPosts } from "../core/board";

type TableRow = (string | number)[];

const slugOf = (url: string) =>
	String(url ?? "")
		.replace(/^\/posts\//, "")
		.replace(/\/$/, "");

/**
 * 数据台 · 内容：文章表现 + 写作节奏 + 标签分布 + 字数×阅读。
 * 后两张卡要读 /post-index.json（文章字数、标签只在构建产物里），所以在客户端补。
 */
export function initContentBoard(): boolean {
	return initStatsBoard({
		page: "content",
		spans: { table: 12, views: 6, quiz: 6 },
		extend: async (board, payload) => {
			const posts = await loadPosts();
			const bySlug = new Map(
				Array.from(posts.entries()).map(([url, meta]) => [slugOf(url), meta]),
			);

			// 标签分布：只取前 6，剩下的合并成「其他」
			const counter = new Map<string, number>();
			for (const meta of posts.values()) {
				for (const tag of meta.tags)
					counter.set(tag, (counter.get(tag) ?? 0) + 1);
			}
			const entries = Array.from(counter.entries()).sort((a, b) => b[1] - a[1]);
			const top = entries
				.slice(0, 6)
				.map(([label, count]) => ({ label, count }));
			const rest = entries.slice(6).reduce((acc, [, count]) => acc + count, 0);
			if (rest > 0) top.push({ label: "其他", count: rest });

			const tagCard = cardShell("标签分布", `${entries.length} 个标签`, 6);
			board.appendChild(tagCard.section);
			drawDonut(tagCard.body, { rows: top, unit: "个标签" });

			// 字数 × 阅读：长文章到底有没有人看
			const table = payload.cards.find((card) => card.id === "table");
			const rows = (table?.data.rows ?? []) as TableRow[];
			const points = rows
				.map((row) => {
					const meta = bySlug.get(String(row[0]));
					return {
						x: Number(meta?.words ?? 0),
						y: Number(row[1]) || 0,
						label: meta?.title ?? String(row[0]),
					};
				})
				.filter((point) => point.x > 0);

			const scatterCard = cardShell("字数与阅读", "长文章有没有人看", 6);
			board.appendChild(scatterCard.section);
			drawScatter(scatterCard.body, { points, xLabel: "字数", yLabel: "阅读" });
		},
	});
}
