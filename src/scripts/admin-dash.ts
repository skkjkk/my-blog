/**
 * 数据台共享客户端逻辑（概览 / 读者 / AI / 内容 / 评论 各页共用）。
 * 每个渲染函数都会先查节点再画，页面上没有那块卡片就自动跳过，
 * 所以多页拆分后同一份脚本照样能用。
 */
export function initAdminDash(): void {
	type Point = { day: string; count: number };
	type Overview = {
		generatedAt: string;
		today: string;
		range: number;
		views: {
			total: number;
			today: number;
			yesterday: number;
			series: Point[];
			top: { path: string; count: number }[];
			hours: { hour: number; count: number }[];
			calendar: Point[];
			search: {
				total: number;
				top: { keyword: string; count: number }[];
				/** 搜了但零结果的词，等于「还缺的题」 */
				zero: { keyword: string; count: number }[];
			};
		};
		ai: {
			total: number;
			today: number;
			yesterday: number;
			avgMs: number;
			tokens: number;
			successRate: number;
			zeroHits: number;
			avgHits: number;
			topPaths: { path: string; count: number }[];
			series: Point[];
			recent: {
				ts: string;
				question: string;
				model: string;
				ms: number;
				ok: number;
			}[];
			models: { model: string; count: number }[];
			/** 近 90 天提问原文，前端聚类用 */
			questions: string[];
		};
		quiz?: {
			top: { slug: string; miss: number; stuck: number; total: number }[];
		};
	};

	type PostMeta = {
		title: string;
		url: string;
		tags?: string[];
		category?: string;
		published?: string;
		words?: number;
	};

	const $ = <T extends HTMLElement = HTMLElement>(sel: string) =>
		document.querySelector(sel) as T | null;

	let range = 14;
	let titles = new Map<string, string>();
	let postsCache: PostMeta[] = [];
	let lastData: Overview | null = null;

	const fmtNum = (value: number) => value.toLocaleString("zh-CN");
	const pad = (value: number) => String(value).padStart(2, "0");
	const esc = (text: string) =>
		String(text ?? "").replace(
			/[<>&"]/g,
			(c) =>
				({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c] ?? c,
		);
	const sum = (rows: Point[]) => rows.reduce((acc, row) => acc + row.count, 0);

	/* 数字滚动 */
	function countUp(node: HTMLElement, target: number) {
		const duration = 650;
		const start = performance.now();
		const decimals = Number(node.dataset.decimals ?? 0);
		function step(now: number) {
			const progress = Math.min(1, (now - start) / duration);
			const eased = 1 - (1 - progress) ** 3;
			const value = target * eased;
			node.textContent =
				decimals > 0 ? value.toFixed(decimals) : fmtNum(Math.round(value));
			if (progress < 1) requestAnimationFrame(step);
		}
		requestAnimationFrame(step);
	}

	function deltaHtml(today: number, yesterday: number) {
		if (yesterday === 0 && today === 0) return "—";
		if (yesterday === 0) return "昨日 0 · 今天开始有";
		const diff = today - yesterday;
		if (diff === 0) return "与昨日持平";
		const pct = Math.round((diff / yesterday) * 100);
		const cls = diff > 0 ? "up" : "down";
		return `<span class="${cls}">${diff > 0 ? "▲" : "▼"} ${Math.abs(pct)}%</span> · 昨日 ${fmtNum(yesterday)}`;
	}

	/* 迷你折线 */
	function spark(values: number[], color = "var(--c2)") {
		const max = Math.max(1, ...values);
		const n = Math.max(2, values.length);
		const pts = values.map((value, index) => {
			const x = (index / (n - 1)) * 100;
			const y = 24 - (value / max) * 20;
			return `${x.toFixed(1)},${y.toFixed(1)}`;
		});
		if (pts.length < 2) pts.push("100,24");
		return `<svg class="spark" viewBox="0 0 100 26" preserveAspectRatio="none" aria-hidden="true">
		<polyline points="${pts.join(" ")}" fill="none" stroke="${color}" stroke-width="1.7"
			vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round" />
	</svg>`;
	}

	/* ================= KPI ================= */
	function renderKpis(data: Overview) {
		const box = $("#kpis");
		if (!box) return;

		const tags = new Set<string>();
		const categories = new Set<string>();
		const monthly = new Map<string, number>();
		for (const post of postsCache) {
			for (const tag of post.tags ?? []) tags.add(tag);
			if (post.category) categories.add(post.category);
			const month = (post.published ?? "").slice(0, 7);
			if (month) monthly.set(month, (monthly.get(month) ?? 0) + 1);
		}

		const monthSeries: number[] = [];
		for (let i = 7; i >= 0; i--) {
			const date = new Date();
			date.setDate(1);
			date.setMonth(date.getMonth() - i);
			monthSeries.push(
				monthly.get(`${date.getFullYear()}-${pad(date.getMonth() + 1)}`) ?? 0,
			);
		}

		const days = fillSeries(data.views.series, data.range);
		const aiDays = fillSeries(data.ai.series, data.range);

		const items: {
			label: string;
			value: number;
			suffix?: string;
			decimals?: number;
			extra: string;
			spark: string;
		}[] = [
			{
				label: "文章",
				value: postsCache.length,
				extra: `${categories.size} 个分类`,
				spark: spark(monthSeries),
			},
			{
				label: "标签",
				value: tags.size,
				extra: "去重后",
				spark: "",
			},
			{
				label: "今日阅读",
				value: data.views.today,
				suffix: "次",
				extra: deltaHtml(data.views.today, data.views.yesterday),
				spark: spark(days.map((row) => row.count)),
			},
			{
				label: "累计阅读",
				value: data.views.total,
				suffix: "次",
				extra: `近 ${data.range} 天 ${fmtNum(sum(days))} 次`,
				spark: spark(days.map((row) => row.count)),
			},
			{
				label: "AI 提问",
				value: data.ai.total,
				suffix: "次",
				extra: deltaHtml(data.ai.today, data.ai.yesterday),
				spark: spark(
					aiDays.map((row) => row.count),
					"var(--alt)",
				),
			},
			{
				label: "平均响应",
				value: Number((data.ai.avgMs / 1000).toFixed(1)),
				decimals: 1,
				suffix: "秒",
				extra: `近 ${data.range} 天`,
				spark: "",
			},
			{
				label: "累计 tokens",
				value: data.ai.tokens,
				extra: "模型调用量",
				spark: "",
			},
			{
				label: "回答成功率",
				value: data.ai.successRate,
				suffix: "%",
				extra: `${data.ai.total} 次提问`,
				spark: "",
			},
		];

		box.innerHTML = items
			.map(
				(item, index) => `
		<div class="kpi" style="animation-delay:${index * 35}ms">
			<p class="kpi-label">${esc(item.label)}</p>
			<p class="kpi-value"><span data-count="${item.value}" data-decimals="${item.decimals ?? 0}">0</span>${
				item.suffix ? `<em>${item.suffix}</em>` : ""
			}</p>
			<p class="kpi-extra">${item.extra}</p>
			${item.spark}
		</div>`,
			)
			.join("");

		for (const node of box.querySelectorAll<HTMLElement>("[data-count]")) {
			countUp(node, Number(node.dataset.count ?? 0));
		}
	}

	function fillSeries(series: Point[], days: number) {
		const map = new Map(series.map((row) => [row.day, row.count]));
		const out: Point[] = [];
		for (let i = days - 1; i >= 0; i--) {
			const key = new Date(Date.now() + 8 * 3600 * 1000 - i * 86400000)
				.toISOString()
				.slice(0, 10);
			out.push({ day: key, count: map.get(key) ?? 0 });
		}
		return out;
	}

	/* ================= 组合图：柱 + 折线 ================= */
	function renderCombo(data: Overview) {
		const svg = $("#combo") as unknown as SVGSVGElement | null;
		if (!svg) return;
		const W = Math.max(260, Math.round(svg.clientWidth || 720));
		const H = W < 520 ? 190 : 240;
		svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
		svg.setAttribute("height", String(H));

		const L = 32;
		const R = 26;
		const T = 12;
		const B = 22;
		const plotW = W - L - R;
		const plotH = H - T - B;

		const days = fillSeries(data.views.series, data.range);
		const aiMap = new Map(data.ai.series.map((row) => [row.day, row.count]));
		const aiCounts = days.map((day) => aiMap.get(day.day) ?? 0);
		const maxV = Math.max(4, ...days.map((row) => row.count));
		const maxA = Math.max(2, ...aiCounts);

		const slot = plotW / days.length;
		const barW = Math.max(3, Math.min(24, slot * 0.56));

		const grid = [0, 0.5, 1]
			.map((ratio) => {
				const y = T + ratio * plotH;
				return `<line class="gl" x1="${L}" y1="${y.toFixed(1)}" x2="${W - R}" y2="${y.toFixed(1)}" />
				<text class="ax" x="${L - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end">${Math.round(maxV * (1 - ratio))}</text>
				<text class="ax-r" x="${W - R + 6}" y="${(y + 3).toFixed(1)}">${Math.round(maxA * (1 - ratio))}</text>`;
			})
			.join("");

		const bars = days
			.map((row, index) => {
				const h = (row.count / maxV) * plotH;
				const x = L + index * slot + (slot - barW) / 2;
				const y = T + plotH - h;
				return `<rect class="bar" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(0, h).toFixed(1)}" rx="2">
				<title>${row.day} · 阅读 ${row.count} 次</title>
			</rect>`;
			})
			.join("");

		const linePts = aiCounts.map((value, index) => {
			const x = L + index * slot + slot / 2;
			const y = T + plotH - (value / maxA) * plotH;
			return `${x.toFixed(1)},${y.toFixed(1)}`;
		});
		const dots = aiCounts
			.map((value, index) => {
				if (value === 0) return "";
				const x = L + index * slot + slot / 2;
				const y = T + plotH - (value / maxA) * plotH;
				return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.4" fill="var(--alt)"><title>${days[index].day} · 提问 ${value} 次</title></circle>`;
			})
			.join("");

		const labelEvery = Math.max(1, Math.ceil(days.length / (W < 520 ? 5 : 8)));
		const labels = days
			.map((row, index) => {
				if (index % labelEvery !== 0 && index !== days.length - 1) return "";
				const x = L + index * slot + slot / 2;
				return `<text class="ax" x="${x.toFixed(1)}" y="${H - 6}" text-anchor="middle">${Number(row.day.slice(5, 7))}/${Number(
					row.day.slice(8, 10),
				)}</text>`;
			})
			.join("");

		svg.innerHTML = `${grid}${bars}
		<polyline points="${linePts.join(" ")}" fill="none" stroke="var(--alt)" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" />
		${dots}${labels}`;

		const note = $("#combo-note");
		if (note) {
			const totalV = sum(days);
			note.textContent = `${data.range} 天 · 阅读 ${fmtNum(totalV)} 次 · 提问 ${fmtNum(sum(aiCounts.map((c, i) => ({ day: days[i].day, count: c }))))} 次`;
		}
	}

	/* ================= 半环仪表 ================= */
	function renderGauge(data: Overview) {
		const svg = $("#gauge") as unknown as SVGSVGElement | null;
		if (!svg) return;
		const W = Math.max(200, Math.round(svg.clientWidth || 260));
		const R = Math.min(96, W * 0.36);
		const H = R + 34;
		svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
		svg.setAttribute("height", String(H));

		const cx = W / 2;
		const cy = R + 10;
		const len = Math.PI * R;
		const rate = Math.max(0, Math.min(100, data.ai.successRate));
		const path = `M ${cx - R} ${cy} A ${R} ${R} 0 0 1 ${cx + R} ${cy}`;

		svg.innerHTML = `
		<path d="${path}" fill="none" stroke="var(--line-soft)" stroke-width="14" stroke-linecap="round" />
		<path d="${path}" fill="none" stroke="var(--c1)" stroke-width="14" stroke-linecap="round"
			stroke-dasharray="${len.toFixed(1)}" stroke-dashoffset="${(len * (1 - rate / 100)).toFixed(1)}" />
		<text x="${cx}" y="${cy - 20}" text-anchor="middle" style="font-size:${Math.round(R * 0.34)}px;font-weight:700;fill:var(--ink-1);font-variant-numeric:tabular-nums">${rate}%</text>
		<text x="${cx}" y="${cy - 4}" text-anchor="middle" style="font-size:11px;fill:var(--ink-3)">回答成功率</text>`;

		const facts = $("#ai-facts");
		if (facts) {
			const rows: [string, string][] = [
				["累计提问", `${fmtNum(data.ai.total)} 次`],
				["今日提问", `${fmtNum(data.ai.today)} 次`],
				[
					"平均响应",
					data.ai.avgMs ? `${(data.ai.avgMs / 1000).toFixed(1)} 秒` : "—",
				],
				["平均命中", `${data.ai.avgHits} 段`],
				["没检索到", `${data.ai.zeroHits} 次`],
				["tokens", fmtNum(data.ai.tokens)],
			];
			facts.innerHTML = rows
				.map(
					([label, value]) =>
						`<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`,
				)
				.join("");
		}

		const models = $("#models");
		if (models) {
			models.innerHTML =
				data.ai.models.length === 0
					? ""
					: data.ai.models
							.map(
								(m) =>
									`<span class="chip"><b>${esc(m.model)}</b><span>${m.count}</span></span>`,
							)
							.join("");
		}
	}

	/* ================= 玫瑰图（24 小时） ================= */
	function renderRose(data: Overview) {
		const svg = $("#rose") as unknown as SVGSVGElement | null;
		if (!svg) return;
		const S = 260;
		const c = S / 2;
		const inner = 30;
		const outerMax = 112;

		const map = new Map(data.views.hours.map((row) => [row.hour, row.count]));
		const counts = Array.from({ length: 24 }, (_, hour) => map.get(hour) ?? 0);
		const max = Math.max(1, ...counts);

		const pt = (r: number, deg: number) => {
			const rad = ((deg - 90) * Math.PI) / 180;
			return `${(c + r * Math.cos(rad)).toFixed(1)},${(c + r * Math.sin(rad)).toFixed(1)}`;
		};

		const slices = counts
			.map((count, hour) => {
				const a1 = hour * 15 + 2.4;
				const a2 = (hour + 1) * 15 - 2.4;
				const r = inner + Math.max(2, (count / max) * (outerMax - inner));
				const d = `M ${pt(inner, a1)} A ${inner} ${inner} 0 0 1 ${pt(inner, a2)} L ${pt(r, a2)} A ${r} ${r} 0 0 1 ${pt(
					r,
					a1,
				)} Z`;
				const night = hour >= 23 || hour < 6;
				const color =
					count === 0 ? "var(--line-soft)" : night ? "var(--c4)" : "var(--c1)";
				return `<path d="${d}" fill="${color}" opacity="${count === 0 ? 0.55 : 0.92}"><title>${hour}:00 · ${count} 次</title></path>`;
			})
			.join("");

		const ticks = [0, 6, 12, 18]
			.map((hour) => {
				const deg = hour * 15;
				const [x, y] = pt(outerMax + 15, deg).split(",");
				return `<text class="ax" x="${x}" y="${y}" dy="3" text-anchor="middle">${hour}</text>`;
			})
			.join("");

		const guide = `<circle cx="${c}" cy="${c}" r="${((inner + outerMax) / 2).toFixed(1)}" fill="none" stroke="var(--line-soft)" stroke-width="1" stroke-dasharray="2 4" />`;

		const total = counts.reduce((a, b) => a + b, 0);
		const peak = counts.reduce(
			(best, count, hour) => (count > counts[best] ? hour : best),
			0,
		);
		const peakLabel = counts[peak] > 0 ? `${peak}` : "—";

		svg.innerHTML = `${guide}${slices}${ticks}
		<text x="${c}" y="${c - 1}" text-anchor="middle" style="font-size:15px;font-weight:700;fill:var(--ink-1);font-variant-numeric:tabular-nums">${peakLabel}</text>
		<text x="${c}" y="${c + 12}" text-anchor="middle" style="font-size:9px;fill:var(--ink-3)">${
			counts[peak] > 0 ? ":00 最热闹" : "暂无数据"
		}</text>`;

		const note = $("#rose-note");
		if (note) {
			note.textContent =
				total > 0 ? `共 ${fmtNum(total)} 次 · 高峰 ${peak}:00` : "还没有数据";
		}
	}

	/* ================= 日历热力图 ================= */
	function renderCalendar(data: Overview) {
		const box = $("#calendar");
		const note = $("#cal-note");
		if (!box) return;

		const map = new Map(
			(data.views.calendar ?? []).map((row) => [row.day, row.count]),
		);
		const weeks = 20;
		const todayKey = new Date(Date.now() + 8 * 3600 * 1000)
			.toISOString()
			.slice(0, 10);
		const end = new Date(`${todayKey}T00:00:00Z`);
		const endDow = (end.getUTCDay() + 6) % 7; // 0 = 周一
		const lastMonday = new Date(end.getTime() - endDow * 86400000);
		const firstMonday = new Date(
			lastMonday.getTime() - (weeks - 1) * 7 * 86400000,
		);
		const max = Math.max(1, ...map.values());

		const cells: string[] = [];
		for (let dow = 0; dow < 7; dow++) {
			const label =
				dow === 0
					? "一"
					: dow === 2
						? "三"
						: dow === 4
							? "五"
							: dow === 6
								? "日"
								: "";
			cells.push(`<div class="cal dow">${label}</div>`);
			for (let w = 0; w < weeks; w++) {
				const day = new Date(firstMonday.getTime() + (w * 7 + dow) * 86400000)
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
		box.innerHTML = cells.join("");

		if (note) {
			const filled = Array.from({ length: weeks * 7 }, (_, i) =>
				new Date(firstMonday.getTime() + i * 86400000)
					.toISOString()
					.slice(0, 10),
			).filter((day) => day <= todayKey && (map.get(day) ?? 0) > 0).length;
			note.textContent = `近 ${weeks} 周 · ${filled} 天有人来访`;
		}
	}

	/* ================= 同心环：读者参与度 ================= */
	function renderRings(data: Overview) {
		const svg = $("#rings") as unknown as SVGSVGElement | null;
		const legend = $("#ring-legend");
		if (!svg) return;

		const views = sum(fillSeries(data.views.series, data.range));
		const aiTotal = sum(fillSeries(data.ai.series, data.range));
		const answered = Math.max(0, aiTotal - data.ai.zeroHits);
		const ratioOf = (value: number) =>
			views > 0 ? Math.min(1, value / views) : 0;

		const rings = [
			{
				label: "用站内搜索",
				value: data.views.search.total,
				color: "var(--c2)",
			},
			{ label: "问 AI 助手", value: aiTotal, color: "var(--c4)" },
			{ label: "问到了答案", value: answered, color: "var(--c1)" },
		].map((ring) => ({ ...ring, p: ratioOf(ring.value) }));

		const radii = [78, 58, 38];
		const arcs = rings
			.map((ring, index) => {
				const r = radii[index];
				const C = 2 * Math.PI * r;
				const dash = C * Math.max(ring.p, 0.006);
				return `<circle cx="100" cy="100" r="${r}" fill="none" stroke="var(--line-soft)" stroke-width="13" />
				<circle cx="100" cy="100" r="${r}" fill="none" stroke="${ring.color}" stroke-width="13" stroke-linecap="round"
					stroke-dasharray="${dash.toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 100 100)">
					<title>${ring.label} · ${ring.value} 次（占阅读 ${Math.round(ring.p * 100)}%）</title>
				</circle>`;
			})
			.join("");

		svg.innerHTML = `${arcs}
		<text x="100" y="98" text-anchor="middle" style="font-size:19px;font-weight:700;fill:var(--ink-1);font-variant-numeric:tabular-nums">${fmtNum(
			views,
		)}</text>
		<text x="100" y="113" text-anchor="middle" style="font-size:9.5px;fill:var(--ink-3)">次阅读</text>`;

		if (legend) {
			legend.innerHTML = rings
				.map(
					(ring) =>
						`<li><i style="background:${ring.color}"></i><span>${ring.label}</span><b>${Math.round(ring.p * 100)}%</b></li>`,
				)
				.join("");
		}
	}

	/* ================= 标签环形图 ================= */
	function renderTags() {
		const svg = $("#donut") as unknown as SVGSVGElement | null;
		const legend = $("#donut-legend");
		const note = $("#tags-note");
		if (!svg) return;

		const counter = new Map<string, number>();
		for (const post of postsCache) {
			for (const tag of post.tags ?? [])
				counter.set(tag, (counter.get(tag) ?? 0) + 1);
		}
		const entries = Array.from(counter.entries()).sort((a, b) => b[1] - a[1]);
		const used = entries.length;
		const orphans = entries.filter(([, count]) => count === 1).length;

		if (note) {
			const avgPerPost = postsCache.length
				? (
						entries.reduce((acc, [, count]) => acc + count, 0) /
						postsCache.length
					).toFixed(1)
				: "0";
			note.textContent = `${used} 个标签 · 每篇 ${avgPerPost} 个${orphans > 0 ? ` · ${orphans} 个只用过 1 次` : ""}`;
		}

		if (entries.length === 0) {
			svg.innerHTML = "";
			if (legend)
				legend.innerHTML = `<li class="empty" style="padding:0">还没有标签</li>`;
			return;
		}

		const top = entries.slice(0, 5);
		const restTotal = entries
			.slice(5)
			.reduce((acc, [, count]) => acc + count, 0);
		const slices = top.map(([tag, count], index) => ({
			label: tag,
			count,
			color: `var(--c${index + 1})`,
		}));
		if (restTotal > 0)
			slices.push({ label: "其他", count: restTotal, color: "var(--c6)" });

		const total = slices.reduce((acc, slice) => acc + slice.count, 0);
		const R = 66;
		const C = 2 * Math.PI * R;
		let offset = 0;
		const arcs = slices
			.map((slice) => {
				const dash = (slice.count / total) * C;
				const gap = Math.min(4, dash * 0.15);
				const arc = `<circle cx="90" cy="90" r="${R}" fill="none" stroke="${slice.color}" stroke-width="20"
				stroke-dasharray="${Math.max(0, dash - gap).toFixed(1)} ${(C - Math.max(0, dash - gap)).toFixed(1)}"
				stroke-dashoffset="${(-offset).toFixed(1)}" transform="rotate(-90 90 90)">
				<title>${esc(slice.label)} · ${slice.count} 篇</title>
			</circle>`;
				offset += dash;
				return arc;
			})
			.join("");

		svg.innerHTML = `${arcs}
		<text x="90" y="86" text-anchor="middle" style="font-size:20px;font-weight:700;fill:var(--ink-1);font-variant-numeric:tabular-nums">${used}</text>
		<text x="90" y="101" text-anchor="middle" style="font-size:10px;fill:var(--ink-3)">个标签</text>`;

		if (legend) {
			legend.innerHTML = slices
				.map(
					(slice) =>
						`<li><i style="background:${slice.color}"></i><span>${esc(slice.label)}</span><b>${Math.round(
							(slice.count / total) * 100,
						)}%</b></li>`,
				)
				.join("");
		}
	}

	/* ================= 散点图 ================= */
	function renderScatter(data: Overview) {
		const svg = $("#scatter") as unknown as SVGSVGElement | null;
		if (!svg) return;

		const countByUrl = new Map(
			data.views.top.map((row) => [row.path, row.count]),
		);
		const points = postsCache
			.filter((post) => (post.words ?? 0) > 0)
			.map((post) => ({
				title: post.title,
				words: post.words ?? 0,
				count: countByUrl.get(post.url) ?? 0,
			}));

		const W = Math.max(220, Math.round(svg.clientWidth || 300));
		const H = 190;
		svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
		svg.setAttribute("height", String(H));

		if (points.length < 2) {
			svg.innerHTML = `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" class="ax">阅读记录还不够，等有数据后再看</text>`;
			return;
		}

		const L = 34;
		const R = 12;
		const T = 10;
		const B = 26;
		const plotW = W - L - R;
		const plotH = H - T - B;
		const maxW = Math.max(...points.map((point) => point.words));
		const maxC = Math.max(...points.map((point) => point.count));
		const xOf = (words: number) => L + (words / maxW) * plotW;
		const yOf = (count: number) => T + plotH - (count / maxC) * plotH;

		const grid = [0, 0.5, 1]
			.map((ratio) => {
				const y = T + ratio * plotH;
				return `<line class="gl" x1="${L}" y1="${y.toFixed(1)}" x2="${W - R}" y2="${y.toFixed(1)}" />
				<text class="ax" x="${L - 5}" y="${(y + 3).toFixed(1)}" text-anchor="end">${Math.round(maxC * (1 - ratio))}</text>`;
			})
			.join("");

		const dots = points
			.map(
				(
					point,
				) => `<circle cx="${xOf(point.words).toFixed(1)}" cy="${yOf(point.count).toFixed(1)}" r="5"
				fill="var(--c1)" fill-opacity="0.75" stroke="var(--card)" stroke-width="1.5">
				<title>${esc(point.title)} · ${fmtNum(point.words)} 字 · ${point.count} 次</title>
			</circle>`,
			)
			.join("");

		svg.innerHTML = `${grid}${dots}
		<text class="ax" x="${W - R}" y="${H - 6}" text-anchor="end">字数 →</text>`;
	}

	/* ================= 排行 ================= */
	function renderRank(
		id: string,
		rows: { path?: string; keyword?: string; count: number }[],
		emptyText: string,
	) {
		const box = $(id);
		if (!box) return;
		if (rows.length === 0) {
			box.innerHTML = `<li class="empty" style="display:block">${esc(emptyText)}</li>`;
			return;
		}
		const max = Math.max(...rows.map((row) => row.count));
		box.innerHTML = rows
			.map((row, index) => {
				const label = row.path
					? (titles.get(row.path) ?? row.path)
					: esc(row.keyword ?? "");
				const href = row.path
					? `<a class="rank-title" href="${row.path}">${esc(label)}</a>`
					: `<span class="rank-title">${label}</span>`;
				return `<li>
				<span class="rank-no">${pad(index + 1)}</span>
				<span class="rank-body">${href}
					<span class="rank-track"><i data-w="${Math.round((row.count / max) * 100)}"></i></span>
				</span>
				<span class="rank-count">${fmtNum(row.count)}</span>
			</li>`;
			})
			.join("");
		requestAnimationFrame(() => {
			requestAnimationFrame(() => {
				for (const bar of box.querySelectorAll<HTMLElement>(".rank-track i"))
					bar.style.width = `${bar.dataset.w}%`;
			});
		});
	}

	/* ================= 写作节奏 ================= */
	function renderContent() {
		const box = $("#months");
		const facts = $("#content-facts");
		const note = $("#rhythm-note");
		if (!box) return;

		const counter = new Map<string, number>();
		let totalWords = 0;
		let newest = "";
		for (const post of postsCache) {
			const month = (post.published ?? "").slice(0, 7);
			if (month) counter.set(month, (counter.get(month) ?? 0) + 1);
			totalWords += post.words ?? 0;
			if ((post.published ?? "") > newest) newest = post.published ?? "";
		}

		const months: { label: string; count: number }[] = [];
		for (let i = 7; i >= 0; i--) {
			const date = new Date();
			date.setDate(1);
			date.setMonth(date.getMonth() - i);
			months.push({
				label: `${date.getMonth() + 1}月`,
				count:
					counter.get(`${date.getFullYear()}-${pad(date.getMonth() + 1)}`) ?? 0,
			});
		}
		const max = Math.max(1, ...months.map((month) => month.count));
		box.innerHTML = months
			.map(
				(month) => `<div class="month">
				<b>${month.count || ""}</b>
				<i data-h="${month.count === 0 ? 2 : Math.max(8, Math.round((month.count / max) * 100))}"></i>
				<span>${month.label}</span>
			</div>`,
			)
			.join("");
		requestAnimationFrame(() => {
			for (const bar of box.querySelectorAll<HTMLElement>("i[data-h]"))
				bar.style.height = `${bar.dataset.h}%`;
		});

		const avgWords = postsCache.length
			? Math.round(totalWords / postsCache.length)
			: 0;
		const daysSince = newest
			? Math.floor((Date.now() - new Date(newest).getTime()) / 86400000)
			: null;
		if (facts) {
			const rows: [string, string][] = [
				["总字数", fmtNum(totalWords)],
				["平均每篇", `${fmtNum(avgWords)} 字`],
				["最近发布", newest || "—"],
				[
					"停更",
					daysSince === null
						? "—"
						: daysSince <= 0
							? "今天刚发"
							: `${daysSince} 天`,
				],
			];
			facts.innerHTML = rows
				.map(
					([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`,
				)
				.join("");
		}
		if (note) {
			const thisMonth = months[months.length - 1]?.count ?? 0;
			const lastMonth = months[months.length - 2]?.count ?? 0;
			note.textContent = `本月 ${thisMonth} 篇 · 上月 ${lastMonth} 篇`;
		}
	}

	/* ================= 提问记录 ================= */
	function renderLog(data: Overview) {
		const box = $("#log");
		if (!box) return;
		if (data.ai.recent.length === 0) {
			box.innerHTML = `<li class="empty">还没有人问过</li>`;
			return;
		}
		box.innerHTML = data.ai.recent
			.map((item) => {
				const date = new Date(item.ts);
				const time = `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
				const meta = `${item.ms ? `${(item.ms / 1000).toFixed(1)}s` : ""}${item.ok ? "" : " · 失败"}`;
				return `<li>
				<span class="log-time">${time}</span>
				<span class="log-q">${esc(item.question)}</span>
				<span class="log-meta ${item.ok ? "" : "bad"}">${meta}</span>
			</li>`;
			})
			.join("");
	}

	/* ================= 汇总渲染 ================= */
	function renderAll(data: Overview) {
		renderKpis(data);
		renderCombo(data);
		renderGauge(data);
		renderRose(data);
		renderCalendar(data);
		renderRings(data);
		renderTags();
		renderScatter(data);
		renderRank(
			"#ranking",
			data.views.top.slice(0, 8),
			"还没有数据，等有人访问后就会出现",
		);
		renderRank("#searches", data.views.search.top, "还没有搜索记录");
		renderRank("#ai-paths", data.ai.topPaths, "还没有提问记录");
		renderContent();
		renderLog(data);
		renderDiagnostics(data);

		const searchNote = $("#search-note");
		if (searchNote) {
			searchNote.textContent =
				data.views.search.total > 0
					? `${data.range} 天内 ${fmtNum(data.views.search.total)} 次搜索`
					: "还没有人搜索过";
		}
	}

	/* ================= 自我诊断：搜不到什么 / 最常被问 / 总记不住 ================= */
	function clusterQuestions(list: string[]) {
		const counter = new Map<string, { count: number; sample: string }>();
		for (const raw of list) {
			// 去掉标点与空白再归并，「什么是 MCP？」和「什么是MCP」算同一句
			const key = raw
				.replace(/[\s，。？！、,.?!：:；;"'“”‘’（）()《》<>【】[\]]/g, "")
				.toLowerCase()
				.slice(0, 60);
			if (key.length < 2) continue;
			const hit = counter.get(key);
			if (hit) hit.count += 1;
			else counter.set(key, { count: 1, sample: raw.trim() });
		}

		return Array.from(counter.values())
			.sort((a, b) => b.count - a.count)
			.slice(0, 8)
			.map((item) => ({ keyword: item.sample, count: item.count }));
	}

	function renderDiagnostics(data: Overview) {
		const zero = data.views.search.zero ?? [];
		renderRank("#zero-search", zero, "最近没有搜空的关键词");

		const zeroNote = $("#zero-note");
		if (zeroNote) {
			zeroNote.textContent =
				zero.length === 0
					? "零结果搜索词"
					: `${zero.length} 个词搜不到东西，可以考虑补题`;
		}

		const questions = clusterQuestions(data.ai.questions ?? []);
		renderRank("#questions", questions, "还没有提问记录");

		const questionNote = $("#question-note");
		if (questionNote) {
			const raw = (data.ai.questions ?? []).length;
			questionNote.textContent =
				raw === 0
					? "提问原文去重后按次数排"
					: `近 90 天 ${fmtNum(raw)} 条提问，去重后取前 8`;
		}

		const quizRows = (data.quiz?.top ?? []).filter((row) => row.miss > 0);
		renderQuizRank(quizRows);

		const quizNote = $("#quiz-note");
		if (quizNote) {
			const total = (data.quiz?.top ?? []).reduce(
				(acc, row) => acc + row.total,
				0,
			);
			quizNote.textContent =
				total === 0 ? "还没刷过题" : `累计 ${fmtNum(total)} 次评分`;
		}
	}

	/** slug 反查文章路径（post-index.json 里的 url 都是 /posts/<slug>/） */
	function slugToPath(slug: string) {
		const hit = postsCache.find((post) => post.url?.includes(`/${slug}/`));
		return hit?.url ?? `/posts/${slug}/`;
	}

	/** 刷题榜：拿 slug 找标题，通用 renderRank 只认 path/keyword，这里单独画 */
	function renderQuizRank(
		rows: { slug: string; miss: number; stuck: number; total: number }[],
	) {
		const box = $("#quiz-miss");
		if (!box) return;
		if (rows.length === 0) {
			box.innerHTML = `<li class="empty" style="display:block">还没有人被难住，去刷几题</li>`;
			return;
		}

		const max = Math.max(...rows.map((row) => row.miss), 1);
		box.innerHTML = rows
			.map((row, index) => {
				const href = slugToPath(row.slug);
				const label = titles.get(href) ?? row.slug;
				return `<li>
				<span class="rank-no">${pad(index + 1)}</span>
				<span class="rank-body">
					<a class="rank-title" href="${href}">${esc(label)}</a>
					<span class="rank-track"><i data-w="${Math.round((row.miss / max) * 100)}"></i></span>
				</span>
				<span class="rank-count" title="卡住 ${row.stuck} 次 / 共 ${row.total} 次评分">${fmtNum(row.miss)}</span>
			</li>`;
			})
			.join("");

		requestAnimationFrame(() => {
			requestAnimationFrame(() => {
				for (const bar of box.querySelectorAll<HTMLElement>(".rank-track i"))
					bar.style.width = `${bar.dataset.w}%`;
			});
		});
	}

	let resizeTimer = 0;
	window.addEventListener("resize", () => {
		window.clearTimeout(resizeTimer);
		resizeTimer = window.setTimeout(() => {
			if (lastData) renderAll(lastData);
		}, 220);
	});

	async function loadTitles() {
		try {
			postsCache = (await (
				await fetch("/post-index.json")
			).json()) as PostMeta[];
			titles = new Map(postsCache.map((post) => [post.url, post.title]));
		} catch {
			postsCache = [];
		}
	}

	function showConsole(show: boolean) {
		const gate = $("#gate");
		const panel = $("#console");
		if (gate) gate.hidden = show;
		if (panel) panel.hidden = !show;
	}

	async function load() {
		let response: Response;
		try {
			response = await fetch(`/api/admin/overview?range=${range}`, {
				headers: { accept: "application/json" },
			});
		} catch {
			showConsole(false);
			return;
		}
		if (response.status === 401) {
			showConsole(false);
			return;
		}

		const data = (await response.json().catch(() => null)) as Overview | null;
		if (!data) {
			showConsole(false);
			return;
		}

		lastData = data;
		showConsole(true);
		renderAll(data);
		window.dispatchEvent(new Event("admin:console"));

		const stamp = $("#stamp");
		if (stamp) {
			const now = new Date();
			stamp.textContent = `${now.getFullYear()}.${pad(now.getMonth() + 1)}.${pad(now.getDate())} ${pad(now.getHours())}:${pad(
				now.getMinutes(),
			)} · GMT+8`;
		}
	}

	for (const button of document.querySelectorAll<HTMLButtonElement>(
		"#range-seg button",
	)) {
		button.addEventListener("click", () => {
			range = Number(button.dataset.range ?? 14);
			for (const other of document.querySelectorAll("#range-seg button"))
				other.classList.toggle("is-active", other === button);
			void load();
		});
	}

	$("#refresh")?.addEventListener("click", () => void load());

	$("#logout")?.addEventListener("click", async () => {
		await fetch("/api/admin/logout", { method: "POST" });
		showConsole(false);
	});

	$("#login-form")?.addEventListener("submit", async (event) => {
		event.preventDefault();
		const input = $("#password") as HTMLInputElement | null;
		const error = $("#login-error");
		if (error) error.hidden = true;
		const response = await fetch("/api/admin/login", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ password: input?.value ?? "" }),
		});
		if (!response.ok) {
			const body = (await response.json().catch(() => ({}))) as {
				error?: string;
			};
			if (error) {
				error.textContent = body.error ?? "密码不对";
				error.hidden = false;
			}
			return;
		}
		if (input) input.value = "";
		await load();
	});

	void (async () => {
		await loadTitles();
		await load();
	})();
}
