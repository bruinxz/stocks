-- Morning checkups are account ledgers, not user-wide aggregates.
-- This migration changes the business key to (user, portfolio, date), marks the
-- known 2026-07-21 aggregate row invalid, and appends a correction notification.
-- It intentionally does not edit any already-sent message.

BEGIN;

DROP INDEX IF EXISTS morning_risk_checkups_user_date_uniq;

CREATE UNIQUE INDEX IF NOT EXISTS morning_risk_checkups_user_portfolio_date_uniq
  ON morning_risk_checkups (user_id, portfolio_id, date);

UPDATE morning_risk_checkups
SET breakdown = COALESCE(breakdown, '{}'::jsonb) || jsonb_build_object(
      'correction', jsonb_build_object(
        'status', 'invalidated',
        'reason', 'legacy service aggregated every active portfolio but read snapshots from one portfolio',
        'corrected_at', NOW()
      )
    ),
    error = '已更正：该记录错误聚合了多个模拟盘，不可作为单账户收益依据',
    updated_at = NOW()
WHERE user_id = 4
  AND date = DATE '2026-07-21'
  AND ABS(COALESCE(weekly_return_pct, 0)) > 0.5;

INSERT INTO feishu_notification_outbox (
  idempotency_key,
  topic_key,
  audience,
  recipient_user_id,
  kind,
  severity,
  title,
  payload,
  status,
  attempts,
  max_attempts,
  next_attempt_at,
  correlation_id,
  metadata,
  created_at,
  updated_at
)
SELECT
  'morning-risk-checkup:4:2026-07-21:correction',
  'morning-risk-checkup:4:correction',
  'user',
  4,
  'morning_risk_checkup_correction',
  'HIGH',
  '🟠 更正 · 07-21 开盘前体检收益率无效',
  jsonb_build_object(
    'msg_type', 'text',
    'content', jsonb_build_object(
      'text',
      '更正：2026-07-21 开盘前风险体检中的 +99.78% 为多模拟盘资产聚合、单模拟盘快照对比造成的错误结果。该数字无效；系统已改为每个模拟盘独立计算和通知。'
    )
  ),
  'pending',
  0,
  6,
  NOW(),
  'morning_risk_checkup:4:2026-07-21:correction',
  jsonb_build_object(
    'user_id', 4,
    'date', '2026-07-21',
    'corrects_kind', 'morning_risk_checkup',
    'corrected', true
  ),
  NOW(),
  NOW()
WHERE EXISTS (
  SELECT 1
  FROM morning_risk_checkups
  WHERE user_id = 4
    AND date = DATE '2026-07-21'
    AND breakdown->'correction'->>'status' = 'invalidated'
)
ON CONFLICT (idempotency_key) DO NOTHING;

COMMIT;
