import { describe, expect, test } from '@jest/globals';
import { parseB5DailyReport, parseB5ReportHistory } from '../b5ProjectionAdapter';
import { jcsCanonicalize } from '../contractSchema';
import { reportFixture } from '../testFixtures';

describe('B5 canonical projection → B6 view adapter', () => {
  test('preserves the complete daily wire and derives one view without field loss', () => {
    const source = reportFixture();
    const parsed = parseB5DailyReport(source.wire);
    expect(parsed.wire).toEqual(source.wire);
    expect(parsed.source_snapshot_ids).toEqual([source.wire.source_snapshot_id]);
    expect(parsed.snapshot.items).toEqual(source.wire.entries);
    expect(parsed.sections.map(section => section.key)).toEqual(['summary', 'recommendation-aapl']);
    expect(parsed.markdown).toBe(source.wire.markdown);
  });

  test('maps canonical unpaged history wire into a client page without inventing detail', () => {
    const report = reportFixture();
    const entry = {
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
    };
    const wire = {
      projection_version: '0.1.0',
      filters: {
        query: 'aapl',
        profile: 'us_preferred',
        market_scope: 'us',
        from_day: '2026-07-10',
        to_day: '2026-07-10',
      },
      entries: [entry],
      total: 1,
    };
    const page = parseB5ReportHistory(wire, 1, 20);
    expect(page.wire).toEqual(wire);
    expect(page.page).toBe(1);
    expect(page.page_size).toBe(20);
    expect(page.entries[0]).toMatchObject({
      snapshot_id: report.snapshot.snapshot_id,
      output_fingerprint: report.snapshot.output_fingerprint,
      top_rating: 'A',
    });
    expect(page).not.toHaveProperty('selected_report');
    expect(page).not.toHaveProperty('comparison');
  });

  test('rejects incomplete daily wire, inconsistent summary/sections and forged JCS preimage', () => {
    const report = reportFixture();
    expect(() => parseB5DailyReport({ ...report.wire, entries: [] })).toThrow(
      /output_fingerprint|summary mismatch/
    );
    expect(() =>
      parseB5DailyReport({
        ...report.wire,
        sections: report.wire.sections.slice(0, 1),
      })
    ).toThrow(/sections mismatch/);
    expect(() =>
      parseB5DailyReport({
        ...report.wire,
        source_fingerprint_preimage_jcs: jcsCanonicalize({ forged: true }),
      })
    ).toThrow(/preimage hash/);
    expect(() =>
      parseB5DailyReport({
        ...report.wire,
        source_fingerprint_preimage_jcs: '{ "not": "canonical" }',
      })
    ).toThrow(/canonical JCS/);
    expect(() =>
      parseB5DailyReport({
        ...report.wire,
        summary: {
          ...report.wire.summary,
          rating_counts: { A: 0, B: 1, C: 0, D: 0, F: 0 },
        },
      })
    ).toThrow(/summary mismatch/);
    expect(() =>
      parseB5DailyReport({
        ...report.wire,
        sections: report.wire.sections.map(section =>
          section.kind === 'summary'
            ? { ...section, high_conviction_count: section.high_conviction_count - 1 }
            : section
        ),
      })
    ).toThrow(/sections mismatch/);
    expect(() =>
      parseB5DailyReport({
        ...report.wire,
        sections: report.wire.sections.map(section =>
          section.kind === 'recommendation' ? { ...section, evidence_ids: ['E9'] } : section
        ),
      })
    ).toThrow(/sections mismatch/);
  });

  test('rejects history total/filter/entry shape mismatches', () => {
    expect(() =>
      parseB5ReportHistory({
        projection_version: '0.1.0',
        filters: {
          query: '',
          profile: null,
          market_scope: null,
          from_day: null,
          to_day: null,
        },
        entries: [],
        total: 1,
      })
    ).toThrow(/total mismatch/);
    expect(() =>
      parseB5ReportHistory({
        projection_version: '0.1.0',
        filters: { query: '', profile: null, market_scope: null, from_day: null },
        entries: [],
        total: 0,
      })
    ).toThrow(/missing required/);
    const report = reportFixture();
    const entry = {
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
    };
    const history = {
      projection_version: '0.1.0',
      filters: {
        query: '',
        profile: null,
        market_scope: null,
        from_day: null,
        to_day: null,
      },
      entries: [entry],
      total: 1,
    };
    expect(() =>
      parseB5ReportHistory({
        ...history,
        entries: [{ ...entry, source_fingerprint_preimage_jcs: '{"forged":true}' }],
      })
    ).toThrow(/canonical JCS|hash mismatch/);
    expect(() =>
      parseB5ReportHistory({
        ...history,
        filters: { ...history.filters, profile: 'japan_blue_chip', market_scope: 'us' },
      })
    ).toThrow(/incompatible/);
    expect(() =>
      parseB5ReportHistory({
        ...history,
        filters: { ...history.filters, from_day: '2026-07-11', to_day: '2026-07-10' },
      })
    ).toThrow(/date range/);
    expect(() =>
      parseB5ReportHistory({
        ...history,
        filters: { ...history.filters, profile: 'japan_blue_chip', market_scope: 'jp' },
      })
    ).toThrow(/does not satisfy filters/);
  });
});
