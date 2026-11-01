/**
 * Agent 回归冒烟：对真实 /api/ask 跑四类问题，检查「知识路由」而不是死抠答案措辞。
 *
 * 用法：
 *   node scripts/ask-regression.mjs                      # 默认本地 http://127.0.0.1:8787
 *   node scripts/ask-regression.mjs https://wkb...       # 线上
 *
 * 需要服务端已配好 AI_API_KEY。退出码 0 表示所有场景 PASS。
 */

const BASE = (process.argv[2] ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const TIMEOUT_MS = 120_000;

const CASES = [
	{
		id: "general",
		question: "用一句话解释 CAP 定理，不要查笔记。",
		note: null,
		allowRoute: ["general", "web", "mixed"],
		forbidTools: ["read_note"],
	},
	{
		id: "note",
		question: "这篇笔记里说 CAS 有什么缺点？",
		note: {
			slug: "java-cas-compare-and-swap",
			title: "什么是 Java 的 CAS（Compare-And-Swap）操作？",
			url: "/posts/java-cas-compare-and-swap/",
		},
		allowRoute: ["notes", "mixed"],
		requireTools: ["read_note"],
	},
	{
		id: "web",
		question: "Cloudflare Workers 最近一次 changelog 更新是什么？请给出日期和来源。",
		note: null,
		allowRoute: ["web", "mixed"],
		requireTools: ["web_search"],
	},
	{
		id: "no-tool",
		question: "把「你好，世界」翻译成英文。",
		note: {
			slug: "java-cas-compare-and-swap",
			title: "什么是 Java 的 CAS（Compare-And-Swap）操作？",
			url: "/posts/java-cas-compare-and-swap/",
		},
		allowRoute: ["general"],
		forbidTools: ["read_note", "search_notes", "web_search", "fetch_url"],
	},
];

async function runCase(item) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	try {
		const response = await fetch(`${BASE}/api/ask`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				question: item.question,
				note: item.note,
				history: [],
			}),
			signal: controller.signal,
		});
		if (!response.ok) {
			const detail = await response.text().catch(() => "");
			throw new Error(`HTTP ${response.status} ${detail.slice(0, 200)}`);
		}
		if (!response.body) throw new Error("没有流式响应体");

		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		const events = [];

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const blocks = buffer.split("\n\n");
			buffer = blocks.pop() ?? "";
			for (const block of blocks) {
				const line = block.split("\n").find((row) => row.startsWith("data:"));
				if (!line) continue;
				try {
					events.push(JSON.parse(line.slice(5).trim()));
				} catch {
					// 忽略半截事件
				}
			}
		}

		const done = events.find((event) => event.type === "done");
		const error = events.find((event) => event.type === "error");
		const tools = [
			...new Set(
				events
					.filter((event) => event.type === "tool")
					.map((event) => String(event.name ?? "")),
			),
		];
		const answer = events
			.filter((event) => event.type === "text")
			.map((event) => String(event.delta ?? ""))
			.join("");
		const sources = events.find((event) => event.type === "sources");

		return {
			ok: Boolean(done) && !error,
			error: error?.message ?? "",
			route: done?.route ?? "",
			rounds: done?.rounds ?? 0,
			citations: done?.citations ?? 0,
			tools,
			sources: sources?.items ?? [],
			answer,
		};
	} finally {
		clearTimeout(timer);
	}
}

function assertCase(item, result) {
	const failures = [];
	if (!result.ok) failures.push(`请求失败：${result.error || "没有 done 事件"}`);
	if (item.allowRoute && !item.allowRoute.includes(result.route))
		failures.push(`路由 ${result.route || "空"} 不在 ${item.allowRoute.join("/")}`);
	for (const name of item.requireTools ?? [])
		if (!result.tools.includes(name)) failures.push(`缺少必需工具 ${name}`);
	for (const name of item.forbidTools ?? [])
		if (result.tools.includes(name)) failures.push(`不该调用 ${name}`);
	if (!result.answer.trim()) failures.push("没有正文回答");
	return failures;
}

const filter = process.argv[3];
const selected = filter ? CASES.filter((item) => item.id === filter) : CASES;
if (selected.length === 0) {
	console.error(`没有这个场景：${filter}`);
	process.exit(1);
}

console.log(`Agent 回归：${BASE}\n`);
let failed = 0;

for (const item of selected) {
	const started = Date.now();
	try {
		const result = await runCase(item);
		const failures = assertCase(item, result);
		const status = failures.length === 0 ? "PASS" : "FAIL";
		if (failures.length > 0) failed += 1;
		console.log(
			`${status} ${item.id.padEnd(8)} route=${result.route || "-"} rounds=${result.rounds} ` +
				`tools=${result.tools.join(",") || "-"} citations=${result.citations} ` +
				`${Date.now() - started}ms`,
		);
		if (result.answer)
			console.log(`     答：${result.answer.replace(/\s+/g, " ").slice(0, 140)}`);
		for (const failure of failures) console.log(`     ✗ ${failure}`);
	} catch (error) {
		failed += 1;
		console.log(`FAIL ${item.id.padEnd(8)} ${error?.message ?? error}`);
	}
}

console.log(`\n${selected.length - failed}/${selected.length} 通过`);
process.exit(failed === 0 ? 0 : 1);
