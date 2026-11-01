/**
 * 外部资料工具：联网搜索 + 读取公开网页。
 *
 * 设计约束：
 *   1. 不引第三方 SDK；默认走 Bing RSS，配了 API Key 可切 Brave / Tavily。
 *   2. 只允许公网 http(s)，挡掉 localhost、内网、云元数据地址，避免 SSRF。
 *   3. 读取有超时、字节上限和域名重定向复检；正文截断后再交给模型。
 *   4. 网页内容是「不可信资料」，提示词会明确要求忽略其中的指令。
 */

export const WEB_LIMITS = Object.freeze({
	results: 5,
	queryChars: 200,
	pageChars: 6000,
	pageBytes: 512 * 1024,
	timeoutMs: 12_000,
	maxRedirects: 3,
});

const DEFAULT_UA =
	"Mozilla/5.0 (compatible; WkbBlogAgent/1.0; +https://github.com/skkjkk/my-blog)";

/** IPv4 私网 / 保留地址：按数值判断，比维护一长串前缀可靠 */
function isPrivateV4(host) {
	const parts = host.split(".").map(Number);
	if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return true;
	const [a, b, c] = parts;
	if (a === 0 || a === 10 || a === 127) return true;
	if (a === 169 && b === 254) return true;
	if (a === 172 && b >= 16 && b <= 31) return true;
	if (a === 192 && b === 168) return true;
	if (a === 100 && b >= 64 && b <= 127) return true;
	if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
	if (a === 198 && (b === 18 || b === 19 || b === 51)) return true;
	if (a === 203 && b === 0 && c === 113) return true;
	if (a >= 224) return true;
	return false;
}

/** 私网 / 本机 / 云元数据：一律不允许外部工具访问 */
export function isPrivateHost(hostname) {
	let host = String(hostname ?? "")
		.toLowerCase()
		.replace(/^\[|\]$/g, "")
		.replace(/\.$/, "");
	if (!host) return true;

	if (host.startsWith("::ffff:")) host = host.slice(7);

	if (
		host === "localhost" ||
		host.endsWith(".localhost") ||
		host.endsWith(".local") ||
		host.endsWith(".internal") ||
		host.endsWith(".home.arpa") ||
		host === "metadata.google.internal"
	)
		return true;

	if (host === "::" || host === "::1" || host.startsWith("fe80:")) return true;
	if (/^f[cd][0-9a-f]{2}:/.test(host)) return true;

	if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return isPrivateV4(host);

	// 单段主机名基本是内网别名（公网域名至少有 nnn.nnn）
	if (!host.includes(".") && !host.includes(":")) return true;
	return false;
}

/** 规范化公开 URL：只留 http/https，挡账号密码和非常规端口 */
export function normalizeHttpUrl(raw, base = undefined) {
	let parsed;
	try {
		parsed = base ? new URL(String(raw ?? ""), base) : new URL(String(raw ?? ""));
	} catch {
		return null;
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
	if (parsed.username || parsed.password) return null;
	if (parsed.port && parsed.port !== "80" && parsed.port !== "443") return null;
	if (isPrivateHost(parsed.hostname)) return null;
	parsed.hash = "";
	return parsed.toString();
}

export function decodeEntities(raw) {
	const named = {
		amp: "&",
		lt: "<",
		gt: ">",
		quot: '"',
		apos: "'",
		nbsp: " ",
		hellip: "…",
		mdash: "—",
		ndash: "–",
	};
	return String(raw ?? "").replace(
		/&(?:#x([0-9a-f]+)|#(\d+)|([a-z][a-z0-9]+));/gi,
		(match, hex, dec, name) => {
			if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
			if (dec) return String.fromCodePoint(Number.parseInt(dec, 10));
			return named[String(name).toLowerCase()] ?? match;
		},
	);
}

/** 从 HTML 里抽正文：去脚本/样式/导航，保留段落和列表换行 */
export function htmlToText(html) {
	const text = String(html ?? "")
		.replace(/<!--[\s\S]*?-->/g, " ")
		.replace(
			/<(script|style|noscript|svg|canvas|iframe|template)[^>]*>[\s\S]*?<\/\1>/gi,
			" ",
		)
		.replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article)[^>]*>/gi, "\n")
		.replace(/<li[^>]*>/gi, "\n- ")
		.replace(/<[^>]+>/g, " ");

	return decodeEntities(text)
		.replace(/\r\n?/g, "\n")
		.replace(/[ \t\f\v]+/g, " ")
		.replace(/ *\n */g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

export function extractTitle(html) {
	const source = String(html ?? "");
	const og =
		source.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i) ??
		source.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);
	if (og?.[1]) return decodeEntities(og[1]).trim();
	const title = source.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
	return title?.[1] ? decodeEntities(title[1]).replace(/\s+/g, " ").trim() : "";
}

function tagValue(block, tag) {
	const match = String(block ?? "").match(
		new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"),
	);
	return match?.[1]
		? decodeEntities(match[1].replace(/<!\[CDATA\[|\]\]>/g, "")).trim()
		: "";
}

/** 解析 Google 的基础 HTML 结果（gbv=1），只认带 h3 标题的链接 */
export function parseGoogleHtml(html) {
	const source = String(html ?? "");
	const results = [];
	const links = source.matchAll(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi);
	for (const match of links) {
		const inner = match[2] ?? "";
		if (!/<h3[\s>]/i.test(inner)) continue;

		let href = decodeEntities(match[1] ?? "").replace(/&amp;/g, "&");
		try {
			const parsed = new URL(href, "https://www.google.com");
			if (parsed.pathname === "/url" && parsed.searchParams.get("q"))
				href = parsed.searchParams.get("q") ?? "";
		} catch {
			continue;
		}
		if (/google\.[a-z.]+/i.test(href)) continue;

		const title = htmlToText(inner).replace(/\s+/g, " ").trim();
		if (!title) continue;

		const after = source.slice(match.index + match[0].length, match.index + match[0].length + 420);
		const snippet = htmlToText(after)
			.replace(/\s+/g, " ")
			.trim()
			.slice(0, 320);
		results.push({ title, url: href, snippet });
	}
	return results;
}

/** 解析 Bing RSS；不依赖 XML 库，字段只有 title/link/description */
export function parseBingRss(xml) {
	const results = [];
	const items = String(xml ?? "").match(/<item>[\s\S]*?<\/item>/gi) ?? [];
	for (const block of items) {
		const title = tagValue(block, "title").replace(/\s+/g, " ").trim();
		const url = tagValue(block, "link");
		const description = htmlToText(tagValue(block, "description")).slice(0, 320);
		if (!title || !url) continue;
		results.push({ title, url, snippet: description });
	}
	return results;
}

async function fetchTimed(
	url,
	init,
	timeoutMs,
	parentSignal,
	fetchImpl = fetch,
) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	const abort = () => controller.abort();
	if (parentSignal?.aborted) controller.abort();
	else parentSignal?.addEventListener?.("abort", abort, { once: true });

	try {
		return await fetchImpl(url, {
			...init,
			redirect: "manual",
			signal: controller.signal,
		});
	} finally {
		clearTimeout(timer);
		parentSignal?.removeEventListener?.("abort", abort);
	}
}

/**
 * 搜索入口也可能 302（Bing 会按地区跳转）。这里手动跟，但每一跳都重新校验公网地址。
 */
async function fetchPublic(url, init, timeoutMs, parentSignal, fetchImpl = fetch) {
	let current = normalizeHttpUrl(url);
	if (!current) throw new Error("搜索地址不合法");
	for (let hop = 0; hop <= WEB_LIMITS.maxRedirects; hop += 1) {
		const response = await fetchTimed(
			current,
			init,
			timeoutMs,
			parentSignal,
			fetchImpl,
		);
		if (response.status < 300 || response.status >= 400) return response;
		const location = response.headers.get("location");
		if (!location) return response;
		const next = normalizeHttpUrl(location, current);
		if (!next) throw new Error("搜索服务重定向到了不允许的地址");
		current = next;
	}
	throw new Error("搜索服务重定向次数过多");
}

async function readLimited(response, maxBytes) {
	const declared = Number(response.headers.get("content-length") ?? 0);
	if (declared > maxBytes)
		throw new Error(`网页太大（${Math.round(declared / 1024)} KB）`);

	if (!response.body) return String(await response.text()).slice(0, maxBytes);

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let total = 0;
	let out = "";
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value?.byteLength ?? 0;
		if (total > maxBytes) {
			await reader.cancel().catch(() => {});
			throw new Error("网页太大，已停止读取");
		}
		out += decoder.decode(value, { stream: true });
	}
	out += decoder.decode();
	return out;
}

function cleanResults(rows, limit) {
	const out = [];
	const seen = new Set();
	for (const row of rows ?? []) {
		const title = String(row?.title ?? "").replace(/\s+/g, " ").trim();
		const url = normalizeHttpUrl(row?.url);
		if (!title || !url || seen.has(url)) continue;
		if (/bing\.com\/aclick|go\.microsoft\.com\/fwlink/i.test(url)) continue;
		seen.add(url);
		out.push({
			title: title.slice(0, 140),
			url,
			snippet: String(row?.snippet ?? row?.description ?? row?.content ?? "")
				.replace(/\s+/g, " ")
				.trim()
				.slice(0, 320),
		});
		if (out.length >= limit) break;
	}
	return out;
}

/**
 * 联网搜索。provider 默认 bing，可配 brave / tavily / searxng。
 * 返回 { provider, results:[{title,url,snippet}] }。
 */
export async function searchWeb(query, options = {}) {
	const env = options.env ?? {};
	const q = String(query ?? "").trim().slice(0, WEB_LIMITS.queryChars);
	if (!q) return { provider: "none", results: [] };

	const limit = Math.min(
		Math.max(Math.round(Number(options.limit) || 4), 1),
		WEB_LIMITS.results,
	);
	const fetchImpl = options.fetchImpl ?? fetch;
	const timeoutMs = Number(env.WEB_SEARCH_TIMEOUT_MS) || WEB_LIMITS.timeoutMs;
	const provider = String(env.WEB_SEARCH_PROVIDER ?? "auto")
		.trim()
		.toLowerCase();
	const apiKey = String(env.WEB_SEARCH_API_KEY ?? "").trim();
	const base = String(env.WEB_SEARCH_BASE_URL ?? "").trim();
	const headers = {
		accept: "application/json, text/xml, application/xml, text/html;q=0.9",
		"accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
		"user-agent": DEFAULT_UA,
	};

	let response;
	let rows = [];

	if (provider === "brave") {
		if (!apiKey) throw new Error("联网搜索缺少 WEB_SEARCH_API_KEY");
		const url = new URL(
			base || "https://api.search.brave.com/res/v1/web/search",
		);
		url.searchParams.set("q", q);
		url.searchParams.set("count", String(limit));
		response = await fetchPublic(
			url.toString(),
			{ headers: { ...headers, "x-subscription-token": apiKey } },
			timeoutMs,
			options.signal,
			fetchImpl,
		);
		if (!response.ok) throw new Error(`联网搜索返回 ${response.status}`);
		const data = await response.json();
		rows = (data?.web?.results ?? []).map((row) => ({
			title: row.title,
			url: row.url,
			snippet: row.description,
		}));
	} else if (provider === "tavily") {
		if (!apiKey) throw new Error("联网搜索缺少 WEB_SEARCH_API_KEY");
		response = await fetchPublic(
			base || "https://api.tavily.com/search",
			{
				method: "POST",
				headers: { ...headers, "content-type": "application/json" },
				body: JSON.stringify({
					api_key: apiKey,
					query: q,
					search_depth: "basic",
					max_results: limit,
					include_answer: false,
				}),
			},
			timeoutMs,
			options.signal,
			fetchImpl,
		);
		if (!response.ok) throw new Error(`联网搜索返回 ${response.status}`);
		const data = await response.json();
		rows = data?.results ?? [];
	} else if (provider === "searxng") {
		if (!base) throw new Error("SearXNG 缺少 WEB_SEARCH_BASE_URL");
		const url = new URL(base);
		url.searchParams.set("q", q);
		url.searchParams.set("format", "json");
		response = await fetchPublic(
			url.toString(),
			{ headers },
			timeoutMs,
			options.signal,
			fetchImpl,
		);
		if (!response.ok) throw new Error(`联网搜索返回 ${response.status}`);
		const data = await response.json();
		rows = data?.results ?? [];
	} else if (provider === "google" || provider === "auto") {
		// Google 的 gbv=1 是轻量 HTML 版，解析成本低；auto 模式下失败再退 Bing。
		let googleError = null;
		try {
			const url = new URL(base || "https://www.google.com/search");
			url.searchParams.set("q", q);
			url.searchParams.set("num", String(limit));
			url.searchParams.set("hl", "zh-CN");
			url.searchParams.set("gbv", "1");
			response = await fetchPublic(
				url.toString(),
				{ headers: { ...headers, accept: "text/html" } },
				timeoutMs,
				options.signal,
				fetchImpl,
			);
			if (!response.ok) throw new Error(`Google 返回 ${response.status}`);
			rows = parseGoogleHtml(await readLimited(response, 512 * 1024));
		} catch (error) {
			googleError = error;
		}

		if (rows.length === 0 && provider === "auto") {
			try {
				const url = new URL("https://www.bing.com/search");
				url.searchParams.set("q", q);
				url.searchParams.set("format", "rss");
				url.searchParams.set("mkt", "en-US");
				url.searchParams.set("setlang", "en-US");
				url.searchParams.set("ensearch", "1");
				response = await fetchPublic(
					url.toString(),
					{ headers: { ...headers, accept: "application/rss+xml, text/xml" } },
					timeoutMs,
					options.signal,
					fetchImpl,
				);
				if (response.ok) {
					const xml = await readLimited(response, 256 * 1024);
					rows = parseBingRss(xml);
				}
			} catch (error) {
				if (!googleError) googleError = error;
			}
		}

		if (rows.length === 0 && googleError)
			throw new Error(`联网搜索失败：${googleError.message}`);
	} else if (provider === "bing") {
		const url = new URL(base || "https://www.bing.com/search");
		url.searchParams.set("q", q);
		url.searchParams.set("format", "rss");
		url.searchParams.set("mkt", "en-US");
		url.searchParams.set("setlang", "en-US");
		url.searchParams.set("ensearch", "1");
		response = await fetchPublic(
			url.toString(),
			{ headers: { ...headers, accept: "application/rss+xml, text/xml" } },
			timeoutMs,
			options.signal,
			fetchImpl,
		);
		if (!response.ok) throw new Error(`联网搜索返回 ${response.status}`);
		const xml = await readLimited(response, 256 * 1024);
		rows = parseBingRss(xml);
	} else {
		throw new Error(`不支持的搜索服务：${provider}`);
	}

	return { provider, results: cleanResults(rows, limit) };
}

/**
 * 读取公开网页正文。返回 { found, url, title, text, chars }。
 * 3xx 会手动跟，但每一跳都重新做公网校验。
 */
export async function readPage(rawUrl, options = {}) {
	const env = options.env ?? {};
	const fetchImpl = options.fetchImpl ?? fetch;
	const timeoutMs = Number(env.WEB_FETCH_TIMEOUT_MS) || WEB_LIMITS.timeoutMs;

	let current = normalizeHttpUrl(rawUrl);
	if (!current) throw new Error("这个网址不允许读取（只支持公网 http/https）");

	let response = null;
	for (let hop = 0; hop <= WEB_LIMITS.maxRedirects; hop += 1) {
		response = await fetchTimed(
			current,
			{
				headers: {
					accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.8",
					"accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
					"user-agent": DEFAULT_UA,
				},
			},
			timeoutMs,
			options.signal,
			fetchImpl,
		);
		if (response.status < 300 || response.status >= 400) break;
		const location = response.headers.get("location");
		if (!location) break;
		const next = normalizeHttpUrl(location, current);
		if (!next) throw new Error("网页重定向到了不允许的地址");
		current = next;
	}

	if (!response) throw new Error("网页没有响应");
	if (!response.ok) throw new Error(`网页返回 ${response.status}`);

	const type = String(response.headers.get("content-type") ?? "").toLowerCase();
	if (
		type &&
		!/(text\/html|application\/xhtml\+xml|text\/plain|application\/json|text\/markdown)/.test(
			type,
		)
	)
		throw new Error("这个链接不是可读的网页正文");

	const body = await readLimited(response, WEB_LIMITS.pageBytes);
	const isHtml = !type || /html|xhtml/.test(type);
	const title = isHtml
		? extractTitle(body) || new URL(current).hostname
		: new URL(current).hostname;
	const text = (isHtml ? htmlToText(body) : body)
		.replace(/\n{3,}/g, "\n\n")
		.trim()
		.slice(0, WEB_LIMITS.pageChars);

	return {
		found: text.length > 0,
		url: current,
		title,
		text,
		chars: text.length,
	};
}
