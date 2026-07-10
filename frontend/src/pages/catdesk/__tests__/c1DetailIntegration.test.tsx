import { renderToStaticMarkup } from 'react-dom/server';
import type { CandidateListEntry } from '../types';
import { buildMorningSections } from '../tabs/morning/detail/buildMorningSections';
import { buildUSSections } from '../tabs/us/detail/buildUSSections';

const candidate: CandidateListEntry = {
  symbol: 'NVDA',
  name: 'NVIDIA',
  rating_band: 'A',
  score: {
    scoring_id: 'score-1',
    snapshot_hash: '0123456789abcdef',
    score: 88,
    band: 'A',
    dims: [
      { key: 'quality', score: 90, band: 'A', weight: 0.2 },
      { key: 'growth', score: 86, band: 'A', weight: 0.2 },
    ],
    evidence: ['earnings'],
  },
  conviction: {
    ticker: 'NVDA',
    as_of: '2026-07-10T00:00:00Z',
    base: 80,
    score_ref: { scoring_id: 'score-1', snapshot_hash: '0123456789abcdef' },
    adjustments: [{ delta: 5, reason: 'earnings beat' }],
    final: 85,
    level: 'HIGH',
  },
  risk_gate: {
    status: 'YELLOW',
    triggers: [{ code: 'EARNINGS_T-2', severity: 'medium', detail: '财报窗口临近' }],
    evaluated_at: '2026-07-10T00:00:00Z',
  },
  entry_plan: {
    price_band: { low: 150, high: 155, currency: 'USD' },
    stop: 142,
    targets: [165, 175],
    size_hint: { tier: 'TIER_3', pct: 3, disclaimer_key: 'size_hint_advisory' },
    time_horizon: 'SWING',
    invalidation: '跌破关键支撑',
    conviction_ref: 'score-1',
  },
};

describe('C1 detail integration', () => {
  test('US candidate exposes score, conviction, risk, and entry sections', () => {
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
