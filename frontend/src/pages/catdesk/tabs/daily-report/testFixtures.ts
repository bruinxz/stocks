import type { DailyReportDocument, RecommendationEntry, RecommendationSnapshot } from './types';
import { sha256Text } from './contractSchema';
import { canonicalizeRecommendationFingerprintPreimage } from './recommendationAdapter';
import type { B5DailyReportWire } from './types';

const SNAPSHOT_ID = '11111111-1111-4111-8111-111111111111';
const RECOMMENDATION_ID = '22222222-2222-4222-8222-222222222222';
export const HASH_A = 'a'.repeat(64);
export const HASH_B = 'b'.repeat(64);
export const HASH_C = 'c'.repeat(64);

export function recommendationFixture(
  overrides: Partial<RecommendationEntry> = {}
): RecommendationEntry {
  return {
    id: RECOMMENDATION_ID,
    snapshot_id: SNAPSHOT_ID,
    ticker: 'AAPL',
    as_of: '2026-07-10T06:00:00Z',
    score: {
      scoring_id: '33333333-3333-4333-8333-333333333333',
      snapshot_hash: HASH_A,
      profile: 'us_preferred',
      market_scope: 'us',
      total: 87.75,
      rating: 'A',
      dims: [
        { key: 'Q', score: 90, band: 'A', weight: 0.2 },
        { key: 'G', score: 88, band: 'A', weight: 0.2 },
        { key: 'V', score: 85, band: 'A', weight: 0.15 },
        { key: 'M', score: 90, band: 'A', weight: 0.2 },
        { key: 'T', score: 88, band: 'A', weight: 0.15 },
        { key: 'R', score: 82, band: 'B', weight: 0.1 },
      ],
    },
    conviction: {
      ticker: 'AAPL',
      as_of: '2026-07-10T06:00:00Z',
      base: 87.75,
      score_ref: {
        scoring_id: '33333333-3333-4333-8333-333333333333',
        snapshot_hash: HASH_A,
      },
      adjustments: [],
      final: 87.75,
      level: 'HIGH',
    },
    risk_gate: {
      ticker: 'AAPL',
      evaluated_at: '2026-07-10T06:00:00Z',
      gate: 'GREEN',
      triggers: [],
      ok_to_enter: true,
    },
    entry_plan: {
      ticker: 'AAPL',
      generated_at: '2026-07-10T06:00:00Z',
      entry: { low: 198, high: 202, currency: 'USD' },
      stop: { value: 189, currency: 'USD' },
      targets: [{ value: 220, currency: 'USD' }],
      size_hint: {
        tier: 'TIER_5',
        pct: 5,
        disclaimer_key: 'size_hint_advisory',
        rationale: 'high conviction with clean gate',
      },
      time_horizon: 'SWING',
      invalidation: 'breaks below support',
      conviction_ref: 87.75,
      score_ref: {
        scoring_id: '33333333-3333-4333-8333-333333333333',
        snapshot_hash: HASH_A,
      },
    },
    trigger_signals: [
      {
        code: 'CATALYST_MATCHED',
        strength: 'STRONG',
        detail: 'public catalyst matched',
        source_ref: 'E1',
      },
    ],
    weights: {
      contributions: [
        {
          source_kind: 'trigger',
          source_ref: 'CATALYST_MATCHED',
          weight: 1,
        },
      ],
      normalized: true,
    },
    explanation: {
      headline: '新品周期进入验证窗',
      body: '需求与供给信号同时改善 [E1]',
      caveats: ['财报窗口前波动可能放大'],
      language: 'zh-CN',
      template_id: 'morning_brief_v1',
      template_hash: HASH_C,
    },
    evidence_refs: [
      {
        id: 'E1',
        kind: 'DISCLOSURE',
        source_uri: 'sec-edgar://0001193125-25-000123#item-8-01',
        as_of: '2026-07-10T05:00:00Z',
        hash: HASH_B,
        short_text: '公开披露',
      },
    ],
    catalyst_relevance: {
      catalyst_id: 'catalyst-1',
      kind: 'product',
      relevance_score: 0.785,
      components: {
        sector_map: 1,
        revenue_exposure: 0.8,
        adr_parity: 0.5,
        supply_chain: 0.7,
        historical_beta: 0.6,
      },
    },
    model_version: '3.1.0',
    disclaimer_version: '1.0.0',
    ...overrides,
  };
}

export function snapshotFixture(overrides: Record<string, unknown> = {}): RecommendationSnapshot {
  const items = (overrides.items as RecommendationSnapshot['items'] | undefined) ?? [
    {
      recommendation: recommendationFixture(),
      rating_band: 'A',
    },
  ];
  const disclaimer = {
    version: '1.0.0',
    short_text: '仅供参考',
    full_text: '投资有风险，本内容仅供参考。',
    language: 'zh-CN' as const,
    effective_at: '2026-07-01T00:00:00Z',
    hash: '',
    ...(overrides.disclaimer as Partial<RecommendationSnapshot['disclaimer']> | undefined),
  };
  disclaimer.hash = sha256Text(disclaimer.full_text);
  const snapshot = {
    snapshot_id: SNAPSHOT_ID,
    as_of: '2026-07-10T06:00:00Z',
    profile: 'us_preferred',
    market_scope: 'us',
    items,
    output_fingerprint: '',
    disclaimer,
    meta: {
      contract_version: '0.3.1',
      profile_version: '3.1.0',
      input_fingerprint: HASH_C,
      strategy_version: '3.1.0',
      pipeline_version: '3.1.0',
      generated_by: 'fixture',
      generation_ms: 12,
    },
    ...Object.fromEntries(
      Object.entries(overrides).filter(([key]) => key !== 'items' && key !== 'disclaimer')
    ),
  } as unknown as RecommendationSnapshot;
  snapshot.output_fingerprint = sha256Text(canonicalizeRecommendationFingerprintPreimage(snapshot));
  if (typeof overrides.output_fingerprint === 'string') {
    snapshot.output_fingerprint = overrides.output_fingerprint;
  }
  return snapshot;
}

export function reportFixture(): DailyReportDocument {
  const snapshot = snapshotFixture();
  const wire: B5DailyReportWire = {
    projection_version: '0.1.0',
    report_id: 'report-2026-07-10-us',
    trading_day: '2026-07-10',
    profile: snapshot.profile,
    market_scope: snapshot.market_scope,
    source_snapshot_id: snapshot.snapshot_id,
    source_as_of: snapshot.as_of,
    source_output_fingerprint: snapshot.output_fingerprint,
    source_fingerprint_preimage_jcs: canonicalizeRecommendationFingerprintPreimage(snapshot),
    disclaimer: snapshot.disclaimer,
    meta: snapshot.meta,
    summary: {
      item_count: 1,
      high_conviction_count: 1,
      rating_counts: { A: 1, B: 0, C: 0, D: 0, F: 0 },
    },
    entries: snapshot.items,
    sections: [
      {
        kind: 'summary',
        section_id: 'summary',
        title: '摘要',
        item_count: 1,
        high_conviction_count: 1,
        rating_counts: { A: 1, B: 0, C: 0, D: 0, F: 0 },
      },
      {
        kind: 'recommendation',
        section_id: 'recommendation-aapl',
        title: 'AAPL',
        ticker: 'AAPL',
        rating_band: 'A',
        evidence_ids: ['E1'],
      },
    ],
    markdown: '## 今日结论\n\n证据优先，风险先行。',
  };
  return {
    wire,
    report_id: wire.report_id,
    trading_day: wire.trading_day,
    source_snapshot_ids: [SNAPSHOT_ID],
    snapshot,
    title: '2026-07-10 每日研究报告',
    markdown: '## 今日结论\n\n证据优先，风险先行。',
    sections: [
      { key: 'overview', title: '市场概览', markdown: '波动收窄。' },
      { key: 'risk', title: '风险检查', markdown: '无红色门禁。' },
    ],
  };
}
