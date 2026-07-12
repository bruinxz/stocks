import { describe, expect, test } from '@jest/globals';
import { parseRecommendationSnapshot, RecommendationContractError } from '../recommendationAdapter';
import { snapshotFixture } from './fixtures';

describe('Recommendation v0.3.1 frontend adapter', () => {
  test.each([
    ['us_preferred', 'us', 'zh-CN'],
    ['multibagger', 'cn_a', 'en-US'],
    ['japan_blue_chip', 'jp', 'ja-JP'],
    ['japan_multibagger', 'jp', 'ja-JP'],
    ['korea_semiconductor_chain', 'kr', 'ko-KR'],
    ['korea_multibagger', 'kr', 'ko-KR'],
  ] as const)('accepts %s/%s and preserves full pins', (profile, scope, language) => {
    const raw = snapshotFixture({
      profile,
      market_scope: scope,
      disclaimer: { ...snapshotFixture().disclaimer, language },
      items: [
        {
          recommendation: {
            ...snapshotFixture().items[0].recommendation,
            score: {
              ...snapshotFixture().items[0].recommendation.score,
              profile,
              market_scope: scope,
            },
            explanation: {
              ...snapshotFixture().items[0].recommendation.explanation,
              language,
            },
          },
          rating_band: 'A',
        },
      ],
    });
    const parsed = parseRecommendationSnapshot(raw);
    expect(parsed.profile).toBe(profile);
    expect(parsed.market_scope).toBe(scope);
    expect(parsed.meta).toMatchObject({
      contract_version: '0.3.1',
      profile_version: '3.1.0',
      input_fingerprint: 'c'.repeat(64),
    });
  });

  test.each([
    ['custom profile', { profile: 'custom' }],
    ['missing pin', { meta: { ...snapshotFixture().meta, input_fingerprint: undefined } }],
    ['unknown top-level field', { shadow_archive: true }],
    ['profile/scope mismatch', { profile: 'japan_blue_chip', market_scope: 'us' }],
    ['bad hash', { output_fingerprint: 'ABC' }],
  ])('rejects %s', (_name, override) => {
    expect(() => parseRecommendationSnapshot(snapshotFixture(override))).toThrow(
      RecommendationContractError
    );
  });

  test('rejects rating, disclaimer, evidence, risk, and size mirrors when mismatched', () => {
    const base = snapshotFixture();
    expect(() =>
      parseRecommendationSnapshot({
        ...base,
        items: [{ ...base.items[0], rating_band: 'B' }],
      })
    ).toThrow(/rating mirror/);
    expect(() =>
      parseRecommendationSnapshot({
        ...base,
        items: [
          {
            ...base.items[0],
            recommendation: { ...base.items[0].recommendation, disclaimer_version: '2.0.0' },
          },
        ],
      })
    ).toThrow(/disclaimer_version/);
    expect(() =>
      parseRecommendationSnapshot({
        ...base,
        items: [
          {
            ...base.items[0],
            recommendation: {
              ...base.items[0].recommendation,
              explanation: { ...base.items[0].recommendation.explanation, body: 'Missing [E9]' },
            },
          },
        ],
      })
    ).toThrow(/evidence token/);
    expect(() =>
      parseRecommendationSnapshot({
        ...base,
        items: [
          {
            ...base.items[0],
            recommendation: {
              ...base.items[0].recommendation,
              risk_gate: { gate: 'RED', ok_to_enter: false },
            },
          },
        ],
      })
    ).toThrow(/blocks entry/);
    expect(() =>
      parseRecommendationSnapshot({
        ...base,
        items: [
          {
            ...base.items[0],
            recommendation: {
              ...base.items[0].recommendation,
              entry_plan: {
                size_hint: {
                  tier: 'TIER_3',
                  pct: 5,
                  disclaimer_key: 'size_hint_advisory',
                },
              },
            },
          },
        ],
      })
    ).toThrow(/pct mismatch/);
  });

  test('rejects malformed score dims and noncanonical evidence URIs', () => {
    const base = snapshotFixture();
    expect(() =>
      parseRecommendationSnapshot({
        ...base,
        items: [
          {
            ...base.items[0],
            recommendation: {
              ...base.items[0].recommendation,
              score: {
                ...base.items[0].recommendation.score,
                dims: base.items[0].recommendation.score.dims.slice(0, 5),
              },
            },
          },
        ],
      })
    ).toThrow(/six rows/);
    expect(() =>
      parseRecommendationSnapshot({
        ...base,
        items: [
          {
            ...base.items[0],
            recommendation: {
              ...base.items[0].recommendation,
              evidence_refs: [
                {
                  ...base.items[0].recommendation.evidence_refs[0],
                  source_uri: 'javascript:alert(1)',
                },
              ],
            },
          },
        ],
      })
    ).toThrow(/canonical/);
  });

  test('allows an empty item list while retaining envelope and disclaimer', () => {
    const parsed = parseRecommendationSnapshot(snapshotFixture({ items: [] }));
    expect(parsed.items).toEqual([]);
    expect(parsed.disclaimer.full_text).toContain('投资有风险');
  });
});
