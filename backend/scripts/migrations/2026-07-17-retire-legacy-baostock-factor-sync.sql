UPDATE scheduled_tasks
SET is_active = false, updated_at = NOW()
WHERE type = 'DERIVED_FACTOR_SYNC'
  AND name = '每日派生因子同步 (baostock)'
  AND is_active = true;

UPDATE scheduled_tasks
SET name = '每日派生因子同步 (自动多源)',
    parameters = jsonb_set(
      COALESCE(parameters, '{}'::jsonb),
      '{provider}',
      '"auto"'::jsonb,
      true
    ),
    updated_at = NOW()
WHERE type = 'DERIVED_FACTOR_SYNC'
  AND name = '每日派生因子同步 (东方财富)'
  AND NOT EXISTS (
    SELECT 1
    FROM scheduled_tasks existing
    WHERE existing.name = '每日派生因子同步 (自动多源)'
  );

UPDATE scheduled_tasks legacy
SET is_active = false, updated_at = NOW()
WHERE legacy.type = 'DERIVED_FACTOR_SYNC'
  AND legacy.name = '每日派生因子同步 (东方财富)'
  AND EXISTS (
    SELECT 1
    FROM scheduled_tasks authoritative
    WHERE authoritative.name = '每日派生因子同步 (自动多源)'
      AND authoritative.id <> legacy.id
  );
