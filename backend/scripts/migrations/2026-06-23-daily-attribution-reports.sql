-- US-080 PM-003 2026-06-23 — 创建 daily_attribution_reports (per-portfolio per-date 6 维归因报告) (up).
--
-- 一行 = 单个 portfolio + 一个交易日 的 6 维归因报告.
-- 由 DailyAttributionService (PM-001/002), DAILY_ATTRIBUTION_GENERATE cron (PM-006) 在 17:00 触发持久化.
--
-- 之前因 sequelize.sync 仅 dev 跑, 而 prod 无对应 SQL migration, 导致表缺失,
-- GET /api/portfolio/:id/attribution/daily 直接返回 500. 本 migration 补齐.
--
-- 字段语义 (与 backend/src/models/DailyAttributionReport.ts 对齐 — 必须一一对齐, 否则 sequelize 报错):
--   - portfolio_id          关联 PaperTradingPortfolio.id (或 LiveBrokerAccount.id)
--   - date                  归因目标交易日 (YYYY-MM-DD, Asia/Shanghai)
--   - total_pnl             当日总盈亏 (元)
--   - total_pnl_pct         当日盈亏百分比 (nullable: prev_total<=0)
--   - realized_pnl          当日已实现盈亏 (Σ SELL.realized_pnl)
--   - unrealized_delta      = total_pnl - realized_pnl
--   - trade_count/buy_count/sell_count 当日成交笔数
--   - breakdown JSONB       6 维归因拆解 (factor/industry/timing/selection/sizing/execution_cost/residual + contrib[])
--   - best_trades/worst_trades JSONB  top 3 winners/losers
--   - ai_summary TEXT       ≤ 200 字 AI / heuristic 摘要
--   - bias_findings JSONB   行为偏差告警数组 (PM-008)
--   - recommendations JSONB 明日改进建议数组
--   - status                ok/skipped/failed (与 DailyAttributionReport 对齐, fail-OPEN)
--   - reason VARCHAR(200)   skipped/failed 原因
--   - metadata JSONB        cron_run_id / data_source / engine_input 等
--   - generated_at          报告生成时间戳
--   - source                daily_attribution_service / cron / manual_replay
--
-- 索引:
--   - UNIQUE(portfolio_id, date) — 业务唯一 (重跑 idempotent upsert)
--   - (portfolio_id) / (date) / (status) / (generated_at)
--
-- 回滚: 2026-06-23-daily-attribution-reports-rollback.sql.
--
-- 执行 (生产):
--   psql $DATABASE_URL -f backend/scripts/migrations/2026-06-23-daily-attribution-reports.sql

BEGIN;

CREATE TABLE IF NOT EXISTS daily_attribution_reports (
  id                  SERIAL PRIMARY KEY,
  portfolio_id        INTEGER NOT NULL,
  date                DATE NOT NULL,
  total_pnl           NUMERIC(20, 4) NOT NULL DEFAULT 0,
  total_pnl_pct       NUMERIC(10, 4),
  realized_pnl        NUMERIC(20, 4) NOT NULL DEFAULT 0,
  unrealized_delta    NUMERIC(20, 4) NOT NULL DEFAULT 0,
  trade_count         INTEGER NOT NULL DEFAULT 0,
  buy_count           INTEGER NOT NULL DEFAULT 0,
  sell_count          INTEGER NOT NULL DEFAULT 0,
  breakdown           JSONB NOT NULL DEFAULT '{}'::jsonb,
  best_trades         JSONB NOT NULL DEFAULT '[]'::jsonb,
  worst_trades        JSONB NOT NULL DEFAULT '[]'::jsonb,
  ai_summary          TEXT NOT NULL DEFAULT '',
  bias_findings       JSONB NOT NULL DEFAULT '[]'::jsonb,
  recommendations     JSONB NOT NULL DEFAULT '[]'::jsonb,
  status              VARCHAR(20) NOT NULL DEFAULT 'ok',
  reason              VARCHAR(200),
  metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
  generated_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  source              VARCHAR(40) NOT NULL DEFAULT 'daily_attribution_service',
  created_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS daily_attribution_reports_portfolio_date_uniq
  ON daily_attribution_reports (portfolio_id, date);

CREATE INDEX IF NOT EXISTS idx_daily_attribution_reports_portfolio_id
  ON daily_attribution_reports (portfolio_id);

CREATE INDEX IF NOT EXISTS idx_daily_attribution_reports_date
  ON daily_attribution_reports (date);

CREATE INDEX IF NOT EXISTS idx_daily_attribution_reports_status
  ON daily_attribution_reports (status);

CREATE INDEX IF NOT EXISTS idx_daily_attribution_reports_generated_at
  ON daily_attribution_reports (generated_at);

COMMENT ON TABLE daily_attribution_reports IS
  'US-080 PM-003 每日归因报告 — 单 portfolio + 单交易日 一行, 6 维归因拆解 (factor/industry/timing/selection/sizing/execution_cost) JSONB. (PM-006 cron 工作日 17:00 触发, PM-007 GET /api/portfolio/:id/attribution/daily 读取)';
COMMENT ON COLUMN daily_attribution_reports.portfolio_id IS '关联 PaperTradingPortfolio.id (或 LiveBrokerAccount.id, 取归因主账户)';
COMMENT ON COLUMN daily_attribution_reports.date IS '归因目标交易日 (YYYY-MM-DD, Asia/Shanghai)';
COMMENT ON COLUMN daily_attribution_reports.total_pnl IS '当日总盈亏 (元; = 当日 EOD total_value - 前一交易日 EOD total_value)';
COMMENT ON COLUMN daily_attribution_reports.total_pnl_pct IS '当日盈亏百分比 (= total_pnl / prev_total_value × 100; null 表示 prev_total<=0)';
COMMENT ON COLUMN daily_attribution_reports.realized_pnl IS '当日已实现盈亏 (Σ SELL.realized_pnl)';
COMMENT ON COLUMN daily_attribution_reports.unrealized_delta IS '当日未实现盈亏变动 (= total_pnl - realized_pnl)';
COMMENT ON COLUMN daily_attribution_reports.trade_count IS '当日成交笔数 (BUY + SELL)';
COMMENT ON COLUMN daily_attribution_reports.buy_count IS '当日 BUY 笔数';
COMMENT ON COLUMN daily_attribution_reports.sell_count IS '当日 SELL 笔数';
COMMENT ON COLUMN daily_attribution_reports.breakdown IS '6 维归因拆解 (factor/industry/timing/selection/sizing/execution_cost/residual + factor_contrib_total + factor_contrib[] + industry_contrib[])';
COMMENT ON COLUMN daily_attribution_reports.best_trades IS '当日盈利 top N 笔交易 (BestWorstTradeSummary[]; 默认 3)';
COMMENT ON COLUMN daily_attribution_reports.worst_trades IS '当日亏损 top N 笔交易 (BestWorstTradeSummary[]; 默认 3)';
COMMENT ON COLUMN daily_attribution_reports.ai_summary IS 'AI / heuristic 摘要 (≤ 200 字; PM-005 替换成 LLM, 当前 heuristicSummary 静态拼接)';
COMMENT ON COLUMN daily_attribution_reports.bias_findings IS '行为偏差告警数组 (PM-008 BehaviorBiasDetector.detectIncremental 填; 本 story 先空)';
COMMENT ON COLUMN daily_attribution_reports.recommendations IS '明日改进建议 (字符串数组; PM-005 / PM-008 填; 本 story 先空)';
COMMENT ON COLUMN daily_attribution_reports.status IS '生成状态: ok / skipped / failed (与 DAILY_ATTRIBUTION_STATUS 对齐, fail-OPEN)';
COMMENT ON COLUMN daily_attribution_reports.reason IS 'skipped/failed 时的原因 (e.g. no_prev_snapshot / db_error)';
COMMENT ON COLUMN daily_attribution_reports.metadata IS '调用 metadata (data_source / engine_input 是否传入 / cron_run_id / heuristic vs llm summary 来源等)';
COMMENT ON COLUMN daily_attribution_reports.generated_at IS '报告生成时间戳 (落库瞬间)';
COMMENT ON COLUMN daily_attribution_reports.source IS '产出来源 (daily_attribution_service / cron / manual_replay)';

COMMIT;
