/**
 * 后台「评论」卡片：加载待审列表、审核动作、博主回复、审核模式、屏蔽词。
 * 只在登录成功后由 admin 页面触发（监听 admin:console 事件）。
 *
 * 安全：所有内容用 textContent 渲染；操作按钮只发 id + 动作名。
 */

type AdminComment = {
	id: number;
	postId: string;
	slug: string;
	content: string;
	createdAt: string;
	status: string;
	isAdmin: boolean;
	pinned: boolean;
	reportCount: number;
	depth: number;
	name: string;
	parentId: number | null;
};

type AdminListResponse = {
	items?: AdminComment[];
	nextCursor?: string | null;
	stats?: { pending: number; approved: number; reported: number; today: number; total: number };
	mode?: string;
	error?: string;
};

const $ = <T extends Element = HTMLElement>(selector: string): T | null => document.querySelector<T>(selector);

let cursor: string | null = null;
let loading = false;
let initialised = false;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
	const response = await fetch(path, {
		...init,
		headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
	});
	const body = (await response.json().catch(() => ({}))) as T & { error?: string };
	if (!response.ok) throw new Error(body?.error ?? `请求失败（${response.status}）`);
	return body as T;
}

function setNote(message: string, isError = false) {
	const note = $("#cmt-note");
	if (!note) return;
	note.textContent = message;
	note.dataset.error = isError ? "1" : "";
}

function renderKpis(stats: AdminListResponse["stats"]) {
	const box = $("#cmt-kpis");
	if (!box) return;
	box.replaceChildren();
	const data = [
		{ label: "待审", value: stats?.pending ?? 0, tone: "warn" },
		{ label: "今日新增", value: stats?.today ?? 0, tone: "" },
		{ label: "被举报", value: stats?.reported ?? 0, tone: "warn" },
		{ label: "总计", value: stats?.total ?? 0, tone: "" },
	];
	for (const item of data) {
		const cell = el("div", `cmt-kpi${item.tone ? ` is-${item.tone}` : ""}`);
		cell.append(el("b", "", String(item.value)));
		cell.append(el("span", "", item.label));
		box.append(cell);
	}
	const badge = $("#cmt-pending-badge");
	if (badge) {
		const pending = stats?.pending ?? 0;
		badge.textContent = pending > 0 ? `待审 ${pending}` : "";
		badge.hidden = pending === 0;
	}
}

function setModeButtons(mode: string) {
	for (const button of document.querySelectorAll<HTMLButtonElement>("#cmt-mode button")) {
		button.classList.toggle("is-active", button.dataset.mode === mode);
	}
}

async function doAction(id: number, action: string) {
	try {
		await api("/api/admin/comments/action", { method: "POST", body: JSON.stringify({ id, action }) });
		setNote("");
		await loadComments(true);
	} catch (error) {
		setNote((error as Error).message, true);
	}
}

function renderRow(comment: AdminComment, titles: Map<string, string>): HTMLElement {
	const row = el("div", "cmt-row");
	row.dataset.id = String(comment.id);

	const head = el("div", "cmt-row-head");
	const check = el("input", "cmt-check") as HTMLInputElement;
	check.type = "checkbox";
	check.dataset.cmtCheck = "1";
	check.addEventListener("change", () => {
		row.classList.toggle("is-selected", check.checked);
		updateSelectedCount();
	});
	head.append(check);
	head.append(el("b", "", comment.name));
	if (comment.isAdmin) head.append(el("i", "cmt-tag", "博主"));
	if (comment.pinned) head.append(el("i", "cmt-tag", "置顶"));
	const statusText: Record<string, string> = {
		pending: "待审",
		approved: "已通过",
		spam: "垃圾",
		deleted: "已删除",
	};
	head.append(el("i", `cmt-status is-${comment.status}`, statusText[comment.status] ?? comment.status));
	if (comment.reportCount > 0) head.append(el("i", "cmt-tag is-warn", `被举报 ${comment.reportCount}`));
	const title = titles.get(comment.slug) ?? comment.postId;
	const link = el("a", "cmt-link", title);
	link.href = comment.slug;
	link.target = "_blank";
	link.rel = "noopener";
	head.append(link);
	head.append(el("span", "cmt-time", new Date(comment.createdAt).toLocaleString("zh-CN", { hour12: false })));
	row.append(head);

	row.append(el("p", "cmt-body", comment.content));

	const actions = el("div", "cmt-actions");
	const button = (label: string, handler: () => void) => {
		const node = el("button", "btn", label);
		node.type = "button";
		node.addEventListener("click", handler);
		actions.append(node);
		return node;
	};

	if (comment.status !== "approved") button("通过", () => void doAction(comment.id, "approve"));
	if (comment.status !== "spam") button("标为垃圾", () => void doAction(comment.id, "spam"));
	if (comment.status !== "deleted") button("删除", () => void doAction(comment.id, "delete"));
	if (comment.status === "deleted") button("恢复", () => void doAction(comment.id, "restore"));
	button(comment.pinned ? "取消置顶" : "置顶", () => void doAction(comment.id, comment.pinned ? "unpin" : "pin"));
	button("回复", () => toggleReply(row, comment));
	button("彻底删除", () => {
		if (window.confirm("彻底删除后无法恢复，确定吗？")) void doAction(comment.id, "hard_delete");
	});

	row.append(actions);
	return row;
}

function toggleReply(row: HTMLElement, comment: AdminComment) {
	const existing = row.querySelector(".cmt-reply");
	if (existing) {
		existing.remove();
		return;
	}
	const box = el("div", "cmt-reply");
	const input = el("textarea", "cmt-reply-input");
	input.rows = 3;
	input.placeholder = "以博主身份回复…";
	const send = el("button", "btn", "发送回复");
	send.type = "button";
	send.addEventListener("click", async () => {
		const content = input.value.trim();
		if (!content) {
			setNote("回复内容是空的", true);
			return;
		}
		send.disabled = true;
		try {
			await api("/api/admin/comments/reply", { method: "POST", body: JSON.stringify({ id: comment.id, content }) });
			setNote("回复已发布");
			await loadComments(true);
		} catch (error) {
			setNote((error as Error).message, true);
		} finally {
			send.disabled = false;
		}
	});
	box.append(input, send);
	row.append(box);
	input.focus();
}

async function loadTitles(): Promise<Map<string, string>> {
	try {
		const rows = (await (await fetch("/post-index.json")).json()) as Array<{ slug?: string; url?: string; title?: string }>;
		const map = new Map<string, string>();
		for (const row of rows) {
			if (!row.title) continue;
			if (row.url) map.set(row.url, row.title);
			if (row.slug) map.set(`/posts/${row.slug}/`, row.title);
		}
		return map;
	} catch {
		return new Map();
	}
}

function selectedIds(): number[] {
	return Array.from(document.querySelectorAll<HTMLInputElement>("[data-cmt-check]:checked"))
		.map((node) => Number(node.closest<HTMLElement>(".cmt-row")?.dataset.id ?? 0))
		.filter((id) => Number.isInteger(id) && id > 0);
}

function updateSelectedCount() {
	const note = $("#cmt-selected");
	if (note) note.textContent = `已选 ${selectedIds().length} 条`;
}

/** 批量操作一条一条发（D1 并发写同一张表容易冲突） */
async function runBatch(action: string) {
	const ids = selectedIds();
	if (ids.length === 0) {
		setNote("先勾选几条评论", true);
		return;
	}
	if (action === "delete" && !window.confirm(`确定删除选中的 ${ids.length} 条评论吗？`)) return;
	let failed = 0;
	for (const id of ids) {
		try {
			await api("/api/admin/comments/action", { method: "POST", body: JSON.stringify({ id, action }) });
		} catch {
			failed += 1;
		}
	}
	setNote(failed > 0 ? `${ids.length - failed} 条成功，${failed} 条失败` : `已处理 ${ids.length} 条`, failed > 0);
	await loadComments(true);
}

async function fillPostFilter(): Promise<void> {
	const select = $("#cmt-post") as HTMLSelectElement | null;
	if (!select || select.dataset.filled === "1") return;
	try {
		const rows = (await (await fetch("/post-index.json")).json()) as Array<{ slug?: string; url?: string; title?: string; id?: string }>;
		for (const row of rows) {
			if (!row.id || !row.title) continue;
			const option = el("option", "", row.title);
			option.value = row.id;
			select.append(option);
		}
		select.dataset.filled = "1";
	} catch {
		// 拿不到文章列表就不提供按文章筛选，不影响其它功能
	}
}

export async function loadComments(reset = false): Promise<void> {
	if (loading) return;
	loading = true;
	const list = $("#cmt-list");
	try {
		if (reset) cursor = null;
		const status = ($("#cmt-status") as HTMLSelectElement | null)?.value ?? "pending";
		const keyword = ($("#cmt-search") as HTMLInputElement | null)?.value.trim() ?? "";
		const postId = ($("#cmt-post") as HTMLSelectElement | null)?.value ?? "";
		const params = new URLSearchParams({ status, limit: "20" });
		if (keyword) params.set("q", keyword);
		if (postId) params.set("postId", postId);
		if (cursor && !reset) params.set("cursor", cursor);

		const titles = await loadTitles();
		const data = await api<AdminListResponse>(`/api/admin/comments?${params.toString()}`);
		renderKpis(data.stats);
		setModeButtons(data.mode ?? "auto");

		if (!list) return;
		if (reset || !cursor) list.replaceChildren();
		for (const item of data.items ?? []) list.append(renderRow(item, titles));

		cursor = data.nextCursor ?? null;
		const more = $("#cmt-more") as HTMLButtonElement | null;
		if (more) more.hidden = !cursor;
		if ((data.items ?? []).length === 0 && (reset || list.childElementCount === 0)) {
			list.append(el("p", "card-note", "这个筛选下没有评论。"));
		}
		setNote("");
	} catch (error) {
		setNote((error as Error).message, true);
	} finally {
		loading = false;
	}
}

async function loadKeywords(): Promise<void> {
	const box = $("#cmt-keywords");
	if (!box) return;
	try {
		const data = await api<{ items?: Array<{ id: number; word: string }> }>("/api/admin/comments/keywords");
		box.replaceChildren();
		for (const item of data.items ?? []) {
			const chip = el("span", "cmt-chip", item.word);
			const remove = el("button", "", "×");
			remove.type = "button";
			remove.addEventListener("click", async () => {
				try {
					await api(`/api/admin/comments/keywords?id=${item.id}`, { method: "DELETE" });
					await loadKeywords();
				} catch (error) {
					setNote((error as Error).message, true);
				}
			});
			chip.append(remove);
			box.append(chip);
		}
		if ((data.items ?? []).length === 0) box.append(el("span", "card-note", "还没有屏蔽词"));
	} catch (error) {
		setNote((error as Error).message, true);
	}
}

export function initAdminComments(): void {
	if (initialised) return;
	initialised = true;

	$("#cmt-refresh")?.addEventListener("click", () => void loadComments(true));
	$("#cmt-post")?.addEventListener("change", () => void loadComments(true));

	$("#cmt-select-all")?.addEventListener("change", (event) => {
		const checked = (event.target as HTMLInputElement).checked;
		for (const box of document.querySelectorAll<HTMLInputElement>("[data-cmt-check]")) {
			box.checked = checked;
			box.closest<HTMLElement>(".cmt-row")?.classList.toggle("is-selected", checked);
		}
		updateSelectedCount();
	});
	$("#cmt-batch-approve")?.addEventListener("click", () => void runBatch("approve"));
	$("#cmt-batch-delete")?.addEventListener("click", () => void runBatch("delete"));
	$("#cmt-status")?.addEventListener("change", () => void loadComments(true));
	$("#cmt-search")?.addEventListener("input", () => {
		window.clearTimeout((window as unknown as { __cmtTimer?: number }).__cmtTimer);
		(window as unknown as { __cmtTimer?: number }).__cmtTimer = window.setTimeout(() => void loadComments(true), 300);
	});
	$("#cmt-more")?.addEventListener("click", () => {
		cursor = cursor ?? null;
		void loadComments(false);
	});

	for (const button of document.querySelectorAll<HTMLButtonElement>("#cmt-mode button")) {
		button.addEventListener("click", async () => {
			const mode = button.dataset.mode ?? "auto";
			try {
				await api("/api/admin/comments/settings", { method: "POST", body: JSON.stringify({ mode }) });
				setModeButtons(mode);
				setNote(mode === "hold" ? "已切到「全部待审」" : "已切到「先发后审」");
			} catch (error) {
				setNote((error as Error).message, true);
			}
		});
	}

	$("#cmt-keyword-add")?.addEventListener("click", async () => {
		const input = $("#cmt-keyword-input") as HTMLInputElement | null;
		const word = input?.value.trim() ?? "";
		if (!word) return;
		try {
			await api("/api/admin/comments/keywords", { method: "POST", body: JSON.stringify({ word }) });
			if (input) input.value = "";
			await loadKeywords();
		} catch (error) {
			setNote((error as Error).message, true);
		}
	});

	window.addEventListener("admin:console", () => {
		void fillPostFilter();
		void loadComments(true);
		void loadKeywords();
	});

	const consolePanel = $("#console");
	if (consolePanel && !consolePanel.hidden) {
		void fillPostFilter();
		void loadComments(true);
		void loadKeywords();
	}
}

