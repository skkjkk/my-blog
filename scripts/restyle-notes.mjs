/**
 * 把「面试问答笔记」重排成结构化技术文档（标题/表格/提示块/mermaid 图）
 *
 * 用法：
 *   node scripts/restyle-notes.mjs --limit 3 --dry     # 先看效果，不落盘
 *   node scripts/restyle-notes.mjs --limit 3           # 落盘 3 篇
 *   node scripts/restyle-notes.mjs --concurrency 4     # 全量
 *   node scripts/restyle-notes.mjs --only 索引         # 只处理标题含「索引」的
 *   node scripts/restyle-notes.mjs --force             # 已经重排过的也重来
 *
 * 安全措施：
 *   - 原文备份到 .restyle-backup/（gitignore）
 *   - 逐篇校验：代码块必须原样保留、长度比例、标题层级、表格列数、围栏配对
 *   - 校验不过就带着反馈重试，仍不过则跳过并在报告里标红
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const POSTS_DIR = "src/content/posts";
const BACKUP_DIR = ".restyle-backup";
const REPORT = ".restyle-report.json";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback) => {
	const i = args.findIndex((a) => a === `--${name}`);
	return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const LIMIT = Number(value("limit", "0")) || 0;
const ONLY = value("only", "");
const ONLY_LIST = ONLY ? ONLY.split(",").map((s) => s.trim()).filter(Boolean) : [];
const DRY = flag("dry");
const FORCE = flag("force");
const CONCURRENCY = Number(value("concurrency", "4"));

const env = readFileSync(".dev.vars", "utf8");
const pick = (name) => {
	const m = env.match(new RegExp(`^${name}=(.+)$`, "m"));
	return m ? m[1].trim() : "";
};
const KEY = pick("AI_API_KEY");
const BASE = pick("AI_BASE_URL") || "https://api.hcnsec.cn/v1/chat/completions";
const MODEL = pick("AI_MODEL") || "auto";

/* ---------------- markdown 工具 ---------------- */

const splitFrontmatter = (raw) => {
	const m = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
	if (!m) return { front: "", body: raw };
	return { front: m[0], body: raw.slice(m[0].length) };
};

const fencedBlocks = (md) =>
	[...md.matchAll(/```([^\n`]*)\n([\s\S]*?)```/g)].map((m) => ({
		lang: m[1].trim(),
		code: m[2],
	}));

const tableProblems = (md) => {
	const problems = [];
	const lines = md.split("\n");
	for (let i = 1; i < lines.length; i++) {
		if (!/^\s*\|/.test(lines[i]) || !/^\s*\|?\s*:?-{2,}/.test(lines[i])) continue;
		const cols = (l) => (l.match(/\|/g) || []).length;
		const head = cols(lines[i - 1]);
		let j = i + 1;
		while (j < lines.length && /^\s*\|/.test(lines[j])) {
			if (cols(lines[j]) !== head) problems.push(`第 ${j + 1} 行列数不一致`);
			j++;
		}
	}
	return problems;
};

function validate(original, output) {
	const problems = [];

	// 1. 代码块必须原样保留（mermaid 不算）
	const origCode = fencedBlocks(original).filter((b) => b.lang !== "mermaid");
	for (const block of origCode) {
		if (!output.includes(block.code.trim())) {
			problems.push(`丢失代码块（${block.lang || "无语言"}）：${block.code.trim().split("\n")[0].slice(0, 40)}`);
		}
	}

	// 2. 不能凭空多出代码块
	const outCode = fencedBlocks(output).filter((b) => b.lang !== "mermaid");
	if (outCode.length > origCode.length) {
		problems.push(`多出代码块：原 ${origCode.length} 个，新 ${outCode.length} 个`);
	}

	// 3. 围栏配对
	if ((output.match(/```/g) || []).length % 2 !== 0) problems.push("``` 围栏数量是奇数（可能没闭合）");

	// 4. 一级标题
	if (/^#\s/m.test(output)) problems.push("出现了一级标题 #");

	// 5. 长度比例
	const ratio = output.length / Math.max(original.length, 1);
	if (ratio < 0.7) problems.push(`内容大幅缩水（${(ratio * 100).toFixed(0)}%）`);
	if (ratio > 1.9) problems.push(`内容大幅膨胀（${(ratio * 100).toFixed(0)}%）`);

	// 6. 表格列数
	problems.push(...tableProblems(output));

	// 7. 至少要有两个二级标题
	const h2 = (output.match(/^##\s/gm) || []).length;
	if (h2 < 2) problems.push(`二级标题太少（${h2} 个）`);

	// 8. 不能残留 1) 2) 这种手写编号行首
	const flat = output.split("\n").filter((l) => /^\s*\d{1,2}[)）]\s*/.test(l));
	if (flat.length > 2) problems.push(`仍有 ${flat.length} 行以 1) 2) 形式编号`);

	// 9. 提示块语法：:::tip 后面不能直接跟文字，只能是 :::tip 或 :::tip[标题]
	const badDirective = output
		.split("\n")
		.filter((l) => /^\s*:::([a-zA-Z]+)[ \t]+[^[\s]/.test(l));
	if (badDirective.length) {
		problems.push(`提示块语法错误（应写 :::tip 或 :::tip[标题]）：${badDirective[0].trim().slice(0, 40)}`);
	}

	// 10. ::: 开合配对
	const fences = output.split("\n").filter((l) => /^\s*:::/.test(l)).length;
	if (fences % 2 !== 0) problems.push(`::: 提示块数量是奇数（${fences} 行），可能有没闭合的`);

	return problems;
}

/* ---------------- 提示词 ---------------- */

const SYSTEM = `你是中文技术博客的编辑。任务：把一篇「面试问答笔记」重排成结构清晰、可阅读的技术文档。

硬性规则：
1. 只改结构和排版，不改技术事实：原文的每个要点都必须保留（同类可以合并，但不能丢内容），不能新增原文没有的结论、数据、案例。
2. 所有 \`\`\` 代码块内容一字不改地保留（位置可以移动）。
3. 输出纯 Markdown 正文：不要 frontmatter，不要一级标题 #，不要任何开场白、结语或"以下是优化后的版本"这类说明。
4. 保留作者的语气和标记（如 ⭐、⚠️、"面试加分点"），但要放到合适的位置，不要一行里堆三个加粗。

结构要求：
- 用 \`## \` 二级标题切成 3–7 个有信息量的中文小标题，标题要具体（例如"意向锁的兼容性矩阵"），不要写"1. 2. 3."或"核心要点一"。
- 内容多的小节用 \`### \` 再分层。
- **原文如果是"并列的 N 条"（N 大原则、N 种方式、N 个层次），就拆成 N 个小节（\`##\` 或 \`###\`），每条一个小标题，不要把两条合并成一段**。
- 并列、对比、多维度信息尽量做成 Markdown 表格，表头要有意义（例如 | 锁类型 | 粒度 | 是否锁数据行 | 使用场景 |）。
- 易错点/坑用 :::caution 块，加分点/记忆点用 :::tip 块，补充说明用 :::note 块。语法必须写成单独一行 \`:::tip\` 开头、单独一行 \`:::\` 结束；需要小标题时写 \`:::tip[标题文字]\`，**绝对不能写成 \`:::tip 文字\`**（会渲染失败）。每篇的提示块不超过 4 个。
- 术语首次出现加粗，标识符、命令、字段名用 \`反引号\`。
- 如果原文存在**真实的**流程、层级、组件关系、决策分支，可以插入一张 mermaid 图（每篇最多一张，没有真实结构就不要画，宁缺勿凑）：

\`\`\`mermaid
flowchart TD
  A[事务要改 id=1 的行] --> B[表上加 IX]
  B --> C[行上加 X]
\`\`\`

  mermaid 节点文字要短，避免括号、引号、分号等特殊字符，节点 id 用英文字母。
- 开头保留原文第一句核心结论（可轻微润色），不要另写摘要。
- 若原文有"面试答法建议"之类内容，放到最后一节 \`## 面试怎么答\`，用有序列表写 3–5 条。`;

const userPrompt = (title, body) => `文章标题：${title}

原文（面试问答笔记，请重排为结构化文档）：

<<<BODY
${body.trim()}
BODY>>>`;

/* ---------------- 调模型 ---------------- */

async function restyle(title, body, feedback = "") {
	const messages = [
		{ role: "system", content: SYSTEM },
		{ role: "user", content: userPrompt(title, body) },
	];
	if (feedback) {
		messages.push({
			role: "user",
			content: `上一次输出有以下问题，请修正后重新输出完整正文：\n${feedback}`,
		});
	}
	const res = await fetch(BASE, {
		method: "POST",
		headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
		body: JSON.stringify({ model: MODEL, temperature: 0.3, messages }),
		signal: AbortSignal.timeout(240_000),
	});
	if (!res.ok) throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 200)}`);
	const json = await res.json();
	return String(json.choices?.[0]?.message?.content ?? "")
		.replace(/^```(?:markdown|md)?\s*\n/, "")
		.replace(/\n```\s*$/, "")
		.trim();
}

/* ---------------- 主流程 ---------------- */

const files = readdirSync(POSTS_DIR)
	.filter((f) => f.endsWith(".md"))
	.sort();

const targets = [];
for (const f of files) {
	const raw = readFileSync(join(POSTS_DIR, f), "utf8");
	if (!/^section:\s*note\s*$/m.test(raw)) continue;
	const { front, body } = splitFrontmatter(raw);
	const title = (front.match(/^title:\s*(.+)$/m) || [])[1]?.trim() ?? f;
	if (ONLY_LIST.length && !ONLY_LIST.some((k) => title.includes(k))) continue;
	if (!FORCE && /^##\s/m.test(body)) continue; // 已经重排过
	targets.push({ file: f, raw, front, body, title });
}

const todo = LIMIT ? targets.slice(0, LIMIT) : targets;
console.log(`待处理 ${todo.length} 篇（共 ${files.length} 个文件，已跳过 ${targets.length - todo.length}）`);

if (!DRY) mkdirSync(BACKUP_DIR, { recursive: true });

const report = [];
let done = 0;

const queue = [...todo];
async function worker() {
	while (queue.length) {
		const item = queue.shift();
		if (!item) continue;
		let output = "";
		let problems = [];
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				output = await restyle(item.title, item.body, problems.join("\n"));
				problems = validate(item.body, output);
			} catch (err) {
				problems = [`调用失败：${err.message}`];
				continue;
			}
			if (problems.length === 0) break;
		}
		done++;
		if (problems.length === 0 && output) {
			if (DRY) {
				mkdirSync(".restyle-preview", { recursive: true });
				writeFileSync(join(".restyle-preview", item.file), item.front + output + "\n", "utf8");
			} else {
				copyFileSync(join(POSTS_DIR, item.file), join(BACKUP_DIR, item.file));
				writeFileSync(join(POSTS_DIR, item.file), item.front + output + "\n", "utf8");
			}
			report.push({ file: item.file, title: item.title, ok: true, chars: output.length });
			console.log(`✓ ${done}/${todo.length} ${item.title.slice(0, 30)} (${output.length} 字)`);
		} else {
			report.push({ file: item.file, title: item.title, ok: false, problems });
			console.log(`✗ ${done}/${todo.length} ${item.title.slice(0, 30)} → ${problems.join("；").slice(0, 160)}`);
		}
	}
}

await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

const okCount = report.filter((r) => r.ok).length;
console.log(`\n成功 ${okCount}，失败 ${report.length - okCount}${DRY ? "（dry run，未写入文件）" : ""}`);
if (!DRY) {
	writeFileSync(REPORT, JSON.stringify(report, null, "\t"), "utf8");
	for (const r of report.filter((x) => !x.ok)) console.log(`  失败：${r.title} → ${r.problems.join("；")}`);
}
