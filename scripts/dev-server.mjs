/**
 * 本地开发服务器（wrangler 的备用方案）。
 *
 * 正常路径是 `pnpm build && npx wrangler dev`——它跑的是真的 Cloudflare 运行时。
 * 但有些机器装不了 wrangler（或没有网络），这个脚本用 node:sqlite + worker 的
 * 请求处理器拼出一个等价的 HTTP 服务，够验收评论接口。
 *
 * 用法：node scripts/dev-server.mjs [port]
 * 注意：静态资源不会真的读 dist，只有 /api/* 有真实行为。
 */
import { createServer } from "node:http";
import { createEnv } from "../tests/support/d1.mjs";
import worker from "../worker/index.js";
import { ensureCommentsSchema } from "../worker/lib/db.js";

const port = Number(process.argv[2] ?? 8787);

const env = createEnv({
	ADMIN_PASSWORD: process.env.ADMIN_PASSWORD ?? "dev-pass",
	IP_SALT: process.env.IP_SALT ?? "dev-ip-salt",
	COMMENT_COOKIE_SECRET: process.env.COMMENT_COOKIE_SECRET ?? "dev-cookie-secret",
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
	console.log(`评论服务已启动：http://127.0.0.1:${port}（后台密码：${env.ADMIN_PASSWORD}）`);
});
