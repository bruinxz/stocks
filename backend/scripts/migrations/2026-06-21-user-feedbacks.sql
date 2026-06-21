-- Batch AL (2026-06-21) — user_feedbacks 表 (up).
--
-- SystemWorkspace "用户反馈" tab 落表. 用户从前端 "新建反馈" 弹窗提交标题 + 描述 + 多张图片;
-- FEEDBACK_REVIEW_SWEEP cron (每 30min) 跑启发式分类器 (bug / feature_request / question / praise)
-- + 优先级 (1..5) + 摘要 (≤ 200 字), 写回 ai_classification / ai_priority / ai_summary / reviewed_at;
-- admin 通过 POST /api/admin/feedbacks/:id/resolve 标记 status='resolved' + 写 resolution_note +
-- 可选 commit hash / PR number, resolved_at 取当时时间. 前端在反馈下方绿底回复块展示 resolution_note.
--
-- 字段语义:
--   - title             VARCHAR(200) NOT NULL — 用户填的标题
--   - description       TEXT NOT NULL — 用户填的长描述
--   - image_urls        JSONB NOT NULL DEFAULT '[]' — 上传图片的服务端 URL 数组 (相对路径,
--                       前端通过 /uploads/... 静态服务访问)
--   - status            VARCHAR(30) NOT NULL DEFAULT 'pending'
--                       pending / in_progress / resolved / dismissed
--   - resolution_note   TEXT — admin 解决说明 (绿底回复块)
--   - resolution_commit_hash  VARCHAR(40) — 关联 commit (可选)
--   - resolution_pr_number    INTEGER — 关联 PR 号 (可选)
--   - resolved_at       TIMESTAMPTZ — 解决时刻
--   - reviewed_at       TIMESTAMPTZ — 上次 cron review 时刻 (cron 用此字段做"6h 内 skip")
--   - ai_classification VARCHAR(50) — bug / feature_request / question / praise
--   - ai_priority       SMALLINT — 1 (最低) .. 5 (最高)
--   - ai_summary        TEXT — heuristic 摘要 (≤ 200 字, service 截断)
--   - metadata          JSONB NOT NULL DEFAULT '{}' — 预留 (user_agent / ip 等)
--
-- 索引:
--   - (user_id, status, created_at DESC)  — 前端 GET /api/me/feedbacks 列表查询
--   - (status, reviewed_at NULLS FIRST)   — cron 查 pending + (NULL or >6h) 行
--
-- 回滚: 2026-06-21-user-feedbacks-rollback.sql.
--
-- 执行 (生产):
--   psql $DATABASE_URL -f backend/scripts/migrations/2026-06-21-user-feedbacks.sql

BEGIN;

CREATE TABLE IF NOT EXISTS user_feedbacks (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title VARCHAR(200) NOT NULL,
  description TEXT NOT NULL,
  image_urls JSONB NOT NULL DEFAULT '[]'::jsonb,
  status VARCHAR(30) NOT NULL DEFAULT 'pending',
  resolution_note TEXT,
  resolution_commit_hash VARCHAR(40),
  resolution_pr_number INTEGER,
  resolved_at TIMESTAMP WITH TIME ZONE,
  reviewed_at TIMESTAMP WITH TIME ZONE,
  ai_classification VARCHAR(50),
  ai_priority SMALLINT,
  ai_summary TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_feedbacks_user_status
  ON user_feedbacks(user_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_feedbacks_status_reviewed
  ON user_feedbacks(status, reviewed_at NULLS FIRST);

COMMENT ON TABLE user_feedbacks IS
  'Batch AL 2026-06-21 — SystemWorkspace 用户反馈闭环; status: pending/in_progress/resolved/dismissed';

COMMIT;
