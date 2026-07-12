-- Ownership-safe RecommendationList v0.3.1 rollback.

BEGIN;

DO $ownership$
DECLARE
  expected_marker CONSTANT TEXT :=
    'migration:2026-07-12-ai-recommendation-sot-v031';
  owned_tables CONSTANT TEXT[] := ARRAY[
    'ai_recommendation_snapshot',
    'ai_recommendation_item'
  ];
  existing_count INTEGER;
  matching_count INTEGER;
BEGIN
  SELECT COUNT(*),
         COUNT(*) FILTER (
           WHERE obj_description(c.oid, 'pg_class') = expected_marker
         )
    INTO existing_count, matching_count
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = current_schema()
    AND c.relkind = 'r'
    AND c.relname = ANY(owned_tables);

  IF existing_count <> cardinality(owned_tables)
     OR matching_count <> cardinality(owned_tables) THEN
    RAISE EXCEPTION
      'Recommendation SOT rollback ownership mismatch: existing=%, matching=%, expected=%',
      existing_count, matching_count, cardinality(owned_tables);
  END IF;
END;
$ownership$;

DROP TABLE ai_recommendation_item;
DROP TABLE ai_recommendation_snapshot;

COMMIT;
