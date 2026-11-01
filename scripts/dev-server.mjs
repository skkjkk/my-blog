/**
 * 本地开发服务器（wrangler 的备用方案）。
 *
 * 正常路径是 `pnpm build && npx wrangler dev`——它跑的是真的 Cloudflare 运行时。
 * 但有些机器装不了 wrangler（或没有网络），这个脚本用 node:sqlite + worker 的
 * 请求处理器拼出一个等价的 HTTP 服务：
 *   - /api/*  走真实逻辑（D1 落到内存 SQLite）
 *   - /mcp    真实可用，可以拿 MCP 客户端直连
 *   - 其余    静态文件从 dist 里读（记得先 pnpm build）
 *
 * 用法：node scripts/dev-server.mjs [port]
 */
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { createEnv } from "../tests/support/d1.mjs";
import worker from "../worker/index.js";
import { ensureCommentsSchema } from "../worker/lib/db.js";

const port = Number(process.argv[2] ?? 8787);
const DIST = "dist";

const MIME = {
	".html": "text/html; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".avif": "image/avif",
	".ico": "image/x-icon",
	".xml": "application/xml",
	".txt": "text/plain; charset=utf-8",
	".woff2": "font/woff2",
	".wasm": "application/wasm",
};

/** 把路径 map 到 dist 里的真实文件；目录补 index.html */
async function resolveAsset(pathname) {
	const clean = decodeURIComponent(pathname.split("?")[0]);
	const target = normalize(join(DIST, clean));

	// 防目录穿越
	if (!normalize(target).startsWith(normalize(DIST))) return null;

	const candidates = clean.endsWith("/") ? [join(target, "index.html")] : [target, join(target, "index.html")];

	for (const candidate of candidates) {
		try {
			const info = await stat(candidate);
			if (info.isFile()) return candidate;
		} catch {
			// 继续试下一个
		}
	}

	return null;
}

const env = createEnv({
	ADMIN_PASSWORD: process.env.ADMIN_PASSWORD ?? "dev-pass",
	IP_SALT: process.env.IP_SALT ?? "dev-ip-salt",
	COMMENT_COOKIE_SECRET: process.env.COMMENT_COOKIE_SECRET ?? "dev-cookie-secret",
	ASSETS: {
		fetch: async (request) => {
			const url = new URL(typeof request === "string" ? request : request.url);
			const file = await resolveAsset(url.pathname);
			if (!file) return new Response("Not found", { status: 404 });

			const body = await readFile(file);
			return new Response(body, {
				status: 200,
				headers: { "content-type": MIME[extname(file)] ?? "application/octet-stream" },
			});
		},
	},
});

await ensureCommentsSchema(env);

const server = createServer(async (request, response) => {
	const chunks = [];
	for await (const chunk of request) chunks.push(chunk);
	const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;

	const headers = new Headers();
	for (const [key, value] of Object.entries(request.headers)) {
		if (typeof value === "string") headers.set(key, value);
		else if (Array.isArray(value)) headers.set(key, value.join(", "));
	}
	if (body) headers.set("content-length", String(body.byteLength));

	const requestUrl = `http://127.0.0.1:${port}${request.url ?? "/"}`;
	const workerRequest = new Request(requestUrl, {
		method: request.method ?? "GET",
		headers,
		body: request.method === "GET" || request.method === "HEAD" ? undefined : body,
	});

	try {
		const workerResponse = await worker.fetch(workerRequest, env, {
			waitUntil: (promise) => promise,
			passThroughOnException: () => {},
		});
		response.statusCode = workerResponse.status;
		workerResponse.headers.forEach((value, key) => {
			if (key === "set-cookie") return;
			response.setHeader(key, value);
		});
		const cookies = workerResponse.headers.getSetCookie?.() ?? [];
		if (cookies.length > 0) response.setHeader("set-cookie", cookies);
		response.end(Buffer.from(await workerResponse.arrayBuffer()));
	} catch (error) {
		console.error("请求处理失败", error);
		response.statusCode = 500;
		response.end(JSON.stringify({ error: "服务端出错" }));
	}
});

server.listen(port, "127.0.0.1", () => {
	console.log(`本地全栈服务：http://127.0.0.1:${port}`);
	console.log(`  后台密码：${env.ADMIN_PASSWORD}`);
	console.log(`  MCP 入口：http://127.0.0.1:${port}/mcp`);
});
