import { initShell } from "../core/shell";

/**
 * 数据台 · 评论：审核台本身由 admin-comments.ts 负责，
 * 这里只要把登录门和顶栏跑起来，并在登录成功后打一声招呼（admin:console）。
 */
export function initCommentsBoard(): boolean {
	initShell({
		page: "comments",
		load: async () => {
			window.dispatchEvent(new Event("admin:console"));
			return "ok";
		},
	});
	return true;
}
