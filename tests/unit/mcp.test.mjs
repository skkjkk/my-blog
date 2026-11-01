import test from "node:test";
import assert from "node:assert/strict";
import { createEnv, makeCaller } from "../support/d1.mjs";
import worker from "../../worker/index.js";
import { resetMcpCache } from "../../worker/mcp.js";

const call = makeCaller(worker);

const FIXTURE = {
	generatedAt: "2026-11-01T00:00:00.000Z",
	total: 3,
	items: [
		{
			slug: "mysql-index-fail",
			url: "/posts/mysql-index-fail/",
			title: "MySQL 索引失效的场景有哪些？",
			category: "数据库",
			tags: ["索引", "优化"],
			section: "note",
			outline: ["隐式类型转换", "函数包裹索引列"],
			text: "MySQL 索引失效常见于隐式类型转换、在索引列上使用函数、前导模糊匹配等情况。",
		},
		{
			slug: "java-cas",
			url: "/posts/java-cas/",
			title: "什么是 Java 的 CAS 操作？",
			category: "Java",
			tags: ["并发编程"],
			section: "note",
			outline: ["基本用法", "ABA 问题"],
			text: "CAS 是一条 CPU 级别的原子指令，比较并交换，是 JUC 原子类的基础。",
		},
		{
			slug: "mcp-vs-a2a",
			url: "/posts/mcp-vs-a2a/",
			title: "MCP 和 A2A 有什么区别？",
			category: "Agent与LLM应用",
			tags: ["协议"],
			section: "note",
			outline: ["定位不同"],
			text: "MCP 解决模型与工具的连接，A2A 解决 Agent 之间的协作。",
		},
	],
};

/** 造一个能返回 notes-full.json 的 ASSETS */
function envWithIndex(overrides = {}) {
	return createEnv({
		ASSETS: {
			fetch: async (request) => {
				const url = typeof request === "string" ? request : request.url;
				if (String(url).includes("/notes-full.json")) {
					return new Response(JSON.stringify(FIXTURE), {
						status: 200,
						headers: { "content-type": "application/json" },
					});
				}
				return new Response("asset", { status: 200 });
			},
		},
		...overrides,
	});
}

const rpc = (method, params, id = 1) => ({
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
});

test("MCP initialize 回协议版本与工具能力", async () => {
	resetMcpCache();
	const env = envWithIndex();

	const response = await call("/mcp", rpc("initialize", { protocolVersion: "2025-06-18" }), env);
	assert.equal(response.status, 200);

	const body = await response.json();
	assert.equal(body.jsonrpc, "2.0");
	assert.equal(body.result.protocolVersion, "2025-06-18", "客户端传的版本要原样回");
	assert.ok(body.result.capabilities.tools);
	assert.equal(body.result.serverInfo.name, "wkb-blog");
});

test("MCP tools/list 给出三个工具和合法 inputSchema", async () => {
	resetMcpCache();
	const env = envWithIndex();

	const body = await (await call("/mcp", rpc("tools/list"), env)).json();
	const tools = body.result.tools;

	assert.deepEqual(
		tools.map((tool) => tool.name).sort(),
		["get_note", "recent", "search"],
	);
	for (const tool of tools) {
		assert.equal(tool.inputSchema.type, "object");
		assert.ok(tool.description.length > 5);
	}
});

test("MCP search 命中标题与正文，返回标题和链接", async () => {
	resetMcpCache();
	const env = envWithIndex();

	const body = await (
		await call("/mcp", rpc("tools/call", { name: "search", arguments: { query: "索引" } }), env)
	).json();

	const text = body.result.content[0].text;
	assert.match(text, /MySQL 索引失效的场景有哪些/);
	assert.match(text, /\/posts\/mysql-index-fail\//);
});

test("MCP search 没命中时讲人话", async () => {
	resetMcpCache();
	const env = envWithIndex();

	const body = await (
		await call("/mcp", rpc("tools/call", { name: "search", arguments: { query: "量子计算" } }), env)
	).json();

	assert.match(body.result.content[0].text, /还没写到/);
});

test("MCP get_note 支持 slug 与标题模糊匹配", async () => {
	resetMcpCache();
	const env = envWithIndex();

	const bySlug = await (
		await call("/mcp", rpc("tools/call", { name: "get_note", arguments: { slug_or_title: "java-cas" } }), env)
	).json();
	assert.match(bySlug.result.content[0].text, /CAS 是一条 CPU 级别的原子指令/);
	assert.match(bySlug.result.content[0].text, /ABA 问题/, "要带要点提纲");

	const byTitle = await (
		await call("/mcp", rpc("tools/call", { name: "get_note", arguments: { slug_or_title: "MCP 和 A2A" } }), env)
	).json();
	assert.match(byTitle.result.content[0].text, /Agent 之间的协作/);
});

test("MCP recent 按索引顺序返回", async () => {
	resetMcpCache();
	const env = envWithIndex();

	const body = await (
		await call("/mcp", rpc("tools/call", { name: "recent", arguments: { limit: 2 } }), env)
	).json();

	const lines = body.result.content[0].text.trim().split("\n");
	assert.equal(lines.length, 2);
	assert.match(lines[0], /MySQL 索引失效/);
});

test("MCP 未知工具返回 isError 而不是把请求搞崩", async () => {
	resetMcpCache();
	const env = envWithIndex();

	const body = await (await call("/mcp", rpc("tools/call", { name: "drop_table", arguments: {} }), env)).json();
	assert.equal(body.result.isError, true);
	assert.match(body.result.content[0].text, /未知工具/);
});

test("MCP 通知（无 id）返回 202 空体", async () => {
	resetMcpCache();
	const env = envWithIndex();

	const response = await call(
		"/mcp",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
		},
		env,
	);

	assert.equal(response.status, 202);
});

test("MCP 坏 JSON 与未知方法给出标准 JSON-RPC 错误", async () => {
	resetMcpCache();
	const env = envWithIndex();

	const broken = await call(
		"/mcp",
		{ method: "POST", headers: { "content-type": "application/json" }, body: "{不是 json" },
		env,
	);
	assert.equal(broken.status, 400);
	assert.equal((await broken.json()).error.code, -32700);

	const unknown = await (await call("/mcp", rpc("resources/list"), env)).json();
	assert.equal(unknown.error.code, -32601);
});

test("MCP GET 给出服务说明（方便浏览器里确认活着）", async () => {
	resetMcpCache();
	const env = envWithIndex();

	const body = await (await call("/mcp", {}, env)).json();
	assert.equal(body.ok, true);
	assert.deepEqual(body.tools.sort(), ["get_note", "recent", "search"]);
});
