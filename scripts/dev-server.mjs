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
import { existsSync } from "node:fs";
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

	const candidates = clean.endsWith("/")
		? [join(target, "index.html")]
		: [target, join(target, "index.html")];

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

/**
 * 读仓库根的 .dev.vars（wrangler 的本地密钥文件）。
 * 以前这里手写 env，漏了 AI_*，结果本地一问 AI 就 502「缺少 AI_API_KEY」。
 */
async function loadDevVars() {
	try {
		const text = await readFile(".dev.vars", "utf8");
		const vars = {};
		for (const line of text.split(/\r?\n/)) {
			const hit = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
			if (!hit) continue;
			let value = hit[2].trim();
			if (
				(value.startsWith('"') && value.endsWith('"')) ||
				(value.startsWith("'") && value.endsWith("'"))
			) {
				value = value.slice(1, -1);
			}
			vars[hit[1]] = value;
		}
		return vars;
	} catch {
		return {};
	}
}

const devVars = await loadDevVars();

const env = createEnv({
	ADMIN_PASSWORD:
		process.env.ADMIN_PASSWORD ?? devVars.ADMIN_PASSWORD ?? "dev-pass",
	IP_SALT: process.env.IP_SALT ?? devVars.IP_SALT ?? "dev-ip-salt",
	COMMENT_COOKIE_SECRET:
		process.env.COMMENT_COOKIE_SECRET ??
		devVars.COMMENT_COOKIE_SECRET ??
		"dev-cookie-secret",
	// AI 问答：和线上保持一致，缺了就直说，别再静默 502
	AI_API_KEY: process.env.AI_API_KEY ?? devVars.AI_API_KEY ?? "",
	AI_BASE_URL:
		process.env.AI_BASE_URL ??
		devVars.AI_BASE_URL ??
		"https://api.hcnsec.cn/v1/chat/completions",
	AI_MODEL: process.env.AI_MODEL ?? devVars.AI_MODEL ?? "auto",
	ASSETS: {
		fetch: async (request) => {
			const url = new URL(typeof request === "string" ? request : request.url);
			const file = await resolveAsset(url.pathname);
			if (!file) return new Response("Not found", { status: 404 });

			const body = await readFile(file);
			return new Response(body, {
				status: 200,
				headers: {
					"content-type": MIME[extname(file)] ?? "application/octet-stream",
				},
			});
		},
	},
});

await ensureCommentsSchema(env);

// 开发用播种：有这文件就往内存库里灌一批假事件，方便看空看板长什么样。
// 生产构建不会碰它；.tmp/ 已在 .gitignore 里。
const seedFile = process.env.DEV_SEED ?? join(".tmp", "seed-events.sql");
if (existsSync(seedFile)) {
	env.DB.exec(await readFile(seedFile, "utf8"));
	console.log(`已播种测试数据：${seedFile}`);
}

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
		body:
			request.method === "GET" || request.method === "HEAD" ? undefined : body,
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

		// 流式响应（SSE）必须边收边发：先攒成 Buffer 的话，本地就看不到
		// 「一个字一个字往外蹦」的效果，也没法验中断
		if (workerResponse.body) {
			response.flushHeaders?.();
			for await (const chunk of workerResponse.body) {
				response.write(Buffer.from(chunk));
			}
			response.end();
		} else {
			response.end(Buffer.from(await workerResponse.arrayBuffer()));
		}
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
	console.log(
		env.AI_API_KEY
			? `  AI 问答：${env.AI_MODEL} @ ${env.AI_BASE_URL}`
			: "  AI 问答：未配置（.dev.vars 里加 AI_API_KEY 才有回答）",
	);
});
