/**
 * 评论文本的净化与字段校验。纯函数，不碰数据库，也不碰请求对象。
 * 原则：只做"变成安全文本"，不做 HTML 解析——渲染端一律 textContent。
 */

export const LIMITS = Object.freeze({
	name: 24,
	email: 254,
	website: 200,
	content: 2000,
	slug: 200,
	bodyBytes: 16 * 1024,
});

/** 统一成字符串（null/undefined/对象都不炸） */
function asString(raw) {
	if (typeof raw === "string") return raw;
	if (typeof raw === "number" || typeof raw === "bigint") return String(raw);
	return "";
}

/**
 * 去控制字符（保留 \n）、统一换行、压掉多余空行、裁剪长度。
 */
export function sanitizeText(raw, max) {
	let text = asString(raw).replace(/\r\n?/g, "\n");
	// C0 与 DEL 控制字符，只留 \n
	text = text.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "");
	// 三个以上换行压成一个空行
	text = text.replace(/\n{3,}/g, "\n\n");
	text = text.trim();
	const limit = Number.isFinite(max) && max > 0 ? max : Number.MAX_SAFE_INTEGER;
	return text.length > limit ? text.slice(0, limit) : text;
}

/** 正文净化（长度用 LIMITS.content） */
export function normalizeContent(raw) {
	return sanitizeText(raw, LIMITS.content);
}

const LINK_RE = /\bhttps?:\/\/[^\s<>"']+/gi;

/** 正文里 http(s) 链接的个数（用于"链接太多"判定） */
export function countLinks(text) {
	const matches = asString(text).match(LINK_RE);
	return matches ? matches.length : 0;
}

/** 只放行 http/https 的网址，其它一律 null */
export function safeUrl(raw) {
	const text = asString(raw).trim();
	if (!text) return null;
	if (text.length > LIMITS.website) return null;
	let parsed;
	try {
		parsed = new URL(text);
	} catch {
		return null;
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
	return parsed.toString();
}

/** 昵称：净化后非空且不超长 */
export function validName(raw) {
	const name = sanitizeText(raw, LIMITS.name + 1);
	if (!name) return null;
	if (name.length > LIMITS.name) return null;
	return name;
}

/** 邮箱只做形状校验，返回去空白的原始串（调用方自行哈希，不存明文） */
export function validEmailShape(raw) {
	const text = asString(raw).trim();
	if (!text) return null;
	if (text.length > LIMITS.email) return null;
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) return null;
	return text;
}

/** 文章路径段：必须以 / 开头，不含查询串、锚点与 .. 穿越 */
export function normalizeSlug(raw) {
	const text = asString(raw).trim();
	if (!text || text.length > LIMITS.slug) return null;
	if (!text.startsWith("/")) return null;
	if (text.includes("?") || text.includes("#") || text.includes("..")) return null;
	if (!/^[\w\-./%\u4e00-\u9fff]+$/.test(text)) return null;
	return text;
}

/** 文章稳定键：内容集合里的相对路径，如 posts/hello.md */
export function normalizePostId(raw) {
	const text = asString(raw).trim();
	if (!text || text.length > LIMITS.slug) return null;
	if (text.includes("..") || text.includes("?") || text.includes("#")) return null;
	if (!/^[\w\-./%]+$/.test(text)) return null;
	return text;
}

/** uuid v4 形状（客户端幂等键） */
export function isUuid(raw) {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(asString(raw).trim());
}
