/**
 * Service Worker：让刷题页在没网时也能用。
 *
 * 策略很克制，避免「发布了新内容但手机上还是旧的」：
 *   1. HTML（含 swup 的页面请求）走 network-first，失败才回缓存
 *   2. 静态资源（/_astro/、图片、字体、manifest）走 stale-while-revalidate
 *   3. 题库数据 /quiz-index.json 走 network-first + 缓存兜底（离线可刷关键）
 *   4. /api/* 和 /mcp 一律不缓存，直接走网络
 */
const VERSION = "v1";
const STATIC_CACHE = `wkb-static-${VERSION}`;
const PAGE_CACHE = `wkb-page-${VERSION}`;

/** 首装时先塞进去的东西：首页、刷题页、题库数据、图标 */
const CORE = ["/", "/quiz/", "/quiz-index.json", "/manifest.webmanifest", "/favicon-light-192.png"];

self.addEventListener("install", (event) => {
	event.waitUntil(
		(async () => {
			const cache = await caches.open(PAGE_CACHE);
			// 单个失败不影响整体安装
			await Promise.allSettled(CORE.map((url) => cache.add(new Request(url, { cache: "reload" }))));
			await self.skipWaiting();
		})(),
	);
});

self.addEventListener("activate", (event) => {
	event.waitUntil(
		(async () => {
			const keys = await caches.keys();
			await Promise.all(
				keys.filter((key) => key !== STATIC_CACHE && key !== PAGE_CACHE).map((key) => caches.delete(key)),
			);
			await self.clients.claim();
		})(),
	);
});

const isAsset = (url) =>
	url.pathname.startsWith("/_astro/") ||
	url.pathname.startsWith("/pagefind/") ||
	url.pathname.startsWith("/images/") ||
	/\.(?:css|js|woff2?|png|jpe?g|webp|avif|svg|ico)$/.test(url.pathname);

const isData = (url) => url.pathname === "/quiz-index.json" || url.pathname === "/notes-full.json";

async function networkFirst(request, cacheName) {
	const cache = await caches.open(cacheName);
	try {
		const response = await fetch(request);
		if (response && response.ok && response.type === "basic") cache.put(request, response.clone());
		return response;
	} catch (error) {
		const cached = await cache.match(request, { ignoreSearch: true });
		if (cached) return cached;

		// 刷题页离线兜底：任何页面拿不到都先给刷题页
		if (request.mode === "navigate") {
			const quiz = await cache.match("/quiz/");
			if (quiz) return quiz;
		}
		throw error;
	}
}

async function staleWhileRevalidate(request, cacheName) {
	const cache = await caches.open(cacheName);
	const cached = await cache.match(request);
	const network = fetch(request)
		.then((response) => {
			if (response && response.ok && response.type === "basic") cache.put(request, response.clone());
			return response;
		})
		.catch(() => null);

	return cached ?? (await network) ?? Response.error();
}

self.addEventListener("fetch", (event) => {
	const request = event.request;
	if (request.method !== "GET") return;

	const url = new URL(request.url);
	if (url.origin !== self.location.origin) return;
	if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/mcp")) return;
	if (url.pathname.startsWith("/admin")) return;

	if (isData(url)) {
		event.respondWith(networkFirst(request, PAGE_CACHE));
		return;
	}

	if (request.mode === "navigate" || (request.headers.get("accept") ?? "").includes("text/html")) {
		event.respondWith(networkFirst(request, PAGE_CACHE));
		return;
	}

	if (isAsset(url)) {
		event.respondWith(staleWhileRevalidate(request, STATIC_CACHE));
	}
});

/** 让页面能主动清缓存（调试用：postMessage({type:'clear'})） */
self.addEventListener("message", (event) => {
	if (event.data?.type === "clear") {
		event.waitUntil(caches.keys().then((keys) => Promise.all(keys.map((key) => caches.delete(key)))));
	}
});
