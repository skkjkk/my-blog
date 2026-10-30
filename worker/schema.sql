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
