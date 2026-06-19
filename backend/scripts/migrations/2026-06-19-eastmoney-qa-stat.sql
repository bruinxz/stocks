-- US-038 QA-002 2026-06-19 — 创建 east_money_qa_stats (周聚合表) (up).
--
-- 与 east_money_qa_topics 的关系:
--   - east_money_qa_topics: 一行 = (stock_code, week_start, topic) — N rows per stock per week
--   - east_money_qa_stats:  一行 = (stock_code, week_start)        — 1 row per stock per week
--
-- east_money_qa_stats 字段语义 (与 docs/trader-system/83_ai_qa_topic.md §D QA-003 对齐):
--   - questions_count       — 当周该股全部提问数 (含未答)
--   - answer_count          — 当周该股已被公司回答的提问数 (answer 非空非空白)
--   - answer_rate           — answer_count / questions_count ∈ [0, 1]; 0 提问时 0
--   - top_subtopic          — 当周最高 mention 的 subcategory (TOPIC_SUBCATEGORIES);
--                             所有提问按 classifySubtopic 分类后取 max-count + tie-break
--   - avg_question_sentiment — 当周所有提问情绪分均值 ∈ [-1, +1] (DECIMAL(5,3))
--   - avg_answer_sentiment   — 当周所有"非空回答"情绪分均值 ∈ [-1, +1]; NULL = 当周无回答
--   - answer_template_score  — 当周所有"非空回答"的 detectTemplateAnswer 输出均值 ∈ [0, 1];
--                              1=纯模板 ("感谢关注/详见公告/投资有风险"...), 0=高质量;
--                              NULL = 当周无回答 (与 avg_answer_sentiment 同步)
--
-- 索引:
--   - UNIQUE(stock_code, week_start) — 防重复 sync, bulkCreate updateOnDuplicate 直接刷;
--   - (week_start) — "上周全市场榜单"类查询;
--   - (top_subtopic, week_start) — IndustryQAHeatService leading_signal 检索.
--
-- 默认值 (fail-safe — 未跑过 aggregator 的安全态):
--   questions_count / answer_count 默认 0 (NOT NULL)
--   answer_rate 默认 0
--   top_subtopic 默认 'other_general' (TOPIC_SUBCATEGORIES.OTHER_GENERAL — 无 actionable 含义)
--   avg_question_sentiment 默认 0
--   avg_answer_sentiment / answer_template_score 默认 NULL ("当周无任何回答")
--
-- 回滚: 2026-06-19-eastmoney-qa-stat-rollback.sql.
--
-- 执行 (生产):
--   psql $DATABASE_URL -f backend/scripts/migrations/2026-06-19-eastmoney-qa-stat.sql

BEGIN;

CREATE TABLE IF NOT EXISTS east_money_qa_stats (
  id                       SERIAL PRIMARY KEY,
  stock_code               VARCHAR(10) NOT NULL,
  stock_name               VARCHAR(50),
  week_start               DATE NOT NULL,
  questions_count          INTEGER NOT NULL DEFAULT 0,
  answer_count             INTEGER NOT NULL DEFAULT 0,
  answer_rate              DECIMAL(5, 3) NOT NULL DEFAULT 0,
  top_subtopic             VARCHAR(40) NOT NULL DEFAULT 'other_general',
  avg_question_sentiment   DECIMAL(5, 3) NOT NULL DEFAULT 0,
  avg_answer_sentiment     DECIMAL(5, 3),
  answer_template_score    DECIMAL(5, 3),
  nlp_engine               VARCHAR(50),
  raw_payload              JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at               TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS east_money_qa_stats_stock_week_uniq
  ON east_money_qa_stats (stock_code, week_start);

CREATE INDEX IF NOT EXISTS idx_east_money_qa_stats_week_start
  ON east_money_qa_stats (week_start);

CREATE INDEX IF NOT EXISTS idx_east_money_qa_stats_subtopic_week
  ON east_money_qa_stats (top_subtopic, week_start);

COMMENT ON TABLE east_money_qa_stats IS
  'US-038 QA-002 投资者问答按 (stock, week) 维度聚合 — 1 row per stock per week. 与 east_money_qa_topics (N rows per stock per week, by topic) 互补.';
COMMENT ON COLUMN east_money_qa_stats.questions_count IS '当周该股全部提问数 (含未答)';
COMMENT ON COLUMN east_money_qa_stats.answer_count IS '当周该股已被公司回答的提问数';
COMMENT ON COLUMN east_money_qa_stats.answer_rate IS 'answer_count / questions_count ∈ [0,1]; 提问数=0 时为 0';
COMMENT ON COLUMN east_money_qa_stats.top_subtopic IS '当周最高 mention 的 subcategory (classifySubtopic)';
COMMENT ON COLUMN east_money_qa_stats.avg_question_sentiment IS '当周提问情绪均值 ∈ [-1, +1]';
COMMENT ON COLUMN east_money_qa_stats.avg_answer_sentiment IS '当周非空回答情绪均值 ∈ [-1, +1]; NULL = 当周无回答';
COMMENT ON COLUMN east_money_qa_stats.answer_template_score IS 'detectTemplateAnswer 当周均值 ∈ [0,1]; 1=纯模板; NULL = 当周无回答';
COMMENT ON COLUMN east_money_qa_stats.nlp_engine IS 'NLP 引擎标签 (heuristic_fallback / trading_agents / openai)';
COMMENT ON COLUMN east_money_qa_stats.raw_payload IS '审计辅助 (subtopic 分布 / 模板词命中样本 / 异常提问 ID 等)';

COMMIT;
