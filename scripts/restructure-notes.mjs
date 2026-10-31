/**
 * 规则式重排：把「1) 2) 3) + 大段加粗」的面试笔记改成有 ## 小标题、:::tip 提示块、
 * 有序列表的结构化文档。纯确定性转换，不改一个字的内容，只做切分与标记规范化。
 *
 * 用法：node scripts/restructure-notes.mjs [--dry] [--only 关键字] [--limit N]
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DIR = "src/content/posts";
const BACKUP = ".restyle-backup";
const args = process.argv.slice(2);
const DRY = args.includes("--dry");
const ONLY = args.includes("--only") ? args[args.indexOf("--only") + 1] : "";
const LIMIT = args.includes("--limit") ? Number(args[args.indexOf("--limit") + 1]) : 0;

const splitFront = (raw) => {
	const m = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
	return m ? { front: m[0], body: raw.slice(m[0].length) } : { front: "", body: raw };
};

const cleanHeading = (raw) => {
	let t = raw
		.replace(/\*\*/g, "")
		.replace(/^[⭐✓✳⚠️\s]+/, "")
		.trim();
	// 太长的标题在"："或"——"或"。"处断开，剩下部分回到正文
	let rest = "";
	if (t.length > 40) {
		const m = t.match(/^(.{4,40}?)[：:—]{1,2}(.+)$/);
		if (m) {
			t = m[1];
			rest = m[2];
		} else {
			const m2 = t.match(/^(.{6,38}?)[。，](.+)$/);
			if (m2) {
				t = m2[1];
				rest = m2[2];
			}
		}
	}
	return { title: t.replace(/[：:，,。；;]+$/, "").trim(), rest: rest.trim() };
};

/** 把 ①②③④ 拆成有序列表 */
const circledToList = (raw) => {
	const text = raw
		.replace(/\*\*/g, "")
		.replace(/^[；;，,。：:\s]+/, "")
		// 去掉"四点：""三点，""以下几点："这类前缀
		.replace(/^[^：:。\n]{0,8}(点|条|个方面)[：:，,]\s*/, "")
		.replace(/^[；;，,。：:\s]+/, "")
		.trim();

	const marks = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩"];
	const parts = [];
	let current = "";
	for (const ch of text) {
		if (marks.includes(ch)) {
			if (current.trim()) parts.push(current.trim());
			current = "";
		} else {
			current += ch;
		}
	}
	if (current.trim()) parts.push(current.trim());
	if (parts.length < 2) return null;
	return parts
		.map((p, i) => `${i + 1}. ${p.trim().replace(/^[；;，,。\s]+/, "").replace(/[；;。]+$/, "")}`)
		.join("\n");
};

function restructure(body) {
	const lines = body.split(/\r?\n/);
	const out = [];
	let i = 0;
	const itemRe = /^\s*(\d{1,2})\s*[)）.、]\s+(.*)$/;

	while (i < lines.length) {
		const line = lines[i];
		const m = line.match(itemRe);

		if (!m) {
			out.push(line);
			i++;
			continue;
		}

		// ---- 一个编号条目 ----
		const content = m[2].trim();
		let title = "";
		let rest = "";

		const bold = content.match(/^\*\*(.+?)\*\*(.*)$/);
		if (bold) {
			const cleaned = cleanHeading(bold[1]);
			title = cleaned.title;
			rest = [cleaned.rest, bold[2].trim()].filter(Boolean).join(" ");
		} else {
			// 没有加粗：取第一句当标题
			const firstSentence = content.match(/^(.{4,30}?)[。：:](.*)$/);
			if (firstSentence) {
				title = firstSentence[1].trim();
				rest = (firstSentence[2] || "").trim();
			}
		}

		const isInterview = /面试(答法|怎么答|回答)/.test(title || content);

		if (isInterview) {
			out.push("", "## 面试怎么答", "");
			const list = circledToList(rest || content.replace(/^.*?(四点|几点|三点)[：:，,]?/, ""));
			if (list) {
				out.push(list);
			} else {
				out.push(rest || content);
			}
		} else if (title) {
			out.push("", `## ${title}`, "");
			if (rest) out.push(rest);
		} else {
			// 保持列表形态，但换成标准有序列表
			out.push(`${m[1]}. ${content}`);
		}

		// ---- 吃掉后续行，直到下一个编号条目 ----
		i++;
		const buffer = [];
		while (i < lines.length && !itemRe.test(lines[i])) {
			buffer.push(lines[i]);
			i++;
		}
		out.push(...convertQuotes(buffer));
	}

	return normalize(out.join("\n"));
}

/** 连续的 > 引用 → :::tip / :::caution 提示块 */
function convertQuotes(lines) {
	const out = [];
	let i = 0;
	while (i < lines.length) {
		if (!/^\s*>/.test(lines[i])) {
			out.push(lines[i]);
			i++;
			continue;
		}
		const quote = [];
		while (i < lines.length && /^\s*>/.test(lines[i])) {
			quote.push(lines[i].replace(/^\s*>\s?/, ""));
			i++;
		}
		const text = quote.join("\n").trim();
		if (!text) continue;
		const kind = /⚠️|注意|坑|风险|不能|避免/.test(text) ? "caution" : "tip";
		out.push("", `:::${kind}`, text, ":::", "");
	}
	return out;
}

function normalize(md) {
	const lines = md
		.replace(/\r\n/g, "\n")
		.split("\n")
		.map((l) => l.replace(/[ \t]+$/, ""));

	const out = [];
	const isBlank = (l) => !l || l.trim() === "";

	for (const line of lines) {
		const prev = out.length ? out[out.length - 1] : "";
		const startsH = /^#{1,6}\s/.test(line);
		const startsTable = /^\s*\|/.test(line);
		const startsFence = /^\s*```/.test(line);

		// 标题、表格、代码围栏前空行（连续的表行之间不加）
		if ((startsH || startsFence || (startsTable && !/^\s*\|/.test(prev))) && !isBlank(prev)) {
			out.push("");
		}
		// 标题后空行
		if (/^#{1,6}\s/.test(prev) && !isBlank(line)) {
			out.push("");
		}
		out.push(line);
	}

	return (
		out
			.join("\n")
			.replace(/\n{3,}/g, "\n\n")
			.trim() + "\n"
	);
}

/* ---------------- 主流程 ---------------- */

const files = readdirSync(DIR).filter((f) => f.endsWith(".md")).sort();
if (!DRY) mkdirSync(BACKUP, { recursive: true });
if (DRY) mkdirSync(".restyle-preview", { recursive: true });

let changed = 0;
let skipped = 0;
for (const file of files) {
	const raw = readFileSync(join(DIR, file), "utf8");
	if (!/^section:\s*note\s*$/m.test(raw)) continue;
	const { front, body } = splitFront(raw);
	const title = (front.match(/^title:\s*(.+)$/m) || [])[1]?.trim() ?? file;
	if (ONLY && !title.includes(ONLY)) continue;
	if (/^##\s/m.test(body)) {
		skipped++;
		continue; // 已经重排过（LLM 版或已有小标题）
	}
	if (!/^\s*\d{1,2}\s*[)）.、]\s+/m.test(body)) {
		skipped++;
		continue; // 纯散文，规则版帮不上
	}

	const next = front + restructure(body);
	const before = (body.match(/^\s*\d{1,2}\s*[)）.、]\s+/gm) || []).length;
	const after = (next.match(/^## /gm) || []).length;

	if (DRY) {
		writeFileSync(join(".restyle-preview", file), next, "utf8");
	} else {
		const bak = join(BACKUP, file);
		if (!existsSync(bak)) copyFileSync(join(DIR, file), bak);
		writeFileSync(join(DIR, file), next, "utf8");
	}
	changed++;
	console.log(`${DRY ? "·" : "✓"} ${title.slice(0, 34)}  ${before} 条 → ${after} 个小节`);
	if (LIMIT && changed >= LIMIT) break;
}

console.log(`\n改动 ${changed} 篇，跳过 ${skipped} 篇（已重排或无编号结构）${DRY ? "（dry run）" : ""}`);
