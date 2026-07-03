-- 批9 (2026-07-03): 清理批5已下线任务的 DB 存量 cron row
-- 背景: 批5 移除了 5 个 service (QuantRecommendationService / AutomatedRecommendationLoopService
--       / EarningsForecastWatcher / MarketSentimentIndexService / StrategyKillSwitchMonitor),
--       SchedulerService 的 dispatch 分支改成"已下线空跑桩", cronRegistry 也标为 retired.
--       但 ensureDefaultTasks 当时漏删 8 处 seed → fresh DB / 存量 DB 仍把这些死任务当 active,
--       每次到点空转一次标 COMPLETED (无害但脏, 且污染 cron 诊断).
-- 批9 已删除全部 seed + dispatch 桩保留(防 Unsupported task type 抛错)+ registry 标 retired.
-- 本脚本负责 DB 侧: 把存量的这 5 类任务 disable (保留 row 以便审计, 不物理删).
--
-- 幂等: 按 type 匹配, 重复执行安全. 生产 / staging / DR 重建后均可跑.

UPDATE scheduled_tasks
SET is_active = false,
    updated_at = NOW()
WHERE type IN (
  'AI_DAILY_SCREENER',
  'AUTO_RECOMMENDATION_LOOP',
  'EARNINGS_FORECAST_WATCH',
  'MARKET_SENTIMENT_INDEX_SYNC',
  'STRATEGY_KILL_SWITCH_CHECK'
)
AND is_active = true;
