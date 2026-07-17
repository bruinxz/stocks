-- Remove redundant realtime snapshots and make the model's natural key physical.
-- The table lock prevents a quote writer from racing between DELETE and CREATE INDEX.

BEGIN;

LOCK TABLE realtime_quotes IN SHARE ROW EXCLUSIVE MODE;

WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY symbol, quote_time
           ORDER BY updated_at DESC NULLS LAST, id DESC
         ) AS duplicate_rank
    FROM realtime_quotes
)
DELETE FROM realtime_quotes quote
 USING ranked
 WHERE quote.id = ranked.id
   AND ranked.duplicate_rank > 1;

DROP INDEX IF EXISTS uniq_realtime_quote_symbol_time;
CREATE UNIQUE INDEX uniq_realtime_quote_symbol_time
  ON realtime_quotes (symbol, quote_time);

COMMENT ON INDEX uniq_realtime_quote_symbol_time IS
  'migration:2026-07-17-realtime-quote-dedup';

COMMIT;
