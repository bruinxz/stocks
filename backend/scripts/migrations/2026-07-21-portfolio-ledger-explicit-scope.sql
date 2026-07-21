-- Make portfolio-ledger notification scope explicit and repair the known
-- rebalance BUY summary whose legacy formatter inferred SELL from the source.

BEGIN;

CREATE TABLE IF NOT EXISTS paper_trading_data_corrections (
  id BIGSERIAL PRIMARY KEY,
  correction_key VARCHAR(120) NOT NULL UNIQUE,
  correction_type VARCHAR(80) NOT NULL,
  entity_type VARCHAR(80) NOT NULL,
  entity_id VARCHAR(120) NOT NULL,
  reason TEXT NOT NULL,
  before_state JSONB NOT NULL,
  after_state JSONB,
  applied_by VARCHAR(120) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

UPDATE feishu_notification_outbox
   SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
         'ledger_scope', 'portfolio',
         'ledger_scope_migrated_by', 'portfolio-ledger-explicit-scope-2026-07-21'
       ),
       updated_at = NOW()
 WHERE metadata->>'portfolio_id' ~ '^[0-9]+$'
   AND NOT (COALESCE(metadata, '{}'::jsonb) ? 'ledger_scope')
   AND kind IN (
     'paper_trade_executed',
     'paper_trade_correction',
     'morning_risk_checkup'
   );

UPDATE feishu_notification_outbox
   SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
         'corrected', TRUE,
         'invalidated', TRUE,
         'invalidated_by_idempotency_key', 'paper-trade:447:correction'
       ),
       updated_at = NOW()
 WHERE idempotency_key = 'paper-trade:447:executed'
   AND NOT (COALESCE(metadata, '{}'::jsonb) @> jsonb_build_object(
     'corrected', TRUE,
     'invalidated', TRUE,
     'invalidated_by_idempotency_key', 'paper-trade:447:correction'
   ));

UPDATE feishu_notification_outbox
   SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
         'ledger_scope', 'portfolio',
         'corrects_idempotency_key', 'paper-trade:447:executed'
       ),
       updated_at = NOW()
 WHERE idempotency_key = 'paper-trade:447:correction'
   AND NOT (COALESCE(metadata, '{}'::jsonb) @> jsonb_build_object(
     'ledger_scope', 'portfolio',
     'corrects_idempotency_key', 'paper-trade:447:executed'
   ));

UPDATE feishu_notification_outbox
   SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
         'ledger_scope', 'portfolio',
         'corrected', TRUE,
         'invalidated', TRUE,
         'invalidated_by_idempotency_key', 'morning-risk-checkup:4:2026-07-21:correction'
       ),
       updated_at = NOW()
 WHERE idempotency_key = 'morning-risk-checkup:4:2026-07-21'
   AND NOT (COALESCE(metadata, '{}'::jsonb) @> jsonb_build_object(
     'ledger_scope', 'portfolio',
     'corrected', TRUE,
     'invalidated', TRUE,
     'invalidated_by_idempotency_key', 'morning-risk-checkup:4:2026-07-21:correction'
   ));

UPDATE feishu_notification_outbox
   SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
         'ledger_scope', 'account_correction',
         'corrects_idempotency_key', 'morning-risk-checkup:4:2026-07-21'
       ),
       updated_at = NOW()
 WHERE idempotency_key = 'morning-risk-checkup:4:2026-07-21:correction'
   AND NOT (COALESCE(metadata, '{}'::jsonb) @> jsonb_build_object(
     'ledger_scope', 'account_correction',
     'corrects_idempotency_key', 'morning-risk-checkup:4:2026-07-21'
   ));

WITH target AS (
  SELECT t.*
    FROM paper_trading_trades t
   WHERE t.id = 443
     AND t.portfolio_id = 65
     AND t.symbol = 'sh.510880'
     AND t.direction::text = 'BUY'
     AND t.trade_reason->>'source' = 'rebalance'
     AND t.trade_reason_summary LIKE '卖出:%'
)
INSERT INTO paper_trading_data_corrections (
  correction_key,
  correction_type,
  entity_type,
  entity_id,
  reason,
  before_state,
  applied_by
)
SELECT
  'paper_trade_443_rebalance_summary_direction',
  'repair_trade_reason_summary',
  'paper_trading_trade',
  '443',
  'BUY rebalance trade was labeled as SELL because the legacy formatter inferred direction from source',
  jsonb_build_object(
    'portfolio', jsonb_build_object('id', target.portfolio_id),
    'trade', to_jsonb(target)
  ),
  'codex_portfolio_ledger_audit_2026_07_21'
FROM target
ON CONFLICT (correction_key) DO NOTHING;

UPDATE paper_trading_trades
   SET trade_reason_summary = '买入: 再平衡 | 组合再平衡',
       updated_at = NOW()
 WHERE id = 443
   AND portfolio_id = 65
   AND symbol = 'sh.510880'
   AND direction::text = 'BUY'
   AND trade_reason->>'source' = 'rebalance'
   AND trade_reason_summary LIKE '卖出:%';

UPDATE paper_trading_data_corrections correction
   SET after_state = jsonb_build_object(
         'portfolio', jsonb_build_object('id', trade.portfolio_id),
         'trade', to_jsonb(trade)
       ),
       updated_at = NOW()
  FROM paper_trading_trades trade
 WHERE correction.correction_key = 'paper_trade_443_rebalance_summary_direction'
   AND trade.id = 443
   AND correction.after_state IS DISTINCT FROM jsonb_build_object(
         'portfolio', jsonb_build_object('id', trade.portfolio_id),
         'trade', to_jsonb(trade)
       );

COMMIT;
