/**
 * 评论区前端：拉列表、渲染楼中楼、分页、表单提交与各种异常态。
 *
 * 为什么挂在 Layout 里调用：全站用 swup 做局部页面切换，组件里的 <script>
 * 不会在切页时重跑，只有 Page 级脚本 + swup 的 page:view 钩子才能每次都挂上。
 *
 * 安全铁律：用户内容只经 textContent / createTextNode 落到 DOM，绝不拼 innerHTML。
 */

import { draftKey, formatRelative, linkify } from "./comment-utils.mjs";

type SwupLike = { hooks: { on: (event: string, callback: () => void) => void } };
type TurnstileLike = { reset: (widget?: string) => void };

// swup 的全局类型由 @swup/astro 提供，这里只借用最小形状，不重复声明 Window
function getSwup(): SwupLike | undefined {
	return (window as unknown as { swup?: SwupLike }).swup;
}

function getTurnstile(): TurnstileLike | undefined {
	return (window as unknown as { turnstile?: TurnstileLike }).turnstile;
}

type PublicComment = {
	id: number;
	name: string;
	website: string | null;
	content: string;
	createdAt: string;
	isAdmin: boolean;
	pinned: boolean;
	depth: number;
	replyTo?: string;
	replies?: PublicComment[];
};

type ListResponse = { items?: PublicComment[]; nextCursor?: string | null; error?: string };
type CreateResponse = { item?: PublicComment; status?: string; ok?: boolean; error?: string; retryAfter?: number };

const PAGE_SIZE = 20;
const FETCH_TIMEOUT = 10_000;
const DRAFT_NOTE = "恢复了你上次没发出去的内容";
const CONFIG = { turnstileSiteKey: "" };

let postIndexPromise: Promise<Record<string, string>> | null = null;
const activeControllers = new Set<AbortController>();

/** slug（URL 路径）→ 文章稳定键（entry.id） */
function loadPostIndex(): Promise<Record<string, string>> {
	if (!postIndexPromise) {
		postIndexPromise = fetch("/post-index.json")
			.then((response) => (response.ok ? response.json() : []))
			.then((rows: Array<{ url?: string; id?: string }>) => {
				const map: Record<string, string> = {};
				for (const row of rows ?? []) {
					const key = row?.url ? normalizePath(row.url) : "";
					if (key && row?.id) map[key] = row.id;
				}
				return map;
			})
			.catch(() => ({}));
	}
	return postIndexPromise;
}

function normalizePath(url: string): string {
	try {
		const parsed = new URL(url, window.location.origin);
		return parsed.pathname.endsWith("/") ? parsed.pathname : `${parsed.pathname}/`;
	} catch {
		return "";
	}
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

function setStatus(root: HTMLElement, message: string, tone: "info" | "error" = "info") {
	const box = root.querySelector<HTMLElement>("[data-comment-status]");
	if (!box) return;
	box.textContent = message;
	box.dataset.tone = message ? tone : "";
	box.classList.toggle("hidden", !message);
}

/** 正文：纯文本 + 自动链接，全部用 DOM API 组装 */
function renderContent(comment: PublicComment): HTMLElement {
	const body = el("div", "text-sm leading-relaxed whitespace-pre-wrap break-words text-black/75 dark:text-white/75");
	for (const part of linkify(comment.content)) {
		if (part.url) {
			const link = el("a", "text-[var(--primary)] hover:underline break-all", part.text);
			link.href = part.url;
			link.rel = "nofollow noopener ugc";
			link.target = "_blank";
			body.append(link);
		} else {
			body.append(document.createTextNode(part.text));
		}
	}
	return body;
}

function avatarFor(comment: PublicComment): HTMLElement {
	const badge = el("div", "shrink-0 w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold");
	const seed = Array.from(comment.name).reduce((sum, char) => sum + (char.codePointAt(0) ?? 0), 0);
	const hue = seed % 360;
	badge.style.background = `hsl(${hue} 55% 88%)`;
	badge.style.color = `hsl(${hue} 45% 32%)`;
	badge.textContent = comment.name.slice(0, 1).toUpperCase();
	return badge;
}

function commentHeader(comment: PublicComment): HTMLElement {
	const header = el("div", "flex items-center gap-2 flex-wrap mb-1.5");
	header.append(el("span", "text-sm font-bold text-black/85 dark:text-white/85", comment.name));

	if (comment.isAdmin) {
		header.append(el("span", "text-[0.7rem] px-1.5 py-0.5 rounded-md bg-[var(--primary)] text-white", "博主"));
	}
	if (comment.pinned) {
		header.append(
			el(
				"span",
				"text-[0.7rem] px-1.5 py-0.5 rounded-md bg-black/5 dark:bg-white/10 text-black/60 dark:text-white/60",
				"置顶",
			),
		);
	}
	if (comment.replyTo) {
		header.append(el("span", "text-xs text-black/40 dark:text-white/40", `回复 @${comment.replyTo}`));
	}
	header.append(el("span", "text-xs text-black/40 dark:text-white/40", formatRelative(comment.createdAt)));
	return header;
}

function renderComment(comment: PublicComment, onReply: (target: PublicComment) => void): HTMLElement {
	const item = el("article", "flex gap-3 py-4 border-b border-dashed border-[var(--line-divider)] last:border-b-0");
	item.dataset.commentId = String(comment.id);
	item.append(avatarFor(comment));

	const main = el("div", "flex-1 min-w-0");
	main.append(commentHeader(comment));
	main.append(renderContent(comment));

	const actions = el("div", "flex items-center gap-3 mt-2");
	const replyButton = el("button", "text-xs text-black/45 dark:text-white/45 hover:text-[var(--primary)] transition", "回复");
	replyButton.type = "button";
	replyButton.addEventListener("click", () => onReply(comment));
	actions.append(replyButton);
	main.append(actions);

	item.append(main);
	return item;
}

async function fetchJson<T>(url: string, init: RequestInit = {}): Promise<T> {
	const controller = new AbortController();
	activeControllers.add(controller);
	const timer = window.setTimeout(() => controller.abort(), FETCH_TIMEOUT);
	try {
		const response = await fetch(url, { ...init, signal: controller.signal });
		const body = (await response.json().catch(() => ({}))) as T & { error?: string };
		if (!response.ok) {
			const error = new Error(body?.error || "请求没成功") as Error & { status?: number; body?: unknown };
			error.status = response.status;
			error.body = body;
			throw error;
		}
		return body as T;
	} finally {
		window.clearTimeout(timer);
		activeControllers.delete(controller);
	}
}

// ---------------- 表单 ----------------

type FormState = {
	parentId: number | null;
	parentName: string;
	clientId: string;
	startedAt: number;
	submitting: boolean;
	cooldownUntil: number;
};

function newClientId(): string {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
	return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
		const random = (Math.random() * 16) | 0;
		const value = char === "x" ? random : (random & 0x3) | 0x8;
		return value.toString(16);
	});
}

function prefillFromCookie(root: HTMLElement) {
	// cookie 是 HttpOnly 的，前端读不到，这里只负责把草稿补回去
	void root;
}

function saveDraft(slug: string, data: { name: string; email: string; website: string; content: string }) {
	try {
		localStorage.setItem(draftKey(slug), JSON.stringify(data));
	} catch {
		// 隐私模式下写不了，忽略
	}
}

function readDraft(slug: string): { name?: string; email?: string; website?: string; content?: string } | null {
	try {
		const raw = localStorage.getItem(draftKey(slug));
		return raw ? JSON.parse(raw) : null;
	} catch {
		return null;
	}
}

function clearDraft(slug: string) {
	try {
		localStorage.removeItem(draftKey(slug));
	} catch {
		// 忽略
	}
}

async function setupForm(root: HTMLElement, slug: string, postId: string, onCreated: () => void) {
	const form = root.querySelector<HTMLFormElement>("[data-comment-form]");
	if (!form) return;

	const nameInput = form.querySelector<HTMLInputElement>("[name='name']");
	const emailInput = form.querySelector<HTMLInputElement>("[name='email']");
	const websiteInput = form.querySelector<HTMLInputElement>("[name='website']");
	const contentInput = form.querySelector<HTMLTextAreaElement>("[name='content']");
	const honeyInput = form.querySelector<HTMLInputElement>("[name='nickname2']");
	const submitButton = form.querySelector<HTMLButtonElement>("[type='submit']");
	const counter = form.querySelector<HTMLElement>("[data-comment-remaining]");
	const replyHint = root.querySelector<HTMLElement>("[data-reply-hint]");
	const replyName = root.querySelector<HTMLElement>("[data-reply-name]");
	const cancelReply = root.querySelector<HTMLButtonElement>("[data-reply-cancel]");
	const turnstileSlot = form.querySelector<HTMLElement>("[data-turnstile-slot]");

	const state: FormState = { parentId: null, parentName: "", clientId: newClientId(), startedAt: Date.now(), submitting: false, cooldownUntil: 0 };

	const refreshCounter = () => {
		if (!counter || !contentInput) return;
		counter.textContent = `${contentInput.value.length} / ${contentInput.maxLength > 0 ? contentInput.maxLength : 2000}`;
	};
	contentInput?.addEventListener("input", refreshCounter);
	refreshCounter();

	const draft = readDraft(slug);
	if (draft) {
		if (nameInput && draft.name) nameInput.value = draft.name;
		if (emailInput && draft.email) emailInput.value = draft.email;
		if (websiteInput && draft.website) websiteInput.value = draft.website;
		if (contentInput && draft.content) contentInput.value = draft.content;
		refreshCounter();
		setStatus(root, `${DRAFT_NOTE}，改完可以直接发。`);
	}

	const setReplyTarget = (id: number | null, name: string) => {
		state.parentId = id;
		state.parentName = name;
		replyHint?.classList.toggle("hidden", id === null);
		if (replyName) replyName.textContent = name;
		if (id !== null) contentInput?.focus();
	};

	cancelReply?.addEventListener("click", () => setReplyTarget(null, ""));

	root.addEventListener("comment:reply", (event) => {
		const detail = (event as CustomEvent<{ id: number; name: string }>).detail;
		setReplyTarget(detail.id, detail.name);
	});

	const setBusy = (busy: boolean, label?: string) => {
		state.submitting = busy;
		if (submitButton) {
			submitButton.disabled = busy;
			submitButton.textContent = busy ? (label ?? "发送中…") : "发表评论";
		}
	};

	const cooldown = (seconds: number) => {
		state.cooldownUntil = Date.now() + seconds * 1000;
		const tick = () => {
			const left = Math.ceil((state.cooldownUntil - Date.now()) / 1000);
			if (left > 0) {
				setStatus(root, `发得有点频繁，${left} 秒后再试。`, "error");
				if (submitButton) submitButton.disabled = true;
				window.setTimeout(tick, 1000);
				return;
			}
			setStatus(root, "");
			if (submitButton) submitButton.disabled = false;
		};
		tick();
	};

	form.addEventListener("submit", async (event) => {
		event.preventDefault();
		if (state.submitting) return;
		if (Date.now() < state.cooldownUntil) return;

		const name = nameInput?.value.trim() ?? "";
		const content = contentInput?.value.trim() ?? "";
		if (!name) {
			setStatus(root, "先留个昵称吧（最多 24 个字）。", "error");
			nameInput?.focus();
			return;
		}
		if (!content) {
			setStatus(root, "评论内容是空的。", "error");
			contentInput?.focus();
			return;
		}

		const turnstileToken =
			form.querySelector<HTMLInputElement>("[name='cf-turnstile-response']")?.value ?? "";

		setBusy(true);
		try {
			const data = await fetchJson<CreateResponse>("/api/comments", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					slug,
					postId,
					parentId: state.parentId,
					name,
					email: emailInput?.value.trim() ?? "",
					website: websiteInput?.value.trim() ?? "",
					content,
					clientId: state.clientId,
					honey: honeyInput?.value ?? "",
					elapsed: Date.now() - state.startedAt,
					turnstileToken,
				}),
			});

			if (data.status === "pending") {
				setStatus(root, "已提交，博主确认后就会显示。");
			} else {
				setStatus(root, "已发布。");
			}
			clearDraft(slug);
			if (contentInput) contentInput.value = "";
			refreshCounter();
			setReplyTarget(null, "");
			state.clientId = newClientId();
			state.startedAt = Date.now();
			getTurnstile()?.reset();
			onCreated();
		} catch (error) {
			const failure = error as Error & { status?: number; body?: CreateResponse };
			if (failure.status === 429) {
				cooldown(Number(failure.body?.retryAfter ?? 30));
				return;
			}
			saveDraft(slug, {
				name,
				email: emailInput?.value.trim() ?? "",
				website: websiteInput?.value.trim() ?? "",
				content,
			});
			setStatus(root, "没发出去，内容已暂存，刷新也不会丢。", "error");
		} finally {
			setBusy(false);
		}
	});

	// Turnstile：配了 site key 才加载（没配就靠蜜罐 + 频率限制）
	if (CONFIG.turnstileSiteKey && turnstileSlot) {
		const widget = el("div", "cf-turnstile");
		widget.dataset.sitekey = CONFIG.turnstileSiteKey;
		widget.dataset.theme = document.documentElement.classList.contains("dark") ? "dark" : "light";
		turnstileSlot.append(widget);
		const script = el("script");
		script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js";
		script.async = true;
		script.defer = true;
		document.head.append(script);
	}

	prefillFromCookie(root);
	form.dataset.ready = "true";
}

// ---------------- 列表与控制 ----------------

async function mountComments(): Promise<void> {
	const root = document.querySelector<HTMLElement>("section.comments");
	if (!root) return;

	const slug = normalizePath(root.dataset.slug || window.location.pathname);
	if (root.dataset.mountedFor === slug) return;
	root.dataset.mountedFor = slug;

	const list = root.querySelector<HTMLElement>("[data-comment-list]");
	const more = root.querySelector<HTMLButtonElement>("[data-comment-more]");
	const count = root.querySelector<HTMLElement>("[data-comment-count]");
	if (!list) return;

	list.replaceChildren();
	if (count) count.textContent = "";
	setStatus(root, "正在加载评论…");

	let postId = root.dataset.postId || "";
	if (!postId) {
		const index = await loadPostIndex();
		postId = index[slug] ?? "";
	}

	let nextCursor: string | null = null;
	let total = 0;

	const reply = (target: PublicComment) => {
		root.dispatchEvent(new CustomEvent("comment:reply", { detail: { id: target.id, name: target.name } }));
	};

	const appendItems = (items: PublicComment[]) => {
		for (const item of items) {
			list.append(renderComment(item, reply));
			total += 1;
			for (const child of item.replies ?? []) {
				const node = renderComment(child, reply);
				node.classList.add("pl-10");
				list.append(node);
				total += 1;
			}
		}
		if (count) count.textContent = total > 0 ? `${total} 条评论` : "";
	};

	const load = async (cursor?: string | null) => {
		const params = new URLSearchParams({ slug, limit: String(PAGE_SIZE) });
		if (postId) params.set("postId", postId);
		if (cursor) params.set("cursor", cursor);
		try {
			const data = await fetchJson<ListResponse>(`/api/comments?${params.toString()}`);
			setStatus(root, "");
			appendItems(data.items ?? []);
			nextCursor = data.nextCursor ?? null;
			if (more) more.classList.toggle("hidden", !nextCursor);
			if (total === 0) setStatus(root, "还没有评论，来坐第一排。");
		} catch (error) {
			const message =
				(error as Error).name === "AbortError" ? "网络有点慢，评论没加载出来" : "评论加载失败";
			setStatus(root, message, "error");
			showRetry(root, () => void refresh());
		}
	};

	const refresh = async () => {
		list.replaceChildren();
		total = 0;
		nextCursor = null;
		clearRetry(root);
		await load(null);
	};

	more?.addEventListener("click", () => {
		if (nextCursor) void load(nextCursor);
	});

	await setupForm(root, slug, postId, () => void refresh());
	await load(null);
}

function showRetry(root: HTMLElement, retry: () => void) {
	let button = root.querySelector<HTMLButtonElement>("[data-comment-retry]");
	if (!button) {
		button = el("button", "btn-card rounded-xl px-4 py-1.5 text-sm mt-2", "重试");
		button.type = "button";
		button.dataset.commentRetry = "1";
		root.querySelector("[data-comment-status]")?.after(button);
	}
	button.onclick = () => {
		clearRetry(root);
		retry();
	};
}

function clearRetry(root: HTMLElement) {
	root.querySelector("[data-comment-retry]")?.remove();
}

export function initComments(): void {
	const mount = () => {
		window.setTimeout(() => void mountComments(), 0);
	};

	const swup = getSwup();
	if (swup) {
		mount();
		swup.hooks.on("page:view", mount);
		swup.hooks.on("page:leave", () => {
			for (const controller of activeControllers) controller.abort();
			activeControllers.clear();
		});
	} else {
		document.addEventListener("swup:enable", mount);
		void mountComments();
	}
}

export function setTurnstileSiteKey(key: string): void {
	CONFIG.turnstileSiteKey = key;
}

