/**
 * 题库数据层的纯函数：从一篇笔记的 markdown 正文里，抽出
 *   ① answer  —— 「速览答案」：第一个二级标题之前的那段，通常就是一句话结论
 *   ② outline —— 「要点提纲」：其余 H2 的标题，用来自测「我漏说了哪几点」
 *
 * 这两个东西是 /quiz/ 刷题、⌘K 速览、MCP 工具共用的基础。
 * 纯函数，不依赖 astro，方便直接写单测（见 tests/unit/quiz-utils.test.mjs）。
 */

/** 笔记里「对刷题没意义」的标签：几乎每篇都挂着，当提示会误导 */
export const NOISE_TAGS = new Set(["面试"]);

const FENCE_LINE = /^\s*(?:```|~~~)/;
const HEADING_LINE = /^(#{2,3})\s+(.+)$/;

/** 答案太短时继续往下补段的水位线 */
const MIN_ANSWER_CHARS = 120;
/** 速览答案最长的字数（防止有的笔记首段特别长，刷题页排版崩掉） */
const MAX_ANSWER_CHARS = 600;

/**
 * 去掉 markdown 标记，压成可读纯文本。
 * 只做「显示用」的净化，不追求完全无损。
 */
export function toPlainText(markdown: string): string {
	let text = String(markdown ?? "");

	// 图片整个丢掉；链接只留文字
	text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, "");
	text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
	// 自闭合图片/换行等 HTML 标签
	text = text.replace(/<\/?[a-zA-Z][^>]*\/?>/g, "");
	// 容器指令行（:::note / :::tip / :::）
	text = text.replace(/^\s*:::[^\n]*$/gm, "");
	// 引用、列表、任务框标记
	text = text.replace(/^\s*(?:>\s?|[-*+]\s+|\d+\.\s+|\[[ xX]\]\s*)/gm, "");
	// 标题标记
	text = text.replace(/^\s*#{1,6}\s*/gm, "");
	// 强调、行内代码、删除线（保留下划线，避免把 snake_case 揉坏）
	text = text.replace(/\*\*|~~|`/g, "");
	text = text.replace(/\*/g, "");
	// 表格：分隔行整行丢掉，其余把竖线换成空格
	text = text.replace(/^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$/gm, "");
	text = text.replace(/\|/g, " ");
	// 有几篇笔记首段以「。」开头，属于录入时的手滑
	text = text.replace(/^[\s。，、；：]+/, "");

	return text.replace(/\s+/g, " ").trim();
}

type Block = { text: string; heading: boolean };

/** 按空行切块，并标记这一行是不是标题（标题块不进答案正文） */
function toBlocks(lines: string[]): Block[] {
	const blocks: Block[] = [];
	let buffer: string[] = [];
	let inFence = false;

	const flush = () => {
		if (buffer.length === 0) return;
		const raw = buffer.join("\n");
		const text = toPlainText(raw);
		if (text) blocks.push({ text, heading: false });
		buffer = [];
	};

	for (const line of lines) {
		if (FENCE_LINE.test(line)) {
			// 代码围栏整块跳过：刷题时看代码没意义，要看去原文
			inFence = !inFence;
			flush();
			continue;
		}
		if (inFence) continue;

		if (HEADING_LINE.test(line)) {
			flush();
			const headingText = toPlainText(line);
			if (headingText) blocks.push({ text: headingText, heading: true });
			continue;
		}

		if (line.trim() === "") {
			flush();
			continue;
		}

		buffer.push(line);
	}
	flush();

	return blocks;
}

function joinBlocks(blocks: Block[]): string {
	return blocks
		.filter((b) => !b.heading)
		.map((b) => b.text)
		.join(" ")
		.trim();
}

function clamp(text: string, max: number): string {
	if (text.length <= max) return text;

	const slice = text.slice(0, max);
	// 尽量在句子结束处收尾，别把话切在半句
	const boundary = Math.max(
		slice.lastIndexOf("。"),
		slice.lastIndexOf("！"),
		slice.lastIndexOf("？"),
		slice.lastIndexOf("；"),
	);
	if (boundary >= max * 0.6) return slice.slice(0, boundary + 1);

	return `${slice.trimEnd()}…`;
}

export type QuizAnswer = {
	/** 速览答案：一句结论为主，太短会往下补 */
	answer: string;
	/** 要点提纲：H2（没有 H2 时用 H3）标题列表 */
	outline: string[];
};

export type QuizAnswerOptions = {
	/** 答案低于这个字数就从后续小节补段，默认 120；传 0 = 完全不补 */
	minAnswerChars?: number;
	/** 答案字数上限，默认 600；传 0 = 不封顶 */
	maxAnswerChars?: number;
};

/**
 * 抽出一篇笔记的速览答案与要点提纲。
 *
 * 规则：
 *  1. 第一个二级标题之前的内容 = 答案主干（现有笔记基本都是这个结构）
 *  2. 答案不足 minAnswerChars 时，按顺序把后面各节的段落补进来
 *  3. 全文没有二级标题时，退化为取正文开头几段
 */
export function extractQuizAnswer(
	body: string,
	options: QuizAnswerOptions = {},
): QuizAnswer {
	const minAnswerChars = options.minAnswerChars ?? MIN_ANSWER_CHARS;
	const maxAnswerChars = options.maxAnswerChars ?? MAX_ANSWER_CHARS;

	const lines = String(body ?? "")
		.replace(/\r\n/g, "\n")
		.split("\n");

	const blocks = toBlocks(lines);
	const headingIndex = blocks.findIndex((b) => b.heading);

	const answerBlocks =
		headingIndex > 0 ? blocks.slice(0, headingIndex) : blocks.slice();

	let answer = joinBlocks(answerBlocks);

	// 太短：从后续小节里按顺序补段，直到够长
	if (answer.length < minAnswerChars && headingIndex >= 0) {
		const tail = blocks.slice(headingIndex).filter((b) => !b.heading);
		for (const block of tail) {
			if (answer.length >= minAnswerChars) break;
			answer = `${answer} ${block.text}`.trim();
		}
	}

	// 要点提纲：优先 H2，全站都没有 H2 时退到 H3
	const h2: string[] = [];
	const h3: string[] = [];
	let inFence = false;
	for (const line of lines) {
		if (FENCE_LINE.test(line)) {
			inFence = !inFence;
			continue;
		}
		if (inFence) continue;
		const match = HEADING_LINE.exec(line);
		if (!match) continue;
		const text = toPlainText(match[2]);
		if (!text) continue;
		if (match[1] === "##") h2.push(text);
		else h3.push(text);
	}

	const outline = (h2.length > 0 ? h2 : h3).slice(0, 12);

	return {
		answer: maxAnswerChars > 0 ? clamp(answer, maxAnswerChars) : answer,
		outline,
	};
}

/* ------------------------------------------------------------------ *
 * 刷题卡片：从一篇笔记里抽出「能直接背」的答案
 *
 * 老版本只取「第一个 H2 之前那段」当答案，于是：
 *   - 有 28 篇笔记整篇没有 H2，答案退化成整篇正文再被截断 → 答非所问
 *   - 小节标题只是标题，没有内容 → 自测时不知道自己漏了什么
 * 新版本按 docs/note-standard.md 的骨架，抽出五样东西：
 *   结论（首段）、要点（每节一句核心）、常见追问、易错点、一句话记住
 * ------------------------------------------------------------------ */

export type QuizPoint = {
	/** 小节标题，本身就是「这一条讲什么」 */
	heading: string;
	/** 这一节的一句话核心，用来核对「我说的和笔记一致吗」 */
	detail: string;
};

export type QuizPair = { q: string; a: string };

export type QuizCard = {
	/** 结论：直接回答题目的那段 */
	answer: string;
	/** 要点：分点展开，每点带一句核心 */
	points: QuizPoint[];
	/** 常见追问：面试官可能接着问什么 */
	followUps: QuizPair[];
	/** 易错点：容易答错的地方 */
	pitfalls: string[];
	/** 一句话记住：收尾 */
	memory: string;
	/** 兼容老字段：小节标题列表 */
	outline: string[];
};

const FOLLOWUP_HEADING = /(追问|面试怎么答|延伸|相关问题|反问)/;
const PITFALL_HEADING = /(易错|坑|误区|注意)/;
const SUMMARY_HEADING = /(一句话|小结|总结|记住)/;

/** 卡片里最多放几条，防止极端长文把刷题页撑爆 */
const MAX_POINTS = 8;
const MAX_FOLLOW_UPS = 4;
const MAX_PITFALLS = 4;
/** 结论最多多少字（规范要求 60–200，留余量给旧笔记） */
const MAX_CARD_ANSWER = 420;

type Section = { heading: string; lines: string[] };

/** 按 H2 切小节，代码围栏里的 ## 不算标题 */
function splitNoteSections(lines: string[]): { lead: string[]; sections: Section[]; tips: string[] } {
	const lead: string[] = [];
	const sections: Section[] = [];
	const tips: string[] = [];
	let current: Section | null = null;
	let inFence = false;
	let inTip = false;

	for (const line of lines) {
		if (FENCE_LINE.test(line)) {
			inFence = !inFence;
			(current ? current.lines : lead).push(line);
			continue;
		}
		if (!inFence && /^:::\s*(tip|note|important)/i.test(line)) {
			inTip = true;
			tips.push("");
			continue;
		}
		if (!inFence && inTip && /^:::\s*$/.test(line)) {
			inTip = false;
			continue;
		}
		if (inTip) {
			const text = toPlainText(line);
			if (text) tips[tips.length - 1] = `${tips[tips.length - 1]} ${text}`.trim();
			continue;
		}

		const heading = !inFence ? HEADING_LINE.exec(line) : null;
		if (heading && heading[1] === "##") {
			current = { heading: toPlainText(heading[2]), lines: [] };
			sections.push(current);
			continue;
		}
		(current ? current.lines : lead).push(line);
	}

	return { lead, sections: sections.filter((section) => section.heading), tips };
}

/** 取第一句（太短就连下一句），再按上限收口 */
function firstSentence(text: string, max = 120): string {
	const sentences = text.split(/(?<=[。！？；])/).map((part) => part.trim()).filter(Boolean);
	if (sentences.length === 0) return text.slice(0, max);

	let out = sentences[0];
	for (const next of sentences.slice(1)) {
		if (out.length >= 48 || out.length + next.length > max) break;
		out += next;
	}
	return out.length > max ? `${out.slice(0, max).replace(/[，、；：]$/, "")}…` : out;
}

/** 小节正文的「一句核心」：优先取第一条列表，其次首句（表格行不参与，念出来没意义） */
function sectionDigest(lines: string[]): string {
	const body = lines
		.filter((line) => !FENCE_LINE.test(line))
		.filter((line) => !/^\s*\|/.test(line))
		.join("\n");
	const bullets = body
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => /^(?:[-*+]|\d+\.)\s+\S/.test(line))
		.map((line) => toPlainText(line));

	if (bullets.length > 0 && bullets[0].length >= 12) return firstSentence(bullets[0], 110);
	const plain = toPlainText(body);
	if (!plain) return "";
	return firstSentence(plain, 110);
}

/** 解析「常见追问」：兼容 **问：** / **Q1：** / Q: / 1. **问：…** 答案同行 等写法 */
function parseFollowUps(lines: string[]): QuizPair[] {
	const cleaned = lines.map((line) => line.trim()).filter(Boolean);
	const pairs: QuizPair[] = [];

	/** 问和答挤在同一行：`1. **问：xxx？** 答案……` */
	const Q_INLINE = /^\s*(?:[-*+]|\d+\.)?\s*\*\*\s*(?:问|Q)\s*\d*\s*[：:]\s*(.+?)\s*\*\*\s*(.*)$/;
	/** 问独占一行：`**问：xxx？**` / `Q1：xxx` / `- Q: xxx` */
	const Q_LINE = /^\s*(?:[-*+]|\d+\.)?\s*(?:\*\*)?\s*(?:问|Q)\s*\d*\s*[：:]\s*(?:\*\*)?\s*(.*)$/;
	/** 答独占一行：`**答：** xxx` / `A：xxx` */
	const A_LINE = /^\s*(?:\*\*)?\s*(?:答|A)\s*\d*\s*[：:]\s*(?:\*\*)?\s*(.*)$/;

	const tidy = (text: string) => text.replace(/\*\*/g, "").replace(/^[：:]\s*/, "").trim();

	let cursor = 0;
	while (cursor < cleaned.length && pairs.length < MAX_FOLLOW_UPS) {
		const line = cleaned[cursor];
		const inline = Q_INLINE.exec(line);
		const single = inline ? null : Q_LINE.exec(line);

		if (!inline && !single) {
			cursor++;
			continue;
		}

		const question = tidy(inline ? inline[1] : (single?.[1] ?? ""));
		let answer = inline ? tidy(inline[2]) : "";
		cursor++;

		// 同行没写答案，就吃到下一问之前的所有行
		if (!answer) {
			const parts: string[] = [];
			while (cursor < cleaned.length && !Q_INLINE.test(cleaned[cursor]) && !Q_LINE.test(cleaned[cursor])) {
				parts.push(tidy(A_LINE.exec(cleaned[cursor])?.[1] ?? cleaned[cursor]));
				cursor++;
			}
			answer = parts.join(" ").trim();
		}

		if (question && answer) pairs.push({ q: question, a: answer });
	}

	return pairs;
}

/** 解析「易错点」：每个列表项一条，压成一句话 */
function parsePitfalls(lines: string[]): string[] {
	const bullets = lines
		.map((line) => line.trim())
		.filter((line) => /^(?:[-*+]|\d+\.)\s+\S/.test(line))
		.map((line) => toPlainText(line))
		.filter(Boolean);

	const source = bullets.length > 0 ? bullets : toPlainText(lines.join("\n")).split(/(?<=[。！？])/).map((s) => s.trim()).filter(Boolean);

	return source.filter((text) => text.length >= 8).slice(0, MAX_PITFALLS);
}

/**
 * 抽出一张刷题卡片。
 *
 * 与 extractQuizAnswer 的分工：那个是「速览答案」（给 MCP / 列表页，越短越好），
 * 这个是「完整自测卡」（给 /quiz/ 页面，要能把一道题答完）。
 */
export function extractQuizCard(body: string): QuizCard {
	const lines = String(body ?? "")
		.replace(/\r\n/g, "\n")
		.split("\n");

	const { lead, sections, tips } = splitNoteSections(lines);
	const leadText = toPlainText(lead.join("\n"));

	const points: QuizPoint[] = [];
	for (const section of sections) {
		if (points.length >= MAX_POINTS) break;
		if (SUMMARY_HEADING.test(section.heading)) continue;
		if (FOLLOWUP_HEADING.test(section.heading)) continue;
		if (PITFALL_HEADING.test(section.heading)) continue;
		const detail = sectionDigest(section.lines);
		points.push({ heading: section.heading, detail });
	}

	// 一篇笔记里可能既有「面试怎么答」又有「常见追问」，全都收进来再截断
	const followUps = sections
		.filter((section) => FOLLOWUP_HEADING.test(section.heading))
		.flatMap((section) => parseFollowUps(section.lines))
		.slice(0, MAX_FOLLOW_UPS);

	const pitfalls = sections
		.filter((section) => PITFALL_HEADING.test(section.heading))
		.flatMap((section) => parsePitfalls(section.lines))
		.slice(0, MAX_PITFALLS);

	// 结论：首段优先；首段缺失（少数旧笔记直接上小标题）就退到第一个小节
	let answer = leadText;
	if (!answer) answer = points[0]?.detail ?? "";
	if (answer.length > MAX_CARD_ANSWER) answer = clamp(answer, MAX_CARD_ANSWER);

	// 一句话记住：优先收尾小节的正文，其次全文里最短的那个 tip
	const summarySection = sections.find((section) => SUMMARY_HEADING.test(section.heading));
	const summaryText = summarySection ? toPlainText(summarySection.lines.join("\n")) : "";
	const memory = pickMemory(summaryText, tips);

	return {
		answer,
		points,
		followUps,
		pitfalls,
		memory,
		outline: sections
			.map((section) => section.heading)
			.filter((heading) => !SUMMARY_HEADING.test(heading))
			.slice(0, 12),
	};
}

/** 「一句话记住」：在收尾小节和正文的 tip 里挑一句够短、能当结论的话 */
function pickMemory(summaryText: string, tips: string[]): string {
	const candidates = [
		...toPlainText(summaryText)
			.split(/(?<=[。！？])/)
			.map((part) => part.trim()),
		...tips.map((tip) => tip.trim()),
	].filter((text) => text.length >= 12);

	if (candidates.length === 0) return "";

	// 优先「一句话」量级的（≤70 字），从后往前找，收尾的 tip 通常在最后
	const short = [...candidates].reverse().find((text) => text.length <= 70);
	return short ?? firstSentence(candidates[candidates.length - 1], 70);
}

/** 今天（本地时区）的 YYYY-MM-DD，刷题排期用 */
export function todayKey(date: Date = new Date()): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

/** 在日期上加天数，返回新的 YYYY-MM-DD */
export function addDays(base: string, days: number): string {
	const [year, month, day] = base.split("-").map((part) => Number(part));
	const date = new Date(year, month - 1, day);
	date.setDate(date.getDate() + days);
	return todayKey(date);
}

/** 两个 YYYY-MM-DD 之间相差的自然日数 */
export function diffDays(from: string, to: string): number {
	const parse = (value: string) => {
		const [year, month, day] = value.split("-").map((part) => Number(part));
		return new Date(year, month - 1, day).getTime();
	};
	return Math.round((parse(to) - parse(from)) / 86400000);
}

