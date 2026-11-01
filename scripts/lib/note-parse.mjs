/**
 * 笔记解析与体检的共用工具（纯函数，无第三方依赖）。
 *
 * 被两个脚本共用：
 *   scripts/note-quality.mjs   —— 体检报告
 *   scripts/enrich-notes.mjs   —— 补全前的「哪里不合格」判定，补全后的回归校验
 *
 * 规范见 docs/note-standard.md，三处口径必须一致。
 */

/** frontmatter + 正文，保留原始 front 文本，方便原样写回 */
export function splitNote(raw) {
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(String(raw ?? ""));
	if (!match) return { front: "", data: {}, body: String(raw ?? "") };
	return { front: match[1], data: parseFront(match[1]), body: match[2] };
}

/** 极简 frontmatter 解析：只认 key: value / key: [a, b] / 引号字符串 */
export function parseFront(front) {
	const data = {};
	for (const line of String(front ?? "").split(/\r?\n/)) {
		const hit = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
		if (!hit) continue;
		const [, key, raw] = hit;
		let value = raw.trim();
		if (value.startsWith("[") && value.endsWith("]")) {
			value = value
				.slice(1, -1)
				.split(",")
				.map((part) => part.trim().replace(/^["']|["']$/g, ""))
				.filter(Boolean);
		} else if (/^"(.*)"$/.test(value) || /^'(.*)'$/.test(value)) {
			value = value.slice(1, -1).replace(/\\"/g, '"');
		}
		data[key] = value;
	}
	return data;
}

const FENCE_LINE = /^\s*(?:```|~~~)/;
const H2_LINE = /^##\s+(.+)$/;
const H3_LINE = /^###\s+(.+)$/;

/** 把 markdown 压成纯文本（体检与刷题抽取共用口径） */
export function toPlainText(markdown) {
	let text = String(markdown ?? "");
	text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, "");
	text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
	text = text.replace(/<\/?[a-zA-Z][^>]*\/?>/g, "");
	text = text.replace(/^\s*:::[^\n]*$/gm, "");
	text = text.replace(/^\s*(?:>\s?|[-*+]\s+|\d+\.\s+|\[[ xX]\]\s*)/gm, "");
	text = text.replace(/^\s*#{1,6}\s*/gm, "");
	text = text.replace(/\*\*|~~|`/g, "");
	text = text.replace(/\*/g, "");
	text = text.replace(/^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/gm, "");
	text = text.replace(/\|/g, " ");
	return text.replace(/\s+/g, " ").trim();
}

/** 中文计字数：去掉所有空白后的字符数 */
export function countChars(text) {
	return String(text ?? "").replace(/\s/g, "").length;
}

/** 按 H2 切小节：{ lead: 首个 H2 之前的正文, sections: [{ heading, body }] }，代码围栏里的 # 不算标题 */
export function splitSections(body) {
	const lines = String(body ?? "").split(/\r?\n/);
	const lead = [];
	const sections = [];
	let current = null;
	let inFence = false;

	for (const line of lines) {
		if (FENCE_LINE.test(line)) {
			inFence = !inFence;
			(current ? current.body : lead).push(line);
			continue;
		}
		const h2 = !inFence && H2_LINE.exec(line);
		if (h2) {
			current = { heading: toPlainText(h2[1]), body: [] };
			sections.push(current);
			continue;
		}
		(current ? current.body : lead).push(line);
	}

	return {
		lead: lead.join("\n").trim(),
		sections: sections.map((section) => ({
			heading: section.heading,
			body: section.body.join("\n").trim(),
		})),
	};
}

/** 小节里的正文纯文本（去掉代码块，代码不计入「实心」判断，但单独统计） */
export function sectionText(markdown) {
	const withoutFence = String(markdown ?? "").replace(/```[\s\S]*?```/g, "");
	return toPlainText(withoutFence);
}

/** 这一节里有没有列表/加粗要点（能一眼复述的那种） */
export function bulletCount(markdown) {
	const lines = String(markdown ?? "").split(/\r?\n/);
	return lines.filter((line) => /^\s*(?:[-*+]|\d+\.)\s+\S/.test(line)).length;
}

export const FOLLOWUP_HEADING = /(追问|面试怎么答|面试延伸|延伸问|相关问题|反问)/;
export const PITFALL_HEADING = /(坑|易错|注意|误区|别踩)/;
export const SUMMARY_HEADING = /(一句话|小结|总结|记住)/;

/** 「一句话记住」这类收尾小节本来就短，不参与「内容太薄」判定 */
function isSummarySection(section) {
	return SUMMARY_HEADING.test(section.heading);
}

/** 概念类笔记不需要代码示例 */
const NO_CODE_CATEGORIES = new Set(["系统设计", "站务"]);

export const RULES = [
	{ key: "lead", label: "首段结论（60–300 字、直接回答）", weight: 25 },
	{ key: "sections", label: "实心小节（≥3 节，每节 ≥80 字）", weight: 20 },
	{ key: "bullets", label: "可复述要点（列表/加粗 ≥3 条）", weight: 15 },
	{ key: "extras", label: "常见追问 / 易错点", weight: 15 },
	{ key: "summary", label: "一句话记住（tip / 小结）", weight: 10 },
	{ key: "example", label: "例子（代码块或表格）", weight: 10 },
	{ key: "redline", label: "红线（一级标题 / 残留标点 / 结构配对）", weight: 5 },
	{ key: "description", label: "description 完整", weight: 5 },
];

/**
 * 体检一篇笔记。
 * 返回 { score, grade, problems[], metrics{} }，problems 是给人看的「哪条不合格」。
 */
export function inspectNote(raw, options = {}) {
	const { front, data, body } = splitNote(raw);
	const category = String(data.category ?? "").trim();
	const problems = [];

	// ---- 正文结构 ----
	const { lead, sections } = splitSections(body);
	const leadText = sectionText(lead);
	const leadChars = countChars(leadText);

	const solid = sections.filter(
		(section) => countChars(sectionText(section.body)) >= 80 || isSummarySection(section),
	);
	const emptyHeads = sections.filter(
		(section) => countChars(sectionText(section.body)) < 80 && !isSummarySection(section),
	);

	const bullets = sections.reduce((sum, section) => sum + bulletCount(section.body), 0) + bulletCount(lead);
	const hasFollowUp = sections.some((section) => FOLLOWUP_HEADING.test(section.heading));
	const hasPitfall = sections.some((section) => PITFALL_HEADING.test(section.heading));
	const hasSummary =
		sections.some((section) => SUMMARY_HEADING.test(section.heading)) || /:::tip[\s\S]*?:::/i.test(body);
	const hasCode = /```[\s\S]*?```/.test(body);
	const hasTable = /^\s*\|[\s\S]*?^\s*\|/m.test(body);
	const totalChars = countChars(sectionText(body));

	// ---- 红线 ----
	const redlines = [];
	if (/^#\s/m.test(body)) redlines.push("正文出现一级标题 #");
	if (/^[。，；：]/.test(leadText)) redlines.push(`首段以「${leadText[0]}」开头`);
	for (const section of sections) {
		const text = sectionText(section.body).trim();
		if (text && /^[。，；：]/.test(text)) {
			redlines.push(`小节「${section.heading}」以「${text[0]}」开头`);
			break;
		}
	}
	if (((body.match(/^```/gm) ?? []).length) % 2 !== 0) redlines.push("代码围栏不配对");
	if ((body.split(/\r?\n/).filter((line) => /^:::/.test(line)).length) % 2 !== 0)
		redlines.push("::: 提示块不配对");
	if (/^\s*\d{1,2}\s*[)）]\s/m.test(body)) redlines.push("残留 1) 2) 老式编号");

	// ---- description ----
	const description = String(data.description ?? "").trim();
	const descriptionOk =
		description.length >= 20 && description.length <= 120 && !/[.．]{2,}|…$/.test(description) && description !== data.title;
	if (!descriptionOk) problems.push("description 缺失 / 过短 / 被截断");

	// ---- 首段 ----
	if (leadChars < 60) problems.push(`首段太短（${leadChars} 字），刷题页会拿它当答案`);
	else if (leadChars > 300) problems.push(`首段太长（${leadChars} 字），抽答案会被截断`);
	if (/^(这个问题|这道题|今天|首先|我们来看|下面|在面试中)/.test(leadText)) problems.push("首段是铺垫不是结论");

	// ---- 小节 ----
	if (sections.length < 3) problems.push(`只有 ${sections.length} 个 ## 小节，题库提纲会空`);
	if (emptyHeads.length > 0)
		problems.push(`${emptyHeads.length} 个小节内容太薄（<80 字）：${emptyHeads.map((s) => s.heading).slice(0, 3).join("、")}`);

	// ---- 要点 / 追问 / 收尾 ----
	if (bullets < 3) problems.push(`可复述要点只有 ${bullets} 条`);
	if (!hasFollowUp) problems.push("缺「常见追问」小节");
	if (!hasPitfall) problems.push("缺「易错点 / 常见坑」小节");
	if (!hasSummary) problems.push("缺「一句话记住」收尾");
	if (!hasCode && !hasTable && !NO_CODE_CATEGORIES.has(category)) problems.push("没有代码示例也没有对比表格");
	if (totalChars < 900) problems.push(`正文偏短（${totalChars} 字）`);

	// ---- 打分 ----
	const ratio = (value) => Math.max(0, Math.min(1, value));
	const scoreParts = {
		lead: leadChars >= 60 && leadChars <= 300 && !/^(这个问题|这道题|今天|首先|我们来看|下面|在面试中)/.test(leadText) ? 1 : leadChars >= 40 ? 0.5 : 0,
		sections: ratio(solid.length / 3),
		bullets: ratio(bullets / 3),
		extras: (hasFollowUp ? 0.5 : 0) + (hasPitfall ? 0.5 : 0),
		summary: hasSummary ? 1 : 0,
		example: hasCode || hasTable ? 1 : NO_CODE_CATEGORIES.has(category) ? 1 : 0,
		redline: redlines.length === 0 ? 1 : 0,
		description: descriptionOk ? 1 : 0,
	};

	let points = 0;
	for (const rule of RULES) points += rule.weight * scoreParts[rule.key];
	const TOTAL_WEIGHT = RULES.reduce((sum, rule) => sum + rule.weight, 0);
	const score = Math.round((points / TOTAL_WEIGHT) * 100);

	const grade = score >= 85 ? "A" : score >= 70 ? "B" : "C";

	return {
		score,
		grade,
		problems,
		redlines,
		metrics: {
			leadChars,
			sections: sections.length,
			solidSections: solid.length,
			bullets,
			hasFollowUp,
			hasPitfall,
			hasSummary,
			hasCode,
			hasTable,
			totalChars,
			descriptionLength: description.length,
		},
		parsed: { front, data, body, lead, sections },
	};
}

/** 补全后回归校验：不能比原来差，也不能丢结构 */
export function verifyRewrite(before, after) {
	const issues = [];
	const a = inspectNote(after);

	if (a.redlines.length > 0) issues.push(`新稿有红线：${a.redlines.join("；")}`);
	if (a.score < before.score) issues.push(`新稿分数下降：${before.score} → ${a.score}`);
	if (a.metrics.totalChars < before.metrics.totalChars * 0.9)
		issues.push(`新稿变短了：${before.metrics.totalChars} → ${a.metrics.totalChars}`);
	if (a.metrics.sections < 3) issues.push(`小节数不足 3（${a.metrics.sections}）`);
	// 原来「空壳小节」被合并掉是好事，所以只跟「实心小节」比
	if (a.metrics.solidSections < Math.max(3, before.metrics.solidSections))
		issues.push(`实心小节变少：${before.metrics.solidSections} → ${a.metrics.solidSections}`);
	if (!a.parsed.data.title) issues.push("新稿丢了 frontmatter title");
	if (!/^---\r?\n/.test(String(after))) issues.push("新稿没有 frontmatter");

	return { ok: issues.length === 0, issues };
}
