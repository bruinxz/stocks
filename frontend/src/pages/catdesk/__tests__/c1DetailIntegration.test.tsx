import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from '@jest/globals';
import type { Dimension } from 'shared/scoring/types';
import type { CandidateListEntry } from '../tabs/c1Types';
import { scoreBandDimensions } from '../tabs/c1Types';
import { ScoreBreakdownCard } from '../tabs/morning/detail/ScoreBreakdownCard';
import { buildMorningSections } from '../tabs/morning/detail/buildMorningSections';
import { buildUSSections } from '../tabs/us/detail/buildUSSections';

const dimension = (score: number, band: Dimension['band']): Dimension => ({
  score,
  band,
  evidence: ['canonical evidence'],
  inputs: {},
});

const scoreRef = {
  scoring_id: '00000000-0000-4000-8000-000000000001',
  snapshot_hash: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
};

const candidate: CandidateListEntry = {
  symbol: 'NVDA',
  name: 'NVIDIA',
  rating_band: 'A',
  score: {
    ...scoreRef,
    ticker: 'NVDA',
    as_of: '2026-07-10',
    market_scope: 'us',
    quality: dimension(90, 'A'),
    growth: dimension(86, 'A'),
    valuation: dimension(76, 'B'),
    moat: dimension(88, 'A'),
    trend: dimension(84, 'B'),
    risk: dimension(72, 'B'),
    weights: {
      quality: 0.2,
      growth: 0.2,
      valuation: 0.15,
      moat: 0.2,
      trend: 0.15,
      risk: 0.1,
    },
    weights_profile: 'us_preferred',
    total: 88,
    rating: 'A',
    computed_at: '2026-07-10T00:00:00Z',
    source_versions: {
      quality_engine: 'quality@v0.3.0',
      growth_engine: 'growth@v0.3.0',
      valuation_engine: 'valuation@v0.3.0',
      moat_engine: 'moat@v0.3.0',
      trend_engine: 'trend@v0.3.0',
      risk_engine: 'risk@v0.3.0',
    },
  },
  conviction: {
    ticker: 'NVDA',
    as_of: '2026-07-10T00:00:00Z',
    base: 80,
    score_ref: scoreRef,
    adjustments: [{ delta: 5, reason: 'earnings beat' }],
    final: 85,
    level: 'HIGH',
  },
  risk_gate: {
    ticker: 'NVDA',
    evaluated_at: '2026-07-10T00:00:00Z',
    gate: 'GREEN',
    triggers: [],
    ok_to_enter: true,
  },
  entry_plan: {
    ticker: 'NVDA',
    generated_at: '2026-07-10T00:00:00Z',
    entry: { low: 150, high: 155, currency: 'USD' },
    stop: { value: 142, currency: 'USD' },
    targets: [
      { value: 165, currency: 'USD' },
      { value: 175, currency: 'USD' },
    ],
    size_hint: {
      tier: 'TIER_3',
      pct: 3,
      disclaimer_key: 'size_hint_advisory',
      rationale: 'high conviction',
    },
    time_horizon: 'SWING',
    invalidation: '跌破关键支撑',
    conviction_ref: 85,
    score_ref: scoreRef,
  },
};

describe('C1 detail integration', () => {
  test('missing canonical score stays unavailable instead of inventing a band', () => {
    expect(scoreBandDimensions(null)).toEqual([]);

    const markup = renderToStaticMarkup(<ScoreBreakdownCard />);
    expect(markup).toContain('暂无评分快照');
    expect(markup).not.toContain('综合: B');
  });

  test('US candidate exposes score, conviction, risk, and entry sections', () => {
    expect(candidate.score?.market_scope).toBe('us');

    const sections = buildUSSections(candidate);
    expect(sections.map(section => section.key)).toEqual(['score', 'conviction', 'risk', 'entry']);

    const entry = sections.find(section => section.key === 'entry');
    const markup = renderToStaticMarkup(<>{entry?.content}</>);
    expect(markup).toContain('150.00');
    expect(markup).toContain('TIER_3');
    expect(markup).toContain('跌破关键支撑');
  });

  test('morning candidate consumes the same entry plan contract', () => {
    const sections = buildMorningSections(candidate);
    expect(sections.at(-1)?.key).toBe('entry');

    const entryMarkup = renderToStaticMarkup(<>{sections.at(-1)?.content}</>);
    expect(entryMarkup).toContain('150.00');
    expect(entryMarkup).toContain('TIER_3');
    expect(entryMarkup).toContain('跌破关键支撑');
  });
});
