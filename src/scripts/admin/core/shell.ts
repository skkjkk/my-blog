/**
 * 数据台外壳：登录门、时间范围、刷新、退出。
 * 各页面只提供 load(range) —— 剩下的都在这儿，页面不用重复写一遍。
 */

import { RANGES, readRange, writeRange } from "./api";
import { $, $$, pad } from "./dom";

export type LoadResult = "ok" | "unauth" | "error";

export type ShellOptions = {
	/** 页面名，仅用于日志 */
	page: string;
	/** 拉数据并渲染；返回 unauth 时外壳自动退回登录门 */
	load: (range: number) => Promise<LoadResult>;
};

export function showConsole(show: boolean): void {
	const gate = $("#gate");
	const panel = $("#console");
	if (gate) gate.hidden = show;
	if (panel) panel.hidden = !show;
}

function stamp(): void {
	const node = $("#stamp");
	if (!node) return;
	const now = new Date();
	node.textContent = `${now.getFullYear()}.${pad(now.getMonth() + 1)}.${pad(now.getDate())} ${pad(
		now.getHours(),
	)}:${pad(now.getMinutes())} · GMT+8`;
}

/** 时间范围按钮统一由这里是生成：加一个 90 天不用改布局 */
function buildRangeSeg(current: number): void {
	const box = $("#range-seg");
	if (!box) return;
	box.innerHTML = RANGES.map(
		(range) =>
			`<button type="button" data-range="${range}"${range === current ? ' class="is-active"' : ""}>${range} 天</button>`,
	).join("");
}

export function initShell(options: ShellOptions): void {
	let range = readRange();
	let busy = false;

	buildRangeSeg(range);

	const run = async () => {
		if (busy) return;
		busy = true;
		try {
			const result = await options.load(range);
			if (result === "unauth") {
				showConsole(false);
				return;
			}
			showConsole(true);
			stamp();
		} finally {
			busy = false;
		}
	};

	for (const button of $$<HTMLButtonElement>("#range-seg button")) {
		button.addEventListener("click", () => {
			range = Number(button.dataset.range ?? range);
			writeRange(range);
			for (const other of $$("#range-seg button"))
				other.classList.toggle("is-active", other === button);
			void run();
		});
	}

	$("#refresh")?.addEventListener("click", () => void run());

	$("#logout")?.addEventListener("click", async () => {
		await fetch("/api/admin/logout", { method: "POST" });
		showConsole(false);
	});

	$("#login-form")?.addEventListener("submit", async (event) => {
		event.preventDefault();
		const input = $("#password") as HTMLInputElement | null;
		const error = $("#login-error");
		if (error) error.hidden = true;
		const response = await fetch("/api/admin/login", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ password: input?.value ?? "" }),
		});
		if (!response.ok) {
			const body = (await response.json().catch(() => ({}))) as {
				error?: string;
			};
			if (error) {
				error.textContent = body.error ?? "密码不对";
				error.hidden = false;
			}
			return;
		}
		if (input) input.value = "";
		await run();
	});

	void run();
}
