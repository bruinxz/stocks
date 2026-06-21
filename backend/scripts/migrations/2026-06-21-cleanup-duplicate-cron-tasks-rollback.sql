-- AR-5 rollback: 恢复 4 个已删冗余 cron task. 注意 id 是新生成的 — 仅恢复 type/name/cron 字段,
-- id 不可恢复. 实际运维: 这些 task 已被 ensureDefaultTasks 不再 seed (因 Batch AJ 同 type
-- 的 id=54/51/74/77 已存在), 故 rollback 主要用于"找回旧 parameters" 紧急回退场景.

BEGIN;

INSERT INTO scheduled_tasks (name, cron_expression, type, parameters, is_active, created_at, updated_at, consecutive_failure_count)
VALUES
  ('stock-市场环境预警', '10,40 9,10,11,13,14 * * 1-5', 'PAPER_TRADING_MARKET_REGIME_CHECK',
    '{"dry_run":false,"user_id":4,"lookback_days":60,"benchmark_symbol":"sh.000300"}'::jsonb,
    true, NOW(), NOW(), 0),
  ('stock-追踪止盈更新', '5 16 * * 1-5', 'PAPER_TRADING_TRAILING_STOP_UPDATE',
    '{"user_id":4}'::jsonb,
    true, NOW(), NOW(), 0),
  ('Equity Curve Governor 每日评估', '30 15 * * 1-5', 'EQUITY_CURVE_GOVERNOR_DAILY_EVAL',
    '{"persist":true}'::jsonb,
    true, NOW(), NOW(), 0),
  ('Research Integrity 周批量审计', '0 2 * * 1', 'RESEARCH_INTEGRITY_BATCH_AUDIT',
    '{"since_days":7}'::jsonb,
    true, NOW(), NOW(), 0)
ON CONFLICT (name) DO NOTHING;

COMMIT;
