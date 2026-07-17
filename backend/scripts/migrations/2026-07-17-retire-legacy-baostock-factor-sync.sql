UPDATE scheduled_tasks
SET is_active = false, updated_at = NOW()
WHERE type = 'DERIVED_FACTOR_SYNC'
  AND name = '每日派生因子同步 (baostock)'
  AND is_active = true;
