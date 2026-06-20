-- US-140 KOL-007 2026-06-21 — kol_author_stats 表回滚 (down).
--
-- 完全回退 2026-06-21-kol-author-stats.sql.
-- 警告: 会丢掉所有 KOLAuthorTrackingService 已生成的胜率快照;
-- 这些数据可由 AnalystForecast + DailyBar 重跑 trackAuthors 恢复.

BEGIN;

DROP INDEX IF EXISTS idx_kol_author_stats_win_rate;
DROP INDEX IF EXISTS idx_kol_author_stats_as_of_date;
DROP INDEX IF EXISTS kol_author_stats_firm_asof_uniq;

DROP TABLE IF EXISTS kol_author_stats;

COMMIT;
