<script lang="ts">
/**
 * ⌘K 命令面板：一个入口干三件事——找题、跳页面、执行小动作。
 *
 * 为什么不用 Pagefind：Pagefind 是全文索引，适合「我不记得标题」的场景，
 * 但要「我记得有篇讲 AQS 的」这种，本地 144 条标题的子序列匹配更快也更准。
 * 组件挂在 Layout 里（swup 容器之外），所以切页面后面板还在、快捷键始终有效。
 */
import { onMount, tick } from "svelte";
import { url } from "../../utils/url-utils";

type Kind = "note" | "page" | "action";

type Entry = {
	kind: Kind;
	title: string;
	subtitle?: string;
	href?: string;
	run?: () => void;
};

type PostIndexItem = {
	title: string;
	url: string;
	category: string;
	tags: string[];
};

const PAGES: Entry[] = [
	{ kind: "page", title: "首页", href: url("/") },
	{ kind: "page", title: "题库目录", subtitle: "按分类和知识点分组的总目录", href: url("/notes/") },
	{ kind: "page", title: "刷题", subtitle: "自测与间隔重复", href: url("/quiz/") },
	{ kind: "page", title: "归档", href: url("/archive/") },
	{ kind: "page", title: "关于", href: url("/about/") },
	{ kind: "page", title: "数据台", subtitle: "访问量、AI 提问、评论审核", href: url("/admin/") },
	{ kind: "page", title: "RSS 订阅", href: url("/rss.xml") },
];

let open = false;
let query = "";
let entries: Entry[] = [];
let results: Entry[] = [];
let active = 0;
let loaded = false;
let note = "";
let noteTimer: ReturnType<typeof setTimeout> | null = null;
let inputEl: HTMLInputElement | null = null;
let listEl: HTMLElement | null = null;

/** 子序列打分：前缀命中 > 连续命中 > 稀疏命中 */
function score(text: string, keyword: string): number {
	if (!keyword) return 1;

	const target = text.toLowerCase();
	const needle = keyword.toLowerCase();

	const direct = target.indexOf(needle);
	if (direct === 0) return 1000;
	if (direct > 0) return 800 - direct;

	let cursor = 0;
	let gaps = 0;
	let last = -1;
	for (const ch of needle) {
		const found = target.indexOf(ch, cursor);
		if (found === -1) return 0;
		if (last >= 0) gaps += found - last - 1;
		last = found;
		cursor = found + 1;
	}

	return Math.max(1, 500 - gaps);
}

function compute(keywordRaw: string, list: Entry[]): Entry[] {
	const keyword = keywordRaw.trim();

	if (!keyword) {
		// 空查询：先给常用入口，再给最近更新的几篇
		const shortcuts = list.filter((entry) => entry.kind !== "note");
		const notes = list.filter((entry) => entry.kind === "note");
		return [...shortcuts.slice(0, 4), ...notes.slice(0, 6)];
	}

	return list
		.map((entry) => ({
			entry,
			value: Math.max(
				score(entry.title, keyword),
				// 分类和标签也参与匹配，权重低一档
				entry.subtitle ? score(entry.subtitle, keyword) * 0.6 : 0,
			),
		}))
		.filter((row) => row.value > 0)
		.sort((a, b) => b.value - a.value)
		.slice(0, 12)
		.map((row) => row.entry);
}

function flash(message: string) {
	note = message;
	if (noteTimer) clearTimeout(noteTimer);
	noteTimer = setTimeout(() => {
		note = "";
	}, 2600);
}

async function copy(text: string) {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		const area = document.createElement("textarea");
		area.value = text;
		area.style.position = "fixed";
		area.style.opacity = "0";
		document.body.appendChild(area);
		area.select();
		try {
			document.execCommand("copy");
			return true;
		} catch {
			return false;
		} finally {
			area.remove();
		}
	}
}

function newNoteTemplate(title: string) {
	const now = new Date();
	const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
	return `---
title: ${title || "新笔记"}
published: ${stamp}
description: ''
tags: []
category: ''
section: note
draft: true
---
`;
}

function show() {
	open = true;
	query = "";

	void tick().then(() => inputEl?.focus());
}

function hide() {
	open = false;
	query = "";
}

function choose(entry: Entry | undefined) {
	if (!entry) return;

	if (entry.run) {
		entry.run();
		return;
	}

	if (entry.href) {
		hide();
		// 站内跳转优先交给 swup，保留页面转场动画
		const swup = (window as unknown as { swup?: { navigate?: (href: string) => void } }).swup;
		if (!entry.href.startsWith("http") && swup?.navigate) swup.navigate(entry.href);
		else window.location.href = entry.href;
	}
}

async function handleEnter() {
	// 没匹配到任何条目时，直接拿查询词开一篇新笔记
	const entry = results[active];
	if (!entry && query.trim()) {
		const ok = await copy(newNoteTemplate(query.trim()));
		flash(ok ? `已复制新笔记 frontmatter：${query.trim()}` : "复制失败");
		return;
	}
	choose(entry);
}

function onKeydown(event: KeyboardEvent) {
	if (!open) return;

	if (event.key === "Escape") {
		event.preventDefault();
		hide();
		return;
	}

	if (event.key === "ArrowDown") {
		event.preventDefault();
		active = Math.min(active + 1, results.length - 1);
		scrollActiveIntoView();
		return;
	}

	if (event.key === "ArrowUp") {
		event.preventDefault();
		active = Math.max(active - 1, 0);
		scrollActiveIntoView();
		return;
	}

	if (event.key === "Enter") {
		event.preventDefault();
		void handleEnter();
	}
}

function scrollActiveIntoView() {
	void tick().then(() => {
		listEl?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
	});
}

function onGlobalKeydown(event: KeyboardEvent) {
	const isToggle = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k";
	if (isToggle) {
		event.preventDefault();
		if (open) hide();
		else show();
		return;
	}

	// 斜杠也能唤起，但别抢输入框里的斜杠
	if (event.key === "/" && !open) {
		const target = event.target as HTMLElement | null;
		if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
		event.preventDefault();
		show();
	}
}

const ACTIONS = (): Entry[] => [
	{
		kind: "action",
		title: "新建笔记：复制 frontmatter",
		subtitle: "把当前输入当成标题，生成一份带日期的骨架",
		run: async () => {
			const title = query.trim() || "新笔记";
			const ok = await copy(newNoteTemplate(title));
			flash(ok ? `已复制：${title}` : "复制失败");
		},
	},
	{
		kind: "action",
		title: "复制当前页链接",
		run: async () => {
			const ok = await copy(window.location.href);
			flash(ok ? "链接已复制" : "复制失败");
		},
	},
	{
		kind: "action",
		title: "问 AI 助手",
		subtitle: "侧边栏打开，基于当前这篇笔记回答",
		run: () => {
			hide();
			window.dispatchEvent(new CustomEvent("ask:open"));
		},
	},
	{
		kind: "action",
		title: "打开站内全文搜索",
		subtitle: "交给 Pagefind，适合只记得正文关键词的情况",
		run: () => {
			hide();
			const toggle = document.getElementById("search-switch") as HTMLElement | null;
			toggle?.click();
		},
	},
];

onMount(() => {
	window.addEventListener("keydown", onGlobalKeydown);

	fetch(url("/post-index.json"))
		.then((response) => (response.ok ? response.json() : []))
		.then((data: PostIndexItem[]) => {
			entries = [
				...ACTIONS(),
				...PAGES,
				...data.map((post) => ({
					kind: "note" as Kind,
					title: post.title,
					subtitle: [post.category, ...(post.tags ?? [])].filter(Boolean).join(" · "),
					href: post.url,
				})),
			];
			loaded = true;
		})
		.catch(() => {
			entries = [...ACTIONS(), ...PAGES];
			loaded = true;
		});

	return () => {
		window.removeEventListener("keydown", onGlobalKeydown);
		if (noteTimer) clearTimeout(noteTimer);
	};
});

$: results = open ? compute(query, entries) : [];
$: query, (active = 0);
</script>

{#if open}
	<div class="fixed inset-0 z-[120] flex items-start justify-center px-4 pt-[10vh]">
		<button
			class="absolute inset-0 bg-black/30 backdrop-blur-[2px] cursor-default"
			aria-label="关闭命令面板"
			on:click={hide}
		></button>

		<div
			class="relative w-full max-w-[40rem] rounded-[var(--radius-large)] bg-[var(--float-panel-bg)] shadow-2xl overflow-hidden"
			role="dialog"
			aria-modal="true"
			on:keydown={onKeydown}
		>
			<div class="flex items-center gap-3 px-5 h-14 border-b border-[var(--line-divider)]">
				<svg class="w-5 h-5 text-30 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<circle cx="11" cy="11" r="7"></circle>
					<path d="m20 20-3.5-3.5"></path>
				</svg>
				<input
					bind:this={inputEl}
					bind:value={query}
					placeholder="找题、跳页面，或者直接打字新建笔记…"
					class="flex-1 min-w-0 h-full bg-transparent outline-none text-[0.95rem] text-90 placeholder:text-30"
					autocomplete="off"
					spellcheck="false"
				/>
				<kbd class="kbd">ESC</kbd>
			</div>

			<div bind:this={listEl} class="max-h-[52vh] overflow-y-auto py-2">
				{#if !loaded}
					<p class="px-5 py-6 text-sm text-30">索引加载中…</p>
				{:else if results.length === 0}
					<div class="px-5 py-6">
						<p class="text-sm text-50 mb-1">没有匹配的题或页面</p>
						<p class="text-xs text-30">按 Enter 用「{query.trim()}」新建一篇笔记（复制 frontmatter 到剪贴板）</p>
					</div>
				{:else}
					{#each results as entry, i}
						<button
							data-index={i}
							class={`w-full text-left px-5 py-2.5 flex items-center gap-3 transition ${
								i === active ? "bg-[var(--btn-plain-bg-hover)]" : ""
							}`}
							on:mouseenter={() => (active = i)}
							on:click={() => choose(entry)}
						>
							<span
								class={`shrink-0 w-1.5 h-1.5 rounded-full ${
									entry.kind === "note" ? "bg-[var(--primary)]" : entry.kind === "page" ? "bg-black/20 dark:bg-white/25" : "bg-amber-400"
								}`}
							></span>
							<span class="min-w-0 flex-1">
								<span class={`block truncate text-sm ${i === active ? "text-[var(--primary)]" : "text-90"}`}>
									{entry.title}
								</span>
								{#if entry.subtitle}
									<span class="block truncate text-xs text-30">{entry.subtitle}</span>
								{/if}
							</span>
							<span class="shrink-0 text-[0.65rem] uppercase tracking-wider text-25">
								{entry.kind === "note" ? "题目" : entry.kind === "page" ? "页面" : "动作"}
							</span>
						</button>
					{/each}
				{/if}
			</div>

			<div class="flex items-center gap-4 px-5 h-10 text-[0.7rem] text-30 border-t border-[var(--line-divider)]">
				<span><kbd class="kbd">↑↓</kbd> 选择</span>
				<span><kbd class="kbd">Enter</kbd> 打开</span>
				<span><kbd class="kbd">⌘K</kbd> 开关</span>
				{#if note}
					<span class="ml-auto text-[var(--primary)]">{note}</span>
				{/if}
			</div>
		</div>
	</div>
{/if}

<style>
	.kbd {
		display: inline-block;
		padding: 0 0.28rem;
		border-radius: 0.25rem;
		background: var(--btn-plain-bg-hover);
		font-size: 0.68rem;
		line-height: 1.5;
		font-family: var(--code-font, ui-monospace);
	}
</style>
