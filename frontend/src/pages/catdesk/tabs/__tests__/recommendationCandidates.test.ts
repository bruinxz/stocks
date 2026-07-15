import { describe, expect, test } from '@jest/globals';
import { snapshotFixture } from '../daily-report/testFixtures';
import {
  loadRecommendationCandidateFeed,
  parseRecommendationCandidateFeed,
  recommendationLatestUrl,
  RecommendationCandidateContractError,
  RecommendationCandidateHttpError,
} from '../recommendationCandidates';

function response(status: number, body?: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe('CatDesk Tab1/2 recommendation candidate boundary', () => {
  test('maps a validated v0.3.1 snapshot without losing proof pins', () => {
    const feed = parseRecommendationCandidateFeed(snapshotFixture(), 'us_preferred', 'us');

    expect(feed.kpi).toMatchObject({ total: 1, high_conviction: 1, avg_score: 87.75 });
    expect(feed.candidates[0]).toMatchObject({
      symbol: 'AAPL',
      name: 'AAPL',
      rating_band: 'A',
      score: {
        scoring_id: '33333333-3333-4333-8333-333333333333',
        total: 87.75,
        quality: { score: 90, band: 'A' },
        risk: { score: 82, band: 'B' },
      },
      provenance: {
        snapshot_id: '11111111-1111-4111-8111-111111111111',
        profile: 'us_preferred',
        market_scope: 'us',
        contract_version: '0.3.1',
      },
    });
    expect(feed.candidates[0].data_sources).toEqual(['sec-edgar://0001193125-25-000123#item-8-01']);
    expect(feed.candidates[0].explanation?.body).toContain('[E1]');
  });

  test('rejects a valid snapshot from the wrong profile/scope', () => {
    expect(() =>
      parseRecommendationCandidateFeed(snapshotFixture(), 'us_preferred', 'cn_a')
    ).toThrow(RecommendationCandidateContractError);
  });

  test('still rejects a mutually unsealed transport mutation', () => {
    const raw = snapshotFixture();
    raw.items[0].recommendation.score.total = 10;
    expect(() => parseRecommendationCandidateFeed(raw, 'us_preferred', 'us')).toThrow();
  });

  test('builds the canonical authenticated browse URL', () => {
    expect(recommendationLatestUrl('us_preferred', 'cn_a')).toBe(
      '/api/v1/ai/recommendations/latest?profile=us_preferred&market_scope=cn_a'
    );
  });

  test('classifies ready, not-generated and unavailable without weakening parsing', async () => {
    const signal = new AbortController().signal;
    await expect(
      loadRecommendationCandidateFeed(signal, 'us_preferred', 'us', async () =>
        response(200, snapshotFixture())
      )
    ).resolves.toMatchObject({ kind: 'ready', feed: { kpi: { total: 1 } } });
    await expect(
      loadRecommendationCandidateFeed(signal, 'us_preferred', 'us', async () => response(404))
    ).resolves.toEqual({ kind: 'not_generated' });
    await expect(
      loadRecommendationCandidateFeed(signal, 'us_preferred', 'us', async () => response(503))
    ).resolves.toEqual({ kind: 'unavailable' });
  });

  test('keeps other HTTP, malformed and network failures fail-closed', async () => {
    const signal = new AbortController().signal;
    await expect(
      loadRecommendationCandidateFeed(signal, 'us_preferred', 'us', async () => response(500))
    ).rejects.toBeInstanceOf(RecommendationCandidateHttpError);
    await expect(
      loadRecommendationCandidateFeed(signal, 'us_preferred', 'us', async () =>
        response(200, { meta: { contract_version: '0.3.0' } })
      )
    ).rejects.toThrow(/Recommendation v0\.3\.1 contract error/);
    await expect(
      loadRecommendationCandidateFeed(signal, 'us_preferred', 'us', async () => {
        throw new TypeError('network offline');
      })
    ).rejects.toThrow('network offline');
  });
});
