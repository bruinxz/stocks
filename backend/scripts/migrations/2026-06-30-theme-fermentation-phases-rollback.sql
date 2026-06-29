-- PR-O5 2026-06-30 — rollback for theme_fermentation_phases.
-- 删除顺序: 先 indexes (其实 DROP TABLE 会带走它们, 这里显式写一份审计 trace 友好), 再表.

BEGIN;

DROP INDEX IF EXISTS idx_tfp_date_phase;
DROP INDEX IF EXISTS idx_tfp_industry_date;
DROP INDEX IF EXISTS idx_tfp_date_mainline;

DROP TABLE IF EXISTS theme_fermentation_phases;

COMMIT;
