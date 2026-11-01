import assert from "node:assert/strict";
import test from "node:test";
import worker from "../../worker/index.js";
import {
	applyDelta,
	buildMessages,
	cutSseEvents,
	emptyTurn,
	parseToolArgs,
	shouldReadCurrentNote,
	sseChunk,
	summarizeTool,
} from "../../worker/lib/agent.js";
import { resetIndexCache } from "../../worker/lib/notes-index.js";
import { createEnv, makeCaller } from "../support/d1.mjs";

const call = makeCaller(worker);

const FIXTURE = {
	generatedAt: "2026-11-01T00:00:00.000Z",
	total: 2,
	items: [
		{
			slug: "java-cas",
			url: "/posts/java-cas/",
			title: "什么是 Java 的 CAS 操作？",
			category: "Java",
			tags: ["并发编程"],
			outline: ["自旋", "ABA 问题"],
			text: "CAS 是一条 CPU 级别的原子指令，比较并交换；缺点是自旋耗 CPU 和 ABA 问题。",
		},
		{
			slug: "java-volatile",
			url: "/posts/java-volatile/",
			title: "volatile 关键字有什么用？",
			category: "Java",
			tags: ["并发编程"],
			outline: ["可见性"],
			text: "volatile 保证可见性和有序性，不保证原子性。",
		},
	],
};

function envWithAssets(overrides = {}) {
	return createEnv({
		ASSETS: {
			fetch: async (request) => {
				const target = typeof request === "string" ? request : request.url;
				if (String(target).includes("/notes-full.json")) {
					return new Response(JSON.stringify(FIXTURE), {
						status: 200,
						headers: { "content-type": "application/json" },
					});
				}
				return new Response("asset", { status: 200 });
			},
		},
		AI_API_KEY: "test-key",
		...overrides,
	});
}

/** 把一组 chunk 拼成 SSE 响应体（模拟上游） */
function sseResponse(chunks) {
	const body =
		chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") +
		"data: [DONE]\n\n";
	return new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

/** 读 SSE 响应，解析成事件对象数组 */
async function readEvents(response) {
	const text = await response.text();
	return text
		.split("\n\n")
		.map((block) => block.split("\n").find((line) => line.startsWith("data:")))
		.filter(Boolean)
		.map((line) => JSON.parse(String(line).slice(5).trim()));
}

// ---------------- 纯逻辑 ----------------

test("cutSseEvents 只切完整事件，半截留在缓冲区", () => {
	const once = cutSseEvents('data: {"a":1}\n\ndata: {"b":2}\n\ndata: {"half"');
	assert.deepEqual(once.events, ['{"a":1}', '{"b":2}']);
	assert.equal(once.rest, 'data: {"half"');

	const twice = cutSseEvents(`${once.rest}:1}\n\n`);
	assert.deepEqual(twice.events, ['{"half":1}']);
	assert.equal(twice.rest, "");
});

test("applyDelta 累加正文、思考与分片的工具调用参数", () => {
	const turn = emptyTurn();
	applyDelta(turn, { reasoning: "先" });
	applyDelta(turn, { reasoning: "想想" });
	applyDelta(turn, { content: "答" });
	applyDelta(turn, { content: "案" });
	applyDelta(turn, {
		tool_calls: [
			{
				index: 0,
				id: "call-1",
				function: { name: "search_notes", arguments: '{"query":' },
			},
		],
	});
	applyDelta(turn, {
		tool_calls: [{ index: 0, function: { arguments: '"CAS"}' } }],
	});

	assert.equal(turn.reasoning, "先想想");
	assert.equal(turn.content, "答案");
	assert.equal(turn.toolCalls.length, 1);
	assert.equal(turn.toolCalls[0].id, "call-1");
	assert.equal(turn.toolCalls[0].function.name, "search_notes");
	assert.deepEqual(parseToolArgs(turn.toolCalls[0].function.arguments), {
		query: "CAS",
	});
});

test("parseToolArgs 遇到残缺 JSON 不炸", () => {
	assert.deepEqual(parseToolArgs('{"a":'), {});
	assert.deepEqual(parseToolArgs(""), {});
	assert.deepEqual(parseToolArgs('{"a":1}'), { a: 1 });
});

test("sseChunk 产出一行合法的 SSE 事件", () => {
	const raw = sseChunk({ type: "text", delta: "你好" });
	assert.ok(raw.startsWith("data: "));
	assert.ok(raw.endsWith("\n\n"));
	assert.deepEqual(JSON.parse(raw.slice(6).trim()), {
		type: "text",
		delta: "你好",
	});
});

test("buildMessages 把当前笔记全文和历史都带上", () => {
	const messages = buildMessages({
		siteName: "Wkb",
		note: { title: "CAS", text: "CAS 的正文" },
		history: [{ role: "assistant", content: "上一轮回答" }],
		question: "为什么自旋耗 CPU",
	});

	assert.equal(messages[0].role, "system");
	assert.match(messages[0].content, /当前浏览的是《CAS》/);
	assert.deepEqual(messages[1], { role: "assistant", content: "上一轮回答" });
	assert.equal(messages.at(-1).role, "user");
	assert.match(messages.at(-1).content, /CAS 的正文/);
	assert.match(messages.at(-1).content, /为什么自旋耗 CPU/);
});

test("summarizeTool 给 UI 的一句话摘要", () => {
	assert.equal(summarizeTool("read_note", { found: false }), "没找到这篇");
	assert.match(
		summarizeTool("read_note", { found: true, title: "CAS", chars: 12 }),
		/CAS/,
	);
	assert.equal(summarizeTool("search_notes", { items: [] }), "没有命中");
	assert.equal(summarizeTool("search_notes", { items: [{}, {}] }), "2 篇命中");
	assert.equal(summarizeTool("web_search", { items: [{}, {}, {}] }), "3 条网页");
	assert.equal(summarizeTool("fetch_url", { found: false }), "网页没有正文");
});

test("shouldReadCurrentNote 只对指向当前文章的提问预读", () => {
	const title = "什么是 Java 的 CAS 操作？";
	assert.equal(shouldReadCurrentNote("这篇讲了什么", title), true);
	assert.equal(shouldReadCurrentNote("作者认为 CAS 有什么缺点", title), true);
	assert.equal(shouldReadCurrentNote("CAS 和 volatile 有什么区别", title), true);
	assert.equal(shouldReadCurrentNote("解释一下 Spring 的 AOP 原理", title), false);
	assert.equal(shouldReadCurrentNote("今天天气怎么样", title), false);
	assert.equal(shouldReadCurrentNote("把这句话翻译成英文", title), false);
});

// ---------------- 接口 ----------------

test("POST /api/ask 没配密钥时明说，不假装正常", async () => {
	resetIndexCache();
	const env = envWithAssets({ AI_API_KEY: "" });

	const response = await call(
		"/api/ask",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ question: "CAS 是什么" }),
		},
		env,
	);

	assert.equal(response.status, 503);
	assert.match((await response.json()).error, /AI_API_KEY/);
});

test("POST /api/ask 空问题直接 400", async () => {
	const env = envWithAssets();
	const response = await call(
		"/api/ask",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ question: "   " }),
		},
		env,
	);

	assert.equal(response.status, 400);
});

test("POST /api/ask 真跑一轮工具调用再流式出答案", async () => {
	resetIndexCache();
	const env = envWithAssets();
	const originalFetch = globalThis.fetch;
	const seen = [];

	globalThis.fetch = async (_url, init) => {
		const body = JSON.parse(String(init?.body ?? "{}"));
		seen.push(body);

		// 第一轮：模型决定调 search_notes（参数分两片吐，模拟真实流）
		if (seen.length === 1) {
			return sseResponse([
				{
					model: "test-model",
					choices: [{ delta: { reasoning: "需要先查站内" } }],
				},
				{
					choices: [
						{
							delta: {
								tool_calls: [
									{
										index: 0,
										id: "call-1",
										type: "function",
										function: { name: "search_notes", arguments: '{"query":' },
									},
								],
							},
						},
					],
				},
				{
					choices: [
						{
							delta: {
								tool_calls: [
									{ index: 0, function: { arguments: '"volatile"}' } },
								],
							},
						},
					],
				},
				{
					choices: [{ delta: {}, finish_reason: "tool_calls" }],
					usage: { total_tokens: 120 },
				},
			]);
		}

		// 第二轮：拿工具结果作答
		return sseResponse([
			{
				model: "test-model",
				choices: [{ delta: { content: "volatile 只保证可见性" } }],
			},
			{
				model: "test-model",
				choices: [{ delta: { content: "，不保证原子性。" } }],
				usage: { total_tokens: 260 },
			},
		]);
	};

	try {
		const response = await call(
			"/api/ask",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					question: "volatile 和 CAS 有什么区别",
					note: {
						slug: "java-cas",
						title: "什么是 Java 的 CAS 操作？",
						url: "/posts/java-cas/",
					},
				}),
			},
			env,
		);

		assert.equal(response.status, 200);
		assert.match(
			response.headers.get("content-type") ?? "",
			/text\/event-stream/,
		);

		const events = await readEvents(response);
		const types = events.map((event) => event.type);

		assert.ok(types.includes("status"), "应该有状态提示");
		assert.ok(types.includes("thinking"), "应该有思考内容");
		assert.ok(types.includes("text"), "应该有正文增量");
		assert.ok(types.includes("sources"), "应该给出引用");

		// 两次工具调用：预读当前笔记 + 模型自己要求的 search_notes
		const toolEvents = events.filter((event) => event.type === "tool");
		const readDone = toolEvents.find(
			(event) => event.name === "read_note" && event.state === "done",
		);
		const searchDone = toolEvents.find(
			(event) => event.name === "search_notes" && event.state === "done",
		);
		assert.ok(readDone, "要显示「读取笔记」已完成");
		assert.match(readDone.summary, /CAS/);
		assert.ok(searchDone, "模型要求的检索要真的执行");
		assert.match(searchDone.summary, /篇命中/);

		// 第二轮请求里应当带上工具结果
		const secondRound = seen[1].messages;
		const toolMessage = secondRound.find((message) => message.role === "tool");
		assert.ok(toolMessage, "工具结果要回喂给模型");
		assert.match(toolMessage.content, /volatile/);
		assert.equal(toolMessage.tool_call_id, "call-1");

		const done = events.find((event) => event.type === "done");
		assert.ok(done);
		assert.equal(done.rounds, 2);
		// 两轮各计一次费，累加才是真实成本（以前只留最后一轮的值）
		assert.equal(done.tokens, 380);

		const answer = events
			.filter((event) => event.type === "text")
			.map((event) => event.delta)
			.join("");
		assert.equal(answer, "volatile 只保证可见性，不保证原子性。");

		// 预读当前笔记的全文要进了第一轮的消息里
		assert.match(
			JSON.stringify(seen[0].messages),
			/CAS 是一条 CPU 级别的原子指令/,
		);
		assert.equal(seen[0].tools.length, 5, "站内与联网工具要一起发上去");
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("通用问题不预读笔记，也不被迫检索站内", async () => {
	resetIndexCache();
	const env = envWithAssets();
	const originalFetch = globalThis.fetch;
	const seen = [];

	globalThis.fetch = async (_url, init) => {
		seen.push(JSON.parse(String(init?.body ?? "{}")));
		return sseResponse([
			{ model: "test-model", choices: [{ delta: { content: "AOP 是面向切面编程。" } }] },
			{ model: "test-model", choices: [{ delta: {}, finish_reason: "stop" }], usage: { total_tokens: 80 } },
		]);
	};

	try {
		const response = await call(
			"/api/ask",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					question: "解释一下 Spring 的 AOP 原理",
					note: {
						slug: "java-cas",
						title: "什么是 Java 的 CAS 操作？",
						url: "/posts/java-cas/",
					},
				}),
			},
			env,
		);

		const events = await readEvents(response);
		assert.equal(
			events.filter((event) => event.type === "tool").length,
			0,
			"通用问题不该有任何工具调用",
		);
		assert.doesNotMatch(
			JSON.stringify(seen[0].messages),
			/CAS 是一条 CPU 级别的原子指令/,
			"当前笔记全文不该被塞进通用问题的上下文",
		);
		const done = events.find((event) => event.type === "done");
		assert.equal(done.route, "general");
		assert.equal(done.rounds, 1);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("需要外部资料时会联网搜索，并把网页来源标记为 W 编号", async () => {
	resetIndexCache();
	const env = envWithAssets();
	const originalFetch = globalThis.fetch;
	let modelCalls = 0;

	globalThis.fetch = async (url, init) => {
		const target = String(url);
		if (target.includes("bing.com/search")) {
			return new Response(
				`<?xml version="1.0"?><rss><channel>
					<item><title>Cloudflare Workers changelog</title><link>https://developers.cloudflare.com/workers/platform/changelog/</link><description>Workers runtime updates.</description></item>
				</channel></rss>`,
				{ status: 200, headers: { "content-type": "application/rss+xml" } },
			);
		}

		modelCalls += 1;
		if (modelCalls === 1) {
			return sseResponse([
				{
					model: "test-model",
					choices: [
						{
							delta: {
								tool_calls: [
									{
										index: 0,
										id: "call-web",
										type: "function",
										function: {
											name: "web_search",
											arguments: '{"query":"Cloudflare Workers latest release"}',
										},
									},
								],
							},
						},
					],
				},
				{ choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { total_tokens: 90 } },
			]);
		}

		return sseResponse([
			{
				model: "test-model",
				choices: [{ delta: { content: "可以看官方 changelog [W1]。" } }],
			},
			{ choices: [{ delta: {}, finish_reason: "stop" }], usage: { total_tokens: 160 } },
		]);
	};

	try {
		const response = await call(
			"/api/ask",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ question: "Cloudflare Workers 最近有什么更新？" }),
			},
			env,
		);

		const events = await readEvents(response);
		const search = events.find(
			(event) =>
				event.type === "tool" &&
				event.name === "web_search" &&
				event.state === "done",
		);
		assert.ok(search);
		assert.match(search.summary, /1 条网页/);

		const sources = events.find((event) => event.type === "sources");
		assert.ok(sources);
		assert.equal(sources.items[0].id, "W1");
		assert.equal(sources.items[0].kind, "web");
		assert.equal(sources.items[0].cited, true);

		const done = events.find((event) => event.type === "done");
		assert.equal(done.route, "web");
		assert.equal(done.citations, 1);
	} finally {
		globalThis.fetch = originalFetch;
	}
});
