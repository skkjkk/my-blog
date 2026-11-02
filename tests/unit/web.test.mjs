import assert from "node:assert/strict";
import test from "node:test";
import {
	extractTitle,
	htmlToText,
	isPrivateHost,
	normalizeHttpUrl,
	parseBingRss,
	parseGoogleHtml,
	readPage,
	searchWeb,
} from "../../worker/lib/web.js";

test("normalizeHttpUrl 只放行公网 http/https", () => {
	assert.equal(normalizeHttpUrl("https://example.com/a?b=1#x"), "https://example.com/a?b=1");
	assert.equal(normalizeHttpUrl("http://127.0.0.1:8787/"), null);
	assert.equal(normalizeHttpUrl("http://localhost/"), null);
	assert.equal(normalizeHttpUrl("http://[::1]/"), null);
	assert.equal(normalizeHttpUrl("http://169.254.169.254/latest/meta-data"), null);
	assert.equal(normalizeHttpUrl("http://192.168.1.2/"), null);
	assert.equal(normalizeHttpUrl("file:///etc/passwd"), null);
	assert.equal(normalizeHttpUrl("https://user:pass@example.com/"), null);
});

test("isPrivateHost 覆盖本机、内网与特殊域名", () => {
	for (const host of [
		"localhost",
		"foo.local",
		"metadata.google.internal",
		"10.0.0.1",
		"172.20.1.1",
		"100.100.0.1",
		"198.18.0.1",
		"::1",
		"fd00::1",
	])
		assert.equal(isPrivateHost(host), true, host);
	for (const host of ["example.com", "developers.cloudflare.com", "1.1.1.1"])
		assert.equal(isPrivateHost(host), false, host);
});

test("htmlToText 去脚本样式并保留段落文字", () => {
	const html = `
		<html><head><title>测试页</title><style>.a{color:red}</style></head>
		<body><nav>导航</nav><article><h1>标题</h1>
		<p>第一段 &amp; 内容</p><script>alert(1)</script>
		<ul><li>要点一</li><li>要点二</li></ul></article></body></html>`;
	assert.equal(extractTitle(html), "测试页");
	const text = htmlToText(html);
	assert.match(text, /第一段 & 内容/);
	assert.match(text, /要点一/);
	assert.doesNotMatch(text, /alert|color:red/);
});

test("parseBingRss 解析标题、链接和摘要", () => {
	const xml = `<rss><channel>
		<item><title><![CDATA[Cloudflare 文档]]></title><link>https://developers.cloudflare.com/workers/</link><description><![CDATA[Workers <b>runtime</b>]]></description></item>
		<item><title>第二条</title><link>https://example.com/b</link><description>摘要</description></item>
	</channel></rss>`;
	const rows = parseBingRss(xml);
	assert.equal(rows.length, 2);
	assert.equal(rows[0].title, "Cloudflare 文档");
	assert.equal(rows[0].snippet, "Workers runtime");
});

test("parseGoogleHtml 提取带 h3 的结果并解开 /url?q= 跳转", () => {
	const html = `
		<div><a href="/url?q=https://developers.cloudflare.com/workers/&amp;sa=U"><h3>Workers 文档</h3></a>
		<span>Cloudflare Workers 官方文档</span></div>
		<div><a href="https://example.com/x"><h3>另一条</h3></a><span>摘要</span></div>`;
	const rows = parseGoogleHtml(html);
	assert.equal(rows.length, 2);
	assert.equal(rows[0].url, "https://developers.cloudflare.com/workers/");
	assert.equal(rows[0].title, "Workers 文档");
});

test("searchWeb 的 auto 模式先试 Google，没解析到结果再退 Bing", async () => {
	let requested = "";
	const fetchImpl = async (url) => {
		requested = String(url);
		return new Response(
			`<rss><channel>
				<item><title>官方文档</title><link>https://developers.cloudflare.com/workers/</link><description>Workers 文档</description></item>
				<item><title>内网</title><link>http://127.0.0.1/admin</link><description>不该出现</description></item>
			</channel></rss>`,
			{ status: 200, headers: { "content-type": "application/rss+xml" } },
		);
	};

	const result = await searchWeb("Cloudflare Workers", {
		env: { WEB_SEARCH_PROVIDER: "auto" },
		fetchImpl,
		limit: 3,
	});
	assert.match(requested, /bing\.com\/search/);
	assert.equal(result.provider, "auto");
	assert.equal(result.results.length, 1);
	assert.equal(result.results[0].url, "https://developers.cloudflare.com/workers/");
});

test("Firecrawl 搜索解析 v2 的 data.web，并带上 Bearer Key", async () => {
	let request = null;
	const fetchImpl = async (url, init) => {
		request = { url: String(url), init };
		return new Response(
			JSON.stringify({
				success: true,
				data: {
					web: [
						{
							title: "Workers Changelog",
							url: "https://developers.cloudflare.com/workers/platform/changelog/",
							description: "2026-10-30 Workers 更新内容",
						},
					],
				},
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
	};

	const result = await searchWeb("Cloudflare Workers changelog", {
		env: {
			WEB_SEARCH_PROVIDER: "firecrawl",
			WEB_SEARCH_API_KEY: "fc-test",
		},
		fetchImpl,
		limit: 4,
	});

	assert.equal(request.url, "https://api.firecrawl.dev/v2/search");
	assert.equal(request.init.headers.authorization, "Bearer fc-test");
	assert.equal(JSON.parse(request.init.body).sources[0], "web");
	assert.equal(result.provider, "firecrawl");
	assert.equal(result.results.length, 1);
	assert.match(result.results[0].snippet, /Workers 更新/);
});

test("readPage 拒绝私网地址", async () => {
	let called = false;
	await assert.rejects(
		() =>
			readPage("http://127.0.0.1:8080/admin", {
				fetchImpl: async () => {
					called = true;
					return new Response("x");
				},
			}),
		/不允许读取/,
	);
	assert.equal(called, false);
});

test("readPage 读取正文、标题，并跟随公网重定向", async () => {
	const calls = [];
	const fetchImpl = async (url) => {
		calls.push(String(url));
		if (calls.length === 1)
			return new Response(null, {
				status: 302,
				headers: { location: "https://example.com/final" },
			});
		return new Response(
			"<html><head><title>最终页面</title></head><body><p>正文内容</p></body></html>",
			{ status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
		);
	};

	const page = await readPage("https://example.com/start", { fetchImpl });
	assert.equal(calls.length, 2);
	assert.equal(page.title, "最终页面");
	assert.equal(page.url, "https://example.com/final");
	assert.match(page.text, /正文内容/);
});

test("readPage 拒绝重定向到内网地址", async () => {
	const fetchImpl = async () =>
		new Response(null, {
			status: 302,
			headers: { location: "http://192.168.1.5/secret" },
		});
	await assert.rejects(
		() => readPage("https://example.com/start", { fetchImpl }),
		/重定向到了不允许的地址/,
	);
});
