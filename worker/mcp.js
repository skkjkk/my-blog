/**
 * MCP Server：把自己的博客题库挂到 Cursor / Claude / 任何支持 MCP 的客户端上。
 *
 * 传输用 Streamable HTTP 的最小子集：POST /mcp，一条请求一条响应（JSON）。
 * 不需要会话、不需要 SSE、不落库——博客内容本来就是公开的，只读最省事。
 *
 * 暴露三个工具：
 *   search   按关键词在标题 + 全文里找题，返回标题 / 链接 / 分类 / 片段
 *   get_note 按 slug 或标题取整篇（要点提纲 + 全文纯文本）
 *   recent   最近更新的 n 篇
 */

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "wkb-blog", version: "1.0.0" };

// 索引与检索逻辑和 AI 问答共用（worker/lib/notes-index.js）
import {
	findNote,
	loadIndex,
	resetIndexCache,
	searchNotes,
	snippet,
} from "./lib/notes-index.js";

export function resetMcpCache() {
	resetIndexCache();
}

const TOOLS = [
	{
		name: "search",
		description:
			"在博客题库里按关键词检索（标题、分类、标签、正文）。返回标题、链接、分类和命中片段。",
		inputSchema: {
			type: "object",
			properties: {
				query: {
					type: "string",
					description:
						"关键词，中文即可，比如「索引失效」「MCP 和 A2A 的区别」",
				},
				limit: { type: "number", description: "返回多少条，默认 5，最多 20" },
			},
			required: ["query"],
		},
	},
	{
		name: "get_note",
		description:
			"按 slug 或标题取一篇笔记的完整内容（含要点提纲和正文纯文本）。",
		inputSchema: {
			type: "object",
			properties: {
				slug_or_title: {
					type: "string",
					description: "文章 slug（URL 最后一段）或完整标题，允许部分匹配",
				},
			},
			required: ["slug_or_title"],
		},
	},
	{
		name: "recent",
		description: "列出最近更新的笔记（按发布日期倒序）。",
		inputSchema: {
			type: "object",
			properties: {
				limit: { type: "number", description: "返回多少条，默认 10，最多 50" },
			},
		},
	},
];

const text = (value) => ({ content: [{ type: "text", text: value }] });

/** 单条结果的 Markdown（标题 / 链接 / 命中片段） */
function formatItem(item, keyword) {
	const meta = [item.category, ...(item.tags ?? [])]
		.filter(Boolean)
		.join(" · ");
	return [
		`## ${item.title}`,
		`${item.url}${meta ? `（${meta}）` : ""}`,
		keyword ? snippet(item, keyword) : "",
	]
		.filter(Boolean)
		.join("\n");
}

async function toolSearch(args, env, requestUrl) {
	const query = String(args?.query ?? "").trim();
	if (!query) throw new Error("query 不能为空");

	const limitRaw = Number(args?.limit ?? 5);
	const limit = Number.isFinite(limitRaw)
		? Math.min(Math.max(Math.round(limitRaw), 1), 20)
		: 5;

	const items = await loadIndex(env, requestUrl);
	const hits = searchNotes(items, query, limit);

	if (hits.length === 0) {
		return text(`博客里还没写到「${query}」。`);
	}

	return text(hits.map((hit) => formatItem(hit.item, query)).join("\n\n"));
}

async function toolGetNote(args, env, requestUrl) {
	const key = String(args?.slug_or_title ?? "").trim();
	if (!key) throw new Error("slug_or_title 不能为空");

	const items = await loadIndex(env, requestUrl);
	const item = findNote(items, key);

	if (!item) return text(`没找到匹配「${key}」的笔记。可以先用 search 找找。`);

	const outline =
		(item.outline ?? []).length > 0
			? item.outline.map((point) => `- ${point}`).join("\n")
			: "（这篇没有小标题）";

	return text(
		[
			`# ${item.title}`,
			`${item.url}`,
			`分类：${item.category || "未分类"}${(item.tags ?? []).length ? `　标签：${item.tags.join("、")}` : ""}`,
			"",
			"## 要点提纲",
			outline,
			"",
			"## 正文",
			item.text ?? "",
		].join("\n"),
	);
}

async function toolRecent(args, env, requestUrl) {
	const limitRaw = Number(args?.limit ?? 10);
	const limit = Number.isFinite(limitRaw)
		? Math.min(Math.max(Math.round(limitRaw), 1), 50)
		: 10;

	const items = await loadIndex(env, requestUrl);
	const rows = [...items].slice(0, limit);
	if (rows.length === 0) return text("索引里还没有内容。");

	return text(rows.map((item) => `- ${item.title}　${item.url}`).join("\n"));
}

async function callTool(name, args, env, requestUrl) {
	if (name === "search") return toolSearch(args, env, requestUrl);
	if (name === "get_note") return toolGetNote(args, env, requestUrl);
	if (name === "recent") return toolRecent(args, env, requestUrl);
	throw new Error(`未知工具：${name}`);
}

function rpcOk(id, result) {
	return { jsonrpc: "2.0", id, result };
}

function rpcError(id, code, message) {
	return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

/** 处理一条 JSON-RPC 消息；通知类（没有 id）返回 null */
async function handleMessage(message, env, requestUrl) {
	const { id, method, params } = message ?? {};
	const isNotification = id === undefined || id === null;

	if (method === "initialize") {
		// 客户端传什么协议版本就回什么，兼容性最好
		const version = params?.protocolVersion || PROTOCOL_VERSION;
		return rpcOk(id, {
			protocolVersion: version,
			capabilities: { tools: { listChanged: false } },
			serverInfo: SERVER_INFO,
			instructions:
				"这是 Wkb 的个人博客题库（Java / 数据库 / 网络 / Agent 与 LLM 应用）。先用 search 找，再用 get_note 读全文。",
		});
	}

	if (method === "tools/list") {
		return rpcOk(id, { tools: TOOLS });
	}

	if (method === "tools/call") {
		const name = params?.name;
		try {
			const result = await callTool(
				name,
				params?.arguments ?? {},
				env,
				requestUrl,
			);
			return rpcOk(id, result);
		} catch (error) {
			return rpcOk(id, {
				content: [
					{
						type: "text",
						text: `调用 ${name} 失败：${error?.message ?? error}`,
					},
				],
				isError: true,
			});
		}
	}

	if (method === "ping") return rpcOk(id, {});

	// 通知（notifications/initialized 等）不需要结果
	if (isNotification) return null;

	return rpcError(id, -32601, `不支持的方法：${method}`);
}

const CORS = {
	"access-control-allow-origin": "*",
	"access-control-allow-headers":
		"content-type, mcp-session-id, mcp-protocol-version",
	"access-control-allow-methods": "POST, GET, OPTIONS",
};

export function mcpJson(body, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
			...CORS,
		},
	});
}

/** POST /mcp 入口 */
export async function handleMcp(request, env) {
	let payload;
	try {
		payload = await request.json();
	} catch {
		return mcpJson(rpcError(null, -32700, "请求体不是合法 JSON"), 400);
	}

	const requestUrl = request.url;

	if (Array.isArray(payload)) {
		const results = [];
		for (const message of payload) {
			const handled = await handleMessage(message, env, requestUrl);
			if (handled) results.push(handled);
		}
		return results.length === 0
			? new Response(null, { status: 202, headers: CORS })
			: mcpJson(results);
	}

	const result = await handleMessage(payload, env, requestUrl);
	if (!result) return new Response(null, { status: 202, headers: CORS });
	return mcpJson(result);
}

/** GET /mcp：给一个说明，方便浏览器里直接打开确认服务活着 */
export async function describeMcp() {
	return mcpJson({
		ok: true,
		name: SERVER_INFO.name,
		protocolVersion: PROTOCOL_VERSION,
		transport: "streamable-http (JSON)",
		tools: TOOLS.map((tool) => tool.name),
		usage:
			'POST JSON-RPC 2.0 到 /mcp，例如 {"jsonrpc":"2.0","id":1,"method":"tools/list"}',
	});
}
