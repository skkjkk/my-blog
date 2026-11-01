/**
 * 图片一键入库：把截图/图片压成 webp 丢进 public/images，并打印可直接粘贴的 markdown。
 *
 * 用法：
 *   node scripts/paste-image.mjs                    # 读 Windows 剪贴板里的图
 *   node scripts/paste-image.mjs a.png b.jpg        # 处理指定文件
 *   node scripts/paste-image.mjs --name cas-aba     # 指定文件名（不给就按时间戳）
 *   node scripts/paste-image.mjs --width 1200       # 最长边限制，默认 1600
 *
 * 输出示例：
 *   ![cas-aba](/images/cas-aba.webp)
 *   原图 2400×1500 482KB → 1600×1000 96KB（省 80%）
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import sharp from "sharp";

const OUT_DIR = "public/images";
const args = process.argv.slice(2);

let maxWidth = 1600;
let givenName = "";
const files = [];

for (let i = 0; i < args.length; i++) {
	const arg = args[i];
	if (arg === "--width") {
		maxWidth = Number(args[++i] ?? 1600) || 1600;
		continue;
	}
	if (arg === "--name") {
		givenName = args[++i] ?? "";
		continue;
	}
	if (arg.startsWith("--")) continue;
	files.push(arg);
}

mkdirSync(OUT_DIR, { recursive: true });

/** 读 Windows 剪贴板里的图片，落到临时 png */
function clipboardImage() {
	const dir = mkdtempSync(join(tmpdir(), "wkb-clip-"));
	const target = join(dir, "clip.png");
	const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$img = [System.Windows.Forms.Clipboard]::GetImage()
if ($img -eq $null) { Write-Output "EMPTY"; exit 0 }
$img.Save("${target.replace(/\\/g, "\\\\")}", [System.Drawing.Imaging.ImageFormat]::Png)
Write-Output "OK"
`;
	try {
		const output = execFileSync("powershell", ["-NoProfile", "-STA", "-Command", script], { encoding: "utf8" });
		if (output.includes("OK") && existsSync(target)) return target;
	} catch {
		// 没剪贴板权限/非 Windows
	}
	return "";
}

const sizeOf = (bytes) => (bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)}MB` : `${Math.round(bytes / 1024)}KB`);

const stamp = () => {
	const now = new Date();
	const pad = (value) => String(value).padStart(2, "0");
	return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
};

/** 文件名规范化：只留字母数字和连字符 */
const slugify = (text) =>
	text
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/^-+|-+$/g, "");

let sources = files;

if (sources.length === 0) {
	const clip = clipboardImage();
	if (!clip) {
		console.error("剪贴板里没有图片。先截图（Win+Shift+S），或者把图片路径作为参数传进来。");
		process.exit(1);
	}
	sources = [clip];
	console.log("已读取剪贴板图片\n");
}

for (const [index, source] of sources.entries()) {
	if (!existsSync(source)) {
		console.error(`找不到文件：${source}`);
		continue;
	}

	const rawSize = statSync(source).size;
	const base = givenName ? (sources.length > 1 ? `${givenName}-${index + 1}` : givenName) : slugify(basename(source, extname(source))) || `img-${stamp()}`;
	const name = `${base}.webp`;
	const target = join(OUT_DIR, name);

	await sharp(source)
		.resize({ width: maxWidth, withoutEnlargement: true })
		.webp({ quality: 82, effort: 5 })
		.toFile(target);

	const outSize = statSync(target).size;
	const meta = await sharp(target).metadata();
	const saved = rawSize > 0 ? Math.max(0, Math.round((1 - outSize / rawSize) * 100)) : 0;

	console.log(`![${base}](/images/${name})\n`);
	console.log(`  ${basename(source)}：${sizeOf(rawSize)} → ${meta.width}×${meta.height} ${sizeOf(outSize)}（省 ${saved}%）`);
	console.log(`  已写入 ${target}\n`);
}

// 顺手提示：public/images 里现在有多少图
const count = readdirSync(OUT_DIR).filter((name) => !name.startsWith(".")).length;
console.log(`public/images 现有 ${count} 个文件。`);
