/**
 * 数据台 · AI 页（v2 卡片式）
 *
 * 页面本身只有一句 <div id="ai-board">；结构、图表、空状态全按接口返回的 cards 生成。
 * 想加一张卡：后端加声明（worker/admin-stats.js），这里不用动——除非是新的 kind。
 */

import { drawFunnel, drawHeatmap, drawHistogram } from "../charts/matrix";
import { drawArea, drawBars, drawDonut } from "../charts/plots";
import { fetchStats, type StatCard, type StatsPayload } from "../core/api";
import { $, esc } from "../core/dom";
import { initShell, type LoadResult } from "../core/shell";
import { drawKpi, drawLog, drawRank, drawTable } from "../widgets/cards";

const SPANS: Record<string, number> = {
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
};

const KIND_SPAN: Record<string, number> = {
	kpi: 12,
	area: 8,
	funnel: 4,
	heatmap: 4,
	histogram: 4,
	bars: 6,
	donut: 6,
	table: 6,
	rank: 6,
	log: 12,
};

function titleMap(): Map<string, string> {
	return new Map();
}

let posts = titleMap();

async function loadPosts(): Promise<void> {
	try {
		const list = (await (await fetch("/post-index.json")).json()) as {
			url?: string;
			title?: string;
		}[];
		posts = new Map(
			(list ?? [])
				.filter((item) => item.url)
				.map((item) => [String(item.url), String(item.title ?? "")]),
		);
	} catch {
		posts = titleMap();
	}
}

const resolve = (path: string) =>
	posts.get(path) ??
	String(path ?? "")
		.replace(/^\/posts\//, "")
		.replace(/\/$/, "");

function build(card: StatCard): { node: HTMLElement; draw: () => void } {
	const span = SPANS[card.id] ?? KIND_SPAN[card.kind] ?? 6;

	if (card.kind === "kpi") {
		const grid = document.createElement("div");
		grid.className = "kpi-grid span-12";
		return {
			node: grid,
			draw: () => drawKpi(grid, (card.data.items ?? []) as never),
		};
	}

	const section = document.createElement("section");
	section.className = `card span-${span} col`;
	section.dataset.card = card.id;
	section.innerHTML = `<div class="card-head">
		<h2>${esc(card.title ?? card.id)}</h2>
		${card.note ? `<p class="card-note">${esc(card.note)}</p>` : ""}
	</div>`;

	const body = document.createElement("div");
	body.className = "card-body";
	section.appendChild(body);

	const draw = () => {
		switch (card.kind) {
			case "area":
				drawArea(body, card.data as never);
				break;
			case "funnel":
				drawFunnel(body, card.data as never);
				break;
			case "heatmap":
				drawHeatmap(body, card.data as never);
				break;
			case "histogram":
				drawHistogram(body, card.data as never);
				break;
			case "bars":
				drawBars(body, card.data as never);
				break;
			case "donut":
				drawDonut(body, card.data as never);
				break;
			case "table":
				drawTable(body, card.data as never);
				break;
			case "rank":
				drawRank(body, card.data as never, resolve);
				break;
			case "log":
				drawLog(body, card.data as never, resolve);
				break;
			default:
				body.innerHTML = `<p class="empty">未知卡片类型：${esc(card.kind)}</p>`;
		}
	};

	return { node: section, draw };
}

let last: StatsPayload | null = null;

function render(board: HTMLElement, payload: StatsPayload): void {
	board.innerHTML = "";
	last = payload;

	if (!payload.coverage.since) {
		const notice = document.createElement("p");
		notice.className = "notice";
		notice.textContent =
			"事件埋点刚刚启用，数据会从今天开始逐日累积；漏斗和留存需要几天才有意义。";
		board.appendChild(notice);
	}

	const draws: (() => void)[] = [];
	for (const card of payload.cards) {
		const { node, draw } = build(card);
		board.appendChild(node);
		draws.push(draw);
	}
	for (const draw of draws) draw();
}

export function initAiBoard(): void {
	const board = $("#ai-board");
	if (!board) return;

	void loadPosts();

	initShell({
		page: "ai",
		load: async (range): Promise<LoadResult> => {
			const result = await fetchStats("ai", range);
			if (!result.ok) {
				if (result.reason === "unauth") return "unauth";
				board.innerHTML = `<p class="notice bad">${esc(result.message ?? "读取失败")}</p>`;
				return "error";
			}
			render(board, result.data);
			return "ok";
		},
	});

	// 图表宽度靠容器算，窗口变了重画一次就行
	let timer = 0;
	window.addEventListener("resize", () => {
		window.clearTimeout(timer);
		timer = window.setTimeout(() => {
			if (last && board.isConnected) render(board, last);
		}, 220);
	});
}
