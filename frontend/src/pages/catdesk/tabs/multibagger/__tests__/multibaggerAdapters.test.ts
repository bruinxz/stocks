import { describe, expect, test } from '@jest/globals';
import { jcsCanonicalize, sha256Text } from '../../daily-report/contractSchema';
import { parseMultibaggerDetail, parseMultibaggerResponse } from '../multibaggerAdapters';

function score() {
  const dimensions = Object.fromEntries(
    ['quality', 'growth', 'valuation', 'moat', 'trend', 'risk'].map((key, index) => [
      key,
      {
        score: 90 - index,
        band: 'A',
        evidence: [`${key} evidence`],
        inputs: { captured: true },
      },
    ])
  );
  const body = {
    ticker: '1301',
    as_of: '2026-07-14T00:00:00Z',
    market_scope: 'jp',
    ...dimensions,
    weights: {
      quality: 0.1,
      growth: 0.25,
      valuation: 0.1,
      moat: 0.15,
      trend: 0.25,
      risk: 0.15,
    },
    weights_profile: 'japan_multibagger',
    total: 87.5,
    rating: 'A',
    computed_at: '2026-07-14T00:00:00Z',
    source_versions: {
      quality_engine: 'quality@1.0.0',
      growth_engine: 'growth@1.0.0',
      valuation_engine: 'valuation@1.0.0',
      moat_engine: 'moat@1.0.0',
      trend_engine: 'trend@1.0.0',
      risk_engine: 'risk@1.0.0',
    },
  };
  return {
    ...body,
    snapshot_hash: sha256Text(jcsCanonicalize(body)),
    scoring_id: '33333333-3333-4333-8333-333333333333',
  };
}

function candidate() {
  const candidateScore = score();
  const scoreRef = {
    scoring_id: candidateScore.scoring_id,
    snapshot_hash: candidateScore.snapshot_hash,
  };
  return {
    symbol: '1301',
    name: '极洋',
    score: candidateScore,
    rating_band: 'A',
    conviction: {
      ticker: '1301',
      as_of: '2026-07-14T00:00:00Z',
      base: 87.5,
      score_ref: scoreRef,
      adjustments: [],
      final: 87.5,
      level: 'HIGH',
    },
    risk_gate: {
      ticker: '1301',
      evaluated_at: '2026-07-14T00:00:00Z',
      gate: 'GREEN',
      triggers: [],
      ok_to_enter: true,
    },
    entry_plan: {
      ticker: '1301',
      generated_at: '2026-07-14T00:00:00Z',
      entry: { low: 4450, high: 4550, currency: 'JPY' },
      stop: { value: 4100, currency: 'JPY' },
      targets: [{ value: 5200, currency: 'JPY' }],
      size_hint: {
        tier: 'TIER_3',
        pct: 3,
        disclaimer_key: 'size_hint_advisory',
        rationale: 'conviction 87.5',
      },
      time_horizon: 'POSITION',
      invalidation: 'close below 4100',
      conviction_ref: 87.5,
      score_ref: scoreRef,
    },
    latest_catalyst: {
      kind: 'product',
      title: 'New capacity',
      occurred_at: '2026-07-13T23:00:00Z',
      available_at_utc: '2026-07-13T23:30:00Z',
      source_ref: 'kind:20260713',
      fact_hash: 'c'.repeat(64),
    },
    market: 'JP',
    market_scope: 'jp',
    exchange: 'tse',
    stage: 'growth',
    conclusion: 'MULTIBAGGER_5X',
    fact_hash: 'f'.repeat(64),
    source_fact_hashes: ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)],
    as_of_utc: '2026-07-14T00:00:00Z',
    available_at_utc: '2026-07-14T00:00:00Z',
    strategy_version: 'japan-multibagger@1.0.0',
    classification_policy_version: 'stage-policy@1.0.0',
    classification_reason_codes: ['CAPTURED_SOURCE', 'OPTIONALITY_HIT'],
  };
}

function response() {
  return {
    kpi: {
      total_candidates: 1,
      stage_distribution: {
        seed: 0,
        early: 0,
        growth: 1,
        break_below: 0,
        deep: 0,
      },
      conclusion_coverage: {
        MULTIBAGGER_2X: 0,
        MULTIBAGGER_5X: 1,
        MULTIBAGGER_10X: 0,
        SKIP: 0,
      },
    },
    rows: [candidate()],
  };
}

describe('multibagger strict adapters', () => {
  test('parses canonical list and detail proof pins', () => {
    const parsed = parseMultibaggerResponse(response());
    expect(parsed.rows[0].symbol).toBe('1301');
    expect(parsed.rows[0].fact_hash).toBe('f'.repeat(64));
    expect(parsed.rows[0].source_fact_hashes).toEqual([
      'a'.repeat(64),
      'b'.repeat(64),
      'c'.repeat(64),
    ]);
    expect(parseMultibaggerDetail(candidate())).toEqual(parsed.rows[0]);
  });

  test('rejects unknown fields and KPI mismatches', () => {
    const unknown = response() as any;
    unknown.rows[0].unexpected = true;
    expect(() => parseMultibaggerResponse(unknown)).toThrow(/unknown fields/);

    const badCount = response();
    badCount.kpi.total_candidates = 2;
    expect(() => parseMultibaggerResponse(badCount)).toThrow(/counts do not match/);
  });

  test('rejects score hash tamper and future availability', () => {
    const tampered = candidate() as any;
    tampered.score.total = 1;
    expect(() => parseMultibaggerDetail(tampered)).toThrow(/snapshot_hash/);

    const future = candidate();
    future.available_at_utc = '2026-07-14T00:00:01Z';
    expect(() => parseMultibaggerDetail(future)).toThrow(/exceeds as_of_utc/);

    const futureCatalyst = candidate();
    futureCatalyst.latest_catalyst!.available_at_utc = '2026-07-14T00:00:01Z';
    expect(() => parseMultibaggerDetail(futureCatalyst)).toThrow(/not PIT-visible/);

    const wrongScope = candidate();
    wrongScope.market_scope = 'us';
    expect(() => parseMultibaggerDetail(wrongScope)).toThrow(/does not match market/);
  });

  test('rejects unsorted or duplicate physical proof arrays', () => {
    const unsorted = candidate();
    unsorted.source_fact_hashes = ['c'.repeat(64), 'b'.repeat(64), 'a'.repeat(64)];
    expect(() => parseMultibaggerDetail(unsorted)).toThrow(/sorted and unique/);

    const duplicateReasons = candidate();
    duplicateReasons.classification_reason_codes = ['CAPTURED_SOURCE', 'CAPTURED_SOURCE'];
    expect(() => parseMultibaggerDetail(duplicateReasons)).toThrow(/sorted and unique/);
  });
});
