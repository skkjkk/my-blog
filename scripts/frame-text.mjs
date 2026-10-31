/**
 * 读取页面里某个 iframe 的文字（借助 browser 级 Target 域，跨域 iframe 也能读）
 * 用法：node scripts/frame-text.mjs <url> <iframe url 关键字>
 */
const PORT = 9222;
const [, , targetUrl, keyword = "giscus"] = process.argv;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
const ws = new WebSocket(version.webSocketDebuggerUrl);
const pending = new Map();
let id = 0;
await new Promise((res, rej) => {
	ws.addEventListener("open", res);
	ws.addEventListener("error", rej);
});
ws.addEventListener("message", (ev) => {
	const m = JSON.parse(ev.data);
	if (m.id && pending.has(m.id)) {
		const { resolve, reject } = pending.get(m.id);
		pending.delete(m.id);
		m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
	}
});
const send = (method, params = {}, sessionId) =>
	new Promise((resolve, reject) => {
		const mid = ++id;
		pending.set(mid, { resolve, reject });
		ws.send(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) }));
	});

// 用一个 tab
const page = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === "page");
const pageWs = new WebSocket(page.webSocketDebuggerUrl);
const pp = new Map();
let pid = 0;
await new Promise((res, rej) => {
	pageWs.addEventListener("open", res);
	pageWs.addEventListener("error", rej);
});
pageWs.addEventListener("message", (ev) => {
	const m = JSON.parse(ev.data);
	if (m.id && pp.has(m.id)) {
		const { resolve, reject } = pp.get(m.id);
		pp.delete(m.id);
		m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
	}
});
const pageSend = (method, params = {}) =>
	new Promise((resolve, reject) => {
		const mid = ++pid;
		pp.set(mid, { resolve, reject });
		pageWs.send(JSON.stringify({ id: mid, method, params }));
	});

await pageSend("Page.enable");
await pageSend("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
await pageSend("Page.navigate", { url: targetUrl });
await sleep(2500);
await pageSend("Runtime.evaluate", {
	expression: `(() => { const g = document.querySelector('.giscus'); if (g) g.scrollIntoView({block:'center'}); })()`,
});
await sleep(10000);

await send("Target.setDiscoverTargets", { discover: true });
const { targetInfos } = await send("Target.getTargets");
console.log("所有 target:\n" + targetInfos.map((t) => `  [${t.type}] ${(t.url || "").slice(0, 90)}`).join("\n"));

const hits = targetInfos.filter((t) => (t.url || "").includes(keyword));
for (const t of hits) {
	const { sessionId } = await send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
	await sleep(400);
	const { result } = await send(
		"Runtime.evaluate",
		{ expression: `document.body ? document.body.innerText.trim().slice(0, 1000) : "(no body)"`, returnByValue: true },
		sessionId,
	);
	console.log(`\n=== ${t.url.slice(0, 70)} ===\n${result.value}`);
	await send("Target.detachFromTarget", { sessionId });
}
ws.close();
pageWs.close();
