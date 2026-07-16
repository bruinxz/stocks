UPDATE scheduled_tasks
SET is_active = false, updated_at = NOW()
WHERE type = 'PAPER_TRADING_RESTRICTED_SHARE_CHECK'
  AND is_active = true;
