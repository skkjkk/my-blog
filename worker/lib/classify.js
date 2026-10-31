/**
 * 两条互相独立的判定：
 *   detectBot()      —— 这段提交像不像机器人（蜜罐、提交过快）
 *   classifyComment()—— 这段内容要不要人工看一眼
 * 都是纯函数：调用方负责把数据库里查到的事实喂进来。
 */

export const BOT_MIN_ELAPSED_MS = 2500;

/** elapsed 缺失/非数字时不能判机器人（脚本、无障碍工具都发不出这个字段） */
function elapsedMs(raw) {
	if (raw === undefined || raw === null || raw === "") return null;
	const value = Number(raw);
	return Number.isFinite(value) ? value : null;
}

export function detectBot({ honey, elapsed }) {
	if (typeof honey === "string" && honey.trim() !== "") return { bot: true, reason: "honeypot" };
	const ms = elapsedMs(elapsed);
	if (ms !== null && ms < BOT_MIN_ELAPSED_MS) return { bot: true, reason: "too_fast" };
	return { bot: false };
}

const REASON_ORDER = ["too_many_links", "keyword", "duplicate", "reported"];

export function classifyComment({
	isAdmin = false,
	mode = "auto",
	linkCount = 0,
	keywordHit = false,
	recentSameHash = false,
	priorReports = 0,
} = {}) {
	if (isAdmin) return { status: "approved", reasons: [] };
	if (mode === "hold") return { status: "pending", reasons: ["hold_mode"] };

	const reasons = [];
	if (linkCount >= 2) reasons.push("too_many_links");
	if (keywordHit) reasons.push("keyword");
	if (recentSameHash) reasons.push("duplicate");
	if (priorReports >= 2) reasons.push("reported");

	reasons.sort((a, b) => REASON_ORDER.indexOf(a) - REASON_ORDER.indexOf(b));
	return reasons.length > 0 ? { status: "pending", reasons } : { status: "approved", reasons: [] };
}
