BEGIN;

UPDATE risk_alerts
   SET metadata = metadata - 'portfolio_id' - 'portfolio_linkage',
       updated_at = NOW()
 WHERE metadata->>'portfolio_linkage' = 'legacy_backfill_2026_07_21';

UPDATE feishu_notification_outbox
   SET metadata = metadata - 'portfolio_id' - 'portfolio_linkage',
       updated_at = NOW()
 WHERE metadata->>'portfolio_linkage' = 'legacy_backfill_2026_07_21';

COMMIT;
