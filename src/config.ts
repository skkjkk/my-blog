import type {
	ExpressiveCodeConfig,
	LicenseConfig,
	NavBarConfig,
	ProfileConfig,
	SiteConfig,
} from "./types/config";
import { LinkPreset } from "./types/config";

// ============================================================
//  ① 网站基本信息：改这里（改完保存，本地预览会自动刷新）
// ============================================================
export const siteConfig: SiteConfig = {
	title: "Wkb", // 网站标题，显示在浏览器标签和左上角
	subtitle: "记录 · 思考 · 折腾", // 副标题
	lang: "zh_CN", // 界面语言：zh_CN 简体中文 / zh_TW 繁体 / en 英文 / ja 日文
	themeColor: {
		hue: 250, // 主题色，0-360：0 红 / 30 橙 / 145 绿 / 200 青 / 250 蓝 / 285 紫 / 345 粉
		fixed: false, // true = 隐藏右上角的换色按钮，游客只能用你的默认色
	},
	banner: {
		enable: false, // 是否需要顶部大图（横幅）
		src: "assets/images/demo-banner.png", // 以 / 开头表示 public 目录，否则相对 src 目录
		position: "center", // 图片裁切位置：top / center / bottom
		credit: {
			enable: false,
			text: "",
			url: "",
		},
	},
	toc: {
		enable: true, // 文章右侧显示目录
		depth: 2, // 目录层级，1-3
	},
	favicon: [],
};

// ============================================================
//  ② 顶部导航栏
// ============================================================
export const navBarConfig: NavBarConfig = {
	links: [
		LinkPreset.Home,
		{
			name: "题库", // 面试笔记的总目录，见 src/pages/notes.astro
			url: "/notes/",
		},
		{
			name: "刷题", // 自测模式，见 src/pages/quiz.astro
			url: "/quiz/",
		},
		LinkPreset.Archive,
		LinkPreset.About,
		{
			name: "GitHub",
			url: "https://github.com/skkjkk",
			external: true, // 显示外链图标，并在新标签页打开
		},
	],
};

// ============================================================
//  ③ 左侧个人名片
// ============================================================
export const profileConfig: ProfileConfig = {
	avatar: "assets/images/avatar.png", // 头像：把图片放进 src/assets/images/ 再改这里
	name: "Wkb", // 你的名字 / 昵称
	bio: "在这里记录一些想法和折腾的过程。",
	links: [
		// 图标名字可以去 https://icones.js.org/ 搜
		{
			name: "GitHub",
			icon: "fa6-brands:github",
			url: "https://github.com/skkjkk",
		},
	],
};

// ============================================================
//  ④ 文章底部的版权声明
// ============================================================
export const licenseConfig: LicenseConfig = {
	enable: true,
	name: "CC BY-NC-SA 4.0",
	url: "https://creativecommons.org/licenses/by-nc-sa/4.0/",
};

export const expressiveCodeConfig: ExpressiveCodeConfig = {
	// 代码块配色，必须选深色主题
	theme: "github-dark",
};

// ============================================================
//  ⑤ 评论区
// ============================================================
export const commentConfig = {
	// local = 本站自建（D1）；giscus = 旧的 GitHub Discussions（仅供回滚对照）
	provider: "local" as "local" | "giscus",
	// Cloudflare Turnstile 的公开 site key（可选）。留空则不加载人机验证，
	// 只靠蜜罐字段 + 频率限制；填了还要在 Worker 里配 TURNSTILE_SECRET。
	turnstileSiteKey: "",
};
