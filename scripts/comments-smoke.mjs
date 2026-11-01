/**
 * 评论接口冒烟：对本地服务逐条断言关键安全行为。
 *
 * 先起服务（二选一）：
 *   npx wrangler dev --port 8787
 *   node scripts/dev-server.mjs 8787
 * 再跑：
 *   node scripts/comments-smoke.mjs
 *
 * 说明：脚本会带 cf-connecting-ip 头来模拟不同的来源 IP（线上这个头由 Cloudflare
 * 覆盖写入，客户端伪造不了），这样频率限制不会互相干扰。
 */
const BASE = process.env.BASE ?? "http://127.0.0.1:8787";
const SLUG = "/posts/smoke-test/";
const POST_ID = "smoke-test.md";

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = "") {
	if (condition) {
		passed += 1;
		console.log(`PASS  ${name}`);
		return;
	}
	failed += 1;
	failures.push(`${name}${detail ? `（${detail}）` : ""}`);
	console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
}

function uuid() {
	return crypto.randomUUID();
}

async function call(path, { method = "GET", body, headers = {} } = {}) {
	const response = await fetch(`${BASE}${path}`, {
		method,
		headers: { "content-type": "application/json", ...headers },
		body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
	});
	const text = await response.text();
	let json = null;
	try {
		json = JSON.parse(text);
	} catch {
		json = null;
	}
	return { status: response.status, json, text, headers: response.headers };
}

function commentBody(overrides = {}) {
	return {
		slug: SLUG,
		postId: POST_ID,
		name: "冒烟测试",
		content: "这是一条冒烟评论",
		clientId: uuid(),
		elapsed: 9000,
		...overrides,
	};
}

async function main() {
	console.log(`冒烟目标：${BASE}\n`);

	// 1. 列表可读
	const list = await call(`/api/comments?slug=${encodeURIComponent(SLUG)}&postId=${encodeURIComponent(POST_ID)}`);
	check("列表返回 200 且结构正确", list.status === 200 && Array.isArray(list.json?.items), `status=${list.status}`);

	// 2. 正常发布
	const clientId = uuid();
	const created = await call("/api/comments", {
		method: "POST",
		body: commentBody({ clientId }),
		headers: { "cf-connecting-ip": "10.0.0.1" },
	});
	check("正常发布返回 201", created.status === 201, `status=${created.status} ${created.text.slice(0, 120)}`);
	check("正常发布立即可见（approved）", created.json?.status === "approved");

	// 3. 幂等：同一 clientId 再发一次
	const again = await call("/api/comments", {
		method: "POST",
		body: commentBody({ clientId }),
		headers: { "cf-connecting-ip": "10.0.0.1" },
	});
	check("同一 clientId 幂等（同一 id）", again.json?.item?.id === created.json?.item?.id, `${again.json?.item?.id} vs ${created.json?.item?.id}`);

	// 4. 两条链接进待审
	const pending = await call("/api/comments", {
		method: "POST",
		body: commentBody({ content: "看 https://a.com 和 https://b.com", clientId: uuid() }),
		headers: { "cf-connecting-ip": "10.0.0.2" },
	});
	check("含两条链接进待审", pending.json?.status === "pending", `status=${pending.json?.status}`);

	// 5. 待审内容不出现在公开列表
	const afterList = await call(`/api/comments?slug=${encodeURIComponent(SLUG)}&postId=${encodeURIComponent(POST_ID)}&limit=50`);
	check("公开列表不含待审内容", !(afterList.text ?? "").includes("https://a.com"));
	check("公开列表不含内部哈希字段", !(afterList.text ?? "").includes("ip_hash"));

	// 6. XSS 原样存储
	const xss = "<img src=x onerror=alert(1)><script>alert(1)</script>";
	const xssResult = await call("/api/comments", {
		method: "POST",
		body: commentBody({ content: xss, clientId: uuid() }),
		headers: { "cf-connecting-ip": "10.0.0.3" },
	});
	check("XSS 载荷按文本原样保存", xssResult.json?.item?.content === xss);

	// 7. 频率限制
	const burst = await call("/api/comments", {
		method: "POST",
		body: commentBody({ content: "紧接着第二条", clientId: uuid() }),
		headers: { "cf-connecting-ip": "10.0.0.3" },
	});
	check("30 秒内第二条被 429", burst.status === 429, `status=${burst.status}`);
	check("429 带 retryAfter", Number(burst.json?.retryAfter) > 0);

	// 8. CSRF
	const crossSite = await call("/api/comments", {
		method: "POST",
		body: commentBody({ clientId: uuid() }),
		headers: { origin: "https://evil.test", "cf-connecting-ip": "10.0.0.4" },
	});
	check("跨站 Origin 被 403", crossSite.status === 403, `status=${crossSite.status}`);

	// 9. 请求体超限
	const huge = await call("/api/comments", {
		method: "POST",
		body: commentBody({ content: "x".repeat(20_000), clientId: uuid() }),
		headers: { "cf-connecting-ip": "10.0.0.5" },
	});
	check("超大请求体被 413", huge.status === 413, `status=${huge.status}`);

	// 10. 管理接口鉴权
	const admin = await call("/api/admin/comments");
	check("未登录访问管理接口 401", admin.status === 401, `status=${admin.status}`);

	const adminAction = await call("/api/admin/comments/action", { method: "POST", body: { id: 1, action: "approve" } });
	check("未登录执行审核动作 401", adminAction.status === 401, `status=${adminAction.status}`);

	console.log(`\n通过 ${passed} 条，失败 ${failed} 条`);
	if (failed > 0) {
		console.log("失败项：");
		for (const item of failures) console.log(` - ${item}`);
		process.exit(1);
	}
}

main().catch((error) => {
	console.error("冒烟脚本本身出错：", error);
	process.exit(1);
});
