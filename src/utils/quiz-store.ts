/**
 * 刷题状态与排期：纯逻辑，不碰 DOM、不依赖框架。
 *
 * 为什么单独抽出来：① 能直接写单测 ② 以后接 D1 跨设备同步（P8）时，
 * 只要把这层换成远端读写，UI 不用动。
 *
 * 排期是「简化版 SM-2」：不追求算法严谨，只要求手感对——
 * 会的隔得越来越久，卡住的明天再见，不会的今天再练一次。
 */
import { addDays, todayKey } from "./quiz-utils.ts";

/** 评分：0 不会 / 1 卡住 / 2 会 */
export type Grade = 0 | 1 | 2;

export type Card = {
	/** 最近一次评分 */
	level: Grade;
	/** 连续答对次数，决定复习间隔 */
	streak: number;
	/** 当前间隔（天） */
	interval: number;
	/** 下次该复习的日期 YYYY-MM-DD */
	due: string;
	/** 累计刷过几次 */
	seen: number;
	/** 最后一次刷的日期 */
	last: string;
};

export type QuizState = {
	v: 1;
	cards: Record<string, Card>;
	/** 每天刷了多少题，用于打卡与连续天数 */
	days: Record<string, number>;
	/** 每日目标题数 */
	goal: number;
};

export const STORAGE_KEY = "wkb:quiz:v1";
export const DEFAULT_GOAL = 5;

/** 「会」之后每次的间隔阶梯（天）：3 → 7 → 21 → 60 → 120 → 240 */
const LADDER = [3, 7, 21, 60, 120, 240];

/** days 最多保留的天数，防止 localStorage 无限长大 */
const MAX_DAY_ENTRIES = 400;

export function emptyState(): QuizState {
	return { v: 1, cards: {}, days: {}, goal: DEFAULT_GOAL };
}

function isCard(value: unknown): value is Card {
	if (!value || typeof value !== "object") return false;
	const card = value as Record<string, unknown>;
	return (
		typeof card.due === "string" && typeof card.seen === "number" && typeof card.streak === "number"
	);
}

function isDateKey(value: string): boolean {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
	// 反过来拼一遍，挡住 2026-13-99 这种格式对但日期不存在的
	const [year, month, day] = value.split("-").map((part) => Number(part));
	const date = new Date(year, month - 1, day);
	return (
		date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
	);
}

/** 从 localStorage 的字符串恢复状态；坏数据一律退化成空状态，不能把页面搞崩 */
export function loadState(raw: string | null): QuizState {
	if (!raw) return emptyState();

	try {
		const parsed = JSON.parse(raw) as Partial<QuizState>;
		const cards: Record<string, Card> = {};
		for (const [slug, value] of Object.entries(parsed.cards ?? {})) {
			if (isCard(value) && isDateKey(value.due)) cards[slug] = value;
		}

		const days: Record<string, number> = {};
		for (const [day, count] of Object.entries(parsed.days ?? {})) {
			if (isDateKey(day) && typeof count === "number" && count > 0) {
				days[day] = count;
			}
		}

		const goal =
			typeof parsed.goal === "number" && parsed.goal >= 1 && parsed.goal <= 50
				? Math.round(parsed.goal)
				: DEFAULT_GOAL;

		return { v: 1, cards, days, goal };
	} catch {
		return emptyState();
	}
}

export function serializeState(state: QuizState): string {
	return JSON.stringify(state);
}

/** 计算一次评分后的新状态（不可变，方便 Svelte 触发更新） */
export function gradeCard(
	state: QuizState,
	slug: string,
	grade: Grade,
	today: string = todayKey(),
): { state: QuizState; card: Card } {
	const prev: Card = state.cards[slug] ?? {
		level: 0,
		streak: 0,
		interval: 0,
		due: today,
		seen: 0,
		last: "",
	};

	let streak = prev.streak;
	let interval = 1;

	if (grade === 2) {
		streak = Math.min(prev.streak + 1, LADDER.length);
		interval = LADDER[streak - 1];
	} else if (grade === 1) {
		streak = Math.max(0, prev.streak - 1);
		interval = 1;
	} else {
		streak = 0;
		interval = 0;
	}

	const card: Card = {
		level: grade,
		streak,
		interval,
		due: addDays(today, interval),
		seen: prev.seen + 1,
		last: today,
	};

	const days: Record<string, number> = {
		...state.days,
		[today]: (state.days[today] ?? 0) + 1,
	};

	// 超量时把最老的日期剔掉
	const keys = Object.keys(days).sort();
	if (keys.length > MAX_DAY_ENTRIES) {
		for (const key of keys.slice(0, keys.length - MAX_DAY_ENTRIES)) delete days[key];
	}

	return {
		state: { ...state, cards: { ...state.cards, [slug]: card }, days },
		card,
	};
}

/** 今天该复习的题（含逾期）：先按逾期程度，再按掌握程度（不会的优先） */
export function dueSlugs(state: QuizState, today: string = todayKey()): string[] {
	return Object.entries(state.cards)
		.filter(([, card]) => card.due <= today)
		.sort((a, b) => {
			if (a[1].due !== b[1].due) return a[1].due < b[1].due ? -1 : 1;
			if (a[1].level !== b[1].level) return a[1].level - b[1].level;
			return a[0].localeCompare(b[0]);
		})
		.map(([slug]) => slug);
}

/** 连续打卡天数：今天算不算，看今天有没有刷过 */
export function streakDays(state: QuizState, today: string = todayKey()): number {
	let cursor = state.days[today] ? today : addDays(today, -1);
	let count = 0;

	while (state.days[cursor] > 0) {
		count += 1;
		cursor = addDays(cursor, -1);
	}

	return count;
}

/** 累计刷题次数（按卡片累计，不按天） */
export function totalSeen(state: QuizState): number {
	return Object.values(state.cards).reduce((sum, card) => sum + card.seen, 0);
}

/** 今天已经刷了几题 */
export function todayCount(state: QuizState, today: string = todayKey()): number {
	return state.days[today] ?? 0;
}

/** 还没刷过的题 */
export function unseenSlugs(state: QuizState, allSlugs: string[]): string[] {
	return allSlugs.filter((slug) => !state.cards[slug]);
}

/** 错题：评过「不会」的 */
export function wrongSlugs(state: QuizState): string[] {
	return Object.entries(state.cards)
		.filter(([, card]) => card.level === 0)
		.sort((a, b) => b[1].seen - a[1].seen)
		.map(([slug]) => slug);
}

/** 洗牌（Fisher-Yates），传 seed 可复现——留给单测用 */
export function shuffle<T>(list: T[], random: () => number = Math.random): T[] {
	const out = [...list];
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(random() * (i + 1));
		[out[i], out[j]] = [out[j], out[i]];
	}
	return out;
}

/**
 * 合并两份状态（本地 + 云端）。规则：
 *   - 卡片：谁最后刷的听谁的；同一天刷过就取更掌握的那条（streak 大）
 *   - 打卡：按天取较大值（两边都刷过就取多的）
 *   - 目标：以本地为准（当前这台设备上你刚调过的值，才是你想看到的）
 */
export function mergeStates(local: QuizState, remote: QuizState): QuizState {
	const cards: Record<string, Card> = { ...remote.cards };

	for (const [slug, mine] of Object.entries(local.cards)) {
		const theirs = cards[slug];
		if (!theirs) {
			cards[slug] = mine;
			continue;
		}

		const mineLast = mine.last || "";
		const theirsLast = theirs.last || "";

		if (mineLast > theirsLast) cards[slug] = mine;
		else if (mineLast === theirsLast && mine.streak > theirs.streak) cards[slug] = mine;
	}

	const days: Record<string, number> = { ...remote.days };
	for (const [day, count] of Object.entries(local.days)) {
		days[day] = Math.max(days[day] ?? 0, count);
	}

	return { v: 1, cards, days, goal: local.goal || remote.goal };
}

/** 两份状态是否等价（避免无意义的上传） */
export function sameState(a: QuizState, b: QuizState): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}