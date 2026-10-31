/**
 * 后台登录态：密码 → HMAC cookie。密码一换，所有旧 cookie 自动失效。
 * 从 worker/index.js 抽出来的，评论管理接口与统计后台共用同一套。
 */
import { hmacHex, timingSafeEqual } from "./crypto.js";

export const ADMIN_COOKIE = "wkb_admin";

export async function adminCookieValue(password) {
	return hmacHex(password, "wkb-admin-v1");
}

export function safeEqual(a, b) {
	return timingSafeEqual(a, b);
}

export function readCookie(request, name) {
	const cookie = request.headers.get("cookie") ?? "";
	for (const part of cookie.split(";")) {
		const [key, ...rest] = part.trim().split("=");
		if (key === name) return rest.join("=");
	}
	return "";
}

export async function isAdmin(request, env) {
	const password = (env?.ADMIN_PASSWORD ?? "").trim();
	if (!password) return false;
	const expected = await adminCookieValue(password);
	return timingSafeEqual(readCookie(request, ADMIN_COOKIE), expected);
}
