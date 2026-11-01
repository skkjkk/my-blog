/**
 * 笔记页 AI 助手（侧边抽屉）
 *
 * 数据来源：POST /api/ask（SSE）。后端会自己跑 agent 循环：
 *   读当前笔记 → 模型思考（reasoning）→ 需要时调工具（read_note / search_notes / related_notes）
 *   → 再想 → 边生成边吐。
 *
 * 这里只负责：把每类事件画成对应 UI、保持自动滚动、能中途停止。
 */

import { track, visitorIds } from "./analytics";

type NoteRef = { slug: string; title: string; url: string };
type HistoryTurn = { role: "user" | "assistant"; content: string };

const MAX_HISTORY = 6;

let booted = false;
let note: NoteRef | null = null;
let history: HistoryTurn[] = [];
let controller: AbortController | null = null;
let busy = false;
let turnSeq = 0;

const $ = <T extends Element = HTMLElement>(sel: string): T | null =>
	document.querySelector<T>(sel);

function escapeHtml(value: string): string {
	return String(value ?? "").replace(
		/[<>&"]/g,
		(char) =>
			({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[char] ?? char,
	);
}

function formatInline(text: string): string {
	return text
		.replace(/`([^`]+)`/g, "<code>$1</code>")
		.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
		.replace(
			/\[([^\]]+)\]\(([^)\s]+)\)/g,
			(_match, label: string, href: string) => {
				const safe = /^(https?:\/\/|\/)/i.test(href) ? href : "#";
				return `<a href="${safe}" target="_blank" rel="noopener noreferrer">${label}</a>`;
			},
		);
}

/** 极简 Markdown：标题 / 列表 / 粗体 / 行内代码 / 代码块 / 链接，够聊天用 */
function renderMarkdown(source: string): string {
	const escaped = escapeHtml(source);

	const block = (text: string): string => {
		const lines = text.split("\n");
		const out: string[] = [];
		let list: "ul" | "ol" | null = null;

		const closeList = () => {
			if (list) {
				out.push(`</${list}>`);
				list = null;
			}
		};

		for (const raw of lines) {
			const line = raw.trimEnd();
			if (!line.trim()) {
				closeList();
				continue;
			}

			const heading = line.match(/^#{1,6}\s+(.*)$/);
			if (heading) {
				closeList();
				out.push(`<h4>${formatInline(heading[1])}</h4>`);
				continue;
			}

			const bullet = line.match(/^\s*[-*]\s+(.*)$/);
			const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
			if (bullet || ordered) {
				const kind: "ul" | "ol" = bullet ? "ul" : "ol";
				if (list !== kind) {
					closeList();
					out.push(`<${kind}>`);
					list = kind;
				}
				out.push(`<li>${formatInline((bullet ?? ordered)?.[1] ?? "")}</li>`);
				continue;
			}

			closeList();
			out.push(`<p>${formatInline(line)}</p>`);
		}

		closeList();
		return out.join("");
	};

	const chunks: string[] = [];
	const fence = /```([a-z0-9+#-]*)\n?([\s\S]*?)```/gi;
	let cursor = 0;
	let match = fence.exec(escaped);

	while (match) {
		chunks.push(block(escaped.slice(cursor, match.index)));
		chunks.push(`<pre><code>${match[2].replace(/\n$/, "")}</code></pre>`);
		cursor = match.index + match[0].length;
		match = fence.exec(escaped);
	}
	chunks.push(block(escaped.slice(cursor)));

	return chunks.join("");
}

function readNote(): NoteRef | null {
	const el = document.querySelector<HTMLElement>("#note-context");
	if (!el?.dataset?.slug) return null;
	return {
		slug: el.dataset.slug ?? "",
		title: el.dataset.title ?? "",
		url: el.dataset.url ?? "",
	};
}

function suggestionsFor(current: NoteRef | null): string[] {
	if (current) {
		return [
			"这篇讲了什么？",
			"用一句话概括",
			"有哪些容易踩的坑？",
			"还有哪些相关的笔记？",
		];
	}
	return ["这个博客都写了什么？", "有哪些并发相关的笔记？", "怎么刷题？"];
}

function nearBottom(log: HTMLElement): boolean {
	return log.scrollHeight - log.scrollTop - log.clientHeight < 90;
}

function scrollToBottom(log: HTMLElement) {
	log.scrollTop = log.scrollHeight;
}

export function initAskPanel(): void {
	if (booted) return;
	booted = true;

	const root = $("#ask");
	const panel = $("#ask-panel");
	const log = $("#ask-log");
	const form = $("#ask-form") as HTMLFormElement | null;
	const input = $("#ask-input") as HTMLTextAreaElement | null;
	const sendButton = $("#ask-send") as HTMLButtonElement | null;
	const stopButton = $("#ask-stop") as HTMLButtonElement | null;
	const hint = $("#ask-hint");
	const contextLabel = $("#ask-context");
	const scrim = $("#ask-scrim");
	const suggests = $("#ask-suggests");

	if (!root || !panel || !log || !form || !input) return;

	const setOpen = (open: boolean) => {
		const wasOpen = root.dataset.open === "true";
		root.dataset.open = open ? "true" : "false";
		panel.setAttribute("aria-hidden", open ? "false" : "true");
		$("#ask-fab")?.setAttribute("aria-expanded", open ? "true" : "false");
		if (scrim) scrim.hidden = !open || window.innerWidth > 640;
		if (open) {
			// 面板打开是漏斗的第二级：只在真正从关到开时记一次
			if (!wasOpen)
				track("panel_open", { path: note?.url || window.location.pathname });
			window.setTimeout(() => {
				input.focus();
				scrollToBottom(log);
			}, 220);
		}
	};

	const openPanel = () => setOpen(true);

	/** 切换笔记时清空对话：上下文变了，接着聊会串味 */
	const syncNote = (reset: boolean) => {
		const next = readNote();
		const changed = (next?.slug ?? "") !== (note?.slug ?? "");
		note = next;

		if (contextLabel) {
			contextLabel.textContent = note
				? `正在看：《${note.title}》`
				: "全站问答";
			contextLabel.title = note?.title ?? "";
		}
		if (suggests) {
			suggests.innerHTML = "";
			for (const text of suggestionsFor(note)) {
				const chip = document.createElement("button");
				chip.type = "button";
				chip.className = "ask-chip";
				chip.textContent = text;
				chip.addEventListener("click", () => {
					input.value = text;
					void submit();
				});
				suggests.appendChild(chip);
			}
		}

		if (changed && reset) {
			history = [];
			for (const node of Array.from(
				log.querySelectorAll(".ask-msg-user, .ask-turn"),
			))
				node.remove();
			resetHint();
		}
	};

	const resetHint = () => {
		if (hint) hint.textContent = "";
	};

	const setBusy = (value: boolean) => {
		busy = value;
		if (sendButton) sendButton.disabled = value;
		if (stopButton) stopButton.hidden = !value;
	};

	const addUserMessage = (text: string) => {
		const bubble = document.createElement("div");
		bubble.className = "ask-msg-user";
		bubble.textContent = text;
		log.appendChild(bubble);
		scrollToBottom(log);
	};

	type TurnHandle = {
		root: HTMLElement;
		steps: HTMLElement;
		status: HTMLElement;
		statusText: HTMLElement;
		toolBox: HTMLElement;
		think: HTMLDetailsElement;
		thinkBody: HTMLElement;
		answer: HTMLElement;
		sources: HTMLElement;
		meta: HTMLElement;
		tools: Map<string, HTMLElement>;
		answerText: string;
		thinkingText: string;
		firstTokenShown: boolean;
	};

	const createTurn = (): TurnHandle => {
		turnSeq += 1;
		const rootEl = document.createElement("div");
		rootEl.className = "ask-turn";
		rootEl.dataset.turn = String(turnSeq);

		const steps = document.createElement("div");
		steps.className = "ask-steps";

		const status = document.createElement("div");
		status.className = "ask-step";
		status.innerHTML =
			'<span class="ask-dot"></span><span class="ask-step-text">正在连接…</span>';

		const toolBox = document.createElement("div");
		toolBox.className = "ask-tool-box";

		const think = document.createElement("details");
		think.className = "ask-think";
		think.open = true;
		const summary = document.createElement("summary");
		summary.textContent = "思考过程";
		const thinkBody = document.createElement("div");
		thinkBody.className = "ask-think-body";
		think.append(summary, thinkBody);
		think.hidden = true;

		steps.append(status, toolBox, think);

		const answer = document.createElement("div");
		answer.className = "ask-answer";

		const sources = document.createElement("div");
		sources.className = "ask-sources";
		sources.hidden = true;

		const meta = document.createElement("div");
		meta.className = "ask-meta";

		rootEl.append(steps, answer, sources, meta);
		log.appendChild(rootEl);
		scrollToBottom(log);

		return {
			root: rootEl,
			steps,
			status,
			statusText: status.querySelector(".ask-step-text") as HTMLElement,
			toolBox,
			think,
			thinkBody,
			answer,
			sources,
			meta,
			tools: new Map(),
			answerText: "",
			thinkingText: "",
			firstTokenShown: false,
		};
	};

	const updateTool = (handle: TurnHandle, event: Record<string, unknown>) => {
		const id = String(event.id ?? Math.random());
		let row = handle.tools.get(id);

		if (!row) {
			row = document.createElement("div");
			row.className = "ask-tool";
			row.dataset.state = "running";
			row.innerHTML =
				'<span class="ask-dot"></span><span class="ask-tool-name"></span><span class="ask-tool-args"></span><span class="ask-tool-summary"></span>';
			handle.toolBox.appendChild(row);
			handle.tools.set(id, row);
		}

		const nameEl = row.querySelector(".ask-tool-name") as HTMLElement;
		const argsEl = row.querySelector(".ask-tool-args") as HTMLElement;
		const summaryEl = row.querySelector(".ask-tool-summary") as HTMLElement;

		nameEl.textContent = String(event.label ?? event.name ?? "工具");
		if (event.state === "running") {
			const args = (event.args ?? {}) as Record<string, unknown>;
			const brief = Object.entries(args)
				.map(([key, value]) => `${key}=${String(value).slice(0, 24)}`)
				.join(" ");
			argsEl.textContent = brief;
			summaryEl.textContent = "";
			row.dataset.state = "running";
		} else {
			row.dataset.state = "done";
			argsEl.textContent = "";
			const ms = Number(event.ms ?? 0);
			summaryEl.textContent = `${String(event.summary ?? "")}${ms > 0 ? ` · ${ms}ms` : ""}`;
		}

		if (nearBottom(log)) scrollToBottom(log);
	};

	const renderSources = (
		handle: TurnHandle,
		items: { title?: string; url?: string }[],
	) => {
		if (items.length === 0) return;
		handle.sources.hidden = false;
		handle.sources.innerHTML = "";
		for (const item of items) {
			if (!item.url) continue;
			const link = document.createElement("a");
			link.href = item.url;
			link.textContent = item.title?.trim() || item.url;
			link.title = item.url;
			handle.sources.appendChild(link);
		}
	};

	const flushAnswer = (handle: TurnHandle) => {
		const pinned = nearBottom(log);
		handle.answer.innerHTML = renderMarkdown(handle.answerText);
		if (busy) {
			const caret = document.createElement("span");
			caret.className = "ask-caret";
			handle.answer.appendChild(caret);
		}
		if (pinned) scrollToBottom(log);
	};

	const handleEvent = (raw: string, handle: TurnHandle) => {
		let event: Record<string, unknown>;
		try {
			event = JSON.parse(raw);
		} catch {
			return;
		}

		const type = String(event.type ?? "");

		if (type === "status") {
			handle.statusText.textContent = String(event.text ?? "处理中…");
			if (nearBottom(log)) scrollToBottom(log);
			return;
		}

		if (type === "note") {
			const title = String(event.title ?? "");
			if (title && contextLabel) {
				contextLabel.textContent = `正在看：《${title}》`;
				contextLabel.title = title;
			}
			return;
		}

		if (type === "tool") {
			updateTool(handle, event);
			return;
		}

		if (type === "thinking") {
			handle.thinkingText += String(event.delta ?? "");
			handle.think.hidden = false;
			handle.thinkBody.textContent = handle.thinkingText;
			handle.thinkBody.scrollTop = handle.thinkBody.scrollHeight;
			if (nearBottom(log)) scrollToBottom(log);
			return;
		}

		if (type === "text") {
			handle.answerText += String(event.delta ?? "");
			if (!handle.firstTokenShown) {
				handle.firstTokenShown = true;
				handle.status.dataset.done = "true";
				handle.statusText.textContent = "已想好，开始回答";
				handle.think.open = false;
				if (handle.thinkingText) {
					const summary = handle.think.querySelector("summary");
					if (summary)
						summary.textContent = `思考过程（${handle.thinkingText.length} 字，点开看）`;
				}
			}
			flushAnswer(handle);
			return;
		}

		if (type === "sources") {
			renderSources(
				handle,
				(event.items ?? []) as { title?: string; url?: string }[],
			);
			return;
		}

		if (type === "done") {
			handle.status.dataset.done = "true";
			handle.statusText.textContent = "完成";
			const ms = Number(event.ms ?? 0);
			const rounds = Number(event.rounds ?? 1);
			const model = String(event.model ?? "");
			handle.meta.textContent = [
				rounds > 1 ? `${rounds} 轮` : "",
				ms ? `${(ms / 1000).toFixed(1)}s` : "",
				model,
			]
				.filter(Boolean)
				.join(" · ");
			if (handle.answerText.trim()) {
				history.push({
					role: "assistant",
					content: handle.answerText.trim().slice(0, 1200),
				});
				while (history.length > MAX_HISTORY * 2) history.shift();
			}
			return;
		}

		if (type === "error") {
			handle.status.dataset.done = "true";
			handle.statusText.textContent = "出错了";
			const box = document.createElement("div");
			box.className = "ask-error";
			box.textContent = String(event.message ?? "出了问题，稍后再试");
			handle.answer.appendChild(box);
			if (nearBottom(log)) scrollToBottom(log);
		}
	};

	async function ask(question: string) {
		if (busy) return;
		setBusy(true);
		if (hint) hint.textContent = "正在生成…";
		$("#ask-welcome")?.classList.add("is-hidden");

		addUserMessage(question);
		history.push({ role: "user", content: question.slice(0, 800) });

		const handle = createTurn();
		controller = new AbortController();
		let raf = 0;

		const scheduleFlush = () => {
			if (raf) return;
			raf = requestAnimationFrame(() => {
				raf = 0;
				flushAnswer(handle);
			});
		};

		try {
			const response = await fetch("/api/ask", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					question,
					note,
					history: history.slice(0, -1),
					...visitorIds(),
				}),
				signal: controller.signal,
			});

			if (!response.ok) {
				const detail = (await response.json().catch(() => ({}))) as {
					error?: string;
				};
				throw new Error(detail.error ?? `请求失败（${response.status}）`);
			}
			if (!response.body) throw new Error("浏览器不支持流式响应");

			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const blocks = buffer.split("\n\n");
				buffer = blocks.pop() ?? "";

				for (const block of blocks) {
					const line = block
						.split("\n")
						.find((item) => item.startsWith("data:"));
					if (!line) continue;
					const payload = line.slice(5).trim();
					if (!payload) continue;

					const type = payload.slice(0, 40);
					handleEvent(payload, handle);
					if (type.includes('"text"') || type.includes('"thinking"'))
						scheduleFlush();
				}
			}

			if (raf) cancelAnimationFrame(raf);
			flushAnswer(handle);
		} catch (error) {
			if ((error as Error)?.name === "AbortError") {
				handle.status.dataset.done = "true";
				handle.statusText.textContent = "已停止";
				const stopped = document.createElement("div");
				stopped.className = "ask-meta";
				stopped.textContent = "（已停止生成）";
				handle.root.appendChild(stopped);
			} else {
				handle.status.dataset.done = "true";
				handle.statusText.textContent = "出错了";
				const box = document.createElement("div");
				box.className = "ask-error";
				box.textContent = (error as Error)?.message ?? "网络不太行，稍后再试";
				handle.answer.appendChild(box);
			}
		} finally {
			handle.steps.classList.add("is-done");
			controller = null;
			if (busy) busy = false;
			setBusy(false);
			resetHint();
			if (nearBottom(log)) scrollToBottom(log);
		}
	}

	async function submit() {
		const question = input.value.trim();
		if (!question || busy) return;
		input.value = "";
		input.style.height = "auto";
		openPanel();
		await ask(question);
	}

	// ---------- 事件绑定 ----------
	$("#ask-fab")?.addEventListener("click", openPanel);
	$("#ask-close")?.addEventListener("click", () => setOpen(false));
	scrim?.addEventListener("click", () => setOpen(false));

	$("#ask-new")?.addEventListener("click", () => {
		history = [];
		for (const node of Array.from(
			log.querySelectorAll(".ask-msg-user, .ask-turn"),
		))
			node.remove();
		history.length = 0;
		resetHint();
		input.focus();
	});

	stopButton?.addEventListener("click", () => {
		controller?.abort();
	});

	form.addEventListener("submit", (event) => {
		event.preventDefault();
		void submit();
	});

	input.addEventListener("keydown", (event) => {
		if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
			event.preventDefault();
			void submit();
		}
	});

	input.addEventListener("input", () => {
		input.style.height = "auto";
		input.style.height = `${Math.min(input.scrollHeight, 112)}px`;
		if (hint && !busy) {
			hint.textContent =
				input.value.length > 420 ? `${input.value.length}/500` : "";
		}
	});

	document.addEventListener("keydown", (event) => {
		if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "j") {
			event.preventDefault();
			setOpen(root.dataset.open !== "true");
		} else if (event.key === "Escape" && root.dataset.open === "true") {
			setOpen(false);
		}
	});

	// ⌘K 命令面板里「问 AI 助手」走这个事件
	window.addEventListener("ask:open", () => {
		setOpen(true);
		input.focus();
	});

	// 切换页面（swup）后重新认一下当前笔记
	const onNavigate = () => {
		setOpen(root.dataset.open === "true");
		syncNote(true);
		if (scrim)
			scrim.hidden = !(
				root.dataset.open === "true" && window.innerWidth <= 640
			);
	};
	document.addEventListener("swup:page:view", onNavigate);
	document.addEventListener("astro:page-load", onNavigate);
	window.addEventListener("resize", () => {
		if (scrim)
			scrim.hidden = !(
				root.dataset.open === "true" && window.innerWidth <= 640
			);
	});

	syncNote(false);
	setBusy(false);
}
