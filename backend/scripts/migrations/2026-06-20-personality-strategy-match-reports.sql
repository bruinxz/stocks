-- US-127 PM-025 2026-06-20 — 创建 personality_strategy_match_reports (per-user 性格 vs 策略匹配度快照) (up).
--
-- 一行 = 单个用户 + 一个 period_end 的"性格画像 + 当前策略画像 + 匹配度评分 + 建议"快照.
--
-- 数据生产路径 (后续 story 接入):
--   - PM-025 PersonalityStrategyMatcher.matchForUser(user_id, period_end?) 主入口
--     → 取近 lookback_days (默认 90) 天 PaperTradingTrade + 当前 PaperTradingPosition
--       + 当前 QuantStrategyWeight (action != 'disabled') + QuantStrategyModel
--     → 反推 personality JSONB (preferred_industries / risk_tolerance / trade_frequency / holding_period)
--     → 反推 strategies JSONB (每个 active 策略画像 + 单策略 match_score)
--     → 算 matches.overall_score + best/worst + suggestions[] + heuristic ≤ 500 字 summary
--   - EV-011 MONTHLY_PERSONALITY_MATCH cron 每月 1 号 09:00 触发
--     → 对所有 active user 调 matchForUser → upsert 本表
--
-- 字段语义 (与 backend/src/models/PersonalityStrategyMatchReport.ts 对齐):
--   - period_start / period_end / lookback_days — 业务键冗余 (默认 period_end - 90 天)
--   - personality JSONB        — 用户性格画像 (preferred_industries[] / risk_tolerance /
--                                  trade_frequency / holding_period / avg_hold_days /
--                                  estimated_volatility)
--   - strategies JSONB         — items[]: { strategy_key, strategy_name, weight,
--                                  industries_focus[], expected_vol, turnover_class,
--                                  hold_class, quality_score, match_score, match_reasons[] }
--   - matches JSONB            — overall_score / best_match / worst_match / suggestions[]
--   - summary TEXT             — ≤ 500 字 heuristic 文本 (service 守 cap, model 不校验)
--   - source                   — heuristic / llm / manual
--   - status                   — ok / skipped (数据稀疏) / failed (fail-OPEN; skipped 也留痕)
--   - reason                   — skipped/failed 时的简短原因
--   - metadata JSONB           — cron_run_id / lookback_days / data_sources_used[] /
--                                  trade_count / strategy_count / errors[]
--   - generated_at             — 落库瞬间时间戳
--
-- 索引:
--   - UNIQUE(user_id, period_end) — 同 user 同 period_end 唯一 (月度 cron 重跑 idempotent upsert)
--   - (user_id) / (period_end)    — 按用户列出历史报告 / 按 period 查全平台覆盖率
--   - (status)                    — ops 看板 (skipped/failed 计数)
--   - (generated_at)              — 按时间排序最近 N 条
--
-- 默认值 (fail-safe — 未跑过 service 的安全态):
--   personality / strategies / matches / metadata 默认 '{}'::jsonb
--   summary 默认 '' (NOT NULL, 让 trivially INSERT 通过)
--   source 默认 'heuristic' (LLM 未接入时安全态)
--   status 默认 'ok' (与 ErrorPatternReport 同款 fail-OPEN)
--   lookback_days 默认 90
--
-- 回滚: 2026-06-20-personality-strategy-match-reports-rollback.sql.
--
-- 执行 (生产):
--   psql $DATABASE_URL -f backend/scripts/migrations/2026-06-20-personality-strategy-match-reports.sql

BEGIN;

CREATE TABLE IF NOT EXISTS personality_strategy_match_reports (
  id                  SERIAL PRIMARY KEY,
  user_id             INTEGER NOT NULL,
  period_start        DATE NOT NULL,
  period_end          DATE NOT NULL,
  lookback_days       INTEGER NOT NULL DEFAULT 90,
  personality         JSONB NOT NULL DEFAULT '{}'::jsonb,
  strategies          JSONB NOT NULL DEFAULT '{}'::jsonb,
  matches             JSONB NOT NULL DEFAULT '{}'::jsonb,
  summary             TEXT NOT NULL DEFAULT '',
  source              VARCHAR(20) NOT NULL DEFAULT 'heuristic',
  status              VARCHAR(20) NOT NULL DEFAULT 'ok',
  reason              VARCHAR(200),
  metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
  generated_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  created_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS personality_strategy_match_reports_user_period_uniq
  ON personality_strategy_match_reports (user_id, period_end);

CREATE INDEX IF NOT EXISTS idx_personality_strategy_match_reports_user_id
  ON personality_strategy_match_reports (user_id);

CREATE INDEX IF NOT EXISTS idx_personality_strategy_match_reports_period_end
  ON personality_strategy_match_reports (period_end);

CREATE INDEX IF NOT EXISTS idx_personality_strategy_match_reports_status
  ON personality_strategy_match_reports (status);

CREATE INDEX IF NOT EXISTS idx_personality_strategy_match_reports_generated_at
  ON personality_strategy_match_reports (generated_at);

COMMENT ON TABLE personality_strategy_match_reports IS
  'US-127 PM-025 性格 vs 策略匹配度快照 — per user per period 一行, personality + strategies + matches JSONB. (EV-011 月度 cron 后续接入)';
COMMENT ON COLUMN personality_strategy_match_reports.period_start IS '画像窗口起点 (默认 period_end - 90 天)';
COMMENT ON COLUMN personality_strategy_match_reports.period_end IS '画像窗口终点 (业务键, 月度 cron 跑时 = 本月 1 号)';
COMMENT ON COLUMN personality_strategy_match_reports.lookback_days IS '画像窗口天数 (默认 90)';
COMMENT ON COLUMN personality_strategy_match_reports.personality IS '用户性格画像 (preferred_industries[]/risk_tolerance/trade_frequency/holding_period/avg_hold_days/estimated_volatility)';
COMMENT ON COLUMN personality_strategy_match_reports.strategies IS '当前 active 策略画像 + 单策略 match_score (items[])';
COMMENT ON COLUMN personality_strategy_match_reports.matches IS '匹配度评分 + 建议 (overall_score/best_match/worst_match/suggestions[])';
COMMENT ON COLUMN personality_strategy_match_reports.summary IS '≤ 500 字 heuristic 摘要 (cap 由 service 守, model 不校验)';
COMMENT ON COLUMN personality_strategy_match_reports.source IS '生成来源: llm / heuristic / manual';
COMMENT ON COLUMN personality_strategy_match_reports.status IS '生成状态: ok / skipped / failed (与 ErrorPatternReport 对齐, fail-OPEN)';
COMMENT ON COLUMN personality_strategy_match_reports.reason IS 'skipped/failed 时的简短原因 (e.g. no_trades / no_active_strategies / matcher_threw)';
COMMENT ON COLUMN personality_strategy_match_reports.metadata IS '调用 metadata (cron_run_id / lookback_days / data_sources_used[] / trade_count / strategy_count / errors[])';
COMMENT ON COLUMN personality_strategy_match_reports.generated_at IS '报告生成时间戳 (落库瞬间)';

COMMIT;
