/** 数据台前端小工具：全部是无依赖的纯函数，任何页面都能用 */

export const $ = <T extends Element = HTMLElement>(
	sel: string,
	root: ParentNode = document,
) => root.querySelector(sel) as T | null;

export const $$ = <T extends Element = HTMLElement>(
	sel: string,
	root: ParentNode = document,
) => Array.from(root.querySelectorAll(sel)) as T[];

export const esc = (text: unknown) =>
	String(text ?? "").replace(
		/[<>&"]/g,
		(char) =>
			({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[char] ?? char,
	);

export const fmtNum = (value: number) =>
	Number.isFinite(value) ? Math.round(value).toLocaleString("zh-CN") : "—";

export const pad = (value: number) => String(value).padStart(2, "0");

export const sum = (values: number[]) =>
	values.reduce((acc, value) => acc + (Number(value) || 0), 0);

/** 大数字滚动一下，进入视野时更有"活起来"的感觉 */
export function countUp(node: HTMLElement, target: number, decimals = 0): void {
	const duration = 620;
	const start = performance.now();
	const to = Number(target) || 0;
	function step(now: number) {
		const progress = Math.min(1, (now - start) / duration);
		const eased = 1 - (1 - progress) ** 3;
		if (decimals > 0) node.textContent = (to * eased).toFixed(decimals);
		else node.textContent = fmtNum(to * eased);
		if (progress < 1) requestAnimationFrame(step);
	}
	if (to === 0) {
		node.textContent = decimals > 0 ? (0).toFixed(decimals) : "0";
		return;
	}
	requestAnimationFrame(step);
}

/** 迷你折线（KPI 卡右下角那种） */
export function spark(values: number[], color = "var(--c2)"): string {
	const list = (values ?? []).map((value) => Number(value) || 0);
	const max = Math.max(1, ...list);
	const count = Math.max(2, list.length);
	const points = list.map((value, index) => {
		const x = (index / (count - 1)) * 100;
		const y = 24 - (value / max) * 20;
		return `${x.toFixed(1)},${y.toFixed(1)}`;
	});
	if (points.length < 2) points.push("100,24");
	const area = `0,26 ${points.join(" ")} 100,26`;
	return `<svg class="spark" viewBox="0 0 100 26" preserveAspectRatio="none" aria-hidden="true">
		<polyline points="${area}" fill="${color}" opacity="0.1" stroke="none" />
		<polyline points="${points.join(" ")}" fill="none" stroke="${color}" stroke-width="1.7"
			vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round" />
	</svg>`;
}

/** 把秒级时间戳格式化成 11/01 17:23 */
export function shortTime(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return "—";
	return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 毫秒 → 人类可读（820ms / 3.4s / 1m12s） */
export function ms(value: number): string {
	const n = Number(value) || 0;
	if (n <= 0) return "—";
	if (n < 1000) return `${Math.round(n)}ms`;
	if (n < 60_000) return `${(n / 1000).toFixed(1)}s`;
	return `${Math.floor(n / 60_000)}m${pad(Math.round((n % 60_000) / 1000))}s`;
}

/** 「+12.3% / -4%」这种涨跌标签；null 表示上期没有可比数据 */
export function deltaTag(value: number | null, suffix = " vs 上期"): string {
	if (value === null)
		return `<span class="flat" title="这个区间之前还没有数据">—</span>`;
	if (!Number.isFinite(value) || value === 0)
		return `<span class="flat">持平${suffix}</span>`;
	const cls = value > 0 ? "up" : "down";
	const arrow = value > 0 ? "▲" : "▼";
	return `<span class="${cls}">${arrow} ${Math.abs(value).toFixed(1)}%</span>${suffix}`;
}
