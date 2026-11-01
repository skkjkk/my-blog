/**
 * 通用「卡片看板」：一个页面只要给个 page 名，剩下的全在这里。
 *
 *   initStatsBoard({ page: "audience" })
 *
 * 后端返回什么卡片就画什么卡片——这也是为什么加指标不用动前端。
 * 需要客户端补数据（比如拿 /post-index.json 合并文章字数）时传 extend。
 */

import {
	drawCalendar,
	drawFunnel,
	drawHeatmap,
	drawHistogram,
} from "../charts/matrix";
import { drawArea, drawBars, drawDonut, drawScatter } from "../charts/plots";
import { drawKpi, drawLog, drawRank, drawTable } from "../widgets/cards";
import { fetchStats, type StatCard, type StatsPayload } from "./api";
import { $, esc } from "./dom";
import { initShell, type LoadResult } from "./shell";

export type BoardOptions = {
	page: string;
	/** 卡片 id → 栅格宽度（12 栅格制），缺省按 kind 猜 */
	spans?: Record<string, number>;
	/** 服务端卡片画完之后追加客户端卡片（例如需要读 /post-index.json 的图表） */
	extend?: (board: HTMLElement, payload: StatsPayload) => void | Promise<void>;
};

const KIND_SPAN: Record<string, number> = {
	kpi: 12,
	area: 8,
	funnel: 4,
	heatmap: 4,
	histogram: 4,
	calendar: 12,
	bars: 6,
	donut: 6,
	table: 6,
	rank: 6,
	log: 12,
	scatter: 6,
};

let postIndex: Map<
	string,
	{ title: string; words: number; tags: string[]; category: string }
> | null = null;

type PostMeta = {
	url?: string;
	title?: string;
	words?: number;
	tags?: string[];
	category?: string;
};

export async function loadPosts(): Promise<
	Map<
		string,
		{ title: string; words: number; tags: string[]; category: string }
	>
> {
	if (postIndex) return postIndex;
	try {
		const list = (await (await fetch("/post-index.json")).json()) as PostMeta[];
		postIndex = new Map(
			(list ?? [])
				.filter((item) => item.url)
				.map((item) => [
					String(item.url),
					{
						title: String(item.title ?? ""),
						words: Number(item.words ?? 0),
						tags: item.tags ?? [],
						category: String(item.category ?? ""),
					},
				]),
		);
	} catch {
		postIndex = new Map();
	}
	return postIndex;
}

const resolveTitle = (path: string) =>
	postIndex?.get(path)?.title ||
	String(path ?? "")
		.replace(/^\/posts\//, "")
		.replace(/\/$/, "");

/** 造一张卡片外壳，返回主体节点 */
export function cardShell(
	title: string,
	note = "",
	span = 6,
): { section: HTMLElement; body: HTMLElement } {
	const section = document.createElement("section");
	section.className = `card span-${span} col`;
	section.innerHTML = `<div class="card-head"><h2>${esc(title)}</h2>${
		note ? `<p class="card-note">${esc(note)}</p>` : ""
	}</div>`;
	const body = document.createElement("div");
	body.className = "card-body";
	section.appendChild(body);
	return { section, body };
}

function build(
	card: StatCard,
	spans: Record<string, number>,
): { node: HTMLElement; draw: () => void } {
	const span = spans[card.id] ?? KIND_SPAN[card.kind] ?? 6;

	if (card.kind === "kpi") {
		const grid = document.createElement("div");
		grid.className = "kpi-grid";
		return {
			node: grid,
			draw: () => drawKpi(grid, (card.data.items ?? []) as never),
		};
	}

	const section = document.createElement("section");
	section.className = `card span-${span} col`;
	section.dataset.card = card.id;
	section.innerHTML = `<div class="card-head"><h2>${esc(card.title ?? card.id)}</h2>${
		card.note ? `<p class="card-note">${esc(card.note)}</p>` : ""
	}</div>`;
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
			case "calendar":
				drawCalendar(body, card.data as never);
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
				drawRank(body, card.data as never, resolveTitle);
				break;
			case "log":
				drawLog(body, card.data as never, resolveTitle);
				break;
			case "scatter":
				drawScatter(body, card.data as never);
				break;
			default:
				body.innerHTML = `<p class="empty">未知卡片类型：${esc(card.kind)}</p>`;
		}
	};

	return { node: section, draw };
}

let last: StatsPayload | null = null;

export function initStatsBoard(options: BoardOptions): boolean {
	const board = $(`#${options.page}-board`);
	if (!board) return false;

	const spans = options.spans ?? {};
	void loadPosts();

	const render = async (payload: StatsPayload) => {
		board.innerHTML = "";
		last = payload;

		if (!payload.coverage.since) {
			const notice = document.createElement("p");
			notice.className = "notice";
			notice.textContent =
				"事件埋点刚刚启用：漏斗、留存、访客数会从今天开始逐日累积，阅读量那几张卡不受影响。";
			board.appendChild(notice);
		}

		const draws: (() => void)[] = [];
		for (const card of payload.cards) {
			const { node, draw } = build(card, spans);
			board.appendChild(node);
			draws.push(draw);
		}
		for (const draw of draws) draw();

		if (options.extend) await options.extend(board, payload);
	};

	initShell({
		page: options.page,
		load: async (range): Promise<LoadResult> => {
			const result = await fetchStats(options.page, range);
			if (!result.ok) {
				if (result.reason === "unauth") return "unauth";
				board.innerHTML = `<p class="notice bad">${esc(result.message ?? "读取失败")}</p>`;
				return "error";
			}
			await render(result.data);
			return "ok";
		},
	});

	let timer = 0;
	window.addEventListener("resize", () => {
		window.clearTimeout(timer);
		timer = window.setTimeout(() => {
			if (last && board.isConnected) void render(last);
		}, 220);
	});

	return true;
}
