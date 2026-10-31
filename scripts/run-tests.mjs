/**
 * 单测入口：直接 import 所有 tests/unit/*.test.mjs。
 *
 * 为什么不用 `node --test tests/unit`：测试运行器给每个文件起子进程，
 * 在受限沙箱里子进程管道会 EPERM。这里改成同进程 import，
 * node:test 会在进程退出时统一汇报并设置退出码。
 */
import { readdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";

const dir = path.resolve(process.cwd(), "tests/unit");
const files = readdirSync(dir)
	.filter((name) => name.endsWith(".test.mjs"))
	.sort();

if (files.length === 0) {
	console.error("没有找到测试文件");
	process.exit(1);
}

for (const file of files) {
	await import(pathToFileURL(path.join(dir, file)).href);
}
