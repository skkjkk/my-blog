/**
 * 把后台页面 <style is:global> 里的选择器全部收进 .dash 作用域
 *
 * 为什么：Astro 会把这些全局样式打进所有页面共用的 CSS，于是 `.grid`（后台的 12 栅格）
 * 把博客主布局的 grid 也改成了 12 列，宽屏下整站布局被压扁。
 * 用法：node scripts/scope-admin-css.mjs [--check]
 */
import { readFileSync, writeFileSync } from "node:fs";

const FILE = "src/pages/admin/index.astro";
const CHECK = process.argv.includes("--check");
const PREFIX = ".dash";
const ALREADY_SCOPED = [".dash", "#ai-chat"];
const KEYFRAME_STEPS = new Set(["from", "to", "0%", "100%"]);

const scoped = (sel) => {
	const s = sel.trim();
	if (!s) return s;
	if (KEYFRAME_STEPS.has(s)) return s;
	if (ALREADY_SCOPED.some((p) => s === p || s.startsWith(`${p} `) || s.startsWith(`${p}.`))) return s;
	if (s.startsWith("html.dark ")) {
		const rest = s.slice("html.dark ".length).trim();
		if (ALREADY_SCOPED.some((p) => rest === p || rest.startsWith(`${p} `))) return s;
		return `html.dark ${PREFIX} ${rest}`;
	}
	return `${PREFIX} ${s}`;
};

const src = readFileSync(FILE, "utf8");
const lines = src.split("\n");
const out = [];
const changed = [];

let inStyle = false;
let depth = 0;
let keyframesAt = null;
let pendingSelector = null; // 多行选择器累积

const braces = (s) => ({
	open: (s.match(/\{/g) || []).length,
	close: (s.match(/\}/g) || []).length,
});

for (const line of lines) {
	if (!inStyle) {
		out.push(line);
		if (/<style[^>]*is:global/.test(line)) inStyle = true;
		continue;
	}
	if (/<\/style>/.test(line)) {
		inStyle = false;
		out.push(line);
		continue;
	}

	const t = line.trim();
	const inKeyframes = keyframesAt !== null && depth >= keyframesAt;

	// 选择器（可能跨行，以逗号结尾表示还有下一行）
	if (!inKeyframes && t !== "" && !t.startsWith("@") && !t.startsWith("/*") && !t.startsWith("*")) {
		if (pendingSelector !== null) {
			pendingSelector.push(line);
			if (t.endsWith("{")) {
				const indent = (pendingSelector[0].match(/^\s*/) || [""])[0];
				// 累积的选择器整体重写
				const all = pendingSelector.join("\n");
				const sel = all.replace(/\{\s*$/, "").trim();
				const parts = sel.split(",").map(scoped);
				const next = indent + parts.join(`,\n${indent}`) + " {";
				if (next.trim() !== all.trim()) changed.push(sel.replace(/\s+/g, " "));
				out.push(next);
				pendingSelector = null;
				depth += 1;
				continue;
			}
			continue;
		}
		if (t.endsWith(",")) {
			pendingSelector = [line];
			continue;
		}
		if (t.endsWith("{")) {
			const indent = line.match(/^\s*/)[0];
			const sel = t.replace(/\{\s*$/, "").trim();
			const next = sel.split(",").map(scoped).join(`,\n${indent}`) + " {";
			if (next.trim() !== t) changed.push(sel);
			out.push(indent + next);
			depth += 1;
			continue;
		}
	}

	if (t.startsWith("@keyframes") && t.includes("{")) {
		keyframesAt = depth + 1;
	}

	const { open, close } = braces(line);
	depth += open - close;
	if (keyframesAt !== null && depth < keyframesAt) keyframesAt = null;

	out.push(line);
}

console.log(`改动 ${changed.length} 处选择器`);
for (const c of changed.slice(0, 12)) console.log("  · " + c);

if (CHECK) {
	console.log("(check only，未写入)");
} else {
	writeFileSync(FILE, out.join("\n"), "utf8");
	console.log(`written → ${FILE}`);
}
