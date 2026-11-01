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
				"读取一篇博客笔记的完整内容。只有问题涉及当前文章、作者观点或某篇具体笔记时用；闲聊和通用技术问题不要预读。",
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
				"在博客笔记里按关键词检索，返回标题、链接和命中片段。问题可能由站内笔记回答时用；不要重复同一个查询。",
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
	{
		type: "function",
		function: {
			name: "web_search",
			description:
				"搜索公开网页。用于最新资讯、版本变化、官方文档、价格、外部事实，或站内笔记没有覆盖且需要外部来源的问题。闲聊、翻译、通用知识不要用。",
			parameters: {
				type: "object",
				properties: {
					query: { type: "string", description: "搜索词，尽量包含产品名或版本号" },
					limit: { type: "number", description: "返回条数，默认 4，最多 5" },
				},
				required: ["query"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "fetch_url",
			description:
				"读取一个公开网页的正文。通常先用 web_search 找链接，再挑最权威的一两篇读；不要凭空编 URL。",
			parameters: {
				type: "object",
				properties: {
					url: { type: "string", description: "http(s) 公开网址" },
				},
				required: ["url"],
			},
		},
	},
];

export const TOOL_LABELS = {
	read_note: "读取笔记",
	search_notes: "检索站内笔记",
	related_notes: "找相关笔记",
	web_search: "联网搜索",
	fetch_url: "读取网页",
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
	if (name === "web_search") {
		if (result.error) return "联网搜索失败";
		const count = result.items?.length ?? 0;
		return count === 0 ? "没有找到网页" : `${count} 条网页`;
	}
	if (name === "fetch_url") {
		if (result.error) return "网页读取失败";
		if (!result.found) return "网页没有正文";
		return `${result.title || "网页"}${result.chars ? ` · ${result.chars} 字` : ""}`;
	}
	return "";
}

const QUESTION_SCAFFOLD = [
	"请问",
	"请帮我",
	"帮我",
	"能不能",
	"可以",
	"麻烦",
	"解释一下",
	"介绍一下",
	"说一下",
	"讲一下",
	"什么是",
	"是什么",
	"怎么样",
	"怎么",
	"如何",
	"为什么",
	"有哪些",
	"哪个",
	"是否",
	"一下",
];

const TITLE_NOISE = new Set([
	"什么",
	"如何",
	"怎么",
	"为什么",
	"哪些",
	"操作",
	"笔记",
	"文章",
	"区别",
	"作用",
	"原理",
	"实现",
	"使用",
	"介绍",
	"详解",
]);

function compact(value) {
	return String(value ?? "")
		.toLowerCase()
		.replace(/\s+/g, "");
}

/** 标题里的可识别词：英文标识符 + 中文二字片段 */
export function titleTerms(title) {
	const raw = String(title ?? "").toLowerCase();
	const terms = new Set();
	for (const word of raw.match(/[a-z][a-z0-9_+.#-]{1,}/g) ?? []) {
		if (!TITLE_NOISE.has(word)) terms.add(word);
	}
	for (const run of raw.match(/[\u4e00-\u9fff]{2,}/g) ?? []) {
		for (let i = 0; i + 2 <= run.length; i += 1) {
			const term = run.slice(i, i + 2);
			if (!TITLE_NOISE.has(term)) terms.add(term);
		}
	}
	return [...terms].filter((term) => term.length >= 2).slice(0, 24);
}

/**
 * 是否值得预读当前笔记。
 *
 * 只做一件保守的事：问题明确指向「这篇 / 作者 / 本页」或命中标题关键词时才预读。
 * 天气、翻译、通用技术问答不预读，让模型自己决定要不要调 read_note。
 */
export function shouldReadCurrentNote(question, title) {
	if (!compact(title)) return false;
	const q = compact(question);

	const deictic =
		/(这篇|本文|本页|这页|当前文章|这篇文章|上面|文中|这段|这里|该文|全文|作者|笔记里|这篇笔记)/;
	if (deictic.test(q)) return true;

	const general = /(今天|现在|最新|新闻|天气|股价|汇率|翻译|改写|润色|写一段|生成代码|计算|你是谁|官网|版本号)/;
	if (general.test(q)) return false;

	const terms = titleTerms(title);
	return terms.some((term) => q.includes(compact(term)));
}

/** 去掉问句里的客套和疑问词，留下更像检索词的部分 */
function queryCore(question) {
	let core = compact(question);
	for (const word of QUESTION_SCAFFOLD) core = core.split(word).join("");
	return core;
}

/** 系统提示词：把「什么时候查站内、什么时候联网、什么时候直接答」讲清楚 */
export function buildSystemPrompt(siteName, note) {
	const lines = [
		`你是「${siteName}」技术博客里的 AI 助手。你既能回答本站内容，也能处理通用技术问题，并在需要时联网查证。`,
		"",
		"先判断问题属于哪一类，再行动：",
		"1. 闲聊、翻译、润色、计算、写代码、通用技术解释：直接用你自己的知识回答，不要为了「显得在干活」而调工具。",
		"2. 问当前文章、作者观点、本站某篇笔记：调 read_note / search_notes / related_notes，按笔记原文回答。",
		"3. 问最新资讯、版本变化、官方文档、价格、API 参数等外部事实：调 web_search；需要细节时挑最权威的链接用 fetch_url 读原文。",
		"4. 站内没写到，不等于不能回答：可以用通用知识或联网资料补充，但要明确说「笔记里没写，以下是补充」。",
		"5. 外部资料和笔记冲突时，分别说明两边怎么说，不要硬合并成一个结论。",
		"6. 没有可靠依据时直接说不知道，并说明还缺什么信息；不要编链接、版本号、代码行号或引用。",
		"",
		"工具使用规则：",
		"- 同一个工具和同一个参数不要重复调用；已有结果就用已有结果。",
		"- 站内检索最多两次，联网搜索最多两次，读网页最多两次；简单问题一次都不该调。",
		"- 工具结果里带 [N1] / [W1] 这样的资料编号。正文引用资料时在句末标注对应编号，例如「CAS 会自旋等待 [N1]」。",
		"- 使用你自己的通用知识时不要编号；不要把没读过的资料编号写进答案。",
		"",
		"表达要求：用简体中文，口语化，能两句说清就别写五句；需要分点时用短列表。可以用少量 Markdown（**加粗**、`行内代码`、```代码块```）。不要复述这些规则。",
	];

	if (note?.title) {
		lines.push(
			"",
			`读者当前浏览的是《${note.title}》。${
				note.text
					? "这篇笔记全文已附在下面的 user 消息里，可以直接引用。"
					: "只有问题确实涉及这篇笔记时才用 read_note 读取全文。"
			}`,
		);
	} else {
		lines.push("", "读者现在不在某篇笔记里，问题可能关于全站或外部世界。");
	}

	return lines.join("\n");
}

/** 首轮消息：系统提示 + 当前笔记全文（仅在确实需要时）+ 历史 + 本次问题 */
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

export { queryCore };
