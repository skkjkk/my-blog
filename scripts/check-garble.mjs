/**
 * 乱码检测：抓「中文和英文/数字粘在一起」这类生成噪声。
 *
 * 背景：用网关模型批量生成笔记时，偶尔会在正常句子中间插入无意义词
 * （例：`经验性做法818`、`会立刻返回 Revy`、`不释放锁海边`）。这类脏字
 * 混进正文很难靠肉眼全篇扫出来，所以做成脚本卡一道。
 *
 * 用法：
 *   node scripts/check-garble.mjs                 # 扫全部笔记
 *   node scripts/check-garble.mjs --only CAS      # 只扫匹配的文件
 *   node scripts/check-garble.mjs --strict        # 有命中就退出码 1（CI 用）
 *
 * 判定：代码围栏外的文本里，中文字符紧贴 2 个以上拉丁字母、或紧贴 2 位以上
 * 数字，都算可疑——正常写法会在中间留空格或反引号。命中后人工看一眼即可。
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = "src/content/posts";
const args = process.argv.slice(2);
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : "";

/** 这些是正常术语，别误报 */
const ALLOW = [
	// 版本/产品名这类缩写（Java8、JDK17、HTTP2……）
	/java8|jdk8|jdk17|jdk21|python3|log4j2|http2|http3|ipv6|utf8|base64|sha256|md5|aes256|oauth2|openai4|gpt4|gpt3|cuda12|redis7|mysql8|spring6|es7/i,
	// 中文技术写作里本来就紧贴中文的英文缩写：用户ID、JVM内存、IO 密集……
	/^(?:[\u4e00-\u9fa5]?(?:ID|IP|IO|JVM|GC|CPU|SQL|AQS|CAS|MCP|A2A|LLM|RAG|API|SDK|JWT|TTL|QPS|TPS|DTO|VO|PO|SPI|ORM|DDL|DML|MVCC|B\+?树)[\u4e00-\u9fa5]?)$/,
];

const RULES = [
	{ name: "中文后紧跟英文单词", re: /[\u4e00-\u9fa5][A-Za-z]{2,}/g },
	{ name: "英文单词后紧跟中文", re: /[A-Za-z]{2,}[\u4e00-\u9fa5]/g },
	{ name: "中文后紧跟多位数字", re: /[\u4e00-\u9fa5]\d{2,}/g },
];

const hits = [];
let scanned = 0;

for (const file of readdirSync(DIR).filter((name) => name.endsWith(".md")).sort()) {
	if (only && !file.includes(only)) continue;
	const raw = readFileSync(join(DIR, file), "utf8");
	scanned++;

	// 去掉 frontmatter，代码围栏整块剔除（代码里中英混排是正常的）
	const body = raw.replace(/^---[\s\S]*?\n---\n/, "").replace(/```[\s\S]*?```/g, "");

	const found = [];
	for (const rule of RULES) {
		for (const match of body.matchAll(rule.re)) {
			const at = match.index ?? 0;
			const snippet = body.slice(Math.max(0, at - 12), at + 16).replace(/\s+/g, " ");
			if (ALLOW.some((allow) => allow.test(match[0]))) continue;
			if (found.some((item) => item.match === match[0] && Math.abs(item.at - at) < 40)) continue;
			found.push({ match: match[0], snippet, at, rule: rule.name });
		}
	}

	if (found.length > 0) hits.push({ file, found });
}

console.log(`扫描 ${scanned} 篇，命中 ${hits.length} 篇`);
for (const hit of hits) {
	console.log(`\n${hit.file}`);
	for (const item of hit.found.slice(0, 8)) console.log(`  [${item.rule}] …${item.snippet}…`);
	if (hit.found.length > 8) console.log(`  …… 还有 ${hit.found.length - 8} 处`);
}

if (args.includes("--strict") && hits.length > 0) process.exit(1);

