/**
 * 笔记页 AI 助手（侧边抽屉）
 *
 * 数据来源：POST /api/ask（SSE）。后端会自己跑 agent 循环：
 *   判断知识来源 → 需要时调工具（读笔记 / 站内检索 / 联网搜索 / 读网页）
 *   → 再想 → 边生成边吐。通用问题不会强制先读当前笔记。
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

/** 极简 Markdown：标题 / 列表 / 粗体 / 行内代码 / 代码块 / 链接，够聊天用
 *  partial=true 表示还在流式输出，代码块可能没写完：先补个围栏，
 *  免得半截 ``` 原样铺在正文里、下一帧又变回代码块（视觉上会抖）。 */
function renderMarkdown(source: string, partial = false): string {
	const html = escapeHtml(source);
	const escaped =
		partial && ((html.match(/```/g)?.length ?? 0) % 2 === 1)
			? `${html}\n\`\`\``
			: html;

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
			"顺便查一下最新的官方文档",
		];
	}
	return [
		"这个博客都写了什么？",
		"有哪些并发相关的笔记？",
		"最近 Cloudflare Workers 有什么更新？",
	];
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

	// 结构由 AskPanel.astro 固定提供；这里用非空断言，避免闭包里反复判空。
	const root = $("#ask")!;
	const panel = $("#ask-panel")!;
	const log = $("#ask-log")!;
	const form = $("#ask-form") as HTMLFormElement;
	const input = $("#ask-input") as HTMLTextAreaElement;
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
			// 换了笔记还在生成：停掉，旧上下文的回答留在旧页面没意义
			controller?.abort();
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
		status: HTMLElement;
		statusText: HTMLElement;
		/** 时间线：思考 / 工具 / 正文 按事件到达顺序往里排，顺序就是真实发生顺序 */
		flow: HTMLElement;
		sources: HTMLElement;
		meta: HTMLElement;
		/** 当前这段「过程」的灰色卡片；正文段会切断它，之后的过程再开新卡片 */
		card: HTMLElement | null;
		/** 当前这段思考（连续 delta 归一段，被别的动作打断就收口） */
		thinkEl: HTMLDetailsElement | null;
		thinkBody: HTMLElement | null;
		thinkText: string;
		/** 当前这段正文 */
		answerEl: HTMLElement | null;
		answerText: string;
		/** 整轮的全部正文（多段拼起来，用于记忆上一轮） */
		fullText: string;
		tools: Map<string, HTMLElement>;
		/** 还在流（决定要不要画光标），和全局 busy 解耦 */
		streaming: boolean;
	};

	const createTurn = (): TurnHandle => {
		turnSeq += 1;
		const rootEl = document.createElement("div");
		rootEl.className = "ask-turn";
		rootEl.dataset.turn = String(turnSeq);

		const status = document.createElement("div");
		status.className = "ask-status";
		status.innerHTML =
			'<span class="ask-dot"></span><span class="ask-status-text">正在连接…</span>';

		const flow = document.createElement("div");
		flow.className = "ask-flow";

		const sources = document.createElement("div");
		sources.className = "ask-sources";
		sources.hidden = true;

		const meta = document.createElement("div");
		meta.className = "ask-meta";

		rootEl.append(status, flow, sources, meta);
		log.appendChild(rootEl);
		scrollToBottom(log);

		return {
			root: rootEl,
			status,
			statusText: status.querySelector(".ask-status-text") as HTMLElement,
			flow,
			sources,
			meta,
			card: null,
			thinkEl: null,
			thinkBody: null,
			thinkText: "",
			answerEl: null,
			answerText: "",
			fullText: "",
			tools: new Map(),
			streaming: true,
		};
	};

	/** 过程行（思考 / 工具）落进当前灰卡片；没有就新开一张 */
	const ensureCard = (handle: TurnHandle): HTMLElement => {
		if (handle.card) return handle.card;
		const card = document.createElement("div");
		card.className = "ask-steps";
		handle.flow.appendChild(card);
		handle.card = card;
		return card;
	};

	/** 收口当前思考段：写回字数摘要，默认折叠（读者手动点开过就不再自动折叠） */
	const closeThink = (handle: TurnHandle) => {
		const details = handle.thinkEl;
		if (!details) return;
		const chars = handle.thinkText.length;
		const summary = details.querySelector("summary");
		if (summary)
			summary.textContent = chars > 0 ? `思考过程（${chars} 字）` : "思考过程";
		if (details.dataset.touched !== "true") details.open = false;
		handle.thinkEl = null;
		handle.thinkBody = null;
		handle.thinkText = "";
	};

	/** 收口当前正文段：撤掉光标，之后再来正文会另起一段（保持时间线顺序） */
	const closeAnswer = (handle: TurnHandle) => {
		if (!handle.answerEl) return;
		for (const caret of Array.from(
			handle.answerEl.querySelectorAll(".ask-caret"),
		))
			caret.remove();
		// 模型有时先吐几个换行再调工具：空白段留着会多出一道空行，直接丢掉
		if (!handle.answerText.trim()) handle.answerEl.remove();
		handle.answerEl = null;
		handle.answerText = "";
	};

	const appendThinking = (handle: TurnHandle, delta: string) => {
		if (!handle.thinkEl) {
			closeAnswer(handle);
			const details = document.createElement("details");
			details.className = "ask-think";
			details.open = true;
			const summary = document.createElement("summary");
			summary.textContent = "思考过程";
			const body = document.createElement("div");
			body.className = "ask-think-body";
			details.append(summary, body);
			// 只认「人点了」：toggle 事件对脚本改 open 也会触发，用它判断会永远判成用户操作
			summary.addEventListener("click", () => {
				details.dataset.touched = "true";
			});
			ensureCard(handle).appendChild(details);
			handle.thinkEl = details;
			handle.thinkBody = body;
			handle.thinkText = "";
		}
		handle.thinkText += delta;
		if (handle.thinkBody) {
			handle.thinkBody.textContent = handle.thinkText;
			handle.thinkBody.scrollTop = handle.thinkBody.scrollHeight;
		}
	};

	/** 开一段新正文：切断当前灰卡片，保证后面的思考/工具排在正文之后 */
	const openAnswer = (handle: TurnHandle) => {
		if (handle.answerEl) return;
		closeThink(handle);
		handle.card = null;
		const el = document.createElement("div");
		el.className = "ask-answer";
		handle.flow.appendChild(el);
		handle.answerEl = el;
		handle.answerText = "";
	};

	const updateTool = (handle: TurnHandle, event: Record<string, unknown>) => {
		const id = event.id === undefined || event.id === null ? "" : String(event.id);
		const running = event.state === "running";
		let row = id ? handle.tools.get(id) : undefined;
		// 同一个 id 又被 running 一次 = 新的一次调用，不能覆盖上一行
		if (row && running && row.dataset.state !== "running") row = undefined;

		if (!row) {
			closeAnswer(handle);
			closeThink(handle);
			row = document.createElement("div");
			row.className = "ask-tool";
			row.dataset.state = "running";
			row.innerHTML =
				'<span class="ask-dot"></span><span class="ask-tool-name"></span><span class="ask-tool-args"></span><span class="ask-tool-summary"></span>';
			ensureCard(handle).appendChild(row);
			if (id) handle.tools.set(id, row);
		}

		const nameEl = row.querySelector(".ask-tool-name") as HTMLElement;
		const argsEl = row.querySelector(".ask-tool-args") as HTMLElement;
		const summaryEl = row.querySelector(".ask-tool-summary") as HTMLElement;

		nameEl.textContent = String(event.label ?? event.name ?? "工具");
		if (running) {
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
		items: {
			id?: string;
			kind?: string;
			title?: string;
			url?: string;
			cited?: boolean;
		}[],
		unmarked = false,
	) => {
		if (items.length === 0) return;
		handle.sources.hidden = false;
		handle.sources.innerHTML = "";

		const label = document.createElement("div");
		label.className = "ask-sources-label";
		label.textContent = unmarked
			? "参考过这些资料（正文未标注编号）"
			: "引用来源";
		handle.sources.appendChild(label);

		for (const item of items) {
			if (!item.url) continue;
			const link = document.createElement("a");
			link.href = item.url;
			link.title = item.url;
			link.dataset.kind = item.kind === "web" ? "web" : "note";
			link.dataset.cited = item.cited ? "true" : "false";

			if (item.id) {
				const id = document.createElement("span");
				id.className = "ask-source-id";
				id.textContent = `[${item.id}]`;
				link.appendChild(id);
			}

			const kind = document.createElement("span");
			kind.className = "ask-source-kind";
			kind.textContent = item.kind === "web" ? "网页" : "笔记";
			link.appendChild(kind);

			const title = document.createElement("span");
			title.textContent = item.title?.trim() || item.url;
			link.appendChild(title);
			handle.sources.appendChild(link);
		}
	};

	/** 重画当前这段正文。光标只跟着「还在流的这一段」走，由 handle.streaming 决定 */
	const flushAnswer = (handle: TurnHandle) => {
		const el = handle.answerEl;
		if (!el) return;
		const pinned = nearBottom(log);
		el.innerHTML = renderMarkdown(handle.answerText, handle.streaming);
		if (handle.streaming) {
			const caret = document.createElement("span");
			caret.className = "ask-caret";
			caret.setAttribute("aria-hidden", "true");
			const last = el.lastElementChild;
			if (last instanceof HTMLParagraphElement) last.appendChild(caret);
			else el.appendChild(caret);
		}
		if (pinned) scrollToBottom(log);
	};

	/** 收尾：不再画光标、折叠最后一段思考、灰卡片变淡。中途停止 / 报错 / 正常完成都走这里 */
	const finishTurn = (handle: TurnHandle) => {
		handle.streaming = false;
		closeThink(handle);
		if (handle.answerEl && !handle.answerText.trim()) {
			handle.answerEl.remove();
			handle.answerEl = null;
			handle.answerText = "";
		}
		flushAnswer(handle);
		for (const caret of Array.from(handle.root.querySelectorAll(".ask-caret")))
			caret.remove();
		// 多段正文时，最后一段才是正式回答；前面那些「我先查一下」压低一点
		const answers = Array.from(
			handle.flow.querySelectorAll<HTMLElement>(":scope > .ask-answer"),
		);
		answers.forEach((el, index) => {
			if (index < answers.length - 1) el.dataset.partial = "true";
			else delete el.dataset.partial;
		});
		for (const card of Array.from(handle.root.querySelectorAll(".ask-steps")))
			card.classList.add("is-done");
	};

	const appendError = (handle: TurnHandle, message: string) => {
		closeAnswer(handle);
		closeThink(handle);
		handle.card = null;
		const box = document.createElement("div");
		box.className = "ask-error";
		box.textContent = message;
		handle.flow.appendChild(box);
		if (nearBottom(log)) scrollToBottom(log);
	};

	const handleEvent = (raw: string, handle: TurnHandle): string => {
		let event: Record<string, unknown>;
		try {
			event = JSON.parse(raw);
		} catch {
			return "";
		}

		const type = String(event.type ?? "");

		if (type === "status") {
			handle.statusText.textContent = String(event.text ?? "处理中…");
			if (nearBottom(log)) scrollToBottom(log);
			return type;
		}

		if (type === "note") {
			const title = String(event.title ?? "");
			if (title && contextLabel) {
				contextLabel.textContent = `正在看：《${title}》`;
				contextLabel.title = title;
			}
			return type;
		}

		if (type === "tool") {
			updateTool(handle, event);
			return type;
		}

		if (type === "thinking") {
			const delta = String(event.delta ?? "");
			if (delta) {
				appendThinking(handle, delta);
				if (nearBottom(log)) scrollToBottom(log);
			}
			return type;
		}

		if (type === "text") {
			const delta = String(event.delta ?? "");
			if (!delta) return type;
			openAnswer(handle);
			handle.answerText += delta;
			handle.fullText += delta;
			return type;
		}

		if (type === "sources") {
			renderSources(
				handle,
				(event.items ?? []) as {
					id?: string;
					kind?: string;
					title?: string;
					url?: string;
					cited?: boolean;
				}[],
				event.unmarked === true,
			);
			return type;
		}

		if (type === "done") {
			handle.status.dataset.done = "true";
			handle.statusText.textContent = "完成";
			const ms = Number(event.ms ?? 0);
			const rounds = Number(event.rounds ?? 1);
			const model = String(event.model ?? "");
			const route = String(event.route ?? "general");
			const routeLabel: Record<string, string> = {
				general: "通用回答",
				notes: "站内笔记",
				web: "联网资料",
				mixed: "笔记 + 联网",
			};
			handle.meta.textContent = [
				routeLabel[route] ?? "",
				rounds > 1 ? `${rounds} 轮` : "",
				ms ? `${(ms / 1000).toFixed(1)}s` : "",
				model,
			]
				.filter(Boolean)
				.join(" · ");
			if (handle.fullText.trim()) {
				history.push({
					role: "assistant",
					content: handle.fullText.trim().slice(0, 1200),
				});
				while (history.length > MAX_HISTORY * 2) history.shift();
			}
			return type;
		}

		if (type === "error") {
			handle.status.dataset.done = "true";
			handle.statusText.textContent = "出错了";
			appendError(handle, String(event.message ?? "出了问题，稍后再试"));
			return type;
		}

		return type;
	};

	async function ask(question: string) {
		if (busy) return;
		setBusy(true);
		if (hint) hint.textContent = "正在生成…";
		$("#ask-welcome")?.classList.add("is-hidden");

		addUserMessage(question);
		history.push({ role: "user", content: question.slice(0, 800) });

		const handle = createTurn();
		const ctrl = new AbortController();
		controller = ctrl;
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
				signal: ctrl.signal,
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

				// 有的反代会把 \n 改写成 \r\n，统一一下再按空行切帧
				buffer += decoder.decode(value, { stream: true });
				buffer = buffer.replace(/\r\n/g, "\n");
				const blocks = buffer.split("\n\n");
				buffer = blocks.pop() ?? "";

				for (const block of blocks) {
					const line = block
						.split("\n")
						.find((item) => item.startsWith("data:"));
					if (!line) continue;
					const payload = line.slice(5).trim();
					if (!payload) continue;

					const type = handleEvent(payload, handle);
					// 正文按帧合并重画；思考是直接写 DOM，不用重画
					if (type === "text") scheduleFlush();
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
				appendError(handle, (error as Error)?.message ?? "网络不太行，稍后再试");
			}
		} finally {
			// 收尾统一走 finishTurn：撤掉光标、折叠最后一段思考、灰卡片变淡
			finishTurn(handle);
			if (controller === ctrl) controller = null;
			if (controller === null) {
				busy = false;
				setBusy(false);
			}
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
		// 正在生成时清空对话：先把请求掐掉，别在背后白烧 token
		controller?.abort();
		history = [];
		for (const node of Array.from(
			log.querySelectorAll(".ask-msg-user, .ask-turn"),
		))
			node.remove();
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
