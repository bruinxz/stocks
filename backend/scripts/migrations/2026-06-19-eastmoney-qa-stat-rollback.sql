-- US-038 QA-002 2026-06-19 — east_money_qa_stats 表回滚 (down).
--
-- 完全回退 2026-06-19-eastmoney-qa-stat.sql.
-- 警告: 会丢掉所有 QA-005 QAStatAggregator 已生成的周聚合数据;
-- 这些数据可由 east_money_qa_topics 重新跑 aggregator 恢复 (前提是 topic 表仍存)。

BEGIN;

DROP INDEX IF EXISTS idx_east_money_qa_stats_subtopic_week;
DROP INDEX IF EXISTS idx_east_money_qa_stats_week_start;
DROP INDEX IF EXISTS east_money_qa_stats_stock_week_uniq;

DROP TABLE IF EXISTS east_money_qa_stats;

COMMIT;
