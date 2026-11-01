/** 结构性图形：热力图、漏斗、直方图。这三种最能体现"产品分析"的味道。 */

import { esc, fmtNum, ms } from "../core/dom";

const WEEKDAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

type HeatData = {
	cells: { dow: number; hour: number; count: number }[];
	max: number;
};

/** 星期 × 小时热力图 */
export function drawHeatmap(el: HTMLElement, data: HeatData): void {
	const cells = data.cells ?? [];
	const max = Math.max(1, data.max ?? 0);
	const total = cells.reduce((acc, cell) => acc + cell.count, 0);
	if (total === 0) {
		el.innerHTML = `<p class="empty">还没有数据</p>`;
		return;
	}

	const map = new Map(
		cells.map((cell) => [`${cell.dow}-${cell.hour}`, cell.count]),
	);
	const rows = WEEKDAYS.map((name, dow) => {
		const cols = Array.from({ length: 24 }, (_, hour) => {
			const count = map.get(`${dow}-${hour}`) ?? 0;
			const level = count === 0 ? 0 : Math.min(4, Math.ceil((count / max) * 4));
			return `<i class="hm lv${level}" title="${name} ${hour}:00 · ${count} 次"></i>`;
		}).join("");
		return `<div class="hrow"><span class="hlab">${name}</span><div class="hcell">${cols}</div></div>`;
	}).join("");

	const hours = [0, 6, 12, 18]
		.map(
			(hour) =>
				`<span style="grid-column:${hour + 2} / span 2">${hour}:00</span>`,
		)
		.join("");

	el.innerHTML = `<div class="heat">
		${rows}
		<div class="haxis"><span class="hlab"></span><div class="hgrid">${hours}</div></div>
	</div>`;
}

type FunnelStep = {
	key: string;
	label: string;
	value: number;
	rate: number;
	stepRate: number;
};

/** 转化漏斗：每级带「相对首级」和「相对上一级」两个数 */
export function drawFunnel(
	el: HTMLElement,
	data: { steps: FunnelStep[] },
): void {
	const steps = data.steps ?? [];
	const first = steps[0]?.value ?? 0;
	if (first === 0) {
		el.innerHTML = `<p class="empty">这个区间还没有访问数据</p>`;
		return;
	}

	el.innerHTML = `<div class="funnel">${steps
		.map((step, index) => {
			const width = Math.max(2, Math.round((step.value / first) * 100));
			const loss = index === 0 ? null : steps[index - 1].value - step.value;
			return `<div class="fstep">
				<div class="fmeta">
					<span class="flabel">${esc(step.label)}</span>
					<span class="fvalue">${fmtNum(step.value)}<em>${step.rate}%</em></span>
				</div>
				<div class="ftrack"><i style="width:${width}%" data-i="${index}"></i></div>
				${loss !== null && loss > 0 ? `<span class="floss">−${fmtNum(loss)} 流失</span>` : ""}
			</div>`;
		})
		.join("")}</div>`;
}

type HistData = {
	buckets: { label: string; count: number }[];
	marks?: { label: string; value: number }[];
	unit?: string;
};

/** 直方图：分布形状比平均值有信息量得多 */
export function drawHistogram(el: HTMLElement, data: HistData): void {
	const buckets = data.buckets ?? [];
	const total = buckets.reduce((acc, bucket) => acc + bucket.count, 0);
	if (total === 0) {
		el.innerHTML = `<p class="empty">还没有成功的回答</p>`;
		return;
	}

	const W = Math.max(260, Math.round(el.clientWidth || 420));
	const H = 168;
	const L = 26;
	const B = 26;
	const T = 18;
	const plotH = H - T - B;
	const slot = (W - L - 8) / buckets.length;
	const max = Math.max(1, ...buckets.map((bucket) => bucket.count));

	const bars = buckets
		.map((bucket, index) => {
			const h = (bucket.count / max) * plotH;
			const x = L + index * slot + slot * 0.14;
			const w = slot * 0.72;
			const y = T + plotH - h;
			return `<rect class="bar" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${Math.max(0, h).toFixed(1)}" rx="2">
				<title>${esc(bucket.label)}ms · ${bucket.count} 次</title></rect>
				<text class="num" x="${(x + w / 2).toFixed(1)}" y="${(y - 4).toFixed(1)}" text-anchor="middle">${bucket.count}</text>
				<text class="ax" x="${(x + w / 2).toFixed(1)}" y="${H - 8}" text-anchor="middle">${esc(bucket.label)}</text>`;
		})
		.join("");

	const marks = (data.marks ?? [])
		.map(
			(mark) =>
				`<span class="mark"><em>${esc(mark.label)}</em>${ms(mark.value)}</span>`,
		)
		.join("");

	el.innerHTML = `<div class="marks">${marks}</div>
		<svg class="chart" viewBox="0 0 ${W} ${H}" role="img">${bars}</svg>`;
}
