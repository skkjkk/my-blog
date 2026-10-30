/**
 * AI 摘要生成脚本
 *
 * 作用：找出所有没有 description（摘要）的文章，调用大模型生成一句话摘要，写回 frontmatter。
 * 由 .github/workflows/ai-summary.yml 在每次文章变动时自动运行。
 *
 * 手动运行：node scripts/ai-summary.mjs
 * 加 --force 可覆盖已有的摘要（慎用）。
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const POSTS_DIR = path.join(process.cwd(), "src/content/posts");
const FORCE = process.argv.includes("--force");

// 有 DeepSeek 的 key 就用 DeepSeek（稳、中文好）；没有就走免费公共接口（限流 1 次/30 秒）
const DEEPSEEK_KEY = (process.env.DEEPSEEK_API_KEY ?? "").trim();
const USE_DEEPSEEK = DEEPSEEK_KEY.length > 0;
const ENDPOINT = USE_DEEPSEEK
	? "https://api.deepseek.com/chat/completions"
	: (process.env.AI_ENDPOINT ?? "https://text.pollinations.ai/openai");
const MODEL = USE_DEEPSEEK ? "deepseek-chat" : (process.env.AI_MODEL ?? "openai");
const GAP_MS = USE_DEEPSEEK ? 1200 : 32000; // 免费接口每 30 秒只能一次

const SYSTEM = `你是个人博客的编辑。给你文章标题和正文，请写一句中文摘要，用于文章列表和搜索引擎。
要求：
- 20 到 60 个汉字，一句话，不要换行
- 说清这篇文章讲了什么，不要用"本文""这篇文章"开头
- 只能依据正文里真实写了的内容，不要补充正文没有的信息，不要编造结论
- 正文很短时就直接概括它说了什么，不要脑补
- 不要加引号、不要 Markdown、不要"摘要："这种前缀
- 只输出摘要本身`;

async function summarize(title, body) {
  const content = `标题：${title}\n\n正文：\n${body.slice(0, 6000)}`;
  const headers = { "content-type": "application/json" };
  if (USE_DEEPSEEK) headers.authorization = `Bearer ${DEEPSEEK_KEY}`;
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content },
      ],
      max_tokens: 220,
      temperature: 0.4,
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error("模型没有返回内容");
  return text
    .trim()
    .replace(/^["'“”「」]+|["'“”「」]+$/g, "")
    .replace(/\s+/g, " ")
    .split("\n")[0]
    .slice(0, 120);
}

/** 极简 frontmatter 解析：只取顶层 key: value（够用，不引第三方库） */
function parseFrontmatter(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return null;
  const [, fm, body] = match;
  const fields = {};
  for (const line of fm.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (m) fields[m[1]] = m[2];
  }
  return { frontmatter: fm, body, fields };
}

function escapeYaml(value) {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** 把 Markdown 正文压成纯文字（去掉语法符号），用于兜底摘要和长度判断 */
function plainText(markdown) {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/:::[a-z]*/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/[*_`>~-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 模型偶尔会抽风（重复输出、只说半句），这里做体检；不合格返回空串 */
function acceptSummary(text, plain) {
  const value = text.trim();
  if (value.length < 8) return "";
  if (/^(.{3,20}?)\1{1,}$/.test(value)) return ""; // 例如「这是一篇测试文章这是一篇测试文章」
  if (plain && value.length > plain.length) return ""; // 比正文还长，明显在编
  return value;
}

function withDescription(frontmatter, description) {
  const lines = frontmatter.split(/\r?\n/);
  const clean = description.replace(/\r?\n/g, " ");
  const index = lines.findIndex((line) => /^description:/.test(line));
  if (index >= 0) {
    lines[index] = `description: ${escapeYaml(clean)}`;
    return lines.join("\n");
  }
  // 没有就插在 title 后面，保持可读
  const titleIndex = lines.findIndex((line) => /^title:/.test(line));
  const insertAt = titleIndex >= 0 ? titleIndex + 1 : 0;
  lines.splice(insertAt, 0, `description: ${escapeYaml(clean)}`);
  return lines.join("\n");
}

async function main() {
  const files = (await readdir(POSTS_DIR)).filter((name) => name.endsWith(".md"));
  let changed = 0;

  for (const file of files) {
    const fullPath = path.join(POSTS_DIR, file);
    const raw = await readFile(fullPath, "utf8");
    const parsed = parseFrontmatter(raw);
    if (!parsed) {
      console.log(`跳过（没有 frontmatter）：${file}`);
      continue;
    }

    const { frontmatter, body, fields } = parsed;
    const current = (fields.description ?? "").replace(/^["']|["']$/g, "").trim();
    const isDraft = /^true$/i.test((fields.draft ?? "").trim());
    if (isDraft) {
      console.log(`跳过（草稿）：${file}`);
      continue;
    }
    if (current && !FORCE) {
      console.log(`已有摘要，跳过：${file}`);
      continue;
    }
    if (/^<Content \/>$/.test(body.trim())) {
      console.log(`跳过（没有正文）：${file}`);
      continue;
    }

    const title = (fields.title ?? "").replace(/^["']|["']$/g, "").trim() || file;
    const plain = plainText(body);

    // 正文太短就没必要问模型，直接用正文开头当摘要（也避免模型硬凑）
    if (plain.length < 60) {
      const fallback = plain.slice(0, 60);
      if (!fallback) {
        console.log(`跳过（正文太短且为空）：${file}`);
        continue;
      }
      const updated = `---\n${withDescription(frontmatter, fallback)}\n---\n${body}`;
      await writeFile(fullPath, updated, "utf8");
      console.log(`正文过短，直接用正文开头作摘要：${title} → ${fallback}`);
      changed++;
      continue;
    }

    console.log(`生成摘要：${title}`);

    let summary = "";
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const raw = await summarize(title, body);
        summary = acceptSummary(raw, plain);
        if (summary) break;
        console.warn(`  第 ${attempt} 次结果不合格（可能是重复或编造），重试`);
      } catch (error) {
        console.warn(`  第 ${attempt} 次失败：${error.message}`);
      }
      if (attempt < 3) await new Promise((r) => setTimeout(r, 3000 * attempt));
    }
    if (!summary) {
      // 兜底：用正文第一句
      const firstSentence = plain.split(/[。！？!?]/)[0]?.slice(0, 80) ?? "";
      if (!firstSentence) {
        console.warn(`  放弃：${file}`);
        continue;
      }
      summary = firstSentence;
      console.log(`  模型不给力，退而用正文第一句`);
    }

    const updated = `---\n${withDescription(frontmatter, summary)}\n---\n${body}`;
    await writeFile(fullPath, updated, "utf8");
    console.log(`  ✓ ${summary}`);
    changed++;
    await new Promise((r) => setTimeout(r, GAP_MS)); // 免费接口限流很严，间隔按需拉长
  }

  console.log(changed > 0 ? `完成，更新了 ${changed} 篇` : "完成，没有需要更新的文章");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
