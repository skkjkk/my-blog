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
