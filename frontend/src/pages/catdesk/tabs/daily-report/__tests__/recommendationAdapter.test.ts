import { describe, expect, test } from '@jest/globals';
import { parseRecommendationSnapshot, RecommendationContractError } from '../recommendationAdapter';
import { snapshotFixture } from '../testFixtures';
import { jcsCanonicalize, sha256Text } from '../contractSchema';

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function reseal(snapshot: ReturnType<typeof snapshotFixture>) {
  snapshot.output_fingerprint = sha256Text(jcsCanonicalize(snapshot.items));
  snapshot.disclaimer.hash = sha256Text(snapshot.disclaimer.full_text);
  return snapshot;
}

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
    ).toThrow(/unknown fields|ticker|gate/);
    expect(() =>
      parseRecommendationSnapshot({
        ...base,
        items: [
          {
            ...base.items[0],
            recommendation: {
              ...base.items[0].recommendation,
              entry_plan: {
                ...base.items[0].recommendation.entry_plan,
                size_hint: {
                  ...base.items[0].recommendation.entry_plan.size_hint,
                  tier: 'TIER_3',
                  pct: 5,
                },
              },
            },
          },
        ],
      })
    ).toThrow(/pct mismatch/);
  });

  test('rejects shortened nested DTOs, adjustment math, gate derivation, and ref mismatches', () => {
    const base = snapshotFixture();
    expect(() =>
      parseRecommendationSnapshot({
        ...base,
        items: [
          {
            ...base.items[0],
            recommendation: {
              ...base.items[0].recommendation,
              conviction: { final: 88, level: 'HIGH' },
            },
          },
        ],
      })
    ).toThrow(/unknown fields|ticker/);
    expect(() =>
      parseRecommendationSnapshot({
        ...base,
        items: [
          {
            ...base.items[0],
            recommendation: {
              ...base.items[0].recommendation,
              conviction: {
                ...base.items[0].recommendation.conviction,
                final: 99,
              },
            },
          },
        ],
      })
    ).toThrow(/final mismatch/);
    expect(() =>
      parseRecommendationSnapshot({
        ...base,
        items: [
          {
            ...base.items[0],
            recommendation: {
              ...base.items[0].recommendation,
              risk_gate: {
                ...base.items[0].recommendation.risk_gate,
                gate: 'YELLOW',
                ok_to_enter: true,
                triggers: [{ code: 'LIQUIDITY_LOW', severity: 'warn', detail: 'thin liquidity' }],
              },
            },
          },
        ],
      })
    ).toThrow(/ok_to_enter/);
    expect(() =>
      parseRecommendationSnapshot({
        ...base,
        items: [
          {
            ...base.items[0],
            recommendation: {
              ...base.items[0].recommendation,
              entry_plan: {
                ...base.items[0].recommendation.entry_plan,
                score_ref: {
                  ...base.items[0].recommendation.entry_plan.score_ref,
                  snapshot_hash: 'f'.repeat(64),
                },
              },
            },
          },
        ],
      })
    ).toThrow(/score_ref mismatch/);
    expect(() =>
      parseRecommendationSnapshot({
        ...base,
        items: [
          {
            ...base.items[0],
            recommendation: {
              ...base.items[0].recommendation,
              risk_gate: {
                ...base.items[0].recommendation.risk_gate,
                gate: 'RED',
                ok_to_enter: false,
                triggers: [{ code: 'LIQUIDITY_LOW', severity: 'block', detail: 'bad severity' }],
              },
            },
          },
        ],
      })
    ).toThrow(/severity mismatch/);
    expect(() =>
      parseRecommendationSnapshot({
        ...base,
        items: [
          {
            ...base.items[0],
            recommendation: {
              ...base.items[0].recommendation,
              risk_gate: {
                ...base.items[0].recommendation.risk_gate,
                gate: 'RED',
                ok_to_enter: false,
                triggers: [{ code: 'TSE_HALT', severity: 'block', detail: 'wrong market' }],
              },
            },
          },
        ],
      })
    ).toThrow(/market mismatch/);
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
    ).toThrow(/length 6/);
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

  test('rejects non-green persisted gates, incomplete explanations, bad weights and signals', () => {
    const base = snapshotFixture();
    expect(() =>
      parseRecommendationSnapshot({
        ...base,
        items: [
          {
            ...base.items[0],
            recommendation: {
              ...base.items[0].recommendation,
              risk_gate: {
                ...base.items[0].recommendation.risk_gate,
                gate: 'YELLOW',
                ok_to_enter: false,
                triggers: [{ code: 'LIQUIDITY_LOW', severity: 'warn', detail: 'thin liquidity' }],
              },
            },
          },
        ],
      })
    ).toThrow(/must be GREEN/);
    expect(() =>
      parseRecommendationSnapshot({
        ...base,
        items: [
          {
            ...base.items[0],
            recommendation: {
              ...base.items[0].recommendation,
              explanation: {
                ...base.items[0].recommendation.explanation,
                template_hash: undefined,
              },
            },
          },
        ],
      })
    ).toThrow(/template_hash/);
    expect(() =>
      parseRecommendationSnapshot({
        ...base,
        items: [
          {
            ...base.items[0],
            recommendation: {
              ...base.items[0].recommendation,
              weights: {
                normalized: true,
                contributions: [
                  {
                    source_kind: 'trigger',
                    source_ref: 'CATALYST_MATCHED',
                    weight: 0.5,
                  },
                ],
              },
            },
          },
        ],
      })
    ).toThrow(/L1/);
    expect(() =>
      parseRecommendationSnapshot({
        ...base,
        items: [
          {
            ...base.items[0],
            recommendation: {
              ...base.items[0].recommendation,
              weights: { normalized: true, contributions: [] },
            },
          },
        ],
      })
    ).toThrow(/zero weights/);
    expect(() =>
      parseRecommendationSnapshot({
        ...base,
        items: [
          {
            ...base.items[0],
            recommendation: {
              ...base.items[0].recommendation,
              trigger_signals: [
                {
                  code: 'UNKNOWN_SIGNAL',
                  strength: 'STRONG',
                  detail: 'invalid code',
                  source_ref: 'E1',
                },
              ],
            },
          },
        ],
      })
    ).toThrow(/signal code/);
    expect(() =>
      parseRecommendationSnapshot({
        ...base,
        items: [
          {
            ...base.items[0],
            recommendation: {
              ...base.items[0].recommendation,
              trigger_signals: [
                {
                  code: 'CATALYST_MATCHED',
                  strength: 'STRONG',
                  detail: 'missing evidence',
                  source_ref: 'E9',
                },
              ],
            },
          },
        ],
      })
    ).toThrow(/source_ref/);
  });

  test('rejects weight source domains, length limits and invalid catalyst relevance', () => {
    const base = snapshotFixture();
    expect(() =>
      parseRecommendationSnapshot({
        ...base,
        items: [
          {
            ...base.items[0],
            recommendation: {
              ...base.items[0].recommendation,
              weights: {
                normalized: true,
                contributions: [
                  {
                    source_kind: 'score_dim',
                    source_ref: 'X',
                    weight: 1,
                  },
                ],
              },
            },
          },
        ],
      })
    ).toThrow(/source_ref/);
    expect(() =>
      parseRecommendationSnapshot({
        ...base,
        items: [
          {
            ...base.items[0],
            recommendation: {
              ...base.items[0].recommendation,
              explanation: {
                ...base.items[0].recommendation.explanation,
                headline: 'x'.repeat(81),
              },
            },
          },
        ],
      })
    ).toThrow(/length/);
    expect(() =>
      parseRecommendationSnapshot({
        ...base,
        items: [
          {
            ...base.items[0],
            recommendation: {
              ...base.items[0].recommendation,
              trigger_signals: [
                {
                  ...base.items[0].recommendation.trigger_signals[0],
                  detail: 'x'.repeat(241),
                },
              ],
            },
          },
        ],
      })
    ).toThrow(/length 1..240/);
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
                  short_text: 'x'.repeat(201),
                },
              ],
            },
          },
        ],
      })
    ).toThrow(/short_text/);
    expect(() =>
      parseRecommendationSnapshot({
        ...base,
        items: [
          {
            ...base.items[0],
            recommendation: {
              ...base.items[0].recommendation,
              catalyst_relevance: {
                ...base.items[0].recommendation.catalyst_relevance,
                kind: 'unclassified',
              },
            },
          },
        ],
      })
    ).toThrow(/catalyst kind/);
  });

  test('allows an empty item list while retaining envelope and disclaimer', () => {
    const parsed = parseRecommendationSnapshot(snapshotFixture({ items: [] }));
    expect(parsed.items).toEqual([]);
    expect(parsed.disclaimer.full_text).toContain('投资有风险');
  });

  test('round-trips the full canonical fixture without projection loss', () => {
    const raw = snapshotFixture();
    expect(parseRecommendationSnapshot(raw)).toEqual(raw);
  });

  test.each([
    [85, 'A'],
    [70, 'B'],
    [55, 'C'],
    [40, 'D'],
    [39.999, 'F'],
  ] as const)('enforces aggregate and dim band boundary %s → %s', (score, band) => {
    const snapshot = clone(snapshotFixture());
    const recommendation = snapshot.items[0].recommendation;
    recommendation.score.total = score;
    recommendation.score.rating = band;
    recommendation.score.dims = recommendation.score.dims.map((dim, index) => ({
      ...dim,
      score,
      band,
      weight: index === 0 ? 1 : 0,
    }));
    snapshot.items[0].rating_band = band;
    recommendation.conviction.base = score;
    recommendation.conviction.final = score;
    recommendation.conviction.adjustments = [];
    recommendation.conviction.level = score >= 75 ? 'HIGH' : score >= 50 ? 'MED' : 'LOW';
    recommendation.entry_plan.conviction_ref = score;
    const sizing =
      score >= 85
        ? (['TIER_5', 5] as const)
        : score >= 70
          ? (['TIER_3', 3] as const)
          : score >= 55
            ? (['TIER_2', 2] as const)
            : score >= 40
              ? (['TIER_1', 1] as const)
              : (['SKIP', 0] as const);
    recommendation.entry_plan.size_hint.tier = sizing[0];
    recommendation.entry_plan.size_hint.pct = sizing[1];
    reseal(snapshot);
    const parsed = parseRecommendationSnapshot(snapshot);
    expect(parsed.items[0].recommendation.score.rating).toBe(band);
  });

  test('rejects aggregate/dim band, weighted total and conviction-size contradictions', () => {
    const aggregate = clone(snapshotFixture());
    aggregate.items[0].recommendation.score.rating = 'F';
    aggregate.items[0].rating_band = 'F';
    reseal(aggregate);
    expect(() => parseRecommendationSnapshot(aggregate)).toThrow(/aggregate rating/);

    const dimension = clone(snapshotFixture());
    dimension.items[0].recommendation.score.dims[0].band = 'F';
    reseal(dimension);
    expect(() => parseRecommendationSnapshot(dimension)).toThrow(/dim band/);

    const weighted = clone(snapshotFixture());
    weighted.items[0].recommendation.score.total = 90;
    weighted.items[0].recommendation.conviction.base = 90;
    weighted.items[0].recommendation.conviction.final = 90;
    weighted.items[0].recommendation.entry_plan.conviction_ref = 90;
    reseal(weighted);
    expect(() => parseRecommendationSnapshot(weighted)).toThrow(/weighted score/);

    const sizing = clone(snapshotFixture());
    sizing.items[0].recommendation.entry_plan.size_hint.tier = 'TIER_3';
    sizing.items[0].recommendation.entry_plan.size_hint.pct = 3;
    reseal(sizing);
    expect(() => parseRecommendationSnapshot(sizing)).toThrow(/conviction mapping/);
  });

  test('rejects conviction-base, duplicate ticker, evidence-PIT and catalyst-sum mismatches', () => {
    const baseMismatch = clone(snapshotFixture());
    baseMismatch.items[0].recommendation.conviction.base = 87;
    baseMismatch.items[0].recommendation.conviction.final = 87;
    reseal(baseMismatch);
    expect(() => parseRecommendationSnapshot(baseMismatch)).toThrow(/conviction base/);

    const duplicate = clone(snapshotFixture());
    const second = clone(duplicate.items[0]);
    second.recommendation.id = '55555555-5555-4555-8555-555555555555';
    duplicate.items.push(second);
    reseal(duplicate);
    expect(() => parseRecommendationSnapshot(duplicate)).toThrow(/duplicate tickers/);

    const futureEvidence = clone(snapshotFixture());
    futureEvidence.items[0].recommendation.evidence_refs[0].as_of = '2026-07-10T07:00:00Z';
    reseal(futureEvidence);
    expect(() => parseRecommendationSnapshot(futureEvidence)).toThrow(/after recommendation/);

    const catalyst = clone(snapshotFixture());
    if (catalyst.items[0].recommendation.catalyst_relevance) {
      catalyst.items[0].recommendation.catalyst_relevance.relevance_score = 0.1;
    }
    reseal(catalyst);
    expect(() => parseRecommendationSnapshot(catalyst)).toThrow(/relevance sum/);
  });

  test.each([
    [
      'missing recommendation key',
      (snapshot: ReturnType<typeof snapshotFixture>) => {
        delete (snapshot.items[0].recommendation as unknown as Record<string, unknown>).ticker;
      },
    ],
    [
      'unknown nested key',
      (snapshot: ReturnType<typeof snapshotFixture>) => {
        (snapshot.items[0].recommendation.score as unknown as Record<string, unknown>).shadow =
          true;
      },
    ],
    [
      'non-string adjustment source_ref',
      (snapshot: ReturnType<typeof snapshotFixture>) => {
        snapshot.items[0].recommendation.conviction.adjustments = [
          { delta: 0, reason: 'neutral', source_ref: 9 as unknown as string },
        ];
      },
    ],
    [
      'invalid adjustment kind_ref',
      (snapshot: ReturnType<typeof snapshotFixture>) => {
        snapshot.items[0].recommendation.conviction.adjustments = [
          {
            delta: 0,
            reason: 'neutral',
            kind_ref: 'forged_kind' as unknown as 'earnings',
          },
        ];
      },
    ],
    [
      'non-string contribution note',
      (snapshot: ReturnType<typeof snapshotFixture>) => {
        (
          snapshot.items[0].recommendation.weights.contributions[0] as unknown as Record<
            string,
            unknown
          >
        ).note = false;
      },
    ],
    [
      'score dim out of range',
      (snapshot: ReturnType<typeof snapshotFixture>) => {
        snapshot.items[0].recommendation.score.dims[0].score = 101;
      },
    ],
    [
      'malformed nested timestamp',
      (snapshot: ReturnType<typeof snapshotFixture>) => {
        snapshot.items[0].recommendation.risk_gate.evaluated_at = '2026-07-10';
      },
    ],
  ])('schema fuzz rejects %s', (_name, mutate) => {
    const snapshot = clone(snapshotFixture());
    mutate(snapshot);
    reseal(snapshot);
    expect(() => parseRecommendationSnapshot(snapshot)).toThrow(RecommendationContractError);
  });

  test('rejects disclaimer and output fingerprint authenticity mismatches', () => {
    const badDisclaimer = clone(snapshotFixture());
    badDisclaimer.disclaimer.full_text = 'forged legal text';
    expect(() => parseRecommendationSnapshot(badDisclaimer)).toThrow(/disclaimer.hash/);

    const badOutput = clone(snapshotFixture());
    badOutput.items[0].recommendation.explanation.headline = 'forged but valid headline';
    expect(() => parseRecommendationSnapshot(badOutput)).toThrow(/output_fingerprint/);
  });
});
