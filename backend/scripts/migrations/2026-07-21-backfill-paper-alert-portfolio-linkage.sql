-- Backfill portfolio linkage for legacy paper-trading alerts and notifications.
-- New producers write metadata.portfolio_id directly; this migration only fills
-- rows where the owner can be derived without guessing.

BEGIN;

WITH resolved AS (
  SELECT alert.id,
         COALESCE(
           CASE
             WHEN alert.metadata->>'portfolio_id' ~ '^[0-9]+$'
               THEN (alert.metadata->>'portfolio_id')::integer
           END,
           CASE
             WHEN alert.metadata->'draft'->>'portfolio_id' ~ '^[0-9]+$'
               THEN (alert.metadata->'draft'->>'portfolio_id')::integer
           END,
           outcome.portfolio_id,
           symbol_portfolio.portfolio_id,
           single_portfolio.portfolio_id
         ) AS portfolio_id
    FROM risk_alerts alert
    LEFT JOIN recommendation_trade_outcomes outcome
      ON outcome.id = CASE
        WHEN alert.metadata->>'outcome_id' ~ '^[0-9]+$'
          THEN (alert.metadata->>'outcome_id')::integer
      END
    LEFT JOIN LATERAL (
      SELECT MIN(position.portfolio_id) AS portfolio_id
        FROM paper_trading_positions position
        JOIN paper_trading_portfolios portfolio ON portfolio.id = position.portfolio_id
       WHERE portfolio.user_id = alert.user_id
         AND portfolio.is_active = TRUE
         AND position.quantity > 0
         AND position.symbol = alert.symbol
      HAVING COUNT(DISTINCT position.portfolio_id) = 1
    ) symbol_portfolio ON TRUE
    LEFT JOIN LATERAL (
      SELECT MIN(portfolio.id) AS portfolio_id
        FROM paper_trading_portfolios portfolio
       WHERE portfolio.user_id = alert.user_id
         AND portfolio.is_active = TRUE
      HAVING COUNT(*) = 1
    ) single_portfolio ON TRUE
)
UPDATE risk_alerts alert
   SET metadata = jsonb_set(
     jsonb_set(COALESCE(alert.metadata, '{}'::jsonb), '{portfolio_id}', to_jsonb(resolved.portfolio_id), TRUE),
     '{portfolio_linkage}',
     '"legacy_backfill_2026_07_21"'::jsonb,
     TRUE
   ),
       updated_at = NOW()
  FROM resolved
 WHERE alert.id = resolved.id
   AND resolved.portfolio_id IS NOT NULL
   AND NOT (COALESCE(alert.metadata, '{}'::jsonb) ? 'portfolio_id');

WITH resolved AS (
  SELECT outbox.id,
         COALESCE(
           CASE
             WHEN outbox.metadata->>'portfolio_id' ~ '^[0-9]+$'
               THEN (outbox.metadata->>'portfolio_id')::integer
           END,
           CASE
             WHEN outbox.topic_key ~ '^paper-(trade|portfolio):[0-9]+$'
               THEN regexp_replace(outbox.topic_key, '^paper-(trade|portfolio):', '')::integer
           END,
           outcome.portfolio_id
         ) AS portfolio_id
    FROM feishu_notification_outbox outbox
    LEFT JOIN recommendation_trade_outcomes outcome
      ON outcome.id = CASE
        WHEN outbox.metadata->>'outcome_id' ~ '^[0-9]+$'
          THEN (outbox.metadata->>'outcome_id')::integer
      END
)
UPDATE feishu_notification_outbox outbox
   SET metadata = jsonb_set(
     jsonb_set(COALESCE(outbox.metadata, '{}'::jsonb), '{portfolio_id}', to_jsonb(resolved.portfolio_id), TRUE),
     '{portfolio_linkage}',
     '"legacy_backfill_2026_07_21"'::jsonb,
     TRUE
   ),
       updated_at = NOW()
  FROM resolved
 WHERE outbox.id = resolved.id
   AND resolved.portfolio_id IS NOT NULL
   AND NOT (COALESCE(outbox.metadata, '{}'::jsonb) ? 'portfolio_id');

COMMIT;
