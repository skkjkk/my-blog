/**
 * 测一下各模型在本机到网关的实际吞吐（用真实的长文改写任务）
 * 用法：node scripts/bench-models.mjs
 */
import { readFileSync } from "node:fs";

const env = readFileSync(".dev.vars", "utf8");
const pick = (n) => (env.match(new RegExp(`^${n}=(.+)$`, "m")) || [])[1]?.trim() ?? "";
const KEY = pick("AI_API_KEY");
const BASE = pick("AI_BASE_URL") || "https://api.hcnsec.cn/v1/chat/completions";

const body = readFileSync("src/content/posts/InnoDB中的表级锁页级锁和行级锁.md", "utf8")
	.replace(/^---[\s\S]*?---\n/, "")
	.slice(0, 2600);

const models = process.argv.slice(2);
const targets = models.length
	? models
	: ["DeepSeek-V4-Flash", "Qwen3.8-Flash-Next", "glm-5.3-flash", "MiniMax-M3.1-Flash", "step-5-preview", "auto"];

for (const model of targets) {
	const t0 = Date.now();
	try {
		const res = await fetch(BASE, {
			method: "POST",
			headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
			body: JSON.stringify({
				model,
				temperature: 0.3,
				max_tokens: 3000,
				messages: [
					{
						role: "system",
						content:
							"你是中文技术博客编辑。把这份面试笔记重排成结构化文档：用 ## 二级标题分节（3-7 节），并列内容做成 Markdown 表格，易错点用 :::caution 块。只改结构不改事实，输出纯 Markdown。",
					},
					{ role: "user", content: body },
				],
			}),
			signal: AbortSignal.timeout(240_000),
		});
		const ms = Date.now() - t0;
		if (!res.ok) {
			console.log(`${model.padEnd(22)} ✗ ${res.status} ${(await res.text()).slice(0, 80)}`);
			continue;
		}
		const json = await res.json();
		const text = json.choices?.[0]?.message?.content ?? "";
		const usage = json.usage ?? {};
		console.log(
			`${model.padEnd(22)} ✓ ${String(ms).padStart(6)}ms  输出 ${text.length} 字  h2=${(text.match(/^## /gm) || []).length}  表格=${(text.match(/^\|/gm) || []).length}  tokens=${usage.completion_tokens ?? "?"}  实际=${json.model ?? model}`,
		);
	} catch (err) {
		console.log(`${model.padEnd(22)} ✗ ${err.message}`);
	}
}
