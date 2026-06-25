-- CE-C 2026-06-25 — 创建 intraday_opportunity_pushes (实时机会推送审计表) (up).
--
-- 一行 = 一次"实时买入机会"飞书推送的审计记录 (含 dedup signature / 推送结果 /
-- T+1 / T+5 forward return 后置回填).
-- 由 IntradayOpportunityPusher.push 在每次"实际推送" (skipped/dry_run/circuit_breaker
-- 也写一行做留痕) 之后写入.
--
-- 字段语义 (与 backend/src/models/IntradayOpportunityPush.ts 严格对齐):
--   - symbol                  'sh.600519' / '600519' 等任意非空 ≤ 20 字符
--   - name                    股票名 ≤ 80 字符 (允许 null)
--   - trigger_rule            'breakout_60d_high' / 'volume_spike' / ... (≤ 40)
--   - trigger_time            机会触发的真实时间 (TIMESTAMPTZ; UTC 存储)
--   - pushed_at               入库时间 (DEFAULT NOW())
--   - decision                JSONB: {action, confidence_score, risk_level, ...}
--   - reasons                 JSONB string[]: top 3 evidence
--   - source_signal_id        AIInvestmentSignal.id 用于深页跳转 (nullable)
--   - target_groups           'business' / 'ops' / 'user' 逗号分隔; ≤ 100
--   - push_result             JSONB: {ok, dedup_signature, pushed_groups,
--                              skipped_reason, channels: [...]}
--   - forward_return_1d       T+1 收盘后回填 (NUMERIC; nullable)
--   - forward_return_5d       T+5 收盘后回填
--   - forward_return_updated_at  最后回填时间戳 (nullable)
--
-- 索引:
--   - (symbol, trigger_time DESC)   per-symbol 时间序检索
--   - (trigger_rule, trigger_time DESC) per-rule 时间序检索
--   - (pushed_at) WHERE forward_return_5d IS NULL  cron 找待回填行 (部分索引)
--
-- 回滚: 2026-06-25-intraday-opportunity-pushes-rollback.sql
--
-- 执行 (生产):
--   psql $DATABASE_URL -f backend/scripts/migrations/2026-06-25-intraday-opportunity-pushes.sql

BEGIN;

CREATE TABLE IF NOT EXISTS intraday_opportunity_pushes (
  id                          SERIAL PRIMARY KEY,
  symbol                      VARCHAR(20) NOT NULL,
  name                        VARCHAR(80),
  trigger_rule                VARCHAR(40) NOT NULL,
  trigger_time                TIMESTAMP WITH TIME ZONE NOT NULL,
  pushed_at                   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  decision                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  reasons                     JSONB NOT NULL DEFAULT '[]'::jsonb,
  source_signal_id            INTEGER,
  target_groups               VARCHAR(100) NOT NULL DEFAULT 'business',
  push_result                 JSONB NOT NULL DEFAULT '{}'::jsonb,
  forward_return_1d           NUMERIC(10, 4),
  forward_return_5d           NUMERIC(10, 4),
  forward_return_updated_at   TIMESTAMP WITH TIME ZONE,
  created_at                  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_iop_symbol_time
  ON intraday_opportunity_pushes (symbol, trigger_time DESC);

CREATE INDEX IF NOT EXISTS idx_iop_rule_time
  ON intraday_opportunity_pushes (trigger_rule, trigger_time DESC);

CREATE INDEX IF NOT EXISTS idx_iop_pending_forward
  ON intraday_opportunity_pushes (pushed_at)
  WHERE forward_return_5d IS NULL;

COMMENT ON TABLE intraday_opportunity_pushes IS
  'CE-C 实时机会推送审计表 — 每次 IntradayOpportunityPusher.push 都写一行 (含 skipped/dry_run/circuit_breaker 留痕), 用于 dedup 回查 / 后置归因 (T+1/T+5 forward return) / 飞书消息追溯.';
COMMENT ON COLUMN intraday_opportunity_pushes.symbol IS '股票代码 (sh.600519 / 600519 / SZ000001 等 caller 自定义)';
COMMENT ON COLUMN intraday_opportunity_pushes.name IS '股票名称';
COMMENT ON COLUMN intraday_opportunity_pushes.trigger_rule IS '触发规则 ID (breakout_60d_high / volume_spike / rapid_rise / ...)';
COMMENT ON COLUMN intraday_opportunity_pushes.trigger_time IS '机会触发的真实时间 (UTC 存储, 与 pushed_at 区分)';
COMMENT ON COLUMN intraday_opportunity_pushes.pushed_at IS '推送写库时间 (默认 NOW())';
COMMENT ON COLUMN intraday_opportunity_pushes.decision IS '决策快照 JSONB: {action, confidence_score, risk_level, suggested_position_pct, entry_zone, stop_loss, take_profit}';
COMMENT ON COLUMN intraday_opportunity_pushes.reasons IS '触发理由 string[] (top 3 evidence)';
COMMENT ON COLUMN intraday_opportunity_pushes.source_signal_id IS '关联 AIInvestmentSignal.id 用于前端深页跳转';
COMMENT ON COLUMN intraday_opportunity_pushes.target_groups IS '推送目标分组逗号分隔: business,ops,user';
COMMENT ON COLUMN intraday_opportunity_pushes.push_result IS '推送结果 JSONB: {ok, dedup_signature, pushed_groups, skipped_reason, channels}';
COMMENT ON COLUMN intraday_opportunity_pushes.forward_return_1d IS 'T+1 收盘后回填的 forward return (百分比, 4 位小数)';
COMMENT ON COLUMN intraday_opportunity_pushes.forward_return_5d IS 'T+5 收盘后回填的 forward return';
COMMENT ON COLUMN intraday_opportunity_pushes.forward_return_updated_at IS '最近一次 forward return 回填的时间戳';

COMMIT;
