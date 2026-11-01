/** 基础图形：趋势（柱+线）、横条分布、环图。全部手写 SVG / HTML，无依赖。 */

import { esc, fmtNum } from "../core/dom";

type AreaData = {
	labels: string[];
	bars: number[];
	line: number[];
	barLabel?: string;
	lineLabel?: string;
};

/** 柱：提问数　线：活跃用户 */
export function drawArea(el: HTMLElement, data: AreaData): void {
	const labels = data.labels ?? [];
	if (labels.length === 0) {
		el.innerHTML = `<p class="empty">还没有数据</p>`;
		return;
	}

	const W = Math.max(280, Math.round(el.clientWidth || 640));
	const H = W < 520 ? 190 : 230;
	const L = 30;
	const R = 30;
	const T = 12;
	const B = 24;
	const plotW = W - L - R;
	const plotH = H - T - B;

	const bars = data.bars ?? [];
	const line = data.line ?? [];
	const maxBar = Math.max(4, ...bars);
	const maxLine = Math.max(2, ...line);
	const slot = plotW / labels.length;
	const barW = Math.max(3, Math.min(22, slot * 0.56));

	const grid = [0, 0.5, 1]
		.map((ratio) => {
			const y = T + ratio * plotH;
			const value = Math.round(maxBar * (1 - ratio));
			// 右侧留给「线」那组数字，否则两条不同量纲的序列会被误读成同一个刻度
			const right =
				line.length > 0
					? `<text class="ax-r" x="${W - R + 6}" y="${(y + 3).toFixed(1)}">${Math.round(maxLine * (1 - ratio))}</text>`
					: "";
			return `<line class="gl" x1="${L}" y1="${y.toFixed(1)}" x2="${W - R}" y2="${y.toFixed(1)}" />
				<text class="ax" x="${L - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end">${value}</text>${right}`;
		})
		.join("");

	const rects = bars
		.map((value, index) => {
			const h = (value / maxBar) * plotH;
			const x = L + index * slot + (slot - barW) / 2;
			const y = T + plotH - h;
			return `<rect class="bar" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(
				0,
				h,
			).toFixed(
				1,
			)}" rx="2"><title>${esc(labels[index])} · ${value}</title></rect>`;
		})
		.join("");

	const points = line.map((value, index) => {
		const x = L + index * slot + slot / 2;
		const y = T + plotH - (value / maxLine) * plotH;
		return { x, y, value };
	});
	const polyline =
		points.length > 1
			? `<polyline points="${points
					.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`)
					.join(
						" ",
					)}" fill="none" stroke="var(--alt)" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" />`
			: "";
	const dots = points
		.map(
			(point) =>
				`<circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="2.4" fill="var(--alt)"><title>${point.value} 人</title></circle>`,
		)
		.join("");

	const every = Math.max(1, Math.ceil(labels.length / (W < 520 ? 5 : 8)));
	const ticks = labels
		.map((label, index) => {
			if (index % every !== 0 && index !== labels.length - 1) return "";
			const x = L + index * slot + slot / 2;
			return `<text class="ax" x="${x.toFixed(1)}" y="${H - 6}" text-anchor="middle">${esc(label.slice(5))}</text>`;
		})
		.join("");

	el.innerHTML = `
		<div class="legend">
			<span><i style="background:var(--c2)"></i>${esc(data.barLabel ?? "数量")}</span>
			${data.lineLabel ? `<span><i style="background:var(--alt)"></i>${esc(data.lineLabel)}</span>` : ""}
		</div>
		<svg class="chart" viewBox="0 0 ${W} ${H}" role="img">
			${grid}${rects}${polyline}${dots}${ticks}
		</svg>`;
}

type BarRow = { label: string; count: number; hint?: string };

/** 横向条：各类分布（会话深度 / 用户分层 / 留存 / 失败原因） */
export function drawBars(el: HTMLElement, data: { rows: BarRow[] }): void {
	const rows = data.rows ?? [];
	const total = rows.reduce((acc, row) => acc + (Number(row.count) || 0), 0);
	if (total === 0) {
		el.innerHTML = `<p class="empty">还没有数据</p>`;
		return;
	}
	const max = Math.max(1, ...rows.map((row) => Number(row.count) || 0));

	el.innerHTML = `<div class="blist">${rows
		.map((row) => {
			const count = Number(row.count) || 0;
			const ratio = total > 0 ? Math.round((count / total) * 100) : 0;
			return `<div class="brow">
				<span class="blabel" title="${esc(row.label)}">${esc(row.label)}</span>
				<span class="btrack"><i data-w="${Math.round((count / max) * 100)}"></i></span>
				<span class="bval">${fmtNum(count)}${row.hint ? `<em>${esc(row.hint)}</em>` : ratio > 0 ? `<em>${ratio}%</em>` : ""}</span>
			</div>`;
		})
		.join("")}</div>`;

	requestAnimationFrame(() => {
		for (const bar of el.querySelectorAll<HTMLElement>(".btrack i"))
			bar.style.width = `${bar.dataset.w ?? 0}%`;
	});
}

type Row = { label: string; count: number };

const DONUT_COLORS = [
	"var(--c1)",
	"var(--c2)",
	"var(--c3)",
	"var(--c4)",
	"var(--c5)",
	"var(--alt)",
	"var(--c6)",
];

/** 环图 + 图例（模型分布这类「占比」问题） */
export function drawDonut(
	el: HTMLElement,
	data: { rows: Row[]; unit?: string },
): void {
	const rows = (data.rows ?? []).filter((row) => Number(row.count) > 0);
	const total = rows.reduce((acc, row) => acc + Number(row.count), 0);
	if (total === 0) {
		el.innerHTML = `<p class="empty">还没有数据</p>`;
		return;
	}

	const R = 58;
	const C = 2 * Math.PI * R;
	let offset = 0;
	const arcs = rows
		.map((row, index) => {
			const share = Number(row.count) / total;
			const dash = share * C;
			const gap = Math.min(3, dash * 0.12);
			const arc = `<circle cx="80" cy="80" r="${R}" fill="none" stroke="${DONUT_COLORS[index % DONUT_COLORS.length]}"
				stroke-width="20" stroke-dasharray="${Math.max(0, dash - gap).toFixed(2)} ${(C - dash + gap).toFixed(2)}"
				stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 80 80)"><title>${esc(row.label)} · ${row.count}</title></circle>`;
			offset += dash;
			return arc;
		})
		.join("");

	const legend = rows
		.map((row, index) => {
			const share = Math.round((Number(row.count) / total) * 100);
			return `<li><i style="background:${DONUT_COLORS[index % DONUT_COLORS.length]}"></i>
				<span>${esc(row.label)}</span><b>${share}%</b></li>`;
		})
		.join("");

	el.innerHTML = `<div class="donut-wrap">
		<svg viewBox="0 0 160 160" class="donut" role="img">${arcs}
			<text x="80" y="78" text-anchor="middle" class="dn">${fmtNum(total)}</text>
			<text x="80" y="94" text-anchor="middle" class="ds">${esc(data.unit ?? "次提问")}</text>
		</svg>
		<ul class="donut-legend">${legend}</ul>
	</div>`;
}

type ScatterPoint = { x: number; y: number; label: string };

/** 散点：字数 × 阅读次数——长文章到底有没有人看 */
export function drawScatter(
	el: HTMLElement,
	data: { points: ScatterPoint[]; xLabel?: string; yLabel?: string },
): void {
	const points = (data.points ?? []).filter(
		(point) => Number.isFinite(point.x) && Number.isFinite(point.y),
	);
	if (points.length === 0) {
		el.innerHTML = `<p class="empty">还没有数据</p>`;
		return;
	}

	const W = Math.max(240, Math.round(el.clientWidth || 320));
	const H = 200;
	const L = 34;
	const R = 12;
	const T = 10;
	const B = 28;
	const plotW = W - L - R;
	const plotH = H - T - B;

	const maxX = Math.max(...points.map((point) => point.x), 1);
	const maxY = Math.max(...points.map((point) => point.y), 1);
	const xOf = (value: number) => L + (value / maxX) * plotW;
	const yOf = (value: number) => T + plotH - (value / maxY) * plotH;

	const grid = [0, 0.5, 1]
		.map((ratio) => {
			const y = T + ratio * plotH;
			return `<line class="gl" x1="${L}" y1="${y.toFixed(1)}" x2="${W - R}" y2="${y.toFixed(1)}" />
				<text class="ax" x="${L - 5}" y="${(y + 3).toFixed(1)}" text-anchor="end">${Math.round(maxY * (1 - ratio))}</text>`;
		})
		.join("");

	const dots = points
		.map(
			(point) =>
				`<circle cx="${xOf(point.x).toFixed(1)}" cy="${yOf(point.y).toFixed(1)}" r="3" fill="var(--c2)" opacity="0.75">
					<title>${point.label} · ${Math.round(point.x)} 字 · ${Math.round(point.y)} 次阅读</title></circle>`,
		)
		.join("");

	el.innerHTML = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img">
			${grid}${dots}
			<text class="ax" x="${(L + plotW / 2).toFixed(1)}" y="${H - 8}" text-anchor="middle">${data.xLabel ?? "字数"}</text>
		</svg>`;
}
