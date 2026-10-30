// 生成本地演示数据（只在本地 wrangler dev 用，不提交数据库）
import { writeFileSync } from "node:fs";

const day = (offset) => new Date(Date.now() + 8 * 3600 * 1000 - offset * 86400000).toISOString().slice(0, 10);
const iso = (offsetDays, hour, minute = 0) =>
  new Date(Date.now() - offsetDays * 86400000 - (23 - hour) * 3600000 + minute * 60000).toISOString();

const posts = [
  "/posts/hello-world/",
  "/posts/astro-blog/",
  "/posts/cloudflare-deploy/",
  "/posts/d1-database/",
  "/posts/ai-summary/",
  "/posts/comments-giscus/",
  "/posts/domain-guide/",
  "/posts/pagefind-search/",
  "/",
  "/archive/",
  "/about/",
];

const lines = [];
lines.push("DELETE FROM views;");
lines.push("DELETE FROM views_hourly;");
lines.push("DELETE FROM ai_log;");
lines.push("DELETE FROM ai_hits;");
lines.push("DELETE FROM search_log;");

const weights = [0.2, 0.14, 0.11, 0.1, 0.08, 0.07, 0.06, 0.05, 0.09, 0.06, 0.04];

for (let d = 0; d < 45; d++) {
  const key = day(d);
  const base = d < 20 ? 8 + Math.round(Math.random() * 6) : 22 + Math.round(Math.random() * 26);
  const scale = d === 0 ? 0.6 : 1;
  for (let i = 0; i < posts.length; i++) {
    const count = Math.max(0, Math.round(base * scale * weights[i] * (0.6 + Math.random() * 0.9)));
    if (count > 0) lines.push(`INSERT INTO views (day, path, count) VALUES ('${key}', '${posts[i]}', ${count}) ON CONFLICT(day, path) DO UPDATE SET count = count + ${count};`);
  }
}

// 时段分布：晚上多、凌晨少
const hourCurve = [0.3, 0.2, 0.1, 0.1, 0.2, 0.4, 0.8, 1.4, 2.2, 3.0, 3.4, 3.2, 2.4, 2.6, 3.1, 3.3, 3.0, 3.4, 4.2, 5.0, 5.6, 5.2, 3.6, 1.8];
for (let d = 0; d < 30; d++) {
  const key = day(d);
  for (let h = 0; h < 24; h++) {
    const count = Math.round(hourCurve[h] * (0.5 + Math.random()));
    if (count > 0) lines.push(`INSERT INTO views_hourly (day, hour, count) VALUES ('${key}', ${h}, ${count}) ON CONFLICT(day, hour) DO UPDATE SET count = count + ${count};`);
  }
}

const questions = [
  "这个博客是怎么搭建的",
  "评论系统用的什么",
  "怎么绑定自己的域名",
  "Cloudflare 部署要花钱吗",
  "AI 摘要怎么实现的",
  "文章搜索是本地索引吗",
  "数据存在哪里",
  "怎么加统计",
  "这个主题叫什么",
  "怎么换颜色",
  "支持暗色模式吗",
  "Astro 和 Next 有什么区别",
  "为什么不用 Notion",
  "怎么备份文章",
  "后台密码忘了怎么办",
];

for (let i = 0; i < 48; i++) {
  const offset = Math.floor(Math.random() * 14);
  const hour = 8 + Math.floor(Math.random() * 15);
  const q = questions[Math.floor(Math.random() * questions.length)];
  const ok = Math.random() > 0.08 ? 1 : 0;
  const ms = 900 + Math.round(Math.random() * 2600);
  const tokens = 400 + Math.round(Math.random() * 900);
  const ts = iso(offset, hour, Math.floor(Math.random() * 60));
  lines.push(
    `INSERT INTO ai_log (ts, day, question, model, ms, tokens, ok) VALUES ('${ts}', '${day(offset)}', '${q}', 'self-dploy/DeepSeek-V4-Flash', ${ms}, ${tokens}, ${ok});`,
  );
}

const hitSets = [
  "/posts/comments-giscus/,/posts/hello-world/",
  "/posts/cloudflare-deploy/,/posts/domain-guide/",
  "/posts/ai-summary/",
  "/posts/d1-database/,/posts/cloudflare-deploy/",
  "",
  "/posts/astro-blog/,/posts/hello-world/,/posts/pagefind-search/",
];
for (let i = 0; i < 40; i++) {
  const paths = hitSets[Math.floor(Math.random() * hitSets.length)];
  const hits = paths ? paths.split(",").length : 0;
  const offset = Math.floor(Math.random() * 14);
  lines.push(`INSERT INTO ai_hits (ts, day, hits, paths) VALUES ('${iso(offset, 20)}', '${day(offset)}', ${hits}, '${paths}');`);
}

const keywords = ["评论", "域名", "部署", "AI", "搜索", "统计", "主题", "颜色", "备份", "评论", "域名", "AI", "部署", "统计"];
for (let i = 0; i < 34; i++) {
  const keyword = keywords[Math.floor(Math.random() * keywords.length)];
  const offset = Math.floor(Math.random() * 14);
  lines.push(
    `INSERT INTO search_log (ts, day, keyword, results) VALUES ('${iso(offset, 21)}', '${day(offset)}', '${keyword}', ${Math.floor(
      Math.random() * 6,
    )});`,
  );
}

writeFileSync("D:/06-Agentworkspace/my-blog/.seed.sql", lines.join("\n"), "utf8");
console.log("ok", lines.length);
