/** 卡片内容渲染：KPI / 表格 / 排行榜 / 日志。 */

import {
	countUp,
	deltaTag,
	esc,
	fmtNum,
	ms,
	shortTime,
	spark,
} from "../core/dom";

type KpiItem = {
	key: string;
	label: string;
	value: number;
	unit?: string;
	decimals?: number;
	delta?: number | null;
	spark?: number[];
	note?: string;
};

export function drawKpi(el: HTMLElement, items: KpiItem[]): void {
	// 6 张卡按 3 列排比 4 列排更好看：最后一行不会剩两个孤零零的
	el.classList.toggle("cols-3", (items ?? []).length === 6);
	el.innerHTML = (items ?? [])
		.map((item) => {
			const decimals = item.decimals ?? 0;
			return `<div class="kpi">
				<p class="kpi-label" title="${esc(item.note ?? item.label)}">${esc(item.label)}</p>
				<p class="kpi-value"><span data-count="${Number(item.value) || 0}" data-decimals="${decimals}">0</span>${
					item.unit ? `<em>${esc(item.unit)}</em>` : ""
				}</p>
				<p class="kpi-extra">${deltaTag(item.delta ?? null)}</p>
				${spark(item.spark ?? [])}
			</div>`;
		})
		.join("");

	for (const node of Array.from(
		el.querySelectorAll<HTMLElement>("[data-count]"),
	)) {
		countUp(
			node,
			Number(node.dataset.count) || 0,
			Number(node.dataset.decimals) || 0,
		);
	}
}

export function drawTable(
	el: HTMLElement,
	data: { columns: string[]; rows: (string | number)[][] },
): void {
	const columns = data.columns ?? [];
	const rows = data.rows ?? [];
	if (rows.length === 0) {
		el.innerHTML = `<p class="empty">还没有数据</p>`;
		return;
	}
	el.innerHTML = `<div class="tbl-wrap"><table class="tbl">
		<thead><tr>${columns.map((column) => `<th>${esc(column)}</th>`).join("")}</tr></thead>
		<tbody>${rows
			.map(
				(row) =>
					`<tr>${row.map((cell, index) => `<td${index === 0 ? ' class="lead"' : ""}>${esc(cell)}</td>`).join("")}</tr>`,
			)
			.join("")}</tbody>
	</table></div>`;
}

type RankRow = { label: string; count: number; href?: string };

export function drawRank(
	el: HTMLElement,
	data: { rows: RankRow[]; text?: boolean },
	resolve?: (path: string) => string,
): void {
	const rows = data.rows ?? [];
	if (rows.length === 0) {
		el.innerHTML = `<p class="empty">还没有数据</p>`;
		return;
	}
	const max = Math.max(1, ...rows.map((row) => Number(row.count) || 0));

	el.innerHTML = `<ol class="rank">${rows
		.map((row, index) => {
			const label = row.href && resolve ? resolve(row.href) : row.label;
			const title = row.href
				? `<a class="rank-title" href="${esc(row.href)}" target="_blank" rel="noreferrer">${esc(label)}</a>`
				: `<span class="rank-title${data.text ? " is-text" : ""}">${esc(label)}</span>`;
			return `<li>
				<span class="rank-no">${String(index + 1).padStart(2, "0")}</span>
				<span class="rank-body">${title}<span class="rank-track"><i data-w="${Math.round(
					((Number(row.count) || 0) / max) * 100,
				)}"></i></span></span>
				<span class="rank-count">${fmtNum(Number(row.count) || 0)}</span>
			</li>`;
		})
		.join("")}</ol>`;

	requestAnimationFrame(() => {
		for (const bar of el.querySelectorAll<HTMLElement>(".rank-track i"))
			bar.style.width = `${bar.dataset.w ?? 0}%`;
	});
}

type LogRow = {
	ts: string;
	text: string;
	path?: string;
	model?: string;
	ms?: number;
	ttft?: number;
	tokens?: number;
	ok?: number;
	err?: string;
	depth?: number;
	hits?: number;
};

const FILTERS = [
	{ key: "all", label: "全部" },
	{ key: "bad", label: "失败" },
	{ key: "slow", label: "慢（>10s）" },
	{ key: "zero", label: "零命中" },
	{ key: "deep", label: "有追问" },
];

export function drawLog(
	el: HTMLElement,
	data: { rows: LogRow[] },
	resolve?: (path: string) => string,
): void {
	const rows = data.rows ?? [];
	if (rows.length === 0) {
		el.innerHTML = `<p class="empty">还没有提问记录</p>`;
		return;
	}

	const items = rows
		.map((row) => {
			const bad = !row.ok;
			const slow = (Number(row.ms) || 0) > 10_000;
			const zero = (Number(row.hits) || 0) === 0;
			const deep = (Number(row.depth) || 0) > 0;
			const flags = [
				bad ? "bad" : "",
				slow ? "slow" : "",
				zero ? "zero" : "",
				deep ? "deep" : "",
			]
				.join(" ")
				.trim();
			const who =
				row.path && resolve
					? resolve(row.path)
					: (row.path ?? "").replace(/^\/posts\//, "").replace(/\/$/, "");
			const badges = [
				row.model ? `<b class="bd">${esc(row.model)}</b>` : "",
				row.ttft ? `<b class="bd">首字 ${ms(row.ttft)}</b>` : "",
				row.tokens ? `<b class="bd">${fmtNum(row.tokens)} tok</b>` : "",
				deep ? `<b class="bd">追问 ${row.depth}</b>` : "",
				zero ? `<b class="bd warn">零命中</b>` : "",
				bad ? `<b class="bd bad">${esc(row.err || "失败")}</b>` : "",
			]
				.filter(Boolean)
				.join("");
			return `<li class="lrow ${flags}" data-flag="${flags}">
				<span class="log-time">${shortTime(row.ts)}</span>
				<span class="lbody">
					<span class="lq">${esc(row.text)}</span>
					<span class="lbadges">${who ? `<b class="bd note">${esc(who)}</b>` : ""}${badges}</span>
				</span>
				<span class="log-meta ${bad ? "bad" : ""}">${ms(Number(row.ms) || 0)}</span>
			</li>`;
		})
		.join("");

	el.innerHTML = `<div class="logbar">${FILTERS.map(
		(filter, index) =>
			`<button type="button" data-filter="${filter.key}"${index === 0 ? ' class="is-active"' : ""}>${filter.label}</button>`,
	).join("")}<span class="loghint"></span></div>
	<ul class="log llog">${items}</ul>`;

	const hint = el.querySelector<HTMLElement>(".loghint");
	const list = el.querySelector<HTMLElement>(".llog");
	const apply = (key: string) => {
		let shown = 0;
		for (const row of Array.from(el.querySelectorAll<HTMLElement>(".lrow"))) {
			const flags = (row.dataset.flag ?? "").split(" ");
			const keep = key === "all" || flags.includes(key);
			row.hidden = !keep;
			if (keep) shown += 1;
		}
		if (hint) hint.textContent = `显示 ${shown} / ${rows.length} 条`;
	};
	for (const button of Array.from(
		el.querySelectorAll<HTMLButtonElement>(".logbar button"),
	)) {
		button.addEventListener("click", () => {
			for (const other of Array.from(el.querySelectorAll(".logbar button")))
				other.classList.toggle("is-active", other === button);
			apply(button.dataset.filter ?? "all");
		});
	}
	if (list) apply("all");
}
