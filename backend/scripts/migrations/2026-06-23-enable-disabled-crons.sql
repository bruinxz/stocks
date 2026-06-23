-- Batch BC-8 (2026-06-23): 启用 8 个被批量 disabled 的 cron
-- 真因: 这 8 个 cron 在 2026-06-11 17:56 被批量 disabled (是不是 ops 误操作 / 还是
-- 出问题暂停, git history 没记录). 启动日志一直报 "reverse drift: 8 registered
-- type(s) without DB row" 告警 (实际有 row 但 is_active=false, 告警 message 不准).
--
-- 修复策略: 启用 + 重置 last_run_status=null + consecutive_failure_count=0
-- 让 SchedulerService 从新调度. 若有真问题, 重新触发后会再 fail 然后查具体错.
--
-- 涉及 8 个 cron type (实际有 12 row, 因 AI_DAILY_SCREENER 有 4 个时段,
-- SIGNAL_PERFORMANCE_REFRESH 有 2 个时段):
--   - AI_DAILY_SCREENER (4 row: 早盘 9:00 / 午盘 12:30 / 收盘 14:30 / 全市场 14:35)
--   - AUTO_RECOMMENDATION_LOOP (1 row: 15:45)
--   - LIVE_SHADOW_AUTOPILOT (1 row: 09:58)
--   - LIVE_SHADOW_WEEKLY_REVIEW (1 row: 周五 16:20)
--   - PAPER_TRADING_ATTRIBUTION_REPORT (1 row: 16:05)
--   - PAPER_TRADING_DAILY_PLAN (1 row: 16:10)
--   - SIGNAL_PERFORMANCE_REFRESH (2 row: 15:20 + 15:25)
--   - SIGNAL_QUALITY_DAILY_REPORT (1 row: 16:30)
--
-- 注意: 若发现这些 cron 启用后又开始 fail, 可能是 ops 当初关掉的真正原因
-- (例如 DB 慢查询 / 内存爆 / API quota 超), 需要单独 debug 不要再批量关.

UPDATE scheduled_tasks
SET
  is_active = true,
  last_run_status = NULL,
  consecutive_failure_count = 0,
  updated_at = NOW()
WHERE type IN (
  'AI_DAILY_SCREENER',
  'AUTO_RECOMMENDATION_LOOP',
  'LIVE_SHADOW_AUTOPILOT',
  'LIVE_SHADOW_WEEKLY_REVIEW',
  'PAPER_TRADING_ATTRIBUTION_REPORT',
  'PAPER_TRADING_DAILY_PLAN',
  'SIGNAL_PERFORMANCE_REFRESH',
  'SIGNAL_QUALITY_DAILY_REPORT'
)
AND is_active = false;
