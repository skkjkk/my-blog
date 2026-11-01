/**
 * 评论区的前端纯函数：把正文切成"文本段 / 链接段"、相对时间、草稿键。
 * 单独放在 .mjs 里是为了能被 node --test 直接测——安全相关的逻辑必须有测试。
 */

const LINK_RE = /\bhttps?:\/\/[^\s<>"']+/gi;
const TRAILING_PUNCTUATION = /[)\]}.。,，;；:：!！?？、]+$/;

/**
 * 把纯文本切成段：`[{text}]` 或 `[{text, url}]`。
 * 只做识别，不生成 HTML——调用方必须用 DOM API 组装节点。
 */
export function linkify(content) {
	const source = String(content ?? "");
	const parts = [];
	let cursor = 0;
	LINK_RE.lastIndex = 0;

	let match = LINK_RE.exec(source);
	while (match) {
		const raw = match[0];
		const url = raw.replace(TRAILING_PUNCTUATION, "");
		if (!url || !/^https?:\/\//i.test(url)) {
			match = LINK_RE.exec(source);
			continue;
		}
		if (match.index > cursor) parts.push({ text: source.slice(cursor, match.index) });
		parts.push({ text: url, url });
		cursor = match.index + url.length;
		LINK_RE.lastIndex = match.index + raw.length;
		match = LINK_RE.exec(source);
	}

	if (cursor < source.length) parts.push({ text: source.slice(cursor) });
	if (parts.length === 0) return [{ text: source }];

	// 合并相邻的纯文本段，避免把一句话切碎
	const merged = [];
	for (const part of parts) {
		const last = merged[merged.length - 1];
		if (last && !last.url && !part.url) last.text += part.text;
		else merged.push({ ...part });
	}
	return merged.filter((part) => part.text !== "");
}

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前 / 具体日期 */
export function formatRelative(iso, now = Date.now()) {
	const time = Date.parse(iso);
	if (Number.isNaN(time)) return "";
	const diff = Math.max(0, now - time);
	const minute = 60_000;
	const hour = 60 * minute;
	const day = 24 * hour;

	if (diff < minute) return "刚刚";
	if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
	if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
	if (diff < 30 * day) return `${Math.floor(diff / day)} 天前`;
	const date = new Date(time);
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const dayOfMonth = String(date.getDate()).padStart(2, "0");
	return `${date.getFullYear()}-${month}-${dayOfMonth}`;
}

/** 草稿按文章分开存，换一篇就是另一个草稿 */
export function draftKey(slug) {
	return `comment-draft:${slug}`;
}
