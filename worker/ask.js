/**
 * POST /api/ask —— 笔记页侧边栏的 AI 助手（SSE 流式 + 工具调用）
 *
 * 前端拿到的是 text/event-stream，每行一个 JSON：
 *   {type:"status",  phase, text}                 状态提示（读笔记 / 思考 / 作答）
 *   {type:"note",    title, url}                  当前笔记，前端用来显示上下文
 *   {type:"tool",    id, name, label, state, ...} 工具调用：running → done（带一句摘要）
 *   {type:"thinking",delta}                       思考内容增量（对应 delta.reasoning）
 *   {type:"text",    delta}                       回答正文增量
 *   {type:"sources", items:[{title,url}]}         引用到的笔记
 *   {type:"done",    ms, model, tokens, rounds}   收尾
 *   {type:"error",   message}                     出错（前端照常展示，不抛 500）
 *
 * 真·Agent 循环：模型可以自己决定调 read_note / search_notes / related_notes，
 * 每次调用都会真的执行、真的把结果喂回模型，最多 3 轮。
 */

import {
	applyDelta,
	buildMessages,
	cutSseEvents,
	emptyTurn,
	parseToolArgs,
	sseChunk,
	summarizeTool,
	TOOLS,
	toolLabel,
} from "./lib/agent.js";
import { recordEvent } from "./lib/events.js";
import {
	findNote,
	loadIndex,
	noteAsContext,
	relatedNotes,
	searchNotes,
	snippet,
} from "./lib/notes-index.js";

const MAX_QUESTION = 500;
const MAX_ROUNDS = 3;
const UPSTREAM_TIMEOUT = 90_000;
const NOTE_CONTEXT_CHARS = 6000;
const DEFAULT_BASE_URL = "https://api.hcnsec.cn/v1/chat/completions";
const DEFAULT_MODEL = "auto";
const SITE_NAME = "Wkb";

function json(body, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
		},
	});
}

/** 读笔记：拿到全文 + 摘要，喂给模型和 UI 都够 */
async function toolReadNote(args, deps) {
	const wanted = String(args?.slug_or_title ?? "").trim();
	const key = wanted || deps.note.slug || deps.note.title || "";
	const items = await loadIndex(deps.env, deps.requestUrl);
	const item = key ? findNote(items, key) : null;

	if (!item) {
		return {
			payload: { found: false, wanted: key },
			modelText: `没找到「${key}」这篇笔记。可以用 search_notes 先搜一下。`,
		};
	}

	deps.pushSource({ title: item.title, url: item.url });
	const text = noteAsContext(item, NOTE_CONTEXT_CHARS);

	return {
		payload: {
			found: true,
			title: item.title,
			url: item.url,
			chars: (item.text ?? "").length,
		},
		modelText: text,
	};
}

async function toolSearchNotes(args, deps) {
	const query = String(args?.query ?? "").trim();
	if (!query)
		return { payload: { items: [] }, modelText: "查询词为空，没有检索。" };

	const items = await loadIndex(deps.env, deps.requestUrl);
	const hits = searchNotes(items, query, args?.limit ?? 4);

	for (const hit of hits)
		deps.pushSource({ title: hit.item.title, url: hit.item.url });

	if (hits.length === 0) {
		return {
			payload: { query, items: [] },
			modelText: `博客里没有检索到「${query}」。`,
		};
	}

	return {
		payload: {
			query,
			items: hits.map((hit) => ({ title: hit.item.title, url: hit.item.url })),
		},
		modelText: hits
			.map((hit) => {
				const meta = [hit.item.category, ...(hit.item.tags ?? [])]
					.filter(Boolean)
					.join(" · ");
				return [
					`## ${hit.item.title}`,
					`${hit.item.url}${meta ? `（${meta}）` : ""}`,
					hit.snippet,
				].join("\n");
			})
			.join("\n\n"),
	};
}

async function toolRelatedNotes(args, deps) {
	const items = await loadIndex(deps.env, deps.requestUrl);
	const current = findNote(items, deps.note.slug || deps.note.title || "");
	const rows = relatedNotes(items, current, args?.limit ?? 4);

	for (const item of rows)
		deps.pushSource({ title: item.title, url: item.url });

	if (rows.length === 0)
		return {
			payload: { items: [] },
			modelText: "没有找到同分类或同标签的笔记。",
		};

	return {
		payload: {
			items: rows.map((item) => ({ title: item.title, url: item.url })),
		},
		modelText: rows
			.map((item) => `- ${item.title}　${item.url}　${snippet(item, "")}`)
			.join("\n"),
	};
}

const RUNNERS = {
	read_note: toolReadNote,
	search_notes: toolSearchNotes,
	related_notes: toolRelatedNotes,
};

async function runTool(name, rawArgs, deps) {
	const runner = RUNNERS[name];
	if (!runner) {
		const payload = { error: `没有这个工具：${name}` };
		return { payload, modelText: payload.error };
	}
	return runner(parseToolArgs(rawArgs), deps);
}

/**
 * 调一次上游，边流边把增量交出去。
 * 返回本轮累加结果（正文 / 思考 / 工具调用）。
 */
async function streamModel({
	env,
	messages,
	signal,
	allowTools = true,
	onDelta,
	onChunk,
}) {
	const apiKey = String(env?.AI_API_KEY ?? "").trim();
	if (!apiKey)
		throw new Error("AI 还没接上（服务端缺少 AI_API_KEY），跟博主说一声");

	const url =
		String(env?.AI_BASE_URL ?? DEFAULT_BASE_URL).trim() || DEFAULT_BASE_URL;
	const model = String(env?.AI_MODEL ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL;

	const body = {
		model,
		messages,
		stream: true,
		stream_options: { include_usage: true },
		temperature: 0.3,
		max_tokens: 1600,
	};
	if (allowTools) {
		body.tools = TOOLS;
		body.tool_choice = "auto";
	}

	const response = await fetch(url, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify(body),
		signal,
	});

	if (!response.ok || !response.body) {
		const detail = await response.text().catch(() => "");
		console.warn("ask upstream error", response.status, detail.slice(0, 300));
		throw new Error(`AI 服务暂时不可用（${response.status}），稍后再试`);
	}

	const turn = emptyTurn();
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let modelName = model;
	let tokens = 0;

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;

		buffer += decoder.decode(value, { stream: true });
		const { events, rest } = cutSseEvents(buffer);
		buffer = rest;

		for (const raw of events) {
			if (raw === "[DONE]") continue;

			let chunk;
			try {
				chunk = JSON.parse(raw);
			} catch {
				continue;
			}

			if (chunk.model) modelName = chunk.model;
			if (chunk.usage?.total_tokens) tokens = chunk.usage.total_tokens;

			const delta = chunk.choices?.[0]?.delta;
			if (!delta) continue;

			applyDelta(turn, delta);

			const thinking =
				typeof delta.reasoning === "string"
					? delta.reasoning
					: delta.reasoning_content;
			if (typeof thinking === "string" && thinking)
				onDelta({ type: "thinking", delta: thinking });
			if (typeof delta.content === "string" && delta.content)
				onDelta({ type: "text", delta: delta.content });
			onChunk?.(chunk);
		}
	}

	return { turn, model: modelName, tokens };
}

export async function handleAsk(request, env, ctx) {
	let payload;
	try {
		payload = await request.json();
	} catch {
		return json({ error: "请求格式不对" }, 400);
	}

	const question = String(payload?.question ?? "")
		.slice(0, MAX_QUESTION)
		.trim();
	if (!question) return json({ error: "问题不能为空" }, 400);

	const note = {
		slug: String(payload?.note?.slug ?? "").slice(0, 200),
		title: String(payload?.note?.title ?? "").slice(0, 200),
		url: String(payload?.note?.url ?? "").slice(0, 300),
	};
	const history = Array.isArray(payload?.history) ? payload.history : [];
	const requestUrl = request.url;
	const visitor = { vid: payload?.vid, sid: payload?.sid };

	const apiKey = String(env?.AI_API_KEY ?? "").trim();
	if (!apiKey)
		return json(
			{ error: "AI 还没接上（服务端缺少 AI_API_KEY），跟博主说一声" },
			503,
		);

	const encoder = new TextEncoder();
	const abort = new AbortController();
	const timer = setTimeout(() => abort.abort(), UPSTREAM_TIMEOUT);

	let closed = false;
	const sources = [];
	const seen = new Set();
	const pushSource = (item) => {
		const url = String(item?.url ?? "");
		if (!url || seen.has(url)) return;
		seen.add(url);
		sources.push({ title: String(item?.title ?? ""), url });
	};

	const startedAt = Date.now();
	const stat = {
		model: "",
		tokens: 0,
		ok: 0,
		hits: 0,
		paths: [],
		ttft: 0,
		err: "",
		rounds: 0,
		tools: [],
	};
	const notePath = (() => {
		try {
			return note.url ? new URL(note.url, "https://blog.local").pathname : "";
		} catch {
			return "";
		}
	})();

	const stream = new ReadableStream({
		async start(controller) {
			const send = (event) => {
				if (closed) return;
				try {
					controller.enqueue(encoder.encode(sseChunk(event)));
				} catch {
					closed = true;
				}
			};

			// 首字延迟：第一次吐出正文的时间点。比总耗时更接近「卡不卡」的体感
			const track = (event) => {
				if (!stat.ttft && event?.type === "text")
					stat.ttft = Date.now() - startedAt;
				send(event);
			};

			const deps = { env, note, requestUrl, pushSource };

			try {
				// 先把当前笔记读进来：这一步要显示成一次真实的工具调用
				let noteContext = { ...note, text: "" };
				if (note.slug || note.title) {
					send({ type: "status", phase: "reading", text: "正在读这篇笔记" });
					const toolId = "read-current";
					send({
						type: "tool",
						id: toolId,
						name: "read_note",
						label: toolLabel("read_note"),
						state: "running",
						args: { slug_or_title: note.slug || note.title },
					});
					const toolStarted = Date.now();
					const read = await runTool(
						"read_note",
						{ slug_or_title: note.slug || note.title },
						deps,
					);
					send({
						type: "tool",
						id: toolId,
						name: "read_note",
						label: toolLabel("read_note"),
						state: "done",
						ms: Date.now() - toolStarted,
						summary: summarizeTool("read_note", read.payload),
					});
					if (read.payload.found) {
						noteContext = {
							...note,
							title: read.payload.title,
							url: read.payload.url,
							text: read.modelText,
						};
						send({
							type: "note",
							title: read.payload.title,
							url: read.payload.url,
						});
					} else {
						send({ type: "note", title: note.title, url: note.url });
					}
				}

				const messages = buildMessages({
					siteName: SITE_NAME,
					note: noteContext,
					history,
					question,
				});
				let rounds = 0;
				let answered = false;

				// 最后一轮不再给工具：保证一定有正文回答，而不是把轮次全花在查资料上
				while (rounds < MAX_ROUNDS) {
					rounds += 1;
					const allowTools = rounds < MAX_ROUNDS;
					send({
						type: "status",
						phase: rounds === 1 ? "thinking" : "followup",
						text:
							rounds === 1
								? "在想怎么回答"
								: allowTools
									? "再查一下资料"
									: "整理答案",
					});

					const { turn, model, tokens } = await streamModel({
						env,
						messages,
						signal: abort.signal,
						allowTools,
						onDelta: track,
					});
					stat.model = model || stat.model;
					// 每一轮都是一次独立计费请求，所以累加才是真实成本
					if (tokens) stat.tokens += tokens;

					if (turn.toolCalls.length === 0) {
						messages.push({ role: "assistant", content: turn.content });
						answered = turn.content.trim().length > 0;
						break;
					}

					send({ type: "status", phase: "tools", text: "调工具查资料" });
					messages.push({
						role: "assistant",
						content: turn.content || "",
						tool_calls: turn.toolCalls,
					});

					for (const call of turn.toolCalls) {
						const name = call.function?.name ?? "";
						const id = call.id || `call-${rounds}-${name}`;
						const args = parseToolArgs(call.function?.arguments);

						send({
							type: "tool",
							id,
							name,
							label: toolLabel(name),
							state: "running",
							args,
						});
						const toolStarted = Date.now();
						let toolResult;
						try {
							toolResult = await runTool(name, call.function?.arguments, deps);
						} catch (error) {
							toolResult = {
								payload: { error: String(error?.message ?? "工具执行失败") },
								modelText: "工具执行失败",
							};
						}
						send({
							type: "tool",
							id,
							name,
							label: toolLabel(name),
							state: "done",
							ms: Date.now() - toolStarted,
							summary: summarizeTool(name, toolResult.payload),
						});
						if (name) stat.tools.push(name);

						messages.push({
							role: "tool",
							tool_call_id: id,
							name,
							content: String(toolResult.modelText ?? "").slice(0, 6000),
						});
					}

					// 查过一轮还没完，就催它收尾，别无限翻笔记
					if (rounds === MAX_ROUNDS - 1) {
						messages.push({
							role: "user",
							content: "资料够了，直接用上面的内容回答我的问题。",
						});
					}
				}

				if (!answered) throw new Error("模型没有给出正文回答，再问一次试试");

				stat.rounds = rounds;

				if (sources.length > 0)
					send({ type: "sources", items: sources.slice(0, 6) });
				stat.ok = 1;
				stat.hits = sources.length;
				stat.paths = sources
					.map((item) => new URL(item.url, "https://blog.local").pathname)
					.slice(0, 5);
				send({
					type: "done",
					ms: Date.now() - startedAt,
					model: stat.model,
					tokens: stat.tokens,
					rounds,
				});
			} catch (error) {
				const message =
					error?.name === "AbortError"
						? "回答超时了，问短一点或者再试一次"
						: String(error?.message ?? "出了点问题");
				stat.err =
					error?.name === "AbortError"
						? "超时"
						: /没有给出正文回答/.test(message)
							? "空回答"
							: /AI 服务暂时不可用/.test(message)
								? "上游异常"
								: message.slice(0, 40);
				send({ type: "error", message });
			} finally {
				clearTimeout(timer);
				closed = true;
				try {
					controller.close();
				} catch {
					// 已经关掉了
				}

				if (env?.DB) {
					const day = new Date(Date.now() + 8 * 3600 * 1000)
						.toISOString()
						.slice(0, 10);
					const now = new Date().toISOString();
					ctx?.waitUntil?.(
						(async () => {
							await env.DB.batch([
								env.DB.prepare(
									"INSERT INTO ai_log (ts, day, question, model, ms, tokens, ok) VALUES (?, ?, ?, ?, ?, ?, ?)",
								).bind(
									now,
									day,
									question,
									stat.model || DEFAULT_MODEL,
									Date.now() - startedAt,
									stat.tokens ?? 0,
									stat.ok,
								),
								env.DB.prepare(
									"INSERT INTO ai_hits (ts, day, hits, paths) VALUES (?, ?, ?, ?)",
								).bind(now, day, stat.hits, stat.paths.join(",")),
							]);
							// 数据台 v2 的事件流：一次提问一行，漏斗 / 延迟 / 模型对比都靠它
							await recordEvent(env, {
								type: "ask",
								path: notePath,
								vid: visitor.vid,
								sid: visitor.sid,
								ms: Date.now() - startedAt,
								ttft: stat.ttft,
								tokens: stat.tokens,
								ok: stat.ok === 1,
								err: stat.err,
								n: history.length,
								hits: stat.hits,
								tag: stat.model || DEFAULT_MODEL,
								text: question,
								meta: { rounds: stat.rounds, tools: stat.tools },
							});
						})().catch((error) => console.warn("AI 记录写入失败", error)),
					);
				}
			}
		},

		cancel() {
			closed = true;
			clearTimeout(timer);
			abort.abort();
		},
	});

	return new Response(stream, {
		headers: {
			"content-type": "text/event-stream; charset=utf-8",
			"cache-control": "no-store, no-transform",
			connection: "keep-alive",
			// 让反向代理别攒着（Cloudflare / nginx 都认）
			"x-accel-buffering": "no",
		},
	});
}
