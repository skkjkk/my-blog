# 评论区使用与运维

评论数据存在自己的 Cloudflare D1 里，不依赖 GitHub / Disqus 之类的第三方。

- 代码：`worker/comments.js`（公开接口）、`worker/comments-admin.js`（后台接口）、`worker/lib/*`（纯逻辑）
- 前端：`src/components/misc/Comment.astro` + `src/scripts/comments.ts`
- 后台：`/admin` 页面的「评论」卡片
- 设计：`docs/superpowers/specs/2026-11-01-comments-design.md`

## 上线三步

1. **建表**（可重复执行，Worker 第一次用到数据库时也会自动跑一遍）

   ```bash
   npx wrangler d1 execute wkb-db --remote --file=worker/schema.sql
   ```

2. **配 Secret**（Cloudflare 项目 → Settings → Variables）

   | 名字 | 必填 | 作用 |
   |---|---|---|
   | `IP_SALT` | 是 | 给 IP 哈希加盐，换掉等于所有人限流清零 |
   | `COMMENT_COOKIE_SECRET` | 是 | 给身份 cookie 签名，换掉等于所有读者变新访客 |
   | `TURNSTILE_SECRET` | 否 | 人机验证的私钥；不配就自动降级 |
   | `ADMIN_PASSWORD` | 是（原有） | 后台密码 |

   想开人机验证还要在 `src/config.ts` 的 `commentConfig.turnstileSiteKey` 填公开 site key。

3. **部署**：推 `main` 分支，Cloudflare 自动构建。

## 日常怎么用

打开 `/admin` → 底部「评论」卡片：

- **待审**：默认只显示需要你动手的。红点数字就是待审条数。
- **通过 / 标为垃圾 / 删除 / 恢复 / 置顶**：单条操作，立即生效。
- **回复**：点「回复」展开输入框，发出后带「博主」标记，无需审核。
- **审核模式**：
  - `先发后审`（默认）——读者发完立刻可见，只有可疑的（两条以上链接、命中屏蔽词、24 小时内重复内容、被举报过）才进待审。
  - `全部待审`——所有评论都等你点头，适合被刷的时候开一会儿。
- **屏蔽词**：命中即进待审（不直接删，留给你判断）。

## 读者看到什么

- 不用注册，填昵称就能发；邮箱选填，只存哈希、不公开、不发邮件。
- 楼中楼两层：对回复的回复会拍平到同一条顶级评论下，并显示「回复 @某人」。
- 刷新页面、清 cookie 都不影响已发布的内容。

## 出问题时

| 现象 | 原因与处理 |
|---|---|
| 评论区显示「评论加载失败」 | `/api/comments` 挂了或 D1 没绑定，看 Worker 日志 |
| 读者说发不出去 | 常见是 429（发太快，等 30 秒）；正文 > 2000 字也会被拒 |
| 后台看不到新评论 | 确认「待审 / 已通过」筛选，或审核模式被切成「全部待审」 |
| 某些评论突然消失 | 被举报 3 次会自动转待审，去「待审」里找 |
| 想临时关掉评论 | 把 `commentConfig.provider` 改成 `"giscus"` 并恢复 Layout 里的旧代码（见下） |

## 回滚到 giscus

`src/layouts/Layout.astro` 里原来的 giscus 加载代码被替换成了评论初始化脚本。要回滚：
把那段 `<script>` 换回 git 历史中的 giscus 版本即可（`git log -p src/layouts/Layout.astro`）。
历史评论一直在仓库的 Discussions 里，没有丢。

## 本地验证

```bash
pnpm test                 # 单元 + 接口集成测试（node:sqlite 跑真实 SQL）
pnpm build                # 构建静态站
npx wrangler dev --port 8787
node scripts/comments-smoke.mjs    # 14 条冒烟断言
```

> `astro dev` 不跑 Worker，`/api` 会 404——本地测评论必须用 `wrangler dev`。
> 机器上装不了 wrangler 时，可以退而用 `node scripts/dev-server.mjs 8787`（等价的本地服务，静态资源除外）。

## 备份

```bash
npx wrangler d1 export wkb-db --remote --output=backup-$(date +%F).sql
```

只备份评论：

```bash
npx wrangler d1 export wkb-db --remote --output=comments.sql --table=comments
```

## 已知边界

- 邮箱不做通知（站上没有邮件服务商）。要加的话得在 `comments` 存明文邮箱并接一个发信 API。
- 评论不迁移自 giscus。
- 没有点赞/表情；数据结构预留了扩展空间。
- 首页不显示评论数（静态页需要额外请求）。
