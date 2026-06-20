-- US-147 KOL-001 2026-06-21 — 创建 etf_creation_redemption (ETF 一级市场申赎 + 折溢价) (up).
--
-- 一行 = (trade_date, etf_code) 二元 PK 的一份 per-ETF 日度申赎 + 折溢价记录:
--   "159995 芯片ETF华夏, 2026-06-21, 半导体, 当日净申购 1.2e8 元,
--    净赎回 0.3e8 元, 收盘 IOPV 溢价率 0.45%".
--
-- 与既有 etf_flows (US-092) 的关系:
--   - etf_flows: net_inflow = (share_count[T] - share_count[T-1]) × nav[T] 代理,
--     单字段 net (优点 = 历史端点稳定, 缺点 = 看不到 gross 申/赎结构);
--   - etf_creation_redemption (本表): gross net_creation / net_redemption 双字段 +
--     premium_pct 折溢价. 让下游 KOLAggregator 能识别 "净 0 但 gross 大 =
--     套利对倒" vs "净申购大 = 真增量资金" 两种 regime, 这是单字段 net 做不到的.
--
-- 数据源: AKShare 多端点合并
--   - fund_etf_iopv_em() — 全市场实时 IOPV + 二级现价 (用于算 premium_pct);
--   - fund_etf_fund_info_em / fund_etf_dividend_sina — 拉申/赎金额 (字段名跨版本
--     有差异, 下游 helper 层 normalize). 未拉到则 NULL (而非 0, 与"真 0" 区分).
--
-- AC 必需字段 (PRD US-147):
--   trade_date / etf_code / etf_name / industry /
--   net_creation / net_redemption / premium_pct.
--
-- 索引:
--   - PK (trade_date, etf_code) 隐含;
--   - (trade_date) — "今日全 ETF 申赎榜"类查询;
--   - (etf_code) — "某 ETF 近 30 天序列";
--   - (industry) — "近期半导体 ETF 全行业";
--   - (trade_date, industry) — "今日半导体行业全 ETF" 复合.
--
-- fail-safe 默认值:
--   - net_creation / net_redemption / premium_pct 允许 NULL (表达"未拉到"≠"真 0");
--   - source 默认 'akshare';
--   - raw_payload JSONB 默认 '{}'::jsonb.
--
-- 回滚: 2026-06-21-etf-creation-redemption-rollback.sql.
--
-- 执行 (生产):
--   psql $DATABASE_URL -f backend/scripts/migrations/2026-06-21-etf-creation-redemption.sql

BEGIN;

CREATE TABLE IF NOT EXISTS etf_creation_redemption (
  trade_date       DATE NOT NULL,
  etf_code         VARCHAR(20) NOT NULL,
  etf_name         VARCHAR(100) NOT NULL,
  industry         VARCHAR(50) NOT NULL,
  net_creation     DECIMAL(24, 4),
  net_redemption   DECIMAL(24, 4),
  premium_pct      DECIMAL(8, 4),
  source           VARCHAR(50) NOT NULL DEFAULT 'akshare',
  raw_payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  PRIMARY KEY (trade_date, etf_code)
);

CREATE INDEX IF NOT EXISTS idx_etf_creation_redemption_trade_date
  ON etf_creation_redemption (trade_date);

CREATE INDEX IF NOT EXISTS idx_etf_creation_redemption_etf_code
  ON etf_creation_redemption (etf_code);

CREATE INDEX IF NOT EXISTS idx_etf_creation_redemption_industry
  ON etf_creation_redemption (industry);

CREATE INDEX IF NOT EXISTS idx_etf_creation_redemption_trade_date_industry
  ON etf_creation_redemption (trade_date, industry);

COMMENT ON TABLE etf_creation_redemption IS
  'US-147 KOL-001 ETF 一级市场申赎 + 折溢价快照 — 1 row per (trade_date, etf_code). 与 etf_flows (net_inflow 代理) 互补, 提供 gross 申/赎 + premium_pct.';
COMMENT ON COLUMN etf_creation_redemption.trade_date IS '交易日 (YYYY-MM-DD), PK 一半';
COMMENT ON COLUMN etf_creation_redemption.etf_code IS '6 位 ETF 代码 (无市场前缀), PK 一半';
COMMENT ON COLUMN etf_creation_redemption.etf_name IS 'ETF 简称 (e.g. "芯片ETF华夏")';
COMMENT ON COLUMN etf_creation_redemption.industry IS '跟踪行业 (与 etf_flows.underlying_industry 同口径, 白名单内)';
COMMENT ON COLUMN etf_creation_redemption.net_creation IS '当日 gross 申购金额 (元, ≥0); NULL = 未拉到 (≠ 真 0)';
COMMENT ON COLUMN etf_creation_redemption.net_redemption IS '当日 gross 赎回金额 (元, ≥0); NULL = 未拉到 (≠ 真 0)';
COMMENT ON COLUMN etf_creation_redemption.premium_pct IS '折溢价率 (%, 二级收盘价/IOPV - 1)*100; 正=溢价, 负=折价; NULL=任一缺失';
COMMENT ON COLUMN etf_creation_redemption.source IS '数据源 (默认 akshare)';
COMMENT ON COLUMN etf_creation_redemption.raw_payload IS '原始端点行, JSON, 默认 {} - 事后回溯';

COMMIT;
