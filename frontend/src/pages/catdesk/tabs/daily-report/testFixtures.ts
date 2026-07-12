import type { DailyReportDocument, RecommendationEntry, RecommendationSnapshot } from './types';

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
      total: 91,
      rating: 'A',
      dims: [
        { key: 'Q', score: 92, band: 'A', weight: 0.2 },
        { key: 'G', score: 90, band: 'A', weight: 0.2 },
        { key: 'V', score: 85, band: 'A', weight: 0.15 },
        { key: 'M', score: 94, band: 'A', weight: 0.2 },
        { key: 'T', score: 88, band: 'A', weight: 0.15 },
        { key: 'R', score: 80, band: 'B', weight: 0.1 },
      ],
    },
    conviction: {
      ticker: 'AAPL',
      as_of: '2026-07-10T06:00:00Z',
      base: 83,
      score_ref: {
        scoring_id: '33333333-3333-4333-8333-333333333333',
        snapshot_hash: HASH_A,
      },
      adjustments: [{ delta: 5, reason: 'fresh public catalyst' }],
      final: 88,
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
        tier: 'TIER_3',
        pct: 3,
        disclaimer_key: 'size_hint_advisory',
        rationale: 'high conviction with clean gate',
      },
      time_horizon: 'SWING',
      invalidation: 'breaks below support',
      conviction_ref: 88,
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
      relevance_score: 0.8,
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
  return {
    snapshot_id: SNAPSHOT_ID,
    as_of: '2026-07-10T06:00:00Z',
    profile: 'us_preferred',
    market_scope: 'us',
    items: [
      {
        recommendation: recommendationFixture(),
        rating_band: 'A',
      },
    ],
    output_fingerprint: HASH_A,
    disclaimer: {
      version: '1.0.0',
      short_text: '仅供参考',
      full_text: '投资有风险，本内容仅供参考。',
      language: 'zh-CN',
      effective_at: '2026-07-01T00:00:00Z',
      hash: HASH_B,
    },
    meta: {
      contract_version: '0.3.1',
      profile_version: '3.1.0',
      input_fingerprint: HASH_C,
      strategy_version: '3.1.0',
      pipeline_version: '3.1.0',
      generated_by: 'fixture',
      generation_ms: 12,
    },
    ...overrides,
  } as RecommendationSnapshot;
}

export function reportFixture(): DailyReportDocument {
  return {
    report_id: 'report-2026-07-10-us',
    trading_day: '2026-07-10',
    source_snapshot_ids: [SNAPSHOT_ID],
    snapshot: snapshotFixture(),
    title: '2026-07-10 每日研究报告',
    markdown: '## 今日结论\n\n证据优先，风险先行。',
    sections: [
      { key: 'overview', title: '市场概览', markdown: '波动收窄。' },
      { key: 'risk', title: '风险检查', markdown: '无红色门禁。' },
    ],
  };
}
