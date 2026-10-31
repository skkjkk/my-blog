/**
 * 把 ```mermaid 代码块转成 <pre class="mermaid">，由前端脚本渲染成图。
 * 不这样做的话，Expressive Code 会把它当普通代码块高亮，图上不去。
 */
import { visit } from "unist-util-visit";

const escapeHtml = (s) =>
	s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function remarkMermaid() {
	return (tree) => {
		visit(tree, "code", (node, index, parent) => {
			if (!parent || typeof index !== "number") return;
			if ((node.lang ?? "").toLowerCase() !== "mermaid") return;

			parent.children[index] = {
				type: "html",
				value: `<div class="mermaid-wrap"><pre class="mermaid">${escapeHtml(node.value)}</pre></div>`,
			};
		});
	};
}
