-- PR-M2 2026-06-29 — 集合竞价 snapshot + 盘中 30-min K 线 (up).
--
-- 两张表服务 "A 股最 robust 日内 alpha" (Zhang/Ma/Zhu 2019 — 9:30-10:00 收益预测
-- 14:30-15:00 收益, 在中国市场表现尤其显著) + 集合竞价 7 大战法 (Han/Hu/Jia 2023).
--
-- 1) auction_snapshots
--    - 一行 = 一只票一个交易日的 9:25 集合竞价后开盘价 + 量 + 涨幅 + 一字判定 + pattern.
--    - 由 cron AUCTION_SNAPSHOT_SYNC 每日 9:25 触发, 覆盖 universe ~500 票
--      (持仓 + 自选 + 涨停池 + 近 30 日推荐过).
--    - 给 OpeningRushDetector / 任意"开盘异动" service 消费.
--    - pattern 取值: 'one_word' / 't_word' / 'low_open_v' / 'high_open_volume' /
--      'shrink_limit' / 'northbound_block' / 'gap_up' / 'gap_down' / 'normal'.
--
-- 2) intraday_klines_30min
--    - 一行 = (symbol, kline_time) 即一只票一个 30 分钟 bar 的 OHLCV.
--    - 由 cron INTRADAY_KLINE_30MIN_SYNC 盘中持续 sync (e.g. 10:05/11:05/13:05/14:05/14:35)
--    - 全市场 universe ~500 票 * 8 bar/日 = ~4k 行/日; 保留 30 日 → ~12 万行.
--    - 给 IntradayMomentumDetector 消费 (核心: r1 = 9:30-10:00 收益预测 r2 = 14:30-15:00).
--
-- 索引设计:
--   - auction_snapshots: UNIQUE(trade_date, symbol) + INDEX(trade_date, pattern) 给 pattern 命中分布查询
--   - intraday_klines_30min: UNIQUE(symbol, kline_time) + INDEX(kline_time DESC, symbol) 给"最近一根 / 时间窗口"反查
--
-- 回滚: 2026-06-29-auction-and-30min-klines-rollback.sql
-- 执行: psql $DATABASE_URL -f backend/scripts/migrations/2026-06-29-auction-and-30min-klines.sql

BEGIN;

CREATE TABLE IF NOT EXISTS auction_snapshots (
  id                BIGSERIAL PRIMARY KEY,
  trade_date        DATE NOT NULL,
  symbol            VARCHAR(20) NOT NULL,
  name              VARCHAR(80),
  open_price        DECIMAL(20, 4),
  open_volume       BIGINT,
  open_amount       DECIMAL(20, 4),
  prev_close        DECIMAL(20, 4),
  open_change_pct   DECIMAL(10, 4),
  is_limit_up       BOOLEAN NOT NULL DEFAULT FALSE,
  pattern           VARCHAR(40) NOT NULL DEFAULT 'normal',
  raw_payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  CONSTRAINT auction_snapshots_uk UNIQUE (trade_date, symbol)
);

CREATE INDEX IF NOT EXISTS idx_auction_snapshots_date_pattern
  ON auction_snapshots (trade_date, pattern);

COMMENT ON TABLE auction_snapshots IS
  'PR-M2 集合竞价 (9:15-9:25) 快照. 每只 universe 票每个交易日一行, 9:25 后由 AUCTION_SNAPSHOT_SYNC 写入. pattern 给 OpeningRushDetector 消费.';
COMMENT ON COLUMN auction_snapshots.open_price IS '集合竞价撮合出的开盘价';
COMMENT ON COLUMN auction_snapshots.open_volume IS '开盘成交量 (股)';
COMMENT ON COLUMN auction_snapshots.open_amount IS '开盘成交额 (元)';
COMMENT ON COLUMN auction_snapshots.open_change_pct IS '(open - prev_close) / prev_close * 100';
COMMENT ON COLUMN auction_snapshots.is_limit_up IS '是否开盘即涨停 (一字 / 缩量涨停)';
COMMENT ON COLUMN auction_snapshots.pattern IS '7+1 战法 pattern: one_word / t_word / low_open_v / high_open_volume / shrink_limit / northbound_block / gap_up / gap_down / normal';
COMMENT ON COLUMN auction_snapshots.raw_payload IS '原始 quote 字段透传 (high/low/turnover_rate/...)';

CREATE TABLE IF NOT EXISTS intraday_klines_30min (
  id           BIGSERIAL PRIMARY KEY,
  symbol       VARCHAR(20) NOT NULL,
  kline_time   TIMESTAMP WITH TIME ZONE NOT NULL,
  open         DECIMAL(20, 4),
  high         DECIMAL(20, 4),
  low          DECIMAL(20, 4),
  close        DECIMAL(20, 4),
  volume       BIGINT,
  money        DECIMAL(20, 4),
  created_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  CONSTRAINT intraday_klines_30min_uk UNIQUE (symbol, kline_time)
);

CREATE INDEX IF NOT EXISTS intraday_klines_30min_time_idx
  ON intraday_klines_30min (kline_time DESC, symbol);

COMMENT ON TABLE intraday_klines_30min IS
  'PR-M2 盘中 30-min K 线时序. 一行 = (symbol, kline_time) OHLCV. 由 INTRADAY_KLINE_30MIN_SYNC 盘中每 30min 写入. 给 IntradayMomentumDetector 消费 (r1=9:30-10:00 预测 r2=14:30-15:00).';
COMMENT ON COLUMN intraday_klines_30min.kline_time IS 'bar 起始时刻 (9:30 / 10:00 / 10:30 / 11:00 / 13:00 / 13:30 / 14:00 / 14:30, Asia/Shanghai)';
COMMENT ON COLUMN intraday_klines_30min.money IS '成交额 (元)';

COMMIT;
