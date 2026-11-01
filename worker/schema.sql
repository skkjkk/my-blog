-- 建表语句全部用 IF NOT EXISTS，可以重复执行（Worker 里也会自动跑一遍，见 ensureSchema）
-- 手动应用：npx wrangler d1 execute wkb-db --remote --file=worker/schema.sql

-- 每天的页面访问量（按路径聚合，不存 IP、不存 UA）
CREATE TABLE IF NOT EXISTS views (
  day TEXT NOT NULL,
  path TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, path)
);
CREATE INDEX IF NOT EXISTS idx_views_day ON views (day);

-- 每天各小时的访问量（读者什么时候来）
CREATE TABLE IF NOT EXISTS views_hourly (
  day TEXT NOT NULL,
  hour INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, hour)
);

-- AI 问答记录
CREATE TABLE IF NOT EXISTS ai_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  day TEXT NOT NULL,
  question TEXT NOT NULL,
  model TEXT,
  ms INTEGER,
  tokens INTEGER,
  ok INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_ai_day ON ai_log (day);

-- AI 检索情况（单独一张表，避免给已有的 ai_log 加列）
CREATE TABLE IF NOT EXISTS ai_hits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  day TEXT NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0,
  paths TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_ai_hits_day ON ai_hits (day);

-- 站内搜索词（读者在找什么）
CREATE TABLE IF NOT EXISTS search_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  day TEXT NOT NULL,
  keyword TEXT NOT NULL,
  results INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_search_day ON search_log (day);

-- ==================== 数据台 v2：全站事件 ====================
-- 一条事件一行，聚合交给 worker/lib/stats.js。
-- 隐私：vid / sid 都是前端随机生成、服务端再用 IP_SALT 哈希过的不可逆值，不存 IP、不存 UA。
CREATE TABLE IF NOT EXISTS events (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  ts     TEXT NOT NULL,
  day    TEXT NOT NULL,
  hour   INTEGER NOT NULL DEFAULT 0,
  dow    INTEGER NOT NULL DEFAULT 0,   -- 0=周一 … 6=周日
  vid    TEXT DEFAULT '',              -- 访客（哈希）
  sid    TEXT DEFAULT '',              -- 会话（哈希）
  type   TEXT NOT NULL,                -- page_view / panel_open / ask / search / quiz / comment
  path   TEXT DEFAULT '',
  ms     INTEGER DEFAULT 0,
  ttft   INTEGER DEFAULT 0,            -- 首字延迟
  tokens INTEGER DEFAULT 0,
  ok     INTEGER NOT NULL DEFAULT 1,
  err    TEXT DEFAULT '',
  n      INTEGER DEFAULT 0,            -- ask: 追问深度（历史轮数）；search: 结果数
  hits   INTEGER DEFAULT 0,            -- ask: 检索命中段数
  tag    TEXT DEFAULT '',              -- ask: 模型名
  text   TEXT DEFAULT '',              -- ask: 问题原文；search: 关键词
  meta   TEXT DEFAULT ''               -- 附加 JSON（轮次、工具…）
);
CREATE INDEX IF NOT EXISTS idx_events_type_day ON events (type, day);
CREATE INDEX IF NOT EXISTS idx_events_day ON events (day);
CREATE INDEX IF NOT EXISTS idx_events_vid ON events (vid, day);
CREATE INDEX IF NOT EXISTS idx_events_sid ON events (sid);

-- 刷题评分聚合（哪些题总记不住 = 哪些答案该重写）
CREATE TABLE IF NOT EXISTS quiz_grade (
  slug TEXT NOT NULL,
  grade INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  updated TEXT NOT NULL,
  PRIMARY KEY (slug, grade)
);

-- ==================== 评论区 ====================
-- 设计文档：docs/superpowers/specs/2026-11-01-comments-design.md

-- 评论主体。post_id 是稳定键（posts/xxx.md），slug 只用于展示
CREATE TABLE IF NOT EXISTS comments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id       TEXT    NOT NULL,
  slug          TEXT    NOT NULL,
  parent_id     INTEGER,
  root_id       INTEGER,
  depth         INTEGER NOT NULL DEFAULT 0,
  name          TEXT    NOT NULL,
  email_hash    TEXT,
  website       TEXT,
  content       TEXT    NOT NULL,
  content_hash  TEXT    NOT NULL,
  status        TEXT    NOT NULL DEFAULT 'pending',
  is_admin      INTEGER NOT NULL DEFAULT 0,
  pinned        INTEGER NOT NULL DEFAULT 0,
  report_count  INTEGER NOT NULL DEFAULT 0,
  identity_hash TEXT    NOT NULL,
  ip_hash       TEXT,
  ua_hash       TEXT,
  client_id     TEXT    NOT NULL,
  created_at    TEXT    NOT NULL,
  updated_at    TEXT,
  deleted_at    TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_comments_client ON comments (client_id);
CREATE INDEX IF NOT EXISTS idx_comments_post ON comments (post_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_comments_slug ON comments (slug, status, created_at);
CREATE INDEX IF NOT EXISTS idx_comments_identity ON comments (identity_hash, created_at);
CREATE INDEX IF NOT EXISTS idx_comments_root ON comments (root_id);
CREATE INDEX IF NOT EXISTS idx_comments_status ON comments (status, created_at);

-- 限流计数（滑动窗口，桶 = ip:<hash> / id:<hash> / site）
CREATE TABLE IF NOT EXISTS comment_rate (
  bucket TEXT NOT NULL,
  window TEXT NOT NULL,
  ts     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_bucket ON comment_rate (bucket, ts);
CREATE INDEX IF NOT EXISTS idx_rate_ts ON comment_rate (ts);

-- 举报（同一条评论 + 同一个 IP 只算一次）
CREATE TABLE IF NOT EXISTS comment_reports (
  comment_id INTEGER NOT NULL,
  ip_hash    TEXT    NOT NULL,
  ts         TEXT    NOT NULL,
  PRIMARY KEY (comment_id, ip_hash)
);

-- 屏蔽词：命中即进待审，不直接删
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

-- 管理动作审计（只追加）
CREATE TABLE IF NOT EXISTS audit_log (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  ts     TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT
);
