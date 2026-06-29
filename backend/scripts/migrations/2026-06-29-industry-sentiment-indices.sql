-- PR-M3 2026-06-29 — 创建 industry_sentiment_indices (板块情绪指数日度聚合) (up).
--
-- 一行 = (trade_date, industry) 二元组, 来自 IndustrySentimentAggregator 每日 16:00 (工作日)
-- 跑一次 — 从 limit_up_stocks JOIN stocks.industry GROUP BY industry 把当日涨停盘 4 大
-- 龙头战法核心指标 (涨停数 / 连板高度 / 封板率 / 炸板率 + 30 日板块动量 + composite_score)
-- 一次性算出, 给推荐 service 消费做"龙头板块加权 / 弱势板块直接 skip"决策.
--
-- 字段语义 (与 backend/src/models/IndustrySentimentIndex.ts 严格对齐):
--   - trade_date                  交易日 (DATEONLY)
--   - industry                    申万一级 (e.g. '半导体' '电力') ≤ 100 字符
--   - lim_up_count                当日涨停只数 (INTEGER)
--   - consecutive_max             当日最高连板数 (e.g. 5 = 五板; 0 = 无涨停)
--   - seal_rate                   封板率 = (一字板 + 收盘封板) / 总涨停数; [0, 1]
--   - lim_up_failure_rate         炸板率 = 至少炸过一次 / 总涨停数 (含 reopen 但收盘仍涨停的);
--                                 [0, 1] — 与 seal_rate 互为参考, 高炸板率板块 = 主力出货
--   - industry_momentum_30d       30 日动量 z-score (相对全市场, 板块平均 30d 涨幅 z-score);
--                                 NULL = 数据不足无法算 (避免误用 0)
--   - composite_score             综合分: weighted sum (lim_up_count * 0.3 + consecutive_max * 0.3
--                                 + seal_rate * 0.2 - lim_up_failure_rate * 0.1
--                                 + industry_momentum_30d_zscore * 0.1) — 大约 [-5, +5] 区间
--   - constituent_count           当日涨停股票数 (与 lim_up_count 同, 冗余便于审计)
--   - top_codes                   涨停代表股 JSONB string[] (前 3 只按连板从高到低)
--   - raw_payload                 透传给前端 / 调试用 JSONB
--
-- 索引:
--   - PRIMARY KEY (trade_date, industry)
--   - (trade_date, composite_score DESC)          per-date 排序取 top N 板块
--   - (industry, trade_date DESC)                 per-industry 时序回查
--
-- 回滚: 2026-06-29-industry-sentiment-indices-rollback.sql
--
-- 执行 (生产):
--   psql $DATABASE_URL -f backend/scripts/migrations/2026-06-29-industry-sentiment-indices.sql

BEGIN;

CREATE TABLE IF NOT EXISTS industry_sentiment_indices (
  trade_date                  DATE NOT NULL,
  industry                    VARCHAR(100) NOT NULL,
  lim_up_count                INTEGER NOT NULL DEFAULT 0,
  consecutive_max             INTEGER NOT NULL DEFAULT 0,
  seal_rate                   NUMERIC(6, 4) NOT NULL DEFAULT 0,
  lim_up_failure_rate         NUMERIC(6, 4) NOT NULL DEFAULT 0,
  industry_momentum_30d       NUMERIC(10, 4),
  composite_score             NUMERIC(10, 4) NOT NULL DEFAULT 0,
  constituent_count           INTEGER NOT NULL DEFAULT 0,
  top_codes                   JSONB NOT NULL DEFAULT '[]'::jsonb,
  raw_payload                 JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at                  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  PRIMARY KEY (trade_date, industry)
);

CREATE INDEX IF NOT EXISTS idx_isi_date_score
  ON industry_sentiment_indices (trade_date, composite_score DESC);

CREATE INDEX IF NOT EXISTS idx_isi_industry_date
  ON industry_sentiment_indices (industry, trade_date DESC);

COMMENT ON TABLE industry_sentiment_indices IS
  'PR-M3 板块情绪指数日度聚合 — 一行 = (trade_date, industry) 二元组, 由 IndustrySentimentAggregator 每日 16:00 (工作日) 跑出, 给推荐 service 消费 "龙头板块加权 / 弱势板块直接 skip" 决策.';
COMMENT ON COLUMN industry_sentiment_indices.trade_date IS '交易日 (YYYY-MM-DD)';
COMMENT ON COLUMN industry_sentiment_indices.industry IS '申万一级行业名 (与 stocks.industry 同口径)';
COMMENT ON COLUMN industry_sentiment_indices.lim_up_count IS '当日涨停只数';
COMMENT ON COLUMN industry_sentiment_indices.consecutive_max IS '当日最高连板数 (0 = 无涨停)';
COMMENT ON COLUMN industry_sentiment_indices.seal_rate IS '封板率 = (一字板 + 收盘封板) / 总涨停数; [0, 1]';
COMMENT ON COLUMN industry_sentiment_indices.lim_up_failure_rate IS '炸板率 = 至少炸过一次 / 总涨停数; [0, 1]';
COMMENT ON COLUMN industry_sentiment_indices.industry_momentum_30d IS '30 日动量 z-score (相对全市场), NULL = 数据不足';
COMMENT ON COLUMN industry_sentiment_indices.composite_score IS '综合分 weighted sum, 大约 [-5, +5] 区间, > +2 = leader, < -1 = weak';
COMMENT ON COLUMN industry_sentiment_indices.constituent_count IS '当日涨停股票数 (与 lim_up_count 同, 冗余便于审计)';
COMMENT ON COLUMN industry_sentiment_indices.top_codes IS '涨停代表股 JSONB string[] (前 3 只按连板高到低)';
COMMENT ON COLUMN industry_sentiment_indices.raw_payload IS '调试 / 审计透传 JSONB';

COMMIT;
