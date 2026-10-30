-- 后台统计用的表结构
-- 应用命令：npx wrangler d1 execute wkb-db --remote --file=worker/schema.sql

-- 每天的页面访问量（按路径聚合，不存 IP、不存 UA，够用且省空间）
CREATE TABLE IF NOT EXISTS views (
  day TEXT NOT NULL,
  path TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, path)
);

CREATE INDEX IF NOT EXISTS idx_views_day ON views (day);

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
