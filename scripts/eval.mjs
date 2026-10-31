/**
 * 在页面里执行一段 JS 并打印结果
 * 用法：node scripts/eval.mjs <url> <表达式文件> [宽] [高]
 */
import { readFileSync } from "node:fs";

const PORT = 9222;
const [url, exprFile, w = "1280", h = "900"] = process.argv.slice(2);
const expression = readFileSync(exprFile, "utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
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
const send = (method, params = {}) =>
	new Promise((resolve, reject) => {
		const mid = ++id;
		pending.set(mid, { resolve, reject });
		ws.send(JSON.stringify({ id: mid, method, params }));
	});

await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", {
	width: Number(w),
	height: Number(h),
	deviceScaleFactor: 1,
	mobile: Number(w) < 600,
});
await send("Page.navigate", { url });
await sleep(2500);

const { result } = await send("Runtime.evaluate", {
	expression,
	returnByValue: true,
	awaitPromise: true,
});
console.log(typeof result.value === "string" ? result.value : JSON.stringify(result, null, 2));
ws.close();
