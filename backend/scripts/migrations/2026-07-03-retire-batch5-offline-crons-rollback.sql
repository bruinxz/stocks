-- 回滚: 批9 DB 清理 (2026-07-03-retire-batch5-offline-crons.sql)
-- 注意: 这 5 类 service 已在批5物理移除, 重新 enable 后任务只会空跑 (dispatch 桩标 COMPLETED),
--       不会恢复任何实际能力. 回滚仅用于误操作时把 row 状态还原, 无业务意义.
UPDATE scheduled_tasks
SET is_active = true,
    updated_at = NOW()
WHERE type IN (
  'AI_DAILY_SCREENER',
  'AUTO_RECOMMENDATION_LOOP',
  'EARNINGS_FORECAST_WATCH',
  'MARKET_SENTIMENT_INDEX_SYNC',
  'STRATEGY_KILL_SWITCH_CHECK'
);
