-- 2026-07-21: 退役旧盘中模拟盘风控任务。
--
-- 该任务在 09:15 首次触发时没有当日成交行情，会回退到旧日线并制造虚假成交；
-- 当前正式任务“模拟盘风控退出检查”已在 15:50 使用当日收盘快照执行，旧任务重复。
UPDATE scheduled_tasks
SET is_active = FALSE,
    last_run_status = CASE WHEN last_run_status = 'RUNNING' THEN 'SKIPPED' ELSE last_run_status END,
    updated_at = NOW()
WHERE name = 'stock-风控退出检查'
  AND type = 'PAPER_TRADING_RISK_CHECK'
  AND cron_expression = '15,45 9,10,11,13,14 * * 1-5';
