/**
 * 加密原语：哈希、HMAC、定时安全比较、IP/身份哈希、身份 cookie 的签名与验签。
 * 只用全局 crypto.subtle（Workers 与 Node 都有），不引入依赖。
 */

const encoder = new TextEncoder();

function toHex(buffer) {
	return Array.from(new Uint8Array(buffer))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

export async function sha256Hex(text) {
	const digest = await crypto.subtle.digest("SHA-256", encoder.encode(String(text)));
	return toHex(digest);
}

async function hmacKey(secret) {
	return crypto.subtle.importKey("raw", encoder.encode(String(secret)), { name: "HMAC", hash: "SHA-256" }, false, [
		"sign",
	]);
}

export async function hmacHex(secret, text) {
	const key = await hmacKey(secret);
	const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(String(text)));
	return toHex(signature);
}

/** 长度相同才逐字符比较，长度不同直接否（不泄露更多信息） */
export function timingSafeEqual(a, b) {
	if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length || a.length === 0) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

/** IP 只以哈希形式出现，用于限流与举报去重 */
export async function hashIp(ip, salt) {
	const text = typeof ip === "string" && ip.trim() ? ip.trim() : "unknown";
	return (await sha256Hex(`${salt}ip:${text}`)).slice(0, 16);
}

/** 身份标识（cookie 里的 uid）→ 存储与查询用的哈希 */
export async function identityHash(uid, salt) {
	return (await sha256Hex(`${salt}id:${uid}`)).slice(0, 32);
}

export function newUid() {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return toHex(bytes);
}

function base64url(text) {
	const bytes = encoder.encode(text);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(text) {
	const padded = text.replace(/-/g, "+").replace(/_/g, "/");
	const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return new TextDecoder().decode(bytes);
}

/** 身份 cookie 的值：base64url(json) + "." + hmac */
export async function signIdentity(payload, secret) {
	const body = base64url(JSON.stringify(payload));
	const signature = await hmacHex(secret, body);
	return `${body}.${signature}`;
}

/** 验签失败、格式不对、JSON 坏了，一律返回 null（当新访客对待） */
export async function verifyIdentity(token, secret) {
	if (typeof token !== "string" || !token) return null;
	const index = token.lastIndexOf(".");
	if (index <= 0) return null;
	const body = token.slice(0, index);
	const signature = token.slice(index + 1);
	const expected = await hmacHex(secret, body);
	if (!timingSafeEqual(signature, expected)) return null;
	try {
		const parsed = JSON.parse(fromBase64url(body));
		return parsed && typeof parsed === "object" ? parsed : null;
	} catch {
		return null;
	}
}
