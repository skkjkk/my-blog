/**
 * 数据台接口层：只认「卡片」，不认 SQL。
 * 换页面 = 换 page 参数；换时间范围 = 换 range。
 */

export type StatCard = {
	id: string;
	kind:
		| "kpi"
		| "area"
		| "funnel"
		| "heatmap"
		| "histogram"
		| "bars"
		| "donut"
		| "table"
		| "rank"
		| "log";
	title?: string;
	note?: string;
	empty?: string;
	span?: number;
	data: Record<string, unknown>;
};

export type StatsPayload = {
	page: string;
	range: number;
	from: string;
	to: string;
	today: string;
	generatedAt: string;
	coverage: { since: string | null; total: number };
	cards: StatCard[];
};

export const RANGES = [7, 14, 30, 90] as const;

const RANGE_LABEL: Record<number, string> = {
	7: "7 天",
	14: "14 天",
	30: "30 天",
	90: "90 天",
};

export const rangeLabel = (range: number) =>
	RANGE_LABEL[range] ?? `${range} 天`;

/** 时间范围写进 URL：刷新、分享、前进后退都能保住 */
export function readRange(): number {
	const value = Number(
		new URLSearchParams(window.location.search).get("range"),
	);
	return (RANGES as readonly number[]).includes(value) ? value : 30;
}

export function writeRange(range: number): void {
	const url = new URL(window.location.href);
	url.searchParams.set("range", String(range));
	window.history.replaceState({}, "", url);
}

export type FetchResult =
	| { ok: true; data: StatsPayload }
	| { ok: false; reason: "unauth" | "error"; message?: string };

export async function fetchStats(
	page: string,
	range: number,
): Promise<FetchResult> {
	let response: Response;
	try {
		response = await fetch(
			`/api/admin/stats?page=${encodeURIComponent(page)}&range=${range}`,
			{
				headers: { accept: "application/json" },
			},
		);
	} catch {
		return { ok: false, reason: "error", message: "网络断了，刷新试试" };
	}

	if (response.status === 401) return { ok: false, reason: "unauth" };

	const body = (await response.json().catch(() => null)) as
		| (StatsPayload & { error?: string })
		| null;
	if (!response.ok || !body?.cards) {
		return {
			ok: false,
			reason: "error",
			message: body?.error ?? `读取失败（${response.status}）`,
		};
	}
	return { ok: true, data: body };
}
