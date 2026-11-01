/**
 * 构建入口：pnpm build
 *
 * 做三件事：先体检文章 → astro build → pagefind 建索引。
 *
 * 为什么要多这一层：这台机器上 esbuild 在系统 TEMP 里删临时文件会被拒
 * （`remove ...\Temp\esbuild-xxx: Access is denied`），构建会直接失败。
 * 把子进程的 TEMP/TMP 指到仓库里的 .tmp（已 gitignore）就绕开了，不用每次手动设环境变量。
 */
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";

const tmp = path.resolve(".tmp");
mkdirSync(tmp, { recursive: true });

const env = { ...process.env, TEMP: tmp, TMP: tmp, TMPDIR: tmp };
const isWindows = process.platform === "win32";

/** shell 模式下必须传整条命令字符串，否则 Node 会警告参数未转义 */
function run(label, command) {
	console.log(`\n▶ ${label}`);
	const result = spawnSync(command, { stdio: "inherit", env, shell: true });
	if (result.error) {
		console.error(`启动失败：${result.error.message}`);
		process.exit(1);
	}
	if (result.status !== 0) {
		console.error(`\n✗ ${label} 失败（退出码 ${result.status}）`);
		process.exit(result.status ?? 1);
	}
}

run("文章体检", "node scripts/lint-posts.mjs");
run("astro build", "npx astro build");
run("pagefind 索引", "npx pagefind --site dist");

console.log("\n✓ 构建完成，产物在 dist/");
