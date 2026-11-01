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

/** 阅读热度日历：20 周 × 7 天，一屏看完半年的节奏 */
export function drawCalendar(
	el: HTMLElement,
	data: { days: { day: string; count: number }[] },
): void {
	const map = new Map(
		(data.days ?? []).map((row) => [row.day, Number(row.count) || 0]),
	);
	const weeks = 20;
	const todayKey = new Date(Date.now() + 8 * 3600 * 1000)
		.toISOString()
		.slice(0, 10);
	const end = new Date(`${todayKey}T00:00:00Z`);
	const endDow = (end.getUTCDay() + 6) % 7; // 0 = 周一
	const lastMonday = new Date(end.getTime() - endDow * 86_400_000);
	const firstMonday = new Date(
		lastMonday.getTime() - (weeks - 1) * 7 * 86_400_000,
	);
	const max = Math.max(1, ...map.values());

	const cells: string[] = [];
	const labels = ["一", "", "三", "", "五", "", "日"];
	for (let dow = 0; dow < 7; dow++) {
		cells.push(`<div class="cal dow">${labels[dow]}</div>`);
		for (let w = 0; w < weeks; w++) {
			const day = new Date(firstMonday.getTime() + (w * 7 + dow) * 86_400_000)
				.toISOString()
				.slice(0, 10);
			const count = map.get(day) ?? 0;
			const ratio = count / max;
			const level =
				count === 0
					? 0
					: ratio > 0.7
						? 4
						: ratio > 0.45
							? 3
							: ratio > 0.2
								? 2
								: 1;
			const future = day > todayKey;
			cells.push(
				`<div class="cal${future ? "" : ` lv${level}`}"${future ? ' style="opacity:0.35"' : ""} title="${day} · ${count} 次阅读"></div>`,
			);
		}
	}

	const active = Array.from({ length: weeks * 7 }, (_, i) =>
		new Date(firstMonday.getTime() + i * 86_400_000).toISOString().slice(0, 10),
	).filter((day) => day <= todayKey && (map.get(day) ?? 0) > 0).length;

	el.innerHTML = `<div class="cal-board">${cells.join("")}</div>
		<div class="cal-legend"><span>少</span><i class="cal lv0"></i><i class="cal lv1"></i><i class="cal lv2"></i><i class="cal lv3"></i><i class="cal lv4"></i><span>多</span><span class="calhint">近 ${weeks} 周 · ${active} 天有人来访</span></div>`;
}
