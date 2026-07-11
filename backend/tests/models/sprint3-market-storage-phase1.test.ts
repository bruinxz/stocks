/**
 * Sprint 3 market storage Phase 1 schema/model parity guard.
 *
 * DB-less and network-free:
 *   cd backend
 *   npx ts-node --transpile-only tests/models/sprint3-market-storage-phase1.test.ts
 *
 * Isolated PostgreSQL forward/down and constraint behavior are exercised by
 * the task handoff command; this test protects source-level parity in CI.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '../..');
const upPath = join(ROOT, 'scripts/migrations/2026-07-11-sprint3-market-storage-phase1.sql');
const downPath = join(
  ROOT,
  'scripts/migrations/2026-07-11-sprint3-market-storage-phase1-rollback.sql',
);
const ormPath = join(ROOT, 'tests/models/sprint3-market-storage-phase1.orm.test.ts');
const databasePath = join(ROOT, 'src/config/database.ts');
const indexPath = join(ROOT, 'src/models/index.ts');

const up = readFileSync(upPath, 'utf8');
const down = readFileSync(downPath, 'utf8');
const database = readFileSync(databasePath, 'utf8');
const index = readFileSync(indexPath, 'utf8');

const tables = [
  ['jpkr_security_master', 'JpkrSecurityMaster'],
  ['jpkr_daily_kline', 'JpkrDailyKline'],
  ['jpkr_disclosure_event', 'JpkrDisclosureEvent'],
  ['jpkr_financial_snapshot', 'JpkrFinancialSnapshot'],
  ['jpkr_fx_observation', 'JpkrFxObservation'],
  ['multibagger_universe', 'MultibaggerUniverse'],
  ['multibagger_text_hit', 'MultibaggerTextHit'],
  ['multibagger_candidate_snapshot', 'MultibaggerCandidateSnapshot'],
  ['backtest_pit_snapshot', 'BacktestPitSnapshot'],
  ['backtest_pit_holding', 'BacktestPitHolding'],
] as const;

const expectedColumns: Record<(typeof tables)[number][0], string[]> = {
  jpkr_security_master: [
    'security_id',
    'market_scope',
    'provider_market_label',
    'exchange',
    'ticker',
    'ticker_name_local',
    'ticker_name_en',
    'currency',
    'listing_day',
    'delisting_day',
    'is_active',
    'source_kind',
    'source_document_id',
    'source_version',
    'available_at_utc',
    'fact_hash',
    'source_payload',
    'created_at',
    'updated_at',
  ],
  jpkr_daily_kline: [
    'jpkr_daily_kline_id',
    'market_scope',
    'provider_market_label',
    'exchange',
    'ticker',
    'ticker_name_local',
    'ticker_name_en',
    'trading_day',
    'open',
    'high',
    'low',
    'close',
    'adjusted_close',
    'corporate_action_version',
    'volume',
    'turnover',
    'currency',
    'dividend_amount',
    'split_ratio',
    'market_cap_local',
    'turnover_rate',
    'is_halted',
    'halt_reason_code',
    'source_kind',
    'source_document_id',
    'source_version',
    'effective_at_utc',
    'available_at_utc',
    'fact_hash',
    'ingested_at',
  ],
  jpkr_disclosure_event: [
    'jpkr_disclosure_event_id',
    'market_scope',
    'provider_market_label',
    'ticker',
    'disclosure_kind',
    'event_headline_local',
    'event_body_url',
    'event_time_utc',
    'available_at_utc',
    'source_kind',
    'source_document_id',
    'source_version',
    'fact_hash',
    'source_payload',
    'ingested_at',
  ],
  jpkr_financial_snapshot: [
    'jpkr_financial_snapshot_id',
    'market_scope',
    'provider_market_label',
    'ticker',
    'fiscal_period_start',
    'fiscal_period_end',
    'fiscal_period_kind',
    'fiscal_year',
    'fiscal_quarter',
    'currency',
    'is_consolidated',
    'revenue',
    'eps',
    'net_income',
    'total_assets',
    'total_equity',
    'total_liabilities',
    'operating_cash_flow',
    'research_and_development',
    'segment_facts',
    'taxonomy_version',
    'parser_version',
    'account_mapping_version',
    'concept_provenance',
    'parse_warnings',
    'source_payload',
    'dim_quality',
    'dim_growth',
    'dim_valuation',
    'dim_moat',
    'dim_trend',
    'dim_risk',
    'coverage_pct',
    'derivation_version',
    'source_kind',
    'source_document_id',
    'source_version',
    'effective_at_utc',
    'available_at_utc',
    'fact_hash',
    'created_at',
  ],
  jpkr_fx_observation: [
    'jpkr_fx_observation_id',
    'pair',
    'direction',
    'observation_day',
    'available_at_utc',
    'source_kind',
    'source_document_id',
    'source_version',
    'local_per_usd',
    'usd_per_local',
    'change_pct',
    'previous_observation_day',
    'previous_source_kind',
    'previous_source_version',
    'previous_fact_hash',
    'fact_hash',
    'created_at',
  ],
  multibagger_universe: [
    'multibagger_universe_id',
    'market_scope',
    'provider_market_label',
    'exchange',
    'ticker',
    'record_kind',
    'universe_source_kind',
    'source_document_id',
    'source_version',
    'effective_at_utc',
    'available_at_utc',
    'as_of_utc',
    'features',
    'evidence_refs',
    'text_hit_kinds',
    'fundamental_snapshot',
    'filter_pass_bitmap',
    'market_cap_cny_100m',
    'fact_hash',
    'created_at',
  ],
  multibagger_text_hit: [
    'multibagger_text_hit_id',
    'market_scope',
    'ticker',
    'source_kind',
    'source_document_id',
    'document_fact_hash',
    'taxonomy_version',
    'term_id',
    'hit_kind',
    'language',
    'field',
    'start_offset',
    'end_offset',
    'context_hash',
    'effective_at_utc',
    'available_at_utc',
    'created_at',
  ],
  multibagger_candidate_snapshot: [
    'multibagger_candidate_snapshot_id',
    'market_scope',
    'exchange',
    'ticker',
    'as_of_utc',
    'available_at_utc',
    'stage',
    'conclusion',
    'score',
    'rating',
    'conviction',
    'risk_gate',
    'entry_plan',
    'latest_catalyst',
    'source_fact_hashes',
    'strategy_version',
    'fact_hash',
    'created_at',
  ],
  backtest_pit_snapshot: [
    'snapshot_id',
    'strategy',
    'market_scope',
    'as_of_utc',
    'snapshot_day',
    'published_at_utc',
    'is_survivorship_biased',
    'is_delisted_at_as_of',
    'source_versions',
    'lineage_closure',
    'metrics',
    'fact_hash',
    'created_at',
  ],
  backtest_pit_holding: [
    'backtest_pit_holding_id',
    'snapshot_id',
    'snapshot_as_of_utc',
    'position_order',
    'market_scope',
    'ticker',
    'weight',
    'return_since_entry',
    'is_stale',
    'source_kind',
    'source_document_id',
    'source_version',
    'available_at_utc',
    'lineage',
    'fact_hash',
    'created_at',
  ],
};

let passed = 0;
let failed = 0;

function assert(name: string, condition: boolean): void {
  if (condition) passed += 1;
  else {
    failed += 1;
    console.error(`FAIL ${name}`);
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

assert('[files] forward exists', existsSync(upPath));
assert('[files] rollback exists', existsSync(downPath));
assert('[files] real ORM proof exists', existsSync(ormPath));
assert('[migration] forward transaction', /\bBEGIN;[\s\S]*\bCOMMIT;/.test(up));
assert('[migration] rollback transaction', /\bBEGIN;[\s\S]*\bCOMMIT;/.test(down));
assert(
  '[migration] ownership marker and rollback fingerprint',
  /migration:2026-07-11-sprint3-market-storage-phase1/.test(up) &&
    /rollback ownership mismatch/.test(down),
);
assert(
  '[migration] canonical CREATE fails closed',
  !/CREATE (?:TABLE|INDEX) IF NOT EXISTS/i.test(up),
);

for (const [table, model] of tables) {
  const modelPath = join(ROOT, `src/models/${model}.ts`);
  assert(`[${table}] model file`, existsSync(modelPath));
  const modelSource = existsSync(modelPath) ? readFileSync(modelPath, 'utf8') : '';
  assert(
    `[${table}] forward CREATE`,
    new RegExp(`CREATE TABLE\\s+${escapeRegex(table)}\\b`, 'i').test(up),
  );
  assert(
    `[${table}] rollback DROP`,
    new RegExp(`DROP TABLE IF EXISTS\\s+${escapeRegex(table)}\\b`, 'i').test(down),
  );
  assert(
    `[${table}] @Table parity`,
    new RegExp(`tableName:\\s*['"]${escapeRegex(table)}['"]`).test(modelSource),
  );
  assert(
    `[${model}] database import`,
    new RegExp(
      `import\\s*\\{\\s*${model}\\s*\\}\\s*from\\s*['"]\\.\\.\\/models\\/${model}['"]`,
    ).test(database),
  );
  assert(`[${model}] database registration`, new RegExp(`\\b${model}\\b\\s*,`).test(database));
  assert(
    `[${model}] barrel export`,
    new RegExp(`export\\s*\\*\\s*from\\s*['"]\\.\\/${model}['"]`).test(index),
  );
  for (const column of expectedColumns[table]) {
    assert(
      `[${table}] model field ${column}`,
      new RegExp(`field:\\s*['"]${escapeRegex(column)}['"]`).test(modelSource),
    );
  }
}

const frozenColumns = [
  'market_scope',
  'effective_at_utc',
  'available_at_utc',
  'source_document_id',
  'source_version',
  'corporate_action_version',
  'taxonomy_version',
  'parser_version',
  'account_mapping_version',
  'record_kind',
  'document_fact_hash',
  'snapshot_as_of_utc',
];
for (const column of frozenColumns) {
  assert(`[columns] ${column}`, new RegExp(`\\b${column}\\b`).test(up));
}

assert(
  '[financial] PIT index order',
  /ix_jpkr_financial_pit[\s\S]*?\(\s*market_scope,\s*ticker,\s*available_at_utc DESC,\s*source_version DESC\s*\)/.test(
    up,
  ),
);
assert(
  '[financial] amendment append identity',
  /UNIQUE\s*\(\s*market_scope,\s*ticker,\s*source_document_id,\s*source_version\s*\)/.test(
    up,
  ),
);
assert(
  '[financial] accepted provider mapping',
  /fiscal_period_kind IN \('Q1', 'Q3', 'SEMIANNUAL', 'ANNUAL'\)/.test(up) &&
    /INTEGER GENERATED ALWAYS AS[\s\S]*?EXTRACT\(YEAR FROM fiscal_period_end\)/.test(up) &&
    /source_kind = 'jpx-edinet'[\s\S]*?taxonomy_version IS NOT NULL/.test(up) &&
    /source_kind = 'dart'[\s\S]*?account_mapping_version IS NOT NULL/.test(up),
);
assert(
  '[financial] generated year avoids insert-side not-null validation',
  /field:\s*'fiscal_year'/.test(
    readFileSync(join(ROOT, 'src/models/JpkrFinancialSnapshot.ts'), 'utf8'),
  ) &&
    /allowNull:\s*true/.test(
      readFileSync(join(ROOT, 'src/models/JpkrFinancialSnapshot.ts'), 'utf8').match(
        /@Column\(\{[^}]*field:\s*'fiscal_year'[^}]*\}\)/,
      )?.[0] || '',
    ) &&
    /fiscalYear !== 2025/.test(readFileSync(ormPath, 'utf8')) &&
    /fiscalYear:\s*1999/.test(readFileSync(ormPath, 'utf8')),
);
assert(
  '[models] migration-owned tables opt out of destructive alter sync',
  /import\s+['"]\.\.\/models\/Sprint3MigrationOwnedModels['"]/.test(database) &&
    /Object\.defineProperty\(model,\s*'sync'/.test(
      readFileSync(join(ROOT, 'src/models/Sprint3MigrationOwnedModels.ts'), 'utf8'),
    ) &&
    /alter sync preserved FK\/defaults/.test(readFileSync(ormPath, 'utf8')),
);
assert(
  '[kline] adjusted close pins corporate action version',
  /adjusted_close IS NULL OR corporate_action_version IS NOT NULL/.test(up),
);
assert(
  '[fx] dedicated reciprocal fact',
  /CREATE TABLE jpkr_fx_observation/.test(up) &&
    /LOCAL_PER_USD_WITH_RECIPROCAL/.test(up) &&
    /ABS\(\(local_per_usd \* usd_per_local\) - 1\)/.test(up),
);
assert(
  '[fx] observation day and previous lineage',
  /ck_jpkr_fx_change_lineage/.test(up) &&
    /previous_observation_day < observation_day/.test(up) &&
    !/jpkr_fx_observation[\s\S]*?effective_at_utc/.test(
      up.slice(
        up.indexOf('CREATE TABLE jpkr_fx_observation'),
        up.indexOf('CREATE TABLE multibagger_universe'),
      ),
    ),
);
assert(
  '[fx] exact pair/provider mapping',
  /pair = 'USDJPY' AND source_kind = 'BOJ'/.test(up) &&
    /pair = 'USDKRW' AND source_kind = 'BOK'/.test(up),
);
assert(
  '[fx] no company/kline fallback column',
  !/fx_rate_to_usd/.test(up),
);
assert(
  '[multibagger] record/document identity',
  /universe_source_kind,\s*record_kind,\s*ticker,\s*source_document_id,\s*source_version,\s*fact_hash/.test(
    up,
  ),
);
assert(
  '[multibagger] candidate replay identity',
  /UNIQUE \(\s*market_scope,\s*exchange,\s*ticker,\s*as_of_utc,\s*strategy_version\s*\)/.test(
    up,
  ),
);
assert(
  '[multibagger] French aggregate isolation',
  /exchange = 'ACADEMIC_REFERENCE'[\s\S]*?ticker LIKE '__AGGREGATE__:%'/.test(up),
);
assert(
  '[multibagger] source facts reject Strategy projection keys',
  /ck_multibagger_source_fact_only/.test(up) &&
    /'score', 'rating', 'rating_band', 'conviction', 'risk_gate'/.test(up),
);
assert(
  '[multibagger] source fact has no candidate publication SOT',
  !/\bis_publishable_candidate\b/.test(up),
);
assert(
  '[text hit] six-field identity',
  /document_fact_hash,\s*taxonomy_version,\s*term_id,\s*field,\s*start_offset,\s*end_offset/.test(
    up,
  ),
);
assert(
  '[text hit] lossless scanner fields',
  /hit_kind IN \('OPTIONALITY', 'POSITIVE', 'NEGATIVE', 'EARLY_NEWS'\)/.test(up) &&
    /language IN \('en', 'zh', 'ja', 'ko'\)/.test(up) &&
    /\bcontext_hash\b/.test(up),
);
assert(
  '[PIT] exact strategy/as-of unique',
  /UNIQUE\s*\(\s*strategy,\s*market_scope,\s*as_of_utc\s*\)/.test(up),
);
assert(
  '[PIT] profile/scope replay compatibility',
  /strategy IN \('us_preferred', 'multibagger', 'custom'\)[\s\S]*?market_scope IN \('cn_a', 'us'\)/.test(
    up,
  ) &&
    /strategy IN \('japan_blue_chip', 'japan_multibagger'\)[\s\S]*?market_scope = 'jp'/.test(
      up,
    ) &&
    /strategy IN \('korea_semiconductor_chain', 'korea_multibagger'\)[\s\S]*?market_scope = 'kr'/.test(
      up,
    ),
);
assert(
  '[PIT] holding FK pins market scope',
  /FOREIGN KEY \(snapshot_id, market_scope, snapshot_as_of_utc\)[\s\S]*?REFERENCES backtest_pit_snapshot\(snapshot_id, market_scope, as_of_utc\)/.test(
    up,
  ),
);
assert(
  '[market] JP/KR currency mapping',
  /market_scope = 'jp' AND currency = 'JPY'/.test(up) &&
    /market_scope = 'kr' AND currency = 'KRW'/.test(up),
);
assert(
  '[PIT] normalized holdings only',
  !/\bholdings\s+JSONB/.test(up) && /CREATE TABLE backtest_pit_holding/.test(up),
);
assert(
  '[PIT] holding availability no-lookahead',
  /available_at_utc <= snapshot_as_of_utc/.test(up),
);
assert(
  '[PIT] aggregate ticker excluded from holdings',
  /backtest_pit_holding[\s\S]*?ticker TEXT NOT NULL CHECK \(ticker NOT LIKE '__AGGREGATE__:%'\)/.test(
    up,
  ),
);
assert(
  '[PIT] non-empty source closure',
  /source_versions <> '\{\}'::jsonb/.test(up) &&
    /'strict \$\.\* \? \(@\.type\(\) != "string" \|\| @ == ""\)'/.test(up),
);
assert(
  '[PIT] unbiased requires evidence',
  /jsonb_typeof\(lineage_closure->'survivorship_evidence'\) = 'object'/.test(up) &&
    /lineage_closure->'survivorship_evidence' <> '\{\}'::jsonb/.test(up),
);

const modelSources = tables
  .map(([, model]) => {
    const path = join(ROOT, `src/models/${model}.ts`);
    return existsSync(path) ? readFileSync(path, 'utf8') : '';
  })
  .join('\n');
assert(
  '[models] DECIMAL/BIGINT string-safe',
  !/DataType\.(?:DECIMAL|BIGINT)[\s\S]{0,160}declare\s+\w+:\s*number\b/.test(modelSources),
);

const createTables = [...up.matchAll(/CREATE TABLE\s+([a-z0-9_]+)/gi)].map(match => match[1]);
const dropTables = [...down.matchAll(/DROP TABLE IF EXISTS\s+([a-z0-9_]+)/gi)].map(
  match => match[1],
);
assert('[rollback] drops exactly created tables', [...createTables].sort().join() === [...dropTables].sort().join());

const parentIndex = createTables.indexOf('backtest_pit_snapshot');
const childIndex = createTables.indexOf('backtest_pit_holding');
const dropParentIndex = dropTables.indexOf('backtest_pit_snapshot');
const dropChildIndex = dropTables.indexOf('backtest_pit_holding');
assert('[rollback] child before parent', childIndex > parentIndex && dropChildIndex < dropParentIndex);

console.log(`sprint3-market-storage-phase1: ${passed} ok / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
