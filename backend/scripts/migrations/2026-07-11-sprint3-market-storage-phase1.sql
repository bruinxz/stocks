-- Sprint 3 Phase 1: physical storage for JP/KR, multibagger and PIT data.
-- This migration is schema-only. It performs no provider or production data writes.
-- New canonical objects intentionally fail closed on any name collision. This
-- prevents a partial pre-existing schema from being mistaken for a valid deploy.

BEGIN;

CREATE TABLE jpkr_security_master (
  security_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market_scope TEXT NOT NULL CHECK (market_scope IN ('jp', 'kr')),
  provider_market_label TEXT,
  exchange TEXT NOT NULL CHECK (exchange IN ('tse', 'ose', 'krx', 'kosdaq')),
  ticker TEXT NOT NULL,
  ticker_name_local TEXT NOT NULL,
  ticker_name_en TEXT,
  currency TEXT NOT NULL CHECK (currency IN ('JPY', 'KRW')),
  listing_day DATE,
  delisting_day DATE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  source_kind TEXT NOT NULL,
  source_document_id TEXT NOT NULL,
  source_version TEXT NOT NULL,
  available_at_utc TIMESTAMPTZ NOT NULL,
  fact_hash TEXT NOT NULL CHECK (fact_hash ~ '^[0-9a-f]{64}$'),
  source_payload JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(source_payload) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ck_jpkr_security_market_exchange CHECK (
    (market_scope = 'jp' AND exchange IN ('tse', 'ose'))
    OR (market_scope = 'kr' AND exchange IN ('krx', 'kosdaq'))
  ),
  CONSTRAINT ck_jpkr_security_market_currency CHECK (
    (market_scope = 'jp' AND currency = 'JPY')
    OR (market_scope = 'kr' AND currency = 'KRW')
  ),
  CONSTRAINT ck_jpkr_security_lifecycle CHECK (
    delisting_day IS NULL OR listing_day IS NULL OR delisting_day >= listing_day
  ),
  CONSTRAINT uq_jpkr_security_source_version
    UNIQUE (source_kind, source_document_id, source_version, ticker)
);

CREATE INDEX ix_jpkr_security_lookup
  ON jpkr_security_master (market_scope, exchange, ticker, available_at_utc DESC);
CREATE INDEX ix_jpkr_security_active
  ON jpkr_security_master (market_scope, is_active, ticker);

CREATE TABLE jpkr_daily_kline (
  jpkr_daily_kline_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market_scope TEXT NOT NULL CHECK (market_scope IN ('jp', 'kr')),
  provider_market_label TEXT,
  exchange TEXT NOT NULL CHECK (exchange IN ('tse', 'ose', 'krx', 'kosdaq')),
  ticker TEXT NOT NULL,
  ticker_name_local TEXT NOT NULL,
  ticker_name_en TEXT,
  trading_day DATE NOT NULL,
  open NUMERIC(18, 4) NOT NULL CHECK (open >= 0),
  high NUMERIC(18, 4) NOT NULL CHECK (high >= 0),
  low NUMERIC(18, 4) NOT NULL CHECK (low >= 0),
  close NUMERIC(18, 4) NOT NULL CHECK (close >= 0),
  adjusted_close NUMERIC(18, 4) CHECK (adjusted_close IS NULL OR adjusted_close >= 0),
  corporate_action_version TEXT,
  volume BIGINT NOT NULL CHECK (volume >= 0),
  turnover NUMERIC(24, 4) CHECK (turnover IS NULL OR turnover >= 0),
  currency TEXT NOT NULL CHECK (currency IN ('JPY', 'KRW')),
  dividend_amount NUMERIC(18, 4)
    CHECK (dividend_amount IS NULL OR dividend_amount >= 0),
  split_ratio NUMERIC(10, 4) CHECK (split_ratio IS NULL OR split_ratio > 0),
  market_cap_local NUMERIC(28, 4)
    CHECK (market_cap_local IS NULL OR market_cap_local >= 0),
  turnover_rate NUMERIC(12, 8)
    CHECK (turnover_rate IS NULL OR turnover_rate >= 0),
  is_halted BOOLEAN NOT NULL DEFAULT FALSE,
  halt_reason_code TEXT,
  source_kind TEXT NOT NULL,
  source_document_id TEXT NOT NULL,
  source_version TEXT NOT NULL,
  effective_at_utc TIMESTAMPTZ NOT NULL,
  available_at_utc TIMESTAMPTZ NOT NULL,
  fact_hash TEXT NOT NULL CHECK (fact_hash ~ '^[0-9a-f]{64}$'),
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ck_jpkr_kline_market_exchange CHECK (
    (market_scope = 'jp' AND exchange IN ('tse', 'ose'))
    OR (market_scope = 'kr' AND exchange IN ('krx', 'kosdaq'))
  ),
  CONSTRAINT ck_jpkr_kline_market_currency CHECK (
    (market_scope = 'jp' AND currency = 'JPY')
    OR (market_scope = 'kr' AND currency = 'KRW')
  ),
  CONSTRAINT ck_jpkr_kline_ohlc CHECK (
    high >= low AND high >= open AND high >= close AND low <= open AND low <= close
  ),
  CONSTRAINT ck_jpkr_kline_adjustment_version CHECK (
    adjusted_close IS NULL OR corporate_action_version IS NOT NULL
  ),
  CONSTRAINT uq_jpkr_kline_identity
    UNIQUE (exchange, ticker, trading_day, source_kind, source_version)
);

CREATE INDEX ix_jpkr_kline_exchange_day
  ON jpkr_daily_kline (exchange, trading_day DESC);
CREATE INDEX ix_jpkr_kline_ticker_day
  ON jpkr_daily_kline (market_scope, ticker, trading_day DESC, ingested_at DESC);
CREATE INDEX ix_jpkr_kline_pit
  ON jpkr_daily_kline (available_at_utc, effective_at_utc);

CREATE TABLE jpkr_disclosure_event (
  jpkr_disclosure_event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market_scope TEXT NOT NULL CHECK (market_scope IN ('jp', 'kr')),
  provider_market_label TEXT,
  ticker TEXT NOT NULL,
  disclosure_kind TEXT NOT NULL,
  event_headline_local TEXT NOT NULL,
  event_body_url TEXT,
  event_time_utc TIMESTAMPTZ NOT NULL,
  available_at_utc TIMESTAMPTZ NOT NULL,
  source_kind TEXT NOT NULL,
  source_document_id TEXT NOT NULL,
  source_version TEXT NOT NULL,
  fact_hash TEXT NOT NULL CHECK (fact_hash ~ '^[0-9a-f]{64}$'),
  source_payload JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(source_payload) = 'object'),
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_jpkr_disclosure_source_version
    UNIQUE (source_kind, source_document_id, source_version)
);

CREATE INDEX ix_jpkr_disclosure_ticker_time
  ON jpkr_disclosure_event (market_scope, ticker, event_time_utc DESC);
CREATE INDEX ix_jpkr_disclosure_pit
  ON jpkr_disclosure_event (available_at_utc, market_scope, ticker);

CREATE TABLE jpkr_financial_snapshot (
  jpkr_financial_snapshot_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market_scope TEXT NOT NULL CHECK (market_scope IN ('jp', 'kr')),
  provider_market_label TEXT,
  ticker TEXT NOT NULL,
  fiscal_period_start DATE,
  fiscal_period_end DATE NOT NULL,
  fiscal_period_kind TEXT NOT NULL
    CHECK (fiscal_period_kind IN ('Q1', 'Q3', 'SEMIANNUAL', 'ANNUAL')),
  fiscal_year INTEGER GENERATED ALWAYS AS
    (EXTRACT(YEAR FROM fiscal_period_end)::INTEGER) STORED,
  fiscal_quarter INTEGER CHECK (fiscal_quarter IS NULL OR fiscal_quarter BETWEEN 1 AND 4),
  currency TEXT NOT NULL,
  is_consolidated BOOLEAN,
  revenue NUMERIC(28, 4),
  eps NUMERIC(28, 8),
  net_income NUMERIC(28, 4),
  total_assets NUMERIC(28, 4),
  total_equity NUMERIC(28, 4),
  total_liabilities NUMERIC(28, 4),
  operating_cash_flow NUMERIC(28, 4),
  research_and_development NUMERIC(28, 4),
  segment_facts JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(segment_facts) = 'array'),
  taxonomy_version TEXT,
  parser_version TEXT NOT NULL,
  account_mapping_version TEXT,
  concept_provenance JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(concept_provenance) = 'object'),
  parse_warnings JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(parse_warnings) = 'array'),
  source_payload JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(source_payload) = 'object'),
  dim_quality JSONB,
  dim_growth JSONB,
  dim_valuation JSONB,
  dim_moat JSONB,
  dim_trend JSONB,
  dim_risk JSONB,
  coverage_pct NUMERIC(5, 2)
    CHECK (coverage_pct IS NULL OR coverage_pct BETWEEN 0 AND 100),
  derivation_version TEXT,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('jpx-edinet', 'dart')),
  source_document_id TEXT NOT NULL,
  source_version TEXT NOT NULL,
  effective_at_utc TIMESTAMPTZ NOT NULL,
  available_at_utc TIMESTAMPTZ NOT NULL,
  fact_hash TEXT NOT NULL CHECK (fact_hash ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ck_jpkr_financial_period CHECK (
    fiscal_period_start IS NULL OR fiscal_period_start <= fiscal_period_end
  ),
  CONSTRAINT ck_jpkr_financial_market_currency CHECK (
    (market_scope = 'jp' AND currency = 'JPY')
    OR (market_scope = 'kr' AND currency = 'KRW')
  ),
  CONSTRAINT ck_jpkr_financial_period_quarter CHECK (
    (fiscal_period_kind = 'Q1' AND fiscal_quarter = 1)
    OR (fiscal_period_kind = 'Q3' AND fiscal_quarter = 3)
    OR (fiscal_period_kind IN ('SEMIANNUAL', 'ANNUAL') AND fiscal_quarter IS NULL)
  ),
  CONSTRAINT ck_jpkr_financial_source_lineage CHECK (
    (source_kind = 'jpx-edinet'
      AND market_scope = 'jp'
      AND taxonomy_version IS NOT NULL
      AND account_mapping_version IS NULL)
    OR
    (source_kind = 'dart'
      AND market_scope = 'kr'
      AND account_mapping_version IS NOT NULL)
  ),
  CONSTRAINT ck_jpkr_financial_derivation_version CHECK (
    (
      dim_quality IS NULL
      AND dim_growth IS NULL
      AND dim_valuation IS NULL
      AND dim_moat IS NULL
      AND dim_trend IS NULL
      AND dim_risk IS NULL
    )
    OR derivation_version IS NOT NULL
  ),
  CONSTRAINT uq_jpkr_financial_source_version
    UNIQUE (market_scope, ticker, source_document_id, source_version)
);

CREATE INDEX ix_jpkr_financial_ticker_period
  ON jpkr_financial_snapshot
    (market_scope, ticker, fiscal_period_end DESC, available_at_utc DESC);
CREATE INDEX ix_jpkr_financial_pit
  ON jpkr_financial_snapshot
    (market_scope, ticker, available_at_utc DESC, source_version DESC);

CREATE TABLE jpkr_fx_observation (
  jpkr_fx_observation_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pair TEXT NOT NULL CHECK (pair IN ('USDJPY', 'USDKRW')),
  direction TEXT NOT NULL
    CHECK (direction = 'LOCAL_PER_USD_WITH_RECIPROCAL'),
  observation_day DATE NOT NULL,
  available_at_utc TIMESTAMPTZ NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('BOJ', 'BOK')),
  source_document_id TEXT NOT NULL,
  source_version TEXT NOT NULL,
  local_per_usd NUMERIC(24, 10) NOT NULL CHECK (local_per_usd > 0),
  usd_per_local NUMERIC(24, 14) NOT NULL CHECK (usd_per_local > 0),
  change_pct NUMERIC(18, 8),
  previous_observation_day DATE,
  previous_source_kind TEXT CHECK (
    previous_source_kind IS NULL OR previous_source_kind IN ('BOJ', 'BOK')
  ),
  previous_source_version TEXT,
  previous_fact_hash TEXT CHECK (
    previous_fact_hash IS NULL OR previous_fact_hash ~ '^[0-9a-f]{64}$'
  ),
  fact_hash TEXT NOT NULL CHECK (fact_hash ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ck_jpkr_fx_pair_source CHECK (
    (pair = 'USDJPY' AND source_kind = 'BOJ')
    OR (pair = 'USDKRW' AND source_kind = 'BOK')
  ),
  CONSTRAINT ck_jpkr_fx_reciprocal CHECK (
    ABS((local_per_usd * usd_per_local) - 1) <= 0.00000001
  ),
  CONSTRAINT ck_jpkr_fx_change_lineage CHECK (
    (change_pct IS NULL
      AND previous_observation_day IS NULL
      AND previous_source_kind IS NULL
      AND previous_source_version IS NULL
      AND previous_fact_hash IS NULL)
    OR
    (change_pct IS NOT NULL
      AND previous_observation_day IS NOT NULL
      AND previous_observation_day < observation_day
      AND previous_source_kind = source_kind
      AND previous_source_version IS NOT NULL
      AND previous_fact_hash IS NOT NULL)
  ),
  CONSTRAINT uq_jpkr_fx_identity
    UNIQUE (pair, direction, observation_day, source_kind, source_version)
);

CREATE INDEX ix_jpkr_fx_pair_day
  ON jpkr_fx_observation (pair, observation_day DESC, available_at_utc DESC);
CREATE INDEX ix_jpkr_fx_pit
  ON jpkr_fx_observation (available_at_utc, pair);

CREATE TABLE multibagger_universe (
  multibagger_universe_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market_scope TEXT NOT NULL CHECK (market_scope IN ('cn_a', 'us', 'jp', 'kr')),
  provider_market_label TEXT,
  exchange TEXT NOT NULL,
  ticker TEXT NOT NULL,
  record_kind TEXT NOT NULL CHECK (
    record_kind IN ('NEW_LISTING', 'LIFECYCLE', 'DAILY', 'FRENCH_AGGREGATE', 'TEXT_HIT')
  ),
  universe_source_kind TEXT NOT NULL,
  source_document_id TEXT NOT NULL,
  source_version TEXT NOT NULL,
  effective_at_utc TIMESTAMPTZ NOT NULL,
  available_at_utc TIMESTAMPTZ NOT NULL,
  as_of_utc TIMESTAMPTZ NOT NULL,
  features JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(features) = 'object'),
  evidence_refs JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(evidence_refs) = 'array'),
  text_hit_kinds JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(text_hit_kinds) = 'array'),
  fundamental_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(fundamental_snapshot) = 'object'),
  filter_pass_bitmap INTEGER NOT NULL DEFAULT 0 CHECK (filter_pass_bitmap >= 0),
  market_cap_cny_100m NUMERIC(18, 4),
  fact_hash TEXT NOT NULL CHECK (fact_hash ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ck_multibagger_aggregate_identity CHECK (
    (record_kind = 'FRENCH_AGGREGATE'
      AND exchange = 'ACADEMIC_REFERENCE'
      AND ticker LIKE '__AGGREGATE__:%')
    OR
    (record_kind <> 'FRENCH_AGGREGATE'
      AND exchange <> 'ACADEMIC_REFERENCE'
      AND ticker NOT LIKE '__AGGREGATE__:%')
  ),
  CONSTRAINT ck_multibagger_market_exchange CHECK (
    (record_kind = 'FRENCH_AGGREGATE'
      AND market_scope = 'us'
      AND exchange = 'ACADEMIC_REFERENCE')
    OR (record_kind <> 'FRENCH_AGGREGATE' AND (
      (market_scope = 'cn_a' AND exchange IN ('sh', 'sz', 'bj'))
      OR (market_scope = 'us' AND exchange IN ('nyse', 'nasdaq'))
      OR (market_scope = 'jp' AND exchange IN ('tse', 'ose'))
      OR (market_scope = 'kr' AND exchange IN ('krx', 'kosdaq'))
    ))
  ),
  CONSTRAINT ck_multibagger_source_fact_only CHECK (
    NOT (
      features ?| ARRAY[
        'score', 'rating', 'rating_band', 'conviction', 'risk_gate',
        'entry_plan', 'stage', 'conclusion'
      ]
    )
    AND NOT (
      fundamental_snapshot ?| ARRAY[
        'score', 'rating', 'rating_band', 'conviction', 'risk_gate',
        'entry_plan', 'stage', 'conclusion'
      ]
    )
  ),
  CONSTRAINT ck_multibagger_pit CHECK (available_at_utc <= as_of_utc),
  CONSTRAINT uq_multibagger_source_fact UNIQUE (
    universe_source_kind,
    record_kind,
    ticker,
    source_document_id,
    source_version,
    fact_hash
  )
);

CREATE INDEX ix_multibagger_as_of
  ON multibagger_universe (as_of_utc DESC, market_scope);
CREATE INDEX ix_multibagger_ticker
  ON multibagger_universe (market_scope, ticker, available_at_utc DESC);
CREATE INDEX ix_multibagger_source_kind
  ON multibagger_universe (universe_source_kind, record_kind, as_of_utc DESC);

CREATE TABLE multibagger_text_hit (
  multibagger_text_hit_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market_scope TEXT NOT NULL CHECK (market_scope IN ('cn_a', 'us', 'jp', 'kr')),
  ticker TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source_document_id TEXT NOT NULL,
  document_fact_hash TEXT NOT NULL CHECK (document_fact_hash ~ '^[0-9a-f]{64}$'),
  taxonomy_version TEXT NOT NULL,
  term_id TEXT NOT NULL,
  hit_kind TEXT NOT NULL CHECK (
    hit_kind IN ('OPTIONALITY', 'POSITIVE', 'NEGATIVE', 'EARLY_NEWS')
  ),
  language TEXT NOT NULL CHECK (language IN ('en', 'zh', 'ja', 'ko')),
  field TEXT NOT NULL CHECK (field IN ('TITLE', 'BODY')),
  start_offset INTEGER NOT NULL CHECK (start_offset >= 0),
  end_offset INTEGER NOT NULL CHECK (end_offset > start_offset),
  context_hash TEXT NOT NULL CHECK (context_hash ~ '^[0-9a-f]{64}$'),
  effective_at_utc TIMESTAMPTZ NOT NULL,
  available_at_utc TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_multibagger_text_hit_identity UNIQUE (
    document_fact_hash,
    taxonomy_version,
    term_id,
    field,
    start_offset,
    end_offset
  )
);

CREATE INDEX ix_multibagger_text_hit_ticker
  ON multibagger_text_hit (market_scope, ticker, available_at_utc DESC);
CREATE INDEX ix_multibagger_text_hit_source
  ON multibagger_text_hit (source_kind, source_document_id, available_at_utc DESC);

CREATE TABLE multibagger_candidate_snapshot (
  multibagger_candidate_snapshot_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market_scope TEXT NOT NULL CHECK (market_scope IN ('cn_a', 'us', 'jp', 'kr')),
  exchange TEXT NOT NULL,
  ticker TEXT NOT NULL CHECK (ticker NOT LIKE '__AGGREGATE__:%'),
  as_of_utc TIMESTAMPTZ NOT NULL,
  available_at_utc TIMESTAMPTZ NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN ('seed', 'early', 'growth', 'break_below', 'deep')),
  conclusion TEXT NOT NULL CHECK (
    conclusion IN ('MULTIBAGGER_2X', 'MULTIBAGGER_5X', 'MULTIBAGGER_10X', 'SKIP')
  ),
  score JSONB CHECK (score IS NULL OR jsonb_typeof(score) = 'object'),
  rating TEXT CHECK (rating IS NULL OR rating IN ('A', 'B', 'C', 'D', 'F')),
  conviction JSONB CHECK (conviction IS NULL OR jsonb_typeof(conviction) = 'object'),
  risk_gate JSONB CHECK (risk_gate IS NULL OR jsonb_typeof(risk_gate) = 'object'),
  entry_plan JSONB CHECK (entry_plan IS NULL OR jsonb_typeof(entry_plan) = 'object'),
  latest_catalyst JSONB,
  source_fact_hashes JSONB NOT NULL CHECK (
    CASE jsonb_typeof(source_fact_hashes)
      WHEN 'array' THEN
        jsonb_array_length(source_fact_hashes) > 0
        AND COALESCE(
          NOT jsonb_path_exists(
            source_fact_hashes,
            'strict $[*] ? (@.type() != "string" || !(@ like_regex "^[0-9a-f]{64}$"))',
            '{}'::jsonb,
            TRUE
          ),
          FALSE
        )
      ELSE FALSE
    END
  ),
  strategy_version TEXT NOT NULL,
  fact_hash TEXT NOT NULL CHECK (fact_hash ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ck_multibagger_candidate_pit CHECK (available_at_utc <= as_of_utc),
  CONSTRAINT ck_multibagger_candidate_market_exchange CHECK (
    (market_scope = 'cn_a' AND exchange IN ('sh', 'sz', 'bj'))
    OR (market_scope = 'us' AND exchange IN ('nyse', 'nasdaq'))
    OR (market_scope = 'jp' AND exchange IN ('tse', 'ose'))
    OR (market_scope = 'kr' AND exchange IN ('krx', 'kosdaq'))
  ),
  CONSTRAINT ck_multibagger_candidate_rating CHECK (
    CASE
      WHEN score IS NULL THEN rating IS NULL
      WHEN jsonb_typeof(score) <> 'object' THEN FALSE
      ELSE COALESCE(
        rating IN ('A', 'B', 'C', 'D', 'F')
        AND jsonb_typeof(score->'rating') = 'string'
        AND score->>'rating' = rating
        AND NOT (score ? 'band'),
        FALSE
      )
    END
  ),
  CONSTRAINT uq_multibagger_candidate_snapshot
    UNIQUE (market_scope, exchange, ticker, as_of_utc, strategy_version)
);

CREATE INDEX ix_multibagger_candidate_as_of
  ON multibagger_candidate_snapshot (as_of_utc DESC, market_scope);
CREATE INDEX ix_multibagger_candidate_filters
  ON multibagger_candidate_snapshot (stage, conclusion, market_scope, as_of_utc DESC);

CREATE TABLE backtest_pit_snapshot (
  snapshot_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  strategy TEXT NOT NULL CHECK (strategy IN (
    'us_preferred',
    'multibagger',
    'custom',
    'japan_blue_chip',
    'japan_multibagger',
    'korea_semiconductor_chain',
    'korea_multibagger'
  )),
  market_scope TEXT NOT NULL CHECK (market_scope IN ('cn_a', 'us', 'jp', 'kr')),
  as_of_utc TIMESTAMPTZ NOT NULL,
  snapshot_day DATE NOT NULL,
  published_at_utc TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_survivorship_biased BOOLEAN NOT NULL,
  is_delisted_at_as_of BOOLEAN NOT NULL DEFAULT FALSE,
  source_versions JSONB NOT NULL CHECK (
    CASE jsonb_typeof(source_versions)
      WHEN 'object' THEN
        source_versions <> '{}'::jsonb
        AND COALESCE(
          NOT jsonb_path_exists(
            source_versions,
            'strict $.* ? (@.type() != "string" || @ == "")',
            '{}'::jsonb,
            TRUE
          ),
          FALSE
        )
      ELSE FALSE
    END
  ),
  lineage_closure JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(lineage_closure) = 'object'),
  metrics JSONB NOT NULL CHECK (jsonb_typeof(metrics) = 'object'),
  fact_hash TEXT NOT NULL CHECK (fact_hash ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ck_backtest_pit_publication CHECK (published_at_utc >= as_of_utc),
  CONSTRAINT ck_backtest_pit_profile_scope CHECK (
    (strategy IN ('us_preferred', 'multibagger', 'custom')
      AND market_scope IN ('cn_a', 'us'))
    OR (strategy IN ('japan_blue_chip', 'japan_multibagger')
      AND market_scope = 'jp')
    OR (strategy IN ('korea_semiconductor_chain', 'korea_multibagger')
      AND market_scope = 'kr')
  ),
  CONSTRAINT ck_backtest_pit_survivorship_evidence CHECK (
    is_survivorship_biased
    OR COALESCE(
      jsonb_typeof(lineage_closure->'survivorship_evidence') = 'object'
      AND lineage_closure->'survivorship_evidence' <> '{}'::jsonb,
      FALSE
    )
  ),
  CONSTRAINT uq_backtest_pit_exact_as_of UNIQUE (strategy, market_scope, as_of_utc),
  CONSTRAINT uq_backtest_pit_snapshot_as_of
    UNIQUE (snapshot_id, market_scope, as_of_utc)
);

CREATE INDEX ix_pit_strategy_as_of
  ON backtest_pit_snapshot (strategy, market_scope, as_of_utc DESC);
CREATE INDEX ix_pit_snapshot_day
  ON backtest_pit_snapshot (strategy, market_scope, snapshot_day DESC);

CREATE TABLE backtest_pit_holding (
  backtest_pit_holding_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id UUID NOT NULL,
  snapshot_as_of_utc TIMESTAMPTZ NOT NULL,
  position_order INTEGER NOT NULL CHECK (position_order >= 0),
  market_scope TEXT NOT NULL CHECK (market_scope IN ('cn_a', 'us', 'jp', 'kr')),
  ticker TEXT NOT NULL CHECK (ticker NOT LIKE '__AGGREGATE__:%'),
  weight NUMERIC(18, 10) NOT NULL CHECK (weight >= 0 AND weight <= 1),
  return_since_entry NUMERIC(24, 10) NOT NULL,
  is_stale BOOLEAN NOT NULL DEFAULT FALSE,
  source_kind TEXT NOT NULL,
  source_document_id TEXT NOT NULL,
  source_version TEXT NOT NULL,
  available_at_utc TIMESTAMPTZ NOT NULL,
  lineage JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(lineage) = 'object'),
  fact_hash TEXT NOT NULL CHECK (fact_hash ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_backtest_pit_holding_snapshot_as_of
    FOREIGN KEY (snapshot_id, market_scope, snapshot_as_of_utc)
    REFERENCES backtest_pit_snapshot(snapshot_id, market_scope, as_of_utc)
    ON DELETE CASCADE,
  CONSTRAINT ck_backtest_pit_holding_availability CHECK (
    available_at_utc <= snapshot_as_of_utc
  ),
  CONSTRAINT uq_backtest_pit_holding_order UNIQUE (snapshot_id, position_order),
  CONSTRAINT uq_backtest_pit_holding_ticker UNIQUE (snapshot_id, market_scope, ticker)
);

CREATE INDEX ix_pit_holding_snapshot
  ON backtest_pit_holding (snapshot_id, position_order);
CREATE INDEX ix_pit_holding_ticker
  ON backtest_pit_holding (market_scope, ticker, available_at_utc DESC);

COMMIT;
