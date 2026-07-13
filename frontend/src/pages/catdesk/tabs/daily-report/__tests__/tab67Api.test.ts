import { describe, expect, jest, test } from '@jest/globals';
import { createTab67HttpApi } from '../tab67Api';
import { reportFixture } from '../testFixtures';
import { canonicalizeRecommendationFingerprintPreimage } from '../recommendationAdapter';

const signal = new AbortController().signal;
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    headers: { 'content-type': 'application/json' },
  });

describe('Tab 6/7 HTTP client', () => {
  test('uses frozen daily/history/detail/diff/replay paths and strict adapters', async () => {
    const report = reportFixture();
    const history = {
      projection_version: '0.1.0',
      filters: {
        query: '',
        profile: 'us_preferred',
        market_scope: 'us',
        from_day: null,
        to_day: null,
      },
      entries: [
        {
          report_id: report.wire.report_id,
          trading_day: report.wire.trading_day,
          profile: report.wire.profile,
          market_scope: report.wire.market_scope,
          source_snapshot_id: report.wire.source_snapshot_id,
          source_as_of: report.wire.source_as_of,
          source_output_fingerprint: report.wire.source_output_fingerprint,
          source_fingerprint_preimage_jcs: report.wire.source_fingerprint_preimage_jcs,
          input_fingerprint: report.wire.meta.input_fingerprint,
          contract_version: '0.3.1',
          profile_version: report.wire.meta.profile_version,
          strategy_version: report.wire.meta.strategy_version,
          pipeline_version: report.wire.meta.pipeline_version,
          disclaimer_version: report.wire.disclaimer.version,
          item_count: report.wire.summary.item_count,
          high_conviction_count: report.wire.summary.high_conviction_count,
          rating_counts: report.wire.summary.rating_counts,
          content_preview: report.wire.markdown.slice(0, 200),
        },
      ],
      total: 1,
    };
    const diff = {
      base_snapshot_id: '44444444-4444-4444-8444-444444444444',
      target_snapshot_id: report.snapshot.snapshot_id,
      profile: 'us_preferred',
      market_scope: 'us',
      fingerprint_match: false,
      added: ['AAPL'],
      removed: [],
      changed: [],
      unchanged: [],
    };
    const fetcher = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/daily-report/latest')) return response(report.wire);
      if (url.includes('/daily-report/history')) return response(history);
      if (url.includes('/diff/')) return response(diff);
      if (url.endsWith('/replay')) return response({ job_id: 'job-1', status: 'queued' });
      if (url.includes('/status?')) return response({ job_id: 'job-1', status: 'running' });
      if (url.includes('/ai/recommendations/')) {
        return response({
          ...report.snapshot,
          fingerprint_preimage_jcs: canonicalizeRecommendationFingerprintPreimage(report.snapshot),
        });
      }
      if (url.includes('/daily-report/')) return response(report.wire);
      throw new Error(`unexpected ${url} ${init?.method}`);
    });
    const api = createTab67HttpApi(fetcher);

    await expect(api.latest('us_preferred', 'us', signal)).resolves.toMatchObject({
      wire: report.wire,
      snapshot: report.snapshot,
    });
    await expect(
      api.daily(report.trading_day, 'us_preferred', 'us', signal)
    ).resolves.toMatchObject({ wire: report.wire, snapshot: report.snapshot });
    await expect(
      api.history(
        {
          page: 1,
          page_size: 20,
          profile: 'us_preferred',
          market_scope: 'us',
          search: 'aapl',
          date: report.trading_day,
        },
        signal
      )
    ).resolves.toMatchObject({ total: 1 });
    await expect(api.snapshot(report.snapshot.snapshot_id, signal)).resolves.toEqual(
      report.snapshot
    );
    await expect(api.diff(diff.base_snapshot_id, diff.target_snapshot_id, signal)).resolves.toEqual(
      diff
    );
    await expect(
      api.submitReplay(
        { trading_day: report.trading_day, profile: 'us_preferred', market_scope: 'us' },
        signal
      )
    ).resolves.toMatchObject({ status: 'queued' });
    await expect(api.replayStatus('job-1', signal)).resolves.toMatchObject({
      status: 'running',
    });

    const urls = fetcher.mock.calls.map(call => String(call[0]));
    expect(urls).toContain('/api/v1/daily-report/latest?profile=us_preferred&market_scope=us');
    expect(urls).toContain(
      `/api/v1/daily-report/${report.trading_day}?profile=us_preferred&market_scope=us`
    );
    expect(urls).toContain(
      `/api/v1/daily-report/history?profile=us_preferred&market_scope=us&query=aapl&from_day=${report.trading_day}&to_day=${report.trading_day}`
    );
    expect(urls).toContain(
      `/api/v1/ai/recommendations/${diff.base_snapshot_id}/diff/${diff.target_snapshot_id}`
    );
  });

  test('rejects bad scopes and surfaces typed HTTP errors', async () => {
    const fetcher = jest.fn(async () => response({ error: 'not found' }, 404));
    const api = createTab67HttpApi(fetcher);
    await expect(api.latest('japan_blue_chip', 'us', signal)).rejects.toThrow(/incompatible/);
    await expect(api.latest('us_preferred', 'us', signal)).rejects.toEqual(
      expect.objectContaining({ status: 404, message: 'not found' })
    );
  });
});
