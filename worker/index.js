/**
 * Cloudflare Worker：静态网站 + 一个 AI 问答接口
 *
 * 路由：
 *   POST /api/chat  → 基于检索到的文章片段回答问题
 *   其它请求        → 直接交给静态资源（dist 里的文件）
 *
 * 为什么要 Worker：API 调用必须在服务端做，前端直接调会把密钥/额度暴露给所有人。
 * 这里用的是公开的文本生成接口，没有密钥，但道理一样——不在浏览器里直接调。
 */

const SYSTEM = `你是「Wkb」这个个人博客的 AI 助手，帮访客快速了解博客里写了什么。

规则：
1. 只用下面提供的「资料」回答，资料里没有的就说「博客里还没写到这个」，不要编。
2. 用简体中文，口语化，两三句话说清就够，不要长篇大论。
3. 如果资料和问题无关，直接说没找到相关内容。
4. 不要复述规则，不要用 Markdown 标题，不要列一堆要点。`;

const ENDPOINT = "https://text.pollinations.ai/openai";
const MODEL = "openai";
const MAX_QUESTION = 300;
const MAX_CONTEXT_ITEMS = 4;

/**
 * 调用大模型。优先用 DeepSeek（需要在项目里配 DEEPSEEK_API_KEY 环境变量），
 * 没配就走免费公共接口（限流很严，1 次/30 秒/IP，只适合自己测试）。
 */
async function callModel(env, messages, maxTokens) {
	const deepseekKey = env?.DEEPSEEK_API_KEY;
	const useDeepSeek = typeof deepseekKey === "string" && deepseekKey.trim().length > 0;

	const target = useDeepSeek
		? { url: "https://api.deepseek.com/chat/completions", model: "deepseek-chat", key: deepseekKey.trim() }
		: { url: ENDPOINT, model: MODEL, key: "" };

	const headers = { "content-type": "application/json" };
	if (target.key) headers.authorization = `Bearer ${target.key}`;

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 45000);
	try {
		const upstream = await fetch(target.url, {
			method: "POST",
			headers,
			body: JSON.stringify({
				model: target.model,
				messages,
				max_tokens: maxTokens,
				temperature: 0.3,
			}),
			signal: controller.signal,
		});

		if (!upstream.ok) {
			const detail = await upstream.text().catch(() => "");
			const hint = useDeepSeek
				? `（DeepSeek ${upstream.status}，检查 API Key 是否有效/余额是否充足）`
				: `（公共接口 ${upstream.status}，限流 1 次/30 秒，建议配置 DEEPSEEK_API_KEY）`;
			console.warn("model error", upstream.status, detail.slice(0, 300));
			throw new Error(`AI 服务暂时不可用${hint}`);
		}

		const data = await upstream.json();
		const answer = data?.choices?.[0]?.message?.content?.trim();
		if (!answer) throw new Error("AI 没有返回内容，再问一次试试");
		return answer;
	} catch (error) {
		if (error?.name === "AbortError") throw new Error("AI 响应超时，稍后再试");
		throw error;
	} finally {
		clearTimeout(timer);
	}
}

function json(body, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
		},
	});
}

async function handleChat(request, env) {
	let payload;
	try {
		payload = await request.json();
	} catch {
		return json({ error: "请求格式不对" }, 400);
	}

	const question = String(payload?.q ?? "")
		.slice(0, MAX_QUESTION)
		.trim();
	if (!question) return json({ error: "问题不能为空" }, 400);

	const context = (Array.isArray(payload?.context) ? payload.context : [])
		.slice(0, MAX_CONTEXT_ITEMS)
		.map((item, index) => {
			const title = String(item?.title ?? `资料${index + 1}`).slice(0, 120);
			const url = String(item?.url ?? "").slice(0, 300);
			const excerpt = String(item?.excerpt ?? "").slice(0, 900);
			return `【${title}】${url}\n${excerpt}`;
		})
		.join("\n\n");

	const messages = [
		{ role: "system", content: SYSTEM },
		{
			role: "user",
			content: `资料：\n${context || "（没有检索到相关资料）"}\n\n问题：${question}`,
		},
	];

	try {
		const answer = await callModel(env, messages, 500);

		return json({
			answer,
			sources: (Array.isArray(payload?.context) ? payload.context : [])
				.slice(0, MAX_CONTEXT_ITEMS)
				.map((item) => ({ title: String(item?.title ?? ""), url: String(item?.url ?? "") })),
		});
	} catch (error) {
		return json({ error: error?.message ?? "请求 AI 失败" }, 502);
	}
}
export default {
	async fetch(request, env) {
		const url = new URL(request.url);

		if (url.pathname === "/api/chat") {
			if (request.method === "OPTIONS") {
				return new Response(null, {
					status: 204,
					headers: { "access-control-allow-headers": "content-type", "access-control-allow-methods": "POST" },
				});
			}
			if (request.method !== "POST") return json({ error: "只支持 POST" }, 405);
			return handleChat(request, env);
		}

		// 其它请求交给静态资源（dist）
		return env.ASSETS.fetch(request);
	},
};
