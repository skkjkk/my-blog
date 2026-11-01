/**
 * 笔记补全流水线：把不合格的笔记按 docs/note-standard.md 重写/扩写，
 * 让刷题页抽出来的答案「直接、完整」。
 *
 * 设计要点：
 *  - 只补不改事实：原稿里的技术判断必须留下，模型只允许补通用原理、举例、追问、易错点
 *  - 写盘前必过 verifyRewrite（分数不能降、正文不能变短、小节不能变少、红线不能破）
 *  - 失败自动带「问题清单」重试一次，仍失败就跳过并记日志，不会半途写坏文件
 *  - 断点续跑：处理过的文件记在 .tmp/enrich-state.json，中断再跑不会重复烧 token
 *  - 每篇的前后对比落盘 .tmp/enrich-log/，方便人工抽检
 *
 * 用法：
 *   node scripts/enrich-notes.mjs --tier C --limit 3 --dry    # 先看 3 篇效果，不写盘
 *   node scripts/enrich-notes.mjs --tier C --write             # 真写
 *   node scripts/enrich-notes.mjs --only CAS --write --force   # 指定篇目，忽略断点
 *   node scripts/enrich-notes.mjs --desc --write               # 只重写 description（便宜）
 *
 * 环境变量：AI_API_KEY（必填）、AI_BASE_URL、AI_MODEL（默认 DeepSeek-V4-Pro）
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inspectNote, splitNote, verifyRewrite } from "./lib/note-parse.mjs";

const DIR = "src/content/posts";
const STATE_FILE = ".tmp/enrich-state.json";
const LOG_DIR = ".tmp/enrich-log";
const BACKUP_DIR = ".tmp/enrich-backup";

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const value = (flag, fallback = "") => (has(flag) ? (args[args.indexOf(flag) + 1] ?? fallback) : fallback);

const WRITE = has("--write");
const DRY = !WRITE;
const FORCE = has("--force");
const DESC_ONLY = has("--desc");
const ONLY = value("--only");
const TIER = value("--tier", "CB");
const LIMIT = Number(value("--limit", "0")) || 0;
const CONCURRENCY = Math.max(1, Number(value("--concurrency", "3")) || 3);
const MODEL = value("--model", process.env.AI_MODEL || "DeepSeek-V4-Pro");

const API_KEY = (process.env.AI_API_KEY ?? "").trim();
const ENDPOINT = (process.env.AI_BASE_URL ?? "https://api.hcnsec.cn/v1/chat/completions").trim();
if (!API_KEY) {
	console.error("缺 AI_API_KEY（可 export 或放进 .dev.vars 后手动传）");
	process.exit(1);
}

const SYSTEM = `你是资深技术编辑，在维护一个中文技术面试题库博客。读者是准备跳槽的后端工程师，刷题时只看「一段能直接背下来的答案」。

你的任务：把给定的旧笔记改写成一篇结构完整、内容准确的技术笔记。硬性要求：

1. 首段（60–200 字）：**第一句就是结论**，直接回答标题那个问题，能当标准答案背。禁止「这个问题很重要」「下面我们来看」「在面试中经常被问到」这类铺垫。
2. 用 ## 分 3–7 个小节。小节标题必须具体、能看出这节讲什么（「为什么必须是双向链表」好，「基本用法」「注意事项」这种空壳不行）。
3. 每个小节正文 ≥80 字，写清机制、因果、边界条件，不要只堆名词。
4. 至少一个小节里给**最小可用的例子**：Java 生态用 Java 代码，数据库用 SQL，Agent/Prompt 类用伪代码、JSON 或对照表格。代码块必须语法正确、能读懂。
5. 必须有「## 常见追问」小节：2–4 组，每条以「- **问：** …」开头，紧接一行「  **答：** …」，问的是面试官真的会追问的点。
6. 必须有「## 易错点」小节：2–4 条，写「容易错的直觉 + 正确说法」。
7. 结尾「## 一句话记住」用 :::tip 包围，一句话不超过 40 字。
8. 严格中文（术语保留英文原词），不要寒暄、不要「本文」「笔者」、不要一级标题 #、不要输出 frontmatter。

事实纪律（最重要）：
- 原稿里已有的技术判断、结论、参数名、类名、场景必须保留，可以重排和补充解释，不许丢。
- 不许编造具体的版本号、性能数字、benchmark、论文结论、公司内部做法。不确定就写定性描述。
- 原稿如果有明显的事实错误（例如把 wait 说成不释放锁、把 HashMap 说成线程安全），必须改正，且在小节里讲清正确说法。
- 宁可少写一节，也不要写空话凑字数。

输出格式（严格遵守，不要加别的说明文字）：
DESCRIPTION: 一行摘要，30–70 个汉字，一句话说清这篇讲了什么，不要用「本文」开头
<<<BODY>>>
（从这里开始是完整正文 markdown）
<<<END>>>`;

function buildUserPrompt(note) {
	const { data, body } = note.parsed;
	const tags = Array.isArray(data.tags) ? data.tags.filter((tag) => tag !== "面试") : [];
	return `标题：${data.title}
分类：${data.category || "未分类"}
标签：${tags.join("、") || "无"}
${note.problems.length ? `\n这篇笔记目前的毛病（改写时针对性解决）：\n${note.problems.map((p) => `- ${p}`).join("\n")}` : ""}

原稿正文：
"""
${body.trim()}
"""`;
}

async function callModel(messages, maxTokens, temperature) {
	const response = await fetch(ENDPOINT, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${API_KEY}` },
		body: JSON.stringify({ model: MODEL, messages, max_tokens: maxTokens, temperature }),
	});
	if (!response.ok) throw new Error(`HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
	const data = await response.json();
	const text = data?.choices?.[0]?.message?.content;
	if (!text) throw new Error("模型没有返回内容");
	return String(text);
}

function parseOutput(text) {
	const descriptionMatch = /^\s*DESCRIPTION:\s*(.+)$/m.exec(text);
	const bodyMatch = /<<<BODY>>>([\s\S]*?)(?:<<<END>>>|$)/.exec(text);
	const description = (descriptionMatch?.[1] ?? "").trim().replace(/^["'“”]+|["'“”]+$/g, "");
	let body = (bodyMatch?.[1] ?? "").trim();
	body = body.replace(/^```(?:markdown|md)?\s*\n/, "").replace(/\n```\s*$/, "").trim();
	return { description, body };
}

/** 改写 body 之后把 description 写回 frontmatter（保留其它字段原样） */
function replaceDescription(front, description) {
	if (!description) return front;
	const line = `description: "${description.replace(/"/g, '\\"')}"`;
	if (/^description:.*$/m.test(front)) return front.replace(/^description:.*$/m, line);
	return `${front}\n${line}`;
}

async function enrichOne(file) {
	const path = join(DIR, file);
	const raw = readFileSync(path, "utf8");
	const note = inspectNote(raw);

	if (DESC_ONLY) {
		const text = await callModel(
			[
				{ role: "system", content: "你是技术博客编辑。给标题和正文写一句中文摘要：30–70 个汉字，一句话，说清这篇讲了什么，不用「本文」开头，不加引号，只输出摘要本身。" },
				{ role: "user", content: `标题：${note.parsed.data.title}\n\n正文：\n${note.parsed.body.slice(0, 4000)}` },
			],
			200,
			0.4,
		);
		const description = text.trim().split("\n")[0].replace(/^["'“”]+|["'“”]+$/g, "").trim();
		const next = `${splitNote(raw).front ? `---\n${replaceDescription(splitNote(raw).front, description)}\n---` : ""}${note.parsed.body}`;
		return { file, description, body: note.parsed.body, next: ensureTrailingNewline(next), before: note, issues: [] };
	}

	const messages = [
		{ role: "system", content: SYSTEM },
		{ role: "user", content: buildUserPrompt(note) },
	];

	let attempt = await callModel(messages, 3600, 0.5);
	let parsed = parseOutput(attempt);
	let candidate = `${parsed.body}\n`;
	let next = `---\n${replaceDescription(splitNote(raw).front, parsed.description)}\n---\n${candidate}`;
	let check = verifyRewrite(note, next);

	if (!check.ok) {
		// 带问题清单重试一次
		const retryMessages = [
			...messages,
			{ role: "assistant", content: attempt },
			{
				role: "user",
				content: `这版不合格，问题如下：\n${check.issues.map((issue) => `- ${issue}`).join("\n")}\n\n请重写。注意：正文只能变长不能变短，必须有 3 个以上 ## 小节，首段 60–200 字且第一句就是结论，结尾要有 :::tip 一句话记住。仍按同样格式输出。`,
			},
		];
		attempt = await callModel(retryMessages, 3600, 0.4);
		parsed = parseOutput(attempt);
		candidate = `${parsed.body}\n`;
		next = `---\n${replaceDescription(splitNote(raw).front, parsed.description)}\n---\n${candidate}`;
		check = verifyRewrite(note, next);
	}

	return {
		file,
		description: parsed.description,
		body: candidate,
		next: ensureTrailingNewline(next),
		before: note,
		after: inspectNote(next),
		issues: check.issues,
	};
}

function ensureTrailingNewline(text) {
	return `${String(text).trimEnd()}\n`;
}

function loadState() {
	try {
		return JSON.parse(readFileSync(STATE_FILE, "utf8"));
	} catch {
		return { done: {}, failed: {} };
	}
}

function saveState(state) {
	mkdirSync(".tmp", { recursive: true });
	writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

// ---------- 选片 ----------
const candidates = [];
for (const file of readdirSync(DIR).filter((name) => name.endsWith(".md")).sort()) {
	const raw = readFileSync(join(DIR, file), "utf8");
	const note = inspectNote(raw);
	if (String(note.parsed.data.section ?? "post") !== "note") continue;
	if (ONLY && !file.includes(ONLY) && !String(note.parsed.data.title ?? "").includes(ONLY)) continue;
	if (!ONLY && !TIER.includes(note.grade)) continue;
	candidates.push({ file, grade: note.grade, score: note.score });
}

const state = loadState();
const todo = candidates
	.filter((item) => FORCE || !state.done[item.file] || DESC_ONLY)
	.slice(0, LIMIT > 0 ? LIMIT : undefined);

console.log(
	`待处理 ${todo.length} 篇（等级 ${TIER}${ONLY ? ` · 关键字 ${ONLY}` : ""} · 模型 ${MODEL} · 并发 ${CONCURRENCY}${DRY ? " · dry run 不写盘" : ""}）`,
);

if (todo.length === 0) {
	console.log("没有要处理的笔记。加 --force 可重做已处理过的。");
	process.exit(0);
}

mkdirSync(LOG_DIR, { recursive: true });
if (WRITE) mkdirSync(BACKUP_DIR, { recursive: true });

let cursor = 0;
let ok = 0;
let failed = 0;

async function worker(id) {
	while (cursor < todo.length) {
		const item = todo[cursor++];
		const label = `[${String(cursor).padStart(3)}/${todo.length}] ${item.file}`;
		try {
			const result = await enrichOne(item.file);
			const status = result.issues?.length ? "问题" : "ok";
			console.log(
				`${label}  ${item.score} → ${result.after?.score ?? "?"} 分 · 正文 ${result.before.metrics.totalChars} → ${result.after?.metrics.totalChars ?? "?"} 字  ${status}`,
			);
			if (result.issues?.length) console.log(`     ! ${result.issues.join("；")}`);

			writeFileSync(
				join(LOG_DIR, `${item.file.replace(/\.md$/, "")}.md`),
				`<!-- before ${item.score} -->\n${readFileSync(join(DIR, item.file), "utf8")}\n\n<!-- after -->\n${result.next}\n`,
				"utf8",
			);

			if (WRITE) {
				const backup = join(BACKUP_DIR, item.file);
				if (!existsSync(backup)) copyFileSync(join(DIR, item.file), backup);
				writeFileSync(join(DIR, item.file), result.next, "utf8");
			}

			if (result.issues?.length) {
				state.failed[item.file] = result.issues;
				failed++;
			} else {
				delete state.failed[item.file];
				state.done[item.file] = { at: new Date().toISOString(), model: MODEL, descOnly: DESC_ONLY };
				ok++;
			}
			// dry run 不记断点，避免「试着跑一次」把真跑的机会吃掉
			if (WRITE) saveState(state);
		} catch (error) {
			failed++;
			state.failed[item.file] = [String(error.message ?? error)];
			saveState(state);
			console.log(`${label}  失败：${error.message ?? error}`);
			await new Promise((resolve) => setTimeout(resolve, 1500));
		}
	}
}

await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, (_, i) => worker(i)));

console.log(`\n完成：成功 ${ok} · 有问题/失败 ${failed}${DRY ? "（dry run，未写盘；确认效果加 --write）" : ""}`);
