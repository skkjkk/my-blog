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
1. 只用「站点目录」和「相关段落」里的内容回答，里面没有的就说「博客里还没写到这个」，不要编。
2. 问"这个博客写了什么"这类整体性问题时，根据站点目录概括主题，不要逐条罗列所有标题。
3. 用简体中文，口语化，两三句话说清就够，不要长篇大论。
4. 不要复述规则，不要用 Markdown 标题，不要列一堆要点。`;

// 大模型接口（OpenAI 兼容）。密钥放在 Cloudflare 的 Secret 里，不进代码、不进仓库。
const DEFAULT_BASE_URL = "https://api.hcnsec.cn/v1/chat/completions";
const DEFAULT_MODEL = "auto";
const MAX_QUESTION = 300;
const MAX_CONTEXT_ITEMS = 4;

/**
 * 调用大模型。
 *   AI_API_KEY  → Cloudflare 里配的 Secret（必须）
 *   AI_BASE_URL → wrangler.jsonc 里的 vars，默认就是上面那个
 *   AI_MODEL    → 同上，默认 auto（由网关自动挑模型）
 */
async function callModel(env, messages, maxTokens) {
	const apiKey = (env?.AI_API_KEY ?? "").trim();
	if (!apiKey) {
		throw new Error("AI 还没接上（服务端缺少 AI_API_KEY），跟博主说一声");
	}

	const url = ((env?.AI_BASE_URL ?? DEFAULT_BASE_URL) || DEFAULT_BASE_URL).trim();
	const model = ((env?.AI_MODEL ?? DEFAULT_MODEL) || DEFAULT_MODEL).trim();

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 45000);
	try {
		const upstream = await fetch(url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${apiKey}`,
			},
			body: JSON.stringify({
				model,
				messages,
				max_tokens: maxTokens,
				temperature: 0.3,
			}),
			signal: controller.signal,
		});

		if (!upstream.ok) {
			const detail = await upstream.text().catch(() => "");
			console.warn("model error", upstream.status, detail.slice(0, 300));
			throw new Error(`AI 服务暂时不可用（${upstream.status}），稍后再试`);
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

	// 站点目录：全部文章的标题+摘要，用来回答"这博客写了什么"这类整体性问题
	const catalog = String(payload?.catalog ?? "")
		.slice(0, 3000)
		.trim();

	const messages = [
		{ role: "system", content: SYSTEM },
		{
			role: "user",
			content: `站点目录（这个博客的全部文章）：\n${catalog || "（空）"}\n\n与问题最相关的段落：\n${context || "（没有检索到相关资料）"}\n\n问题：${question}`,
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
