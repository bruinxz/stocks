-- 上线部署 (2026-07-09): 建立 trading_calendar 表 · §D4.G2 契约承接位
-- 背景: §D4.1 α 降级策略 COALESCE(available_at, time + INTERVAL '1 day') 前
--       INTERVAL 用日历日近似 · trading_calendar landed 后升级为真实交易日 lookup。
--       Baostock bs.query_trade_dates 主源 · AKShare 备 · DataPipeline 独占采集器承接。
-- 契约: docs/refactor/contracts/data.md §D4.G2 (PR #94 @ ad586ef6) shape pin 100% 复用。
-- 幂等: CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS · 重复执行安全。
-- 生产 / staging / DR 重建后均可跑。

CREATE TABLE IF NOT EXISTS trading_calendar (
  trade_date       DATE NOT NULL PRIMARY KEY,
  is_open          BOOLEAN NOT NULL DEFAULT TRUE,
  is_half          BOOLEAN NOT NULL DEFAULT FALSE,
  prev_trade_date  DATE,
  next_trade_date  DATE,
  source           VARCHAR(50) NOT NULL DEFAULT 'baostock',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trading_calendar_is_open
  ON trading_calendar (is_open);

CREATE INDEX IF NOT EXISTS idx_trading_calendar_is_half
  ON trading_calendar (is_half);
