-- 回滚: 重新激活 '推荐信号模拟盘跟单' cron.
-- 注意: 重新激活仅导致每交易日空跑 (quant_recommendation 信号源已随批5 永久删除),
-- 不会恢复任何实际跟单能力. 仅供审计/紧急回退用.

UPDATE scheduled_tasks
SET is_active = true, updated_at = NOW()
WHERE name = '推荐信号模拟盘跟单'
  AND type = 'PAPER_TRADING_AUTO_SYNC'
  AND is_active = false;
