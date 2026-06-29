-- PR-M1 (2026-06-29) — 创建 overnight_signals (隔夜信号矩阵) (up).
--
-- 一行 = 一个 (signal_type, collected_at) 唯一隔夜信号快照.
-- 由 OvernightSignalSyncService 在 cron `*/15 0-9,21-23 * * *` 触发时
-- 写入 (5+ source, 每个 source 一行).
--
-- 字段语义 (与 backend/src/models/OvernightSignal.ts 严格对齐):
--   - signal_type  'a50_future' / 'hk_hsi' / 'us_nasdaq' / 'us_dxy' /
--                  'us_vix' / 'china_adr' (VARCHAR(32))
--   - source       原始 AKShare endpoint 名 (VARCHAR(64), nullable)
--   - collected_at 抓取时间 (TIMESTAMPTZ, default NOW())
--   - value        最新价 (NUMERIC(20,8), nullable)
--   - change_pct   当日涨跌幅 % (NUMERIC(10,4), nullable)
--   - raw_payload  JSONB (默认 {})
--
-- 索引:
--   - UNIQUE (signal_type, collected_at)  upsert 防重 + per-source 时序检索
--   - (collected_at)                       范围扫 (loadOvernightContext)
--
-- 与既有数据的区分:
--   - market_judgments / market_briefs 是衍生卡片, 实时 sina 拉海外指数;
--     本表是 AKShare cron 入库的源头时序数据. 两者互补.
--
-- 回滚: 2026-06-29-overnight-signals-rollback.sql
--
-- 执行 (生产):
--   psql $DATABASE_URL -f backend/scripts/migrations/2026-06-29-overnight-signals.sql

BEGIN;

CREATE TABLE IF NOT EXISTS overnight_signals (
  id            BIGSERIAL PRIMARY KEY,
  signal_type   VARCHAR(32) NOT NULL,
  source        VARCHAR(64),
  collected_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  value         NUMERIC(20, 8),
  change_pct    NUMERIC(10, 4),
  raw_payload   JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- UNIQUE 兼做 upsert key + per-source 时序检索索引
CREATE UNIQUE INDEX IF NOT EXISTS uq_overnight_signals_type_collected
  ON overnight_signals (signal_type, collected_at);

-- range scan (loadOvernightContext 近 12h)
CREATE INDEX IF NOT EXISTS idx_overnight_signals_collected_desc
  ON overnight_signals (collected_at DESC);

COMMENT ON TABLE overnight_signals IS
  'PR-M1 隔夜信号矩阵 — A50/HK/Nasdaq/DXY/VIX 等 5+ 个外盘信号的时序快照. cron 每 15min 跑, 给早盘 QuantRecommendationService / OpeningRushDetector 消费判定大盘方向.';
COMMENT ON COLUMN overnight_signals.signal_type IS 'a50_future / hk_hsi / us_nasdaq / us_dxy / us_vix / china_adr';
COMMENT ON COLUMN overnight_signals.source IS '原始 AKShare endpoint (e.g. index_global_em / stock_hk_index_spot_em)';
COMMENT ON COLUMN overnight_signals.collected_at IS '抓取时间, 与 signal_type 组成 UNIQUE key';
COMMENT ON COLUMN overnight_signals.value IS '最新价 / 收盘价';
COMMENT ON COLUMN overnight_signals.change_pct IS '当日涨跌幅 % (e.g. -1.23 = 下跌 1.23%)';
COMMENT ON COLUMN overnight_signals.raw_payload IS '原始 AKShare 行 (保留全部字段)';

COMMIT;
