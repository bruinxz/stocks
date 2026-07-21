BEGIN;

UPDATE paper_trading_trades
   SET trade_reason_summary = '卖出: 再平衡 | 组合再平衡',
       updated_at = NOW()
 WHERE id = 443
   AND trade_reason_summary = '买入: 再平衡 | 组合再平衡';

DELETE FROM paper_trading_data_corrections
 WHERE correction_key = 'paper_trade_443_rebalance_summary_direction';

UPDATE feishu_notification_outbox
   SET metadata = metadata - 'ledger_scope' - 'ledger_scope_migrated_by',
       updated_at = NOW()
 WHERE metadata->>'ledger_scope_migrated_by' = 'portfolio-ledger-explicit-scope-2026-07-21';

UPDATE feishu_notification_outbox
   SET metadata = metadata - 'invalidated' - 'invalidated_by_idempotency_key',
       updated_at = NOW()
 WHERE idempotency_key = 'paper-trade:447:executed';

UPDATE feishu_notification_outbox
   SET metadata = metadata - 'corrects_idempotency_key',
       updated_at = NOW()
 WHERE idempotency_key = 'paper-trade:447:correction';

UPDATE feishu_notification_outbox
   SET metadata = metadata - 'ledger_scope' - 'corrected' - 'invalidated'
                           - 'invalidated_by_idempotency_key',
       updated_at = NOW()
 WHERE idempotency_key = 'morning-risk-checkup:4:2026-07-21';

UPDATE feishu_notification_outbox
   SET metadata = metadata - 'ledger_scope' - 'corrects_idempotency_key',
       updated_at = NOW()
 WHERE idempotency_key = 'morning-risk-checkup:4:2026-07-21:correction';

COMMIT;
