/**
 * 用 CDP 给页面拍图（无第三方依赖，Node 24 自带 WebSocket + fetch）
 * 用法：node scripts/shot.mjs <url> <输出png> [宽] [高] [--dark] [--full] [--scroll=像素]
 * 需要先手动开一个带 --remote-debugging-port=9222 的 Chrome。
 */
const PORT = 9222;
const [url, out, w = "1280", hgt = "900", ...flags] = process.argv.slice(2);
const width = Number(w);
const height = Number(hgt);
const dark = flags.includes("--dark");
const full = flags.includes("--full");
const scrollFlag = flags.find((f) => f.startsWith("--scroll="));
const scrollY = scrollFlag ? Number(scrollFlag.split("=")[1]) : 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function wsUrl() {
	for (let i = 0; i < 40; i++) {
		try {
			const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
			const page = list.find((t) => t.type === "page");
			if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
		} catch {}
		await sleep(500);
	}
	throw new Error("找不到调试端口");
}

const ws = new WebSocket(await wsUrl());
const pending = new Map();
let id = 0;
await new Promise((res, rej) => {
	ws.addEventListener("open", res);
	ws.addEventListener("error", rej);
});
ws.addEventListener("message", (ev) => {
	const msg = JSON.parse(ev.data);
	if (msg.id && pending.has(msg.id)) {
		const { resolve, reject } = pending.get(msg.id);
		pending.delete(msg.id);
		msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
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
	width,
	height,
	deviceScaleFactor: 1,
	mobile: width < 600,
});
await send("Page.navigate", { url });
await sleep(2500);

if (dark) {
	await send("Runtime.evaluate", {
		expression: `document.documentElement.classList.add('dark'); localStorage.setItem('theme','dark');`,
	});
	await sleep(600);
}
if (scrollY) {
	await send("Runtime.evaluate", { expression: `window.scrollTo(0, ${scrollY})` });
	await sleep(800);
}

let clip;
if (full) {
	const { result } = await send("Runtime.evaluate", {
		expression: `Math.max(document.body.scrollHeight, document.documentElement.scrollHeight)`,
		returnByValue: true,
	});
	const total = Math.min(Number(result.value) || height, 12000);
	clip = { x: 0, y: 0, width, height: total, scale: 1 };
	await send("Emulation.setDeviceMetricsOverride", {
		width,
		height: total,
		deviceScaleFactor: 1,
		mobile: width < 600,
	});
	await sleep(900);
}

const shot = await send("Page.captureScreenshot", {
	format: "png",
	...(full ? { captureBeyondViewport: true, clip } : {}),
});
const { writeFileSync } = await import("node:fs");
writeFileSync(out, Buffer.from(shot.data, "base64"));
console.log(`saved ${out}`);
ws.close();
