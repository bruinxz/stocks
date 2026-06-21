-- US-140 KOL-007 2026-06-21 — 创建 kol_author_stats (按 analyst_firm 维度的胜率统计) (up).
--
-- 一行 = (analyst_firm, as_of_date) 的一份"截至某天"的历史命中率快照:
--   "中信证券 截至 2026-06-21 在过去 N 天内发了 M 份评级 ≥'增持' 的研报,
--    其中 X 份股票 30 天后涨, 命中率 X/M".
--
-- 数据源: AnalystForecast (研报 — US-030 已落库) JOIN DailyBar (forward return).
--   - 评级 ≥ '增持' (买入/推荐/增持/超配/审慎推荐) 的研报视为"看多预测";
--   - 评级 ≤ '减持' (减持/低配/卖出/回避) 的研报视为"看空预测";
--   - 评级 == '持有/中性/观望' 不计入 (无方向信号);
--   - forward_return_pct = (close[t+30 trading days] / close[t-1]) - 1;
--   - 看多命中 = forward_return_pct > 0; 看空命中 = forward_return_pct < 0.
--
-- AC §8 "90 天后 ≥ 3 author 胜率 ≥ 60%" 通过 identifyTopAuthors() 按 win_rate desc
-- 过滤 min_samples + min_win_rate 输出.
--
-- 索引:
--   - UNIQUE(analyst_firm, as_of_date) — 同 firm 同天一行, upsert 直接刷;
--   - (as_of_date) — "今日全部 author 榜单"类查询;
--   - (win_rate DESC, sample_size DESC) — top author 排行 (但 partial WHERE 不支持
--     DESC index in pg, 普通 b-tree 排序方向无关).
--
-- 默认值 (fail-safe):
--   - sample_size / win_count / loss_count 默认 0 (NOT NULL);
--   - win_rate 默认 0;
--   - avg_forward_return_pct / latest_report_date 默认 NULL.
--
-- 回滚: 2026-06-21-kol-author-stats-rollback.sql.
--
-- 执行 (生产):
--   psql $DATABASE_URL -f backend/scripts/migrations/2026-06-21-kol-author-stats.sql

BEGIN;

CREATE TABLE IF NOT EXISTS kol_author_stats (
  id                       SERIAL PRIMARY KEY,
  analyst_firm             VARCHAR(100) NOT NULL,
  as_of_date               DATE NOT NULL,
  sample_size              INTEGER NOT NULL DEFAULT 0,
  win_count                INTEGER NOT NULL DEFAULT 0,
  loss_count               INTEGER NOT NULL DEFAULT 0,
  win_rate                 DECIMAL(5, 4) NOT NULL DEFAULT 0,
  avg_forward_return_pct   DECIMAL(8, 4),
  lookback_days            INTEGER NOT NULL DEFAULT 90,
  forward_window_days      INTEGER NOT NULL DEFAULT 30,
  latest_report_date       DATE,
  raw_payload              JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at               TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS kol_author_stats_firm_asof_uniq
  ON kol_author_stats (analyst_firm, as_of_date);

CREATE INDEX IF NOT EXISTS idx_kol_author_stats_as_of_date
  ON kol_author_stats (as_of_date);

CREATE INDEX IF NOT EXISTS idx_kol_author_stats_win_rate
  ON kol_author_stats (win_rate, sample_size);

COMMENT ON TABLE kol_author_stats IS
  'US-140 KOL-007 按 analyst_firm 维度跟踪研报命中率 — 1 row per (firm, as_of_date).';
COMMENT ON COLUMN kol_author_stats.analyst_firm IS '研报机构名 (与 analyst_forecasts.analyst_firm 对齐, e.g. "中信证券" / "诚通证券")';
COMMENT ON COLUMN kol_author_stats.as_of_date IS '统计截止日 (YYYY-MM-DD) — 每跑一次 tracker 一行';
COMMENT ON COLUMN kol_author_stats.sample_size IS '过去 lookback_days 内该 firm 发的"有方向预测"研报数 (排除持有/中性)';
COMMENT ON COLUMN kol_author_stats.win_count IS '命中数 (看多研报 + forward return > 0 / 看空研报 + forward return < 0)';
COMMENT ON COLUMN kol_author_stats.loss_count IS '未命中数 (与 win_count 反向)';
COMMENT ON COLUMN kol_author_stats.win_rate IS 'win_count / sample_size ∈ [0, 1]; sample_size=0 时为 0';
COMMENT ON COLUMN kol_author_stats.avg_forward_return_pct IS '该 firm 全部样本的 30 天 forward return 均值 (有方向校正; 看空研报取负)';
COMMENT ON COLUMN kol_author_stats.lookback_days IS '统计窗口 (默认 90 天)';
COMMENT ON COLUMN kol_author_stats.forward_window_days IS 'forward return 计算窗口 (默认 30 自然日)';
COMMENT ON COLUMN kol_author_stats.latest_report_date IS '该 firm 在 lookback 窗内最近一份研报日期';
COMMENT ON COLUMN kol_author_stats.raw_payload IS '审计辅助 (sample_stock_codes / 评级分布 / 跳过原因等)';

COMMIT;
