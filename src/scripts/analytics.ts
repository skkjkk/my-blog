/**
 * 轻量埋点：只用两个客户端随机 id，不上报任何设备信息。
 *
 *   vid —— localStorage，认「人」（换设备算新访客，和大多数分析工具一致）
 *   sid —— sessionStorage，认「这一次会话」（关掉标签页就换新的）
 *
 * 服务端入库前会再用 IP_SALT 哈希一次，D1 里永远没有原始 id。
 * 所有上报都失败静默——统计坏了不能让页面坏。
 */

const VID_KEY = "wkb:vid";
const SID_KEY = "wkb:sid";

function randomId(bytes = 12): string {
	try {
		const buffer = new Uint8Array(bytes);
		crypto.getRandomValues(buffer);
		return Array.from(buffer)
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("");
	} catch {
		return Math.random().toString(36).slice(2) + Date.now().toString(36);
	}
}

function read(store: Storage | null, key: string): string {
	try {
		const value = store?.getItem(key);
		if (value && value.length >= 8) return value;
		const fresh = randomId();
		store?.setItem(key, fresh);
		return fresh;
	} catch {
		return randomId();
	}
}

let cache: { vid: string; sid: string } | null = null;

/** 取访客 / 会话 id（首次调用时生成并落盘） */
export function visitorIds(): { vid: string; sid: string } {
	if (cache) return cache;
	let local: Storage | null = null;
	let session: Storage | null = null;
	try {
		local = window.localStorage;
	} catch {
		local = null;
	}
	try {
		session = window.sessionStorage;
	} catch {
		session = null;
	}
	cache = { vid: read(local, VID_KEY), sid: read(session, SID_KEY) };
	return cache;
}

export type TrackType =
	| "page_view"
	| "panel_open"
	| "search"
	| "quiz"
	| "comment";

export type TrackPayload = {
	path?: string;
	ms?: number;
	ttft?: number;
	tokens?: number;
	ok?: boolean;
	err?: string;
	n?: number;
	hits?: number;
	tag?: string;
	text?: string;
	meta?: Record<string, unknown>;
};

/** 记一条事件（fire-and-forget，永远不抛错） */
export function track(type: TrackType, payload: TrackPayload = {}): void {
	try {
		const { vid, sid } = visitorIds();
		const body = JSON.stringify({
			type,
			path: payload.path ?? window.location.pathname,
			...payload,
			vid,
			sid,
		});
		if (navigator.sendBeacon) {
			navigator.sendBeacon(
				"/api/track",
				new Blob([body], { type: "application/json" }),
			);
			return;
		}
		void fetch("/api/track", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body,
			keepalive: true,
		});
	} catch {
		// 统计失败不影响功能
	}
}
