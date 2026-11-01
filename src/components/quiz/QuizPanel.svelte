<script lang="ts">
/**
 * 刷题面板：题库数据来自 /quiz-index.json（构建时生成），
 * 进度存在 localStorage，排期逻辑全在 utils/quiz-store.ts 里（有单测）。
 */
import { onMount } from "svelte";
import {
	type Grade,
	type QuizState,
	DEFAULT_GOAL,
	dueSlugs,
	emptyState,
	gradeCard,
	loadState,
	mergeStates,
	sameState,
	serializeState,
	shuffle,
	streakDays,
	todayCount,
	totalSeen,
	unseenSlugs,
	wrongSlugs,
	STORAGE_KEY,
} from "../../utils/quiz-store";
import { todayKey } from "../../utils/quiz-utils";
import { url } from "../../utils/url-utils";

type Item = {
	slug: string;
	url: string;
	title: string;
	category: string;
	tags: string[];
	answer: string;
	outline: string[];
};

type Mode = "today" | "due" | "wrong" | "random" | "category";

// 一轮最多推多少题，防止一口气刷到天亮
const ROUND_CAP = 30;
const GOAL_CHOICES = [3, 5, 10, 20, 30];

let items: Item[] = [];
let index = new Map<string, Item>();

let state: QuizState = emptyState();
let today = todayKey();

let mode: Mode = "today";
let category = "";
let queue: Item[] = [];
let pos = 0;
let revealed = false;
let checked: boolean[] = [];
let loading = true;
let error = "";
let note = "";
let roundFinished = false;
let noteTimer: ReturnType<typeof setTimeout> | null = null;
/** 云端同步：idle 还没试 / local 仅本地 / synced 已同步 / error 失败 */
let syncState: "idle" | "local" | "synced" | "error" = "idle";
let pushTimer: ReturnType<typeof setTimeout> | null = null;

const GRADE_LABEL: Record<Grade, { text: string; hint: string }> = {
	0: { text: "不会", hint: "1" },
	1: { text: "卡住", hint: "2" },
	2: { text: "会", hint: "3" },
};

function persist() {
	try {
		localStorage.setItem(STORAGE_KEY, serializeState(state));
	} catch {
		// 隐私模式下写不进去就算了，不影响本轮刷题
	}
	schedulePush();
}

/** 拉云端进度：没登录后台就当「仅本地」，不打扰 */
async function pullCloud() {
	try {
		const response = await fetch(url("/api/quiz/state"), { headers: { accept: "application/json" } });
		if (response.status === 401) {
			syncState = "local";
			return;
		}
		if (!response.ok) {
			syncState = "error";
			return;
		}

		const data = await response.json();
		if (typeof data?.payload === "string") {
			const remote = loadState(data.payload);
			const merged = mergeStates(state, remote);
			if (!sameState(merged, state)) {
				state = merged;
				localStorage.setItem(STORAGE_KEY, serializeState(state));
				refreshQueueAfterSync();
			}
		}

		syncState = "synced";
		// 首次拉完立刻把本地已有的补上去，避免第二台设备看不到
		void pushCloud();
	} catch {
		syncState = "error";
	}
}

async function pushCloud() {
	if (syncState !== "synced" && syncState !== "idle") return;
	try {
		const response = await fetch(url("/api/quiz/state"), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ payload: serializeState(state) }),
		});
		if (response.ok) syncState = "synced";
		else if (response.status === 401) syncState = "local";
		else syncState = "error";
	} catch {
		syncState = "error";
	}
}

/** 评分后节流上传，别把每次点击都变成一次请求 */
function schedulePush() {
	if (pushTimer) clearTimeout(pushTimer);
	pushTimer = setTimeout(() => {
		void pushCloud();
	}, 2500);
}

/** 云端数据合并进来后，队列可能过期了 */
function refreshQueueAfterSync() {
	if (mode === "today") buildQueue("today");
}

function flash(message: string) {
	note = message;
	if (noteTimer) clearTimeout(noteTimer);
	noteTimer = setTimeout(() => {
		note = "";
	}, 4000);
}

function slugSet(slugs: string[]): Item[] {
	return slugs.map((slug) => index.get(slug)).filter((item): item is Item => !!item);
}

/** 按模式组一轮题 */
function buildQueue(next: Mode = mode) {
	mode = next;
	if (next === "category" && !category) {
		category = items[0]?.category ?? "";
	}

	const due = dueSlugs(state, today);
	let list: Item[] = [];

	if (next === "today") {
		const unseen = shuffle(unseenSlugs(state, items.map((item) => item.slug)));
		// 先还债，再用没刷过的题补足今天的量
		list = [...slugSet(due), ...slugSet(unseen)];
		list = list.slice(0, Math.min(ROUND_CAP, Math.max(state.goal, due.length)));
	} else if (next === "due") {
		list = slugSet(due);
	} else if (next === "wrong") {
		list = slugSet(wrongSlugs(state));
	} else if (next === "random") {
		list = shuffle([...items]);
	} else if (next === "category") {
		list = shuffle(items.filter((item) => item.category === category));
	}

	queue = list.slice(0, ROUND_CAP);
	pos = 0;
	roundFinished = queue.length === 0;
	revealed = false;
	checked = [];
}

function current(): Item | null {
	return queue[pos] ?? null;
}

function next() {
	pos += 1;
	revealed = false;
	checked = [];
	if (pos >= queue.length) roundFinished = true;
}

function reveal() {
	const item = current();
	if (!item || revealed) return;
	revealed = true;
	checked = new Array(item.outline.length).fill(false) as boolean[];
}

function grade(value: Grade) {
	const item = current();
	if (!item) return;

	const result = gradeCard(state, item.slug, value, today);
	state = result.state;
	persist();

	// 上报聚合计数（数据台用来找「总记不住」的题），失败不影响刷题
	reportGrade(item.slug, value);

	const when =
		result.card.interval === 0
			? "今天再练一次"
			: `${result.card.interval} 天后（${result.card.due}）`;
	flash(`${GRADE_LABEL[value].text} · 下次复习：${when}`);

	next();
}

/** 上报一次评分：只发聚合计数，不带任何身份信息 */
function reportGrade(slug: string, value: Grade) {
	try {
		const body = JSON.stringify({ slug, grade: value });
		if (navigator.sendBeacon) {
			navigator.sendBeacon(url("/api/quiz/grade"), new Blob([body], { type: "application/json" }));
			return;
		}
		void fetch(url("/api/quiz/grade"), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body,
			keepalive: true,
		}).catch(() => {});
	} catch {
		// 统计失败不影响刷题
	}
}

function toggleCheck(i: number) {
	const list = [...checked];
	list[i] = !list[i];
	checked = list;
}

function changeGoal(event: Event) {
	const goal = Number((event.target as HTMLSelectElement).value);
	state = { ...state, goal };
	persist();
	flash(`每日目标改成 ${goal} 题`);
}

function handleKey(event: KeyboardEvent) {
	const target = event.target as HTMLElement | null;
	if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
	if (!current()) return;

	if (event.code === "Space" || event.key === "Enter") {
		event.preventDefault();
		if (!revealed) reveal();
		return;
	}

	if (!revealed) return;

	if (event.key === "1" || event.key === "2" || event.key === "3") {
		grade((Number(event.key) - 1) as Grade);
	}
}

onMount(() => {
	const stored = localStorage.getItem(STORAGE_KEY);
	state = loadState(stored);
	today = todayKey();

	if (!stored) flash("第一次刷题？先自己想，空格看答案，1 / 2 / 3 给自己打分");

	fetch(url("/quiz-index.json"))
		.then((response) => {
			if (!response.ok) throw new Error(`题库加载失败（${response.status}）`);
			return response.json();
		})
		.then((data) => {
			items = data.items ?? [];
			index = new Map(items.map((item: Item) => [item.slug, item]));
			category = items[0]?.category ?? "";
			buildQueue(mode);
			// 索引就绪后再拉云端，合并完能立刻重建今日队列
			void pullCloud();
		})
		.catch((err) => {
			error = err instanceof Error ? err.message : "题库加载失败";
		})
		.finally(() => {
			loading = false;
		});

	window.addEventListener("keydown", handleKey);
	return () => {
		window.removeEventListener("keydown", handleKey);
		if (noteTimer) clearTimeout(noteTimer);
		if (pushTimer) clearTimeout(pushTimer);
	};
});

$: item = pos >= 0 ? (queue[pos] ?? null) : null;
$: doneToday = todayCount(state, today);
$: dueCount = dueSlugs(state, today).length;
$: streak = streakDays(state, today);
$: total = totalSeen(state);
$: progress = queue.length === 0 ? 0 : Math.min(100, (pos / queue.length) * 100);
$: goalProgress = Math.min(100, (doneToday / state.goal) * 100);
$: categories = [...new Set(items.map((entry) => entry.category).filter(Boolean))];

const TABS: { key: Mode; label: string }[] = [
	{ key: "today", label: "今日" },
	{ key: "due", label: "待复习" },
	{ key: "wrong", label: "错题" },
	{ key: "random", label: "随机" },
];
</script>

<div class="space-y-4">
	<!-- 顶部：今日进度与总览 -->
	<section class="card-base px-6 md:px-8 py-6 onload-animation">
		<div class="flex flex-wrap items-end justify-between gap-4 mb-4">
			<div>
				<div class="flex items-center gap-2 mb-2">
					<span class="text-[0.7rem] font-bold tracking-widest text-[var(--primary)]">QUIZ</span>
					<span class="h-[1px] w-16 bg-[var(--line-divider)]"></span>
				</div>
				<h1 class="text-2xl font-bold text-90">刷题</h1>
			</div>
			<div class="flex items-baseline gap-2">
				<span class="text-3xl font-bold text-[var(--primary)]">{doneToday}</span>
				<span class="text-sm text-50">/ {state.goal} 题</span>
			</div>
		</div>

		<div class="h-2 rounded-full bg-[var(--btn-regular-bg)] overflow-hidden mb-4">
			<div
				class="h-full rounded-full bg-[var(--primary)] transition-all duration-500"
				style={`width: ${goalProgress}%`}
			></div>
		</div>

		<div class="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-50">
			<span>待复习 <b class="text-90">{dueCount}</b></span>
			<span>连续 <b class="text-90">{streak}</b> 天</span>
			<span>累计 <b class="text-90">{total}</b> 题次</span>
			<span>题库 <b class="text-90">{items.length}</b> 题</span>
			{#if syncState === "synced"}
				<span class="text-[var(--primary)]" title="进度已存到云端，换设备也能接着刷">● 已同步</span>
			{:else if syncState === "local"}
				<a href={url("/admin/")} class="hover:text-[var(--primary)] transition" title="登录后台后，刷题进度会同步到云端">
					仅本地 · 登录后台可同步
				</a>
			{:else if syncState === "error"}
				<span class="text-red-500" title="稍后会自动重试，也可以刷新页面">同步失败</span>
			{/if}
			<label class="flex items-center gap-1.5 ml-auto">
				<span>每日目标</span>
				<select
					class="bg-[var(--btn-regular-bg)] rounded-md px-2 py-1 text-90 outline-none"
					value={state.goal}
					on:change={changeGoal}
				>
					{#each GOAL_CHOICES as goal}
						<option value={goal}>{goal}</option>
					{/each}
				</select>
			</label>
		</div>
	</section>

	<!-- 模式切换 -->
	<section class="flex flex-wrap items-center gap-2 onload-animation" style="animation-delay: 60ms">
		{#each TABS as tab}
			<button
				class={`h-9 px-4 rounded-lg text-sm font-bold transition ${
					mode === tab.key
						? "bg-[var(--primary)] text-white"
						: "bg-[var(--btn-regular-bg)] text-75 hover:text-[var(--primary)]"
				}`}
				on:click={() => buildQueue(tab.key)}
			>
				{tab.label}{tab.key === "due" && dueCount > 0 ? ` ${dueCount}` : ""}
			</button>
		{/each}

		<select
			class={`h-9 px-3 rounded-lg text-sm outline-none transition ${
				mode === "category"
					? "bg-[var(--btn-regular-bg)] text-[var(--primary)] font-bold"
					: "bg-[var(--btn-regular-bg)] text-75"
			}`}
			bind:value={category}
			on:change={() => buildQueue("category")}
		>
			{#each categories as name}
				<option value={name}>{name}</option>
			{/each}
		</select>
	</section>

	<!-- 题卡 -->
	{#if loading}
		<section class="card-base px-8 py-16 text-center text-50">题库加载中…</section>
	{:else if error}
		<section class="card-base px-8 py-16 text-center">
			<p class="text-90 font-bold mb-2">{error}</p>
			<p class="text-sm text-50">确认 /quiz-index.json 已生成（pnpm build 会在 dist 里产出）。</p>
		</section>
	{:else if !item}
		<section class="card-base px-8 py-14 text-center">
			{#if mode === "today" && doneToday >= state.goal}
				<p class="text-xl font-bold text-90 mb-2">今天的 {state.goal} 题刷完了 🎉</p>
				<p class="text-sm text-50 mb-6">
					连续 {streak} 天，累计 {total} 题次。明天要复习的题已经排好，共 {dueCount} 道。
				</p>
			{:else if roundFinished && queue.length > 0}
				<p class="text-xl font-bold text-90 mb-2">这一轮 {queue.length} 题走完了</p>
				<p class="text-sm text-50 mb-6">
					今天已刷 {doneToday} 题，连续 {streak} 天。要复习的还有 {dueCount} 道。
				</p>
			{:else}
				<p class="text-xl font-bold text-90 mb-2">这个模式暂时没题</p>
				<p class="text-sm text-50 mb-6">
					{dueCount === 0
						? "没有到期要复习的题了，可以随机抽几道或按分类刷。"
						: "换一个模式试试。"}
				</p>
			{/if}
			<div class="flex flex-wrap items-center justify-center gap-3">
				{#if roundFinished && queue.length > 0}
					<button
						class="h-10 px-5 rounded-lg btn-regular font-bold"
						on:click={() => buildQueue(mode)}
					>
						再来一轮
					</button>
				{/if}
				<button class="h-10 px-5 rounded-lg btn-regular font-bold" on:click={() => buildQueue("random")}>
					随机抽几道
				</button>
				{#if mode !== "today"}
					<button
						class="h-10 px-5 rounded-lg bg-[var(--btn-regular-bg)] text-75 font-bold hover:text-[var(--primary)] transition"
						on:click={() => buildQueue("today")}
					>
						回到今日
					</button>
				{/if}
			</div>
		</section>
	{:else}
		<section class="card-base px-6 md:px-9 py-7 onload-animation" style="animation-delay: 100ms">
			<div class="flex flex-wrap items-center gap-2 mb-4 text-sm">
				{#if item.category}
					<span class="px-2 py-0.5 rounded-md bg-[var(--btn-regular-bg)] text-[var(--primary)] font-bold">
						{item.category}
					</span>
				{/if}
				{#each item.tags as tag}
					<span class="text-30">#{tag}</span>
				{/each}
				<span class="ml-auto text-30 tabular-nums">{pos + 1} / {queue.length}</span>
			</div>

			<h2 class="text-xl md:text-2xl font-bold text-90 leading-relaxed mb-5">{item.title}</h2>

			{#if !revealed}
				<button
					class="w-full rounded-xl border border-dashed border-[var(--line-divider)] py-10 text-50 transition hover:border-[var(--primary)] hover:text-[var(--primary)]"
					on:click={reveal}
				>
					<span class="block text-sm font-bold mb-1">先自己想一遍</span>
					<span class="block text-xs">按 <kbd class="kbd">空格</kbd> 或点这里看答案</span>
				</button>
			{:else}
				<div class="rounded-xl bg-[var(--btn-plain-bg-hover)] px-5 py-4 mb-4">
					<p class="text-90 leading-relaxed whitespace-pre-wrap">{item.answer}</p>
				</div>

				{#if item.outline.length > 0}
					<div class="mb-5">
						<p class="text-xs text-30 mb-2">要点提纲（点一下标记「我说到了」）</p>
						<div class="flex flex-wrap gap-2">
							{#each item.outline as point, i}
								<button
									class={`px-2.5 py-1 rounded-md text-xs transition ${
										checked[i]
											? "bg-[var(--primary)] text-white"
											: "bg-[var(--btn-regular-bg)] text-75 hover:text-[var(--primary)]"
									}`}
									on:click={() => toggleCheck(i)}
								>
									{point}
								</button>
							{/each}
						</div>
					</div>
				{/if}

				<div class="flex flex-wrap items-center gap-3">
					<span class="text-xs text-30 mr-auto">你答得怎么样？</span>
					<button
						class="h-10 px-5 rounded-lg font-bold text-sm bg-red-500 text-white transition hover:opacity-90"
						on:click={() => grade(0)}
					>
						不会 <kbd class="kbd">1</kbd>
					</button>
					<button
						class="h-10 px-5 rounded-lg font-bold text-sm bg-[var(--btn-regular-bg)] text-75 transition hover:text-[var(--primary)]"
						on:click={() => grade(1)}
					>
						卡住 <kbd class="kbd">2</kbd>
					</button>
					<button
						class="h-10 px-5 rounded-lg font-bold text-sm bg-[var(--primary)] text-white transition hover:opacity-90"
						on:click={() => grade(2)}
					>
						会 <kbd class="kbd">3</kbd>
					</button>
					<a href={item.url} class="text-xs text-30 hover:text-[var(--primary)] transition ml-1">
						看原文 →
					</a>
				</div>
			{/if}
		</section>

		<!-- 本轮进度 -->
		<section class="flex items-center gap-3 px-1">
			<div class="h-1.5 flex-1 rounded-full bg-[var(--btn-regular-bg)] overflow-hidden">
				<div class="h-full rounded-full bg-[var(--primary)] transition-all" style={`width: ${progress}%`}></div>
			</div>
			<span class="text-xs text-30 tabular-nums">{pos} / {queue.length}</span>
		</section>
	{/if}

	{#if note}
		<div
			class="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-lg bg-[var(--float-panel-bg)] shadow-xl text-sm text-90"
		>
			{note}
		</div>
	{/if}
</div>

<style>
	.kbd {
		display: inline-block;
		padding: 0 0.3rem;
		border-radius: 0.25rem;
		background: rgba(0, 0, 0, 0.12);
		font-size: 0.7rem;
		line-height: 1.5;
		font-family: var(--code-font, ui-monospace);
	}
</style>
