/**
 * 用 GitHub API 把本地 HEAD 发布到远端 main（中文文件名安全）
 *
 * 为什么不用 git push：本机连不上 github.com:443，只有 api.github.com 通。
 * 为什么不用 scripts/gh-push.ps1：它靠 `git diff --name-status` 的文本输出拿路径，
 * 中文文件名会被 git 转义成 "\350\256\276..."，写进 GitHub 就成了乱码空文件。
 * 这里改成只认 blob SHA（与路径无关），路径单独用 UTF-8 原样发送。
 *
 * 用法：node scripts/gh-push.mjs -m "提交说明" [--dry]
 */

import { execFileSync } from "node:child_process";

const OWNER = "skkjkk";
const REPO = "my-blog";
const BRANCH = "main";

const args = process.argv.slice(2);
const messageIndex = args.findIndex((a) => a === "-m" || a === "--message");
const message = messageIndex >= 0 ? args[messageIndex + 1] : `发布 ${new Date().toISOString()}`;
const dry = args.includes("--dry");

const git = (...gitArgs) => execFileSync("git", gitArgs, { maxBuffer: 1024 * 1024 * 512 });
const gitText = (...gitArgs) => git(...gitArgs).toString("utf8");

const token = execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
const api = async (method, path, body) => {
	const res = await fetch(`https://api.github.com${path}`, {
		method,
		headers: {
			authorization: `Bearer ${token}`,
			accept: "application/vnd.github+json",
			"content-type": "application/json",
			"user-agent": "wkb-publisher",
		},
		body: body ? JSON.stringify(body) : undefined,
	});
	const text = await res.text();
	if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 300)}`);
	return text ? JSON.parse(text) : null;
};

/* ---------- 远端现状 ---------- */
const ref = await api("GET", `/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`);
const head = await api("GET", `/repos/${OWNER}/${REPO}/git/commits/${ref.object.sha}`);
const remoteTree = await api("GET", `/repos/${OWNER}/${REPO}/git/trees/${head.tree.sha}?recursive=1`);
const remoteBlobs = new Map(remoteTree.tree.filter((n) => n.type === "blob").map((n) => [n.path, n.sha]));

/* ---------- 本地 HEAD 现状（-z 保证路径不被转义） ---------- */
const localEntries = gitText("ls-tree", "-r", "-z", "--full-tree", "HEAD")
	.split("\0")
	.filter(Boolean)
	.map((line) => {
		const [meta, ...rest] = line.split("\t");
		const [, type, sha] = meta.split(" ");
		return { type, sha, path: rest.join("\t") };
	})
	.filter((entry) => entry.type === "blob");

const localBlobs = new Map(localEntries.map((entry) => [entry.path, entry.sha]));

const toUpload = localEntries.filter((entry) => remoteBlobs.get(entry.path) !== entry.sha);
const toDelete = [...remoteBlobs.keys()].filter((path) => !localBlobs.has(path));

console.log(`远端 ${remoteBlobs.size} 个文件 · 本地 ${localBlobs.size} 个 · 待上传 ${toUpload.length} · 待删除 ${toDelete.length}`);
if (dry) {
	console.log("待上传示例:", toUpload.slice(0, 5).map((e) => e.path));
	console.log("待删除示例:", toDelete.slice(0, 5));
	process.exit(0);
}
if (toUpload.length === 0 && toDelete.length === 0) {
	console.log("远端已经和本地 HEAD 一致，无需推送");
	process.exit(0);
}

/* ---------- 上传新 blob ---------- */
const entries = [];
let done = 0;
for (const entry of toUpload) {
	const bytes = git("cat-file", "blob", entry.sha); // Buffer，二进制安全
	const blob = await api("POST", `/repos/${OWNER}/${REPO}/git/blobs`, {
		content: bytes.toString("base64"),
		encoding: "base64",
	});
	entries.push({ path: entry.path, mode: "100644", type: "blob", sha: blob.sha });
	done += 1;
	if (done % 20 === 0) console.log(`  已上传 ${done}/${toUpload.length}`);
}

/* ---------- 标记删除 ---------- */
for (const path of toDelete) {
	entries.push({ path, mode: "100644", type: "blob", sha: null });
	if (path.startsWith('"')) console.log(`  清理异常路径 ${JSON.stringify(path)}`);
}

const tree = await api("POST", `/repos/${OWNER}/${REPO}/git/trees`, { base_tree: head.tree.sha, tree: entries });
const commit = await api("POST", `/repos/${OWNER}/${REPO}/git/commits`, {
	message,
	tree: tree.sha,
	parents: [head.sha],
});
await api("PATCH", `/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`, { sha: commit.sha, force: false });

console.log(`已发布：${commit.sha.slice(0, 7)} ${message}`);
