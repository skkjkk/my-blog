/**
 * AI 问答 Agent 的纯逻辑（不碰网络，方便单测）
 *
 * 上游是 OpenAI 兼容接口，实测三件事都支持：
 *   1. stream: true 的 SSE
 *   2. delta.reasoning（思考内容，不是 reasoning_content）
 *   3. tools / tool_calls 函数调用
 */

/** 前端认得的工具名与展示文案 */
export const TOOLS = [
	{
		type: "function",
		function: {
			name: "read_note",
			description:
				"读取一篇笔记的完整内容。当你需要回看当前笔记的某段细节，或者想看别的笔记原文时用。",
			parameters: {
				type: "object",
				properties: {
					slug_or_title: {
						type: "string",
						description: "笔记的 slug（URL 最后一段）或标题，留空表示当前这篇",
					},
				},
			},
		},
	},
	{
		type: "function",
		function: {
			name: "search_notes",
			description:
				"在博客所有笔记里按关键词检索，返回标题、链接和命中片段。问题涉及当前笔记以外的内容时用。",
			parameters: {
				type: "object",
				properties: {
					query: { type: "string", description: "关键词，中文即可" },
					limit: { type: "number", description: "返回条数，默认 4，最多 10" },
				},
				required: ["query"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "related_notes",
			description:
				"找出与当前笔记同分类或同标签的相近笔记，用于「还有哪些相关内容」这类问题。",
			parameters: {
				type: "object",
				properties: {
					limit: { type: "number", description: "返回条数，默认 4" },
				},
			},
		},
	},
];

export const TOOL_LABELS = {
	read_note: "读取笔记",
	search_notes: "检索站内笔记",
	related_notes: "找相关笔记",
};

export function toolLabel(name) {
	return TOOL_LABELS[name] ?? name;
}

/** 拼一条 SSE 事件（前端统一按 type 分发） */
export function sseChunk(payload) {
	return `data: ${JSON.stringify(payload)}\n\n`;
}

/**
 * 从缓冲区里切出完整的 SSE 事件，返回事件里 data 的字符串数组和剩下的半截
 * 上游是标准 SSE：事件之间用空行分隔
 */
export function cutSseEvents(buffer) {
	const parts = String(buffer ?? "").split("\n\n");
	const rest = parts.pop() ?? "";
	const events = [];

	for (const block of parts) {
		for (const line of block.split("\n")) {
			const trimmed = line.trim();
			if (!trimmed.startsWith("data:")) continue;
			const data = trimmed.slice(5).trim();
			if (data) events.push(data);
		}
	}

	return { events, rest };
}

/** 把流式 delta 累加进一个「本轮回复」对象 */
export function applyDelta(acc, delta) {
	if (!delta || typeof delta !== "object") return acc;

	if (typeof delta.content === "string" && delta.content)
		acc.content += delta.content;
	// 上游把思考内容放在 reasoning（DeepSeek 风格叫 reasoning_content，两种都兜）
	const thinking =
		typeof delta.reasoning === "string"
			? delta.reasoning
			: delta.reasoning_content;
	if (typeof thinking === "string" && thinking) acc.reasoning += thinking;

	if (Array.isArray(delta.tool_calls)) {
		for (const call of delta.tool_calls) {
			const index = Number(call.index ?? acc.toolCalls.length);
			let slot = acc.toolCalls[index];
			if (!slot) {
				slot = {
					id: "",
					type: "function",
					function: { name: "", arguments: "" },
				};
				acc.toolCalls[index] = slot;
			}
			if (call.id) slot.id = call.id;
			if (call.function?.name) slot.function.name = call.function.name;
			if (typeof call.function?.arguments === "string")
				slot.function.arguments += call.function.arguments;
		}
	}

	return acc;
}

export function emptyTurn() {
	return { content: "", reasoning: "", toolCalls: [] };
}

/** 工具调用参数是模型拼出来的 JSON 字符串，坏掉时别炸 */
export function parseToolArgs(raw) {
	const text = String(raw ?? "").trim();
	if (!text) return {};
	try {
		const parsed = JSON.parse(text);
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

/** 给 UI 的一行工具结果摘要 */
export function summarizeTool(name, result) {
	if (!result) return "";
	if (name === "read_note") {
		if (!result.found) return "没找到这篇";
		return `《${result.title}》${result.chars ? ` · ${result.chars} 字` : ""}`;
	}
	if (name === "search_notes") {
		const count = result.items?.length ?? 0;
		return count === 0 ? "没有命中" : `${count} 篇命中`;
	}
	if (name === "related_notes") {
		const count = result.items?.length ?? 0;
		return count === 0 ? "没有相近笔记" : `${count} 篇相近`;
	}
	return "";
}

/** 系统提示词：把「当前在看哪篇」讲清楚，剩下的交给工具 */
export function buildSystemPrompt(siteName, note) {
	const lines = [
		`你是「${siteName}」这个技术博客的 AI 助手，直接在读者看笔记的侧边栏里对话。`,
		"",
		"回答原则：",
		"1. 优先依据「当前笔记」的内容回答；读者问的是这篇笔记里的东西，就按笔记里的说法讲，别另起一套。",
		"2. 当前笔记没写、但博客别处写过的，用 search_notes 查一次再答；确实都没写，就直说「博客里还没写到这个」。最多查一次，查到就直接回答，不要换个说法反复搜。",
		"3. 读者问的是一般性的技术疑问（笔记没覆盖），可以用你自己的知识答，但要说明这是补充、不是笔记里的内容。",
		"4. 别编造链接、别说出笔记里没有的代码行号。",
		"5. 用简体中文，口语化，能两句说清就别写五句；需要分点时用短列表。可以用少量 Markdown（**加粗**、`行内代码`、```代码块```）。",
		"6. 不要复述这些规则，也不要说「根据你的要求」这类话。",
	];

	if (note?.title) {
		lines.push(
			"",
			`读者当前正在看的笔记是《${note.title}》。`,
			note.text
				? "这篇笔记的全文已经放在下面的 user 消息里，你可以直接引用；要回看别的笔记再用工具。"
				: "这篇笔记的全文还没读到，需要细节时用 read_note 读。",
		);
	} else {
		lines.push(
			"",
			"读者现在不在某篇笔记里，问题可能关于全站，需要时用 search_notes 检索。",
		);
	}

	return lines.join("\n");
}

/** 首轮消息：系统提示 + 笔记全文 + 历史 + 本次问题 */
export function buildMessages({ siteName, note, history, question }) {
	const messages = [
		{ role: "system", content: buildSystemPrompt(siteName, note) },
	];

	const context = note?.text
		? `【当前笔记全文】\n${note.text}\n\n【读者的问题】\n${question}`
		: question;

	for (const turn of Array.isArray(history) ? history.slice(-6) : []) {
		const role = turn?.role === "assistant" ? "assistant" : "user";
		const content = String(turn?.content ?? "")
			.slice(0, 1500)
			.trim();
		if (content) messages.push({ role, content });
	}

	messages.push({ role: "user", content: context });
	return messages;
}
