# 自建评论区 · 设计文档

日期：2026-11-01
状态：待批准
作者：与博客作者对话整理

---

## 1. 意图与背后的原因

现在博客的评论是 giscus：数据存在 GitHub Discussions 里，读者必须用 GitHub 账号登录才能留言，作者只能去 GitHub 上删除，没法按自己的规则管。

作者要的是一个**自己掌控的评论系统**：数据在自己手里，读者门槛低，后台能直接管理，并且**安全和异常处理要与"能上线给陌生人用"相称**——不是玩具。

## 2. 目标

1. 访客无需任何第三方账号，填昵称即可评论（可选邮箱/网址）。
2. 支持二级回复（楼中楼）、按时间排序、分页加载。
3. 作者在 `/admin` 后台可以：查看、搜索、筛选、通过、标为垃圾、删除/恢复、回复、置顶，以及编辑屏蔽词。
4. 具备与真实攻击面匹配的防护：机器人、刷屏、XSS、CSRF、越权、数据膨胀。
5. 任何故障都不拖垮文章页：评论加载失败/提交失败都有明确、可恢复的反馈。
6. 完全跑在现有 Cloudflare Worker + D1 上，不引入任何新的第三方服务或付费依赖。

## 3. 非目标（v1 明确不做）

| 不做 | 原因 |
|---|---|
| 账号体系 / GitHub·Google OAuth | 二维码级复杂度；匿名 + 邮箱哈希足够识别"同一个人" |
| 邮件通知（有人回复我 → 发邮件） | 站上没有邮件服务商；且需要存明文邮箱，与隐私取向冲突 |
| 把 giscus 的历史评论迁移过来 | GitHub Discussions → D1 的映射不可靠（无 parent 关系、作者是 GitHub 账号）；旧评论在仓库里仍可查 |
| 富文本 / 完整 Markdown / 图片上传 | XSS 面积与存储成本都不值；v1 用纯文本 + 换行 + 自动识别链接 |
| 实时推送（WebSocket / SSE） | Workers 免费层不友好；用"提交后本地插入 + 刷新可见"代替 |
| 点赞、表情反应 | 边际价值低，先不做（数据结构预留，后续加表即可） |
| 首页/列表页显示评论数 | 静态页面需要额外请求；列为 v2 可选 |

## 4. 反目标（技术上做得到，但会让这件事算失败）

- **评论加载慢拖累正文**：评论必须异步加载，正文先出；评论接口挂了，文章照常可读。
- **读者被审核墙挡住**：默认先发后审——正常读者的评论立即可见，只有可疑内容进待审。
- **评论变成第二个内容管理负担**：后台必须能一次扫完、批量处理，否则作者会放弃维护。
- **为了"完善"引入外部 SaaS**（Disqus/Waline 托管版）：直接违背"自己管理"。
- **在客户端暴露任何不该公开的数据**：IP 哈希、邮箱哈希、待审内容都不能出现在公开 API 响应里。

## 5. 约束

- 运行环境：Cloudflare Workers + D1（免费层），`run_worker_first: ["/api/*"]`，其余走静态资源。
- 页面是构建时静态生成的（`astro build`），评论只能客户端拉取。
- 全站用 swup 做局部页面切换：**组件内 `<script>` 不会在页面切换时重跑**，挂载逻辑必须放在 `Layout.astro` 并用 `swup.hooks.on("page:view")`（现有 giscus / mermaid / 统计上报都是这个模式）。
- 现有技术栈：Astro 5 + Svelte（已装但评论不用）+ Tailwind + 既有 CSS 变量（`--primary`、`--line-divider`、`text-75` 等）。样式必须跟随深浅色主题。
- 现有后端约定：`worker/index.js` 单文件路由、`json()` 统一响应、`ensureSchema()` 自愈建表、后台用 `ADMIN_PASSWORD` 派生 HMAC cookie。
- 部署方式：推 `main` 分支由 Cloudflare 自动构建部署；D1 结构变更需 `wrangler d1 execute`。

## 6. 作者已决定的（不可改）

- 评论数据存在自己的 D1 里，不依赖 GitHub。
- 匿名评论，不做登录。
- 要有后台管理能力。
- 安全与异常处理按"各种情况都要考虑"的标准做（下文第 8、9 节为逐条清单）。

## 7. 我（建造者侧）决定的部分

以下每一条都是可被推翻的默认值，标注在此以便作者核对。

### 7.1 身份与隐私

- 昵称 1–24 字必填；邮箱选填；网址选填。
- **邮箱只存哈希**（`sha256(SALT + lower(email))` 前 32 位），不存明文。代价：将来若要发通知邮件，需要另加明文列并征得同意。
- **头像不接 Gravatar**：用 `name` + `email_hash` 生成确定性色块 + 首字母（纯前端计算，零外部请求，也不泄露邮箱哈希给第三方）。
- 身份记忆：首次评论后服务端下发 `wkb_commenter` cookie（HttpOnly、SameSite=Lax、180 天），内含签名过的 `{name, emailHash, website, uid}`，下次自动填表，不需要账号。

**身份标识（`identity_hash`）**：`uid` 是服务端随机生成的 16 字节标识，客户端不能自造（cookie 有 HMAC 签名，验签失败即当新访客）。所有"同一身份"的规则——重复内容、被举报计数、首次评论判定、按身份的限流桶——一律用 `identity_hash`，不用 `email_hash`、也不用 `ip_hash`。

理由：邮箱选填，"没填邮箱的人"和"同一出口 IP 下的一公司人"都不该被当成同一个人；IP 哈希只用于限流与举报去重（防止一个人换马甲），不用于内容规则。

签名密钥用 `COMMENT_COOKIE_SECRET`（新增 Secret）；轮换它 = 所有人被当成新访客一次，历史评论不受影响。
- **不存明文 IP**：只存 `sha256(SALT + IP)` 前 16 位，用于限流与撞库去重，180 天后随行删除时可清空。
- 正文按纯文本渲染：**不解析 HTML，不做 Markdown**；只做转义 + 换行 + 自动识别 `http(s)://` 链接（渲染为 `<a rel="nofollow noopener ugc" target="_blank">`）。

### 7.2 审核

- 全局模式两档，存 `settings` 表，后台可切换：
  - `auto`（默认）：先发后审，命中规则才进待审。
  - `hold`：全部进待审（作者心情不好或被人盯上时用）。
- 进 `pending` 的自动规则：正文含 ≥2 个链接、命中屏蔽词、同一 `identity_hash` 24h 内重复内容、该身份曾被举报 ≥2 次。
- **"首次评论的访客进 pending" 默认关闭**。理由：它与"读者不被审核墙挡住"直接冲突——陌生读者的第一条评论恰恰是最想被看见的那条。想严格时把全局模式切到 `hold`，那是更清晰的一档，不需要隐形的首条规则。
- 作者自己（后台登录态）发的评论/回复直接 `approved`，并带"博主"标记。

### 7.3 展示

- 楼中楼最多两层：顶级评论 + 回复；对回复的回复统一挂到同一顶级评论下并 `@昵称`。
- 排序：最新在前（默认）/ 最早在前。
- 分页：顶级评论每页 20 条，cursor 分页（基于 `(created_at, id)`），"加载更多"按钮，不用页码。
- 删除的评论保留占位（"该评论已被删除"），保住楼层结构；只有作者能看"谁删的"。

### 7.4 文章稳定键（防止改标题后评论"失踪"）

现有 URL 段由标题查表得来（`src/data/post-slugs.ts`），改标题或改映射表，slug 就变。所以评论行同时存两个键：

- `post_id`：内容集合的 `entry.id`（即 `posts/<文件名>.md` 相对路径），**稳定不变**，是真正的主键。
- `slug`：发表时的 URL 段，仅用于展示与兼容，可被后台批量修正。

前端只传 `slug`（它拿不到 entry.id），服务端用构建期产出的映射反查 `post_id`：扩展 `/post-index.json`，给每篇加上 `id` 与 `slug` 两个字段（现有 `url` 保留）。这样：

- 改标题后，同一篇文章的评论仍能通过 `post_id` 聚合显示。
- 映射反查不到时（新文章还没部署、或文章已删），退化为按 `slug` 精确匹配，评论照常可见。
- 后台"按文章筛选"用 `post_id` 分组，标题从 `/post-index.json` 取，取不到就显示 `post_id`。

## 8. 安全与防护清单

每条都要落到代码里，并在验收时逐条过。

### 8.1 输入

- 长度上限：昵称 24、邮箱 254、网址 200、正文 2000、slug 200。
- 请求体上限 16 KB（读 `content-length`，超了直接 413，不进 `request.json()`）。
- URL 字段只允许 `http://` / `https://`，解析失败则丢弃该字段（不报错，静默降级）。
- 正文过滤：去控制字符（保留 `\n`）、压缩连续空行 ≤2、首尾 trim；空内容拒绝。
- 邮箱格式只做基本形状校验（`x@y.z`），不做严格 RFC。

### 8.2 XSS

- 前端渲染一律 `textContent` / `createTextNode`，**禁止** `innerHTML` 拼接用户内容。
- 自动链接识别在后端或前端都只产出结构化数据（`{text, url}`），由 DOM API 组装节点。
- 服务端不存 HTML；即使有人手工往 D1 塞 `<script>`，前端也不会执行。
- 响应头保持 `content-type: application/json`，不反射用户输入到 HTML 页面。

### 8.3 CSRF / 越权

- 所有写接口只接受 `POST`；校验 `Origin`（或 `Sec-Fetch-Site: same-origin`）与站点同源，不匹配 → 403。
- 身份 cookie `SameSite=Lax` + `HttpOnly`（JS 不需要读它）。
- 管理员接口沿用现有 HMAC cookie 校验；新增的评论管理接口同样走 `isAdmin()`，且**只读接口和写接口都要校验**（防止待审内容泄漏）。
- 管理操作只按 `id` 精确匹配，不接受客户端传入的 SQL 片段、排序字段白名单化。

### 8.4 人机与反垃圾

1. **Cloudflare Turnstile**（首选，免费、无感）：`TURNSTILE_SECRET` 未配置时自动降级，不阻断站点。
2. **蜜罐字段**：表单里放一个视觉隐藏、`tabindex="-1"`、`autocomplete="off"` 的输入框，有值即判机器人。
3. **提交耗时**：前端记录表单渲染到提交的毫秒数，< 2500ms 判机器人。**`elapsed` 缺失或非数字时不算机器人**（脚本调用、无障碍工具、浏览器禁用 JS 计时都会发不出来这个字段），宁可放过也不误伤。
4. **频率限制**（D1 计数，滑动窗口）：
   - 同 IP 哈希：30 秒 1 条、1 小时 10 条、1 天 30 条
   - 同 `identity_hash`：30 秒 1 条、1 小时 20 条
   - 全站：1 小时 200 条（超了拒绝并告警，防大规模刷）
   - 超限返回 429 + `retryAfter` 秒数，前端显示倒计时。
5. **内容去重**：正文归一化（小写去空白）后取哈希，同 `identity_hash` 24h 内重复 → 直接返回已有评论，不再入库。
6. **举报**：访客可举报（同 IP 单条评论 24h 内只能举报一次），累计 ≥3 自动转 `pending` 并进后台待审。
7. **屏蔽词**：`keywords` 表，后台可增删；命中即 `pending`（不直接删，留给人判断）。
8. **体量闸门**：单篇文章评论 > 2000 条、全表 > 50000 条时拒绝新评论并提示（防 D1 免费额度被刷爆）。

### 8.5 判定为机器人之后怎么处置

三种情况分开处理，不要一律"静默成功"也不要一律"报错"：

| 触发 | 响应 | 落库 |
|---|---|---|
| 蜜罐 / elapsed 异常 / Turnstile 校验失败 | **200 `{ok:true}`，什么都不返回**（不给机器人任何反馈去调参） | 写入 `spam` 状态，供后台观察、必要时加入屏蔽词 |
| 频率超限 | 429 + `retryAfter` 秒数（真人需要知道还能不能再发） | 不写库 |
| 命中屏蔽词 / 链接过多 | 200，但明确文案"已提交，等博主确认"（这是待审，不是拒绝） | 写 `pending` |

真人的误判风险被压在最低：只有蜜罐（人看不见的字段填了值）和 <2.5 秒提交这两种情况才算机器人。

### 8.6 限流失败时的取向

- **限流/去重查询出错 → 放行**（可用性优先），但写一条 `warn` 日志。
- **写库出错 → 返回 500 + `retryable: true`**，绝不给前端返回"成功"。

### 8.7 运维与审计

- `audit_log` 表记录所有管理动作（谁、什么时间、对哪条评论、做了什么），**只追加，不做已读标记**。
- 后台红点口径 = `status='pending'` 的评论条数（真的"要你动手"的数量），不是"未读审计条数"。这样不需要给 `audit_log` 加已读列，也不会因为翻了一遍日志就归零。
- 提供 `scripts/d1-backup.md` 里的导出命令（`wrangler d1 export`），评论表可单独备份。

## 9. 异常处理清单

### 9.1 前端

| 场景 | 行为 |
|---|---|
| 评论列表加载失败 | 卡片内显示"评论加载失败"+ 重试按钮；正文不受影响 |
| 加载超时（10s） | 同上，文案区分"网络慢" |
| 提交中 | 按钮禁用 + 文案"发送中…"，防重复点击 |
| 提交失败（网络/5xx） | 保留已填内容到 `localStorage[comment-draft:<slug>]`，提示"没发出去，内容已暂存" |
| 429 | 显示"太频繁了，X 秒后再试"并倒计时禁用按钮 |
| 待审 | 提示"已提交，博主看过之后就会显示"（不假装成功） |
| 表单校验失败 | 就地标红，不弹 alert |
| swup 切页 | 卸载旧的监听、取消在途 fetch；评论容器按 `data-slug` 重建 |

### 9.2 后端

| 场景 | 行为 |
|---|---|
| D1 未绑定 | 503 + `{error:"评论服务未配置"}` |
| 表不存在 / 建表失败 | `ensureSchema()` 不缓存失败结果，下次重试；本次返回 503 |
| 请求体非 JSON / 超限 | 400 / 413，`{error}` 明确中文文案 |
| 未知 `slug` | 仍允许（文章可能刚改名/刚发），`post_id` 反查不到时退化用 slug；后台能看到无处归属的评论 |
| 分页 cursor 非法 | 忽略 cursor，返回第一页，不报错 |
| 任何未捕获异常 | 顶层 try/catch，返回 500 + `{error, retryable:true}`，`console.error` 打堆栈 |
| 提交幂等 | 客户端生成 `clientId`(uuid)，`comments.client_id` 唯一索引；重复提交返回既有行，不产生重复评论 |

## 10. 数据模型（D1）

```sql
-- 评论主体
CREATE TABLE IF NOT EXISTS comments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id       TEXT    NOT NULL,       -- 稳定键：posts/<文件名>.md（见 §7.4）
  slug          TEXT    NOT NULL,       -- 发表时的 URL 段，仅展示用
  parent_id     INTEGER,                 -- 直接父级（顶级为 NULL）
  root_id       INTEGER,                 -- 所属顶级评论
  depth         INTEGER NOT NULL DEFAULT 0,  -- 0 = 顶级，1 = 回复
  name          TEXT    NOT NULL,
  email_hash    TEXT,
  website       TEXT,
  content       TEXT    NOT NULL,
  content_hash  TEXT    NOT NULL,        -- 归一化后的哈希，用于去重
  status        TEXT    NOT NULL DEFAULT 'pending', -- pending|approved|spam|deleted
  is_admin      INTEGER NOT NULL DEFAULT 0,
  pinned        INTEGER NOT NULL DEFAULT 0,
  report_count  INTEGER NOT NULL DEFAULT 0,
  identity_hash TEXT    NOT NULL,        -- cookie 里 uid 的哈希，见 §7.1
  ip_hash       TEXT,
  ua_hash       TEXT,
  client_id     TEXT    NOT NULL,
  created_at    TEXT    NOT NULL,        -- ISO8601
  updated_at    TEXT,
  deleted_at    TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_comments_client ON comments (client_id);
CREATE INDEX IF NOT EXISTS idx_comments_post ON comments (post_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_comments_slug ON comments (slug, status, created_at);
CREATE INDEX IF NOT EXISTS idx_comments_identity ON comments (identity_hash, created_at);
CREATE INDEX IF NOT EXISTS idx_comments_root ON comments (root_id);
CREATE INDEX IF NOT EXISTS idx_comments_status ON comments (status, created_at);

-- 频率限制（按桶聚合，定期清理）
CREATE TABLE IF NOT EXISTS comment_rate (
  bucket TEXT NOT NULL,   -- ip:<hash> / id:<hash> / site
  window TEXT NOT NULL,   -- 30s|1h|1d
  ts     TEXT NOT NULL,
  PRIMARY KEY (bucket, window, ts)
);
CREATE INDEX IF NOT EXISTS idx_rate_ts ON comment_rate (ts);

-- 举报（同 IP 同评论只能一次）
CREATE TABLE IF NOT EXISTS comment_reports (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  comment_id INTEGER NOT NULL,
  ip_hash    TEXT NOT NULL,
  ts         TEXT NOT NULL,
  PRIMARY KEY (comment_id, ip_hash)
);

-- 屏蔽词
CREATE TABLE IF NOT EXISTS comment_keywords (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  word TEXT NOT NULL UNIQUE,
  ts   TEXT NOT NULL
);

-- 站点设置（审核模式等）
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 管理动作审计
CREATE TABLE IF NOT EXISTS audit_log (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  ts     TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT
);
```

状态机：`pending → approved / spam`；`approved → deleted`；`deleted → approved`（恢复）。物理删除只由后台"彻底删除"触发。

## 11. 接口

公开（无需登录，全部校验同源 + 限流）：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/comments?slug=&cursor=&limit=&sort=` | 返回 `approved` 的顶级评论 + 其下回复；`pinned` 置顶排最前 |
| POST | `/api/comments` | 发评论/回复；body: `{slug, parentId?, name, email?, website?, content, clientId, honey, elapsed, turnstileToken?}` |
| POST | `/api/comments/report` | body: `{id}` |
| GET | `/api/comments/count?slugs=a,b,c` | v2 可选：列表页评论数 |

管理（`isAdmin()` 校验）：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/admin/comments?status=&q=&post_id=&cursor=` | 列表，含待审内容 |
| POST | `/api/admin/comments/action` | `{id, action: approve\|spam\|delete\|restore\|pin\|unpin\|hard_delete}` |
| POST | `/api/admin/comments/reply` | 以博主身份回复（直接 approved） |
| GET/POST | `/api/admin/comments/settings` | 读/写审核模式、开关项 |
| GET/POST/DELETE | `/api/admin/comments/keywords` | 屏蔽词维护 |

约定：响应统一 `{data}` 或 `{error, retryable?}`；所有时间 ISO8601 UTC，前端转本地时区。

## 12. 前端

`src/components/misc/Comment.astro` 重写为「容器 + 骨架」，真正逻辑放 `src/layouts/Layout.astro` 的 `setupComments()`（swup 兼容），组件只输出：

```html
<section class="comments" data-slug={slug}>…骨架…</section>
```

- 结构：标题（评论数）→ 表单（折叠在"写下你的想法"按钮后，减少压迫感）→ 列表 → 加载更多。
- 样式复用 `card-base`、`btn-card`、`--primary`、`text-75` 等既有约定；深浅色自动跟随。
- 空态文案："还没有评论，来坐第一排。"
- 待审提示与 429 倒计时均为卡片内联提示，不用 alert/toast。
- giscus 代码保留在 Layout 里但由 `src/config.ts` 的开关控制是否加载（默认关），便于回滚对比。

## 13. 后台

`src/pages/admin/index.astro` 新增一张 span-12 卡片「评论」：

- KPI：待审 / 总评论 / 今日新增 / 被举报
- 列表：状态筛选 + 关键词搜索 + 按文章筛选；每条显示昵称、时间、文章、内容摘要、状态
- 行内操作：通过 / 垃圾 / 删除 / 恢复 / 回复 / 置顶
- 批量：全选 → 批量通过 / 批量删除
- 设置区：审核模式切换（auto / hold）、屏蔽词增删

## 14. 部署与本地验证

1. `npx wrangler d1 execute wkb-db --remote --file=worker/schema.sql`（新表已合并进同一文件，可重复执行）
2. 新增 Secret：`IP_SALT`、`COMMENT_COOKIE_SECRET`（都必填，各一串随机值）、`TURNSTILE_SECRET`（可选）
3. Turnstile site key 放在 `src/config.ts` 的评论配置里（公开 key，可提交）
4. 扩展 `src/pages/post-index.json.ts`：每条加 `id`（entry.id）和 `slug`，供评论反查稳定键与后台显示文章名
4. 本地验证路径：`pnpm build && npx wrangler dev`（`astro dev` 不跑 Worker，`/api` 会 404）——此限制写入 README 的评论章节
5. 上线顺序：先发代码（此时评论接口可用但前端开关关闭）→ 建表 → 打开开关 → 观察一天待审队列

## 15. 验收标准

- [ ] 未登录、无 GitHub 账号的访客可在 30 秒内发出一楼评论并立即看到
- [ ] 含 2 个链接的评论进待审，后台可见并可一键通过
- [ ] 后台回复带「博主」标记，作者自己的评论无需审核
- [ ] 连续快速提交第 2 条触发 429，前端显示倒计时且不丢失已填内容
- [ ] 正文输入 `<img src=x onerror=alert(1)>` 与 `<script>` 原样显示为文本，不执行
- [ ] 跨站 `Origin` 的 POST 被 403
- [ ] 未登录请求 `/api/admin/comments` 返回 401
- [ ] 断网状态下打开文章页：正文正常，评论区显示"加载失败 + 重试"
- [ ] D1 绑定缺失时接口返回 503 而非 500 堆栈
- [ ] 楼中楼两层结构正确，删除中间层后楼层不塌
- [ ] 深色/浅色切换下评论区配色正确
- [ ] swup 从首页点进文章、再点进第二篇，评论区每次都正确初始化（不重复、不空白）
- [ ] 手改 cookie 里的 uid 换一个人：旧身份的"重复内容/限流"不生效于新身份，也不误伤
- [ ] 把一篇文章改标题并更新 `post-slugs.ts` 后重新部署，该文章的历史评论仍显示在原文章下
- [ ] `pnpm check` / `pnpm build` 通过

## 16. 分阶段

| 阶段 | 内容 | 产出 |
|---|---|---|
| P1 | 数据模型 + 建表 + 公开读写接口 + 基本防护（校验、XSS、CSRF、限流、蜜罐） | 能用 curl 完整走通 |
| P2 | 前端评论组件 + swup 挂载 + 样式 + 异常态 | 页面上可发可看 |
| P3 | 后台审核列表 + 操作 + 设置 + 屏蔽词 | 作者可全流程管理 |
| P4 | Turnstile 接入 + 举报 + 审计日志 + 备份脚本 + 验收清单全过 | 可对外宣布 |

每阶段结束都能部署，不会出现"半个功能上线"。

## 17. 审阅意见与处置

设计写完后由一位独立工程师读过一遍，提出 6 个"不回答就没法写计划"的问题。处置如下（全部由建造者侧决定，作者如不同意可推翻）：

| 问题 | 处置 | 位置 |
|---|---|---|
| "同一身份"落在哪个字段？ | 新增 `identity_hash`（服务端签发、cookie 签名的随机 uid），内容规则与限流都用它，不用 email/ip | §7.1 |
| "首次评论进待审"默认开还是关？ | **默认关**；要严格就切 `hold`，不留隐形规则 | §7.2 |
| slug 会随标题变化，评论会挂空 | 同时存稳定键 `post_id`（entry.id）+ 展示用 `slug`，扩展 `/post-index.json` 做反查 | §7.4 |
| 判定机器人后返回什么、写不写库 | 分三种：蜜罐/耗时/Turnstile → 200 静默 + 存 spam；超频 → 429；屏蔽词/多链接 → 200 待审。`elapsed` 缺失不算机器人 | §8.5 |
| 待审红点按什么口径算 | 红点 = `pending` 条数；`audit_log` 只追加、不加已读列 | §8.7 |
| 头像要不要真 Gravatar | 不要。确定性色块 + 首字母，零外部请求，不把邮箱哈希交给第三方 | §7.1 |
