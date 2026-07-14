import { describe, expect, test } from '@jest/globals';
import {
  JpKrContractError,
  parseJpKrDetailResponse,
  parseJpKrMarketResponse,
} from '../jpkrAdapters';

const DATE = '2026-07-10';

function marketRow(overrides: Record<string, unknown> = {}) {
  return {
    symbol: '7203',
    name_local: 'トヨタ自動車',
    name_en: 'Toyota Motor',
    market: 'JP',
    sector: 'automotive',
    close: 3125.5,
    change_pct: 1.25,
    currency: 'JPY',
    disclosure_events: [
      {
        title: '決算短信',
        doc_type: 'earnings',
        filed_at: '2026-07-10T05:00:00Z',
        source: 'jpx-edinet',
        doc_url: 'https://example.test/filing',
      },
    ],
    revenue_by_region: [{ region: 'Japan', pct: 30 }],
    fx_beta: 0.75,
    is_halted: false,
    data_sources: ['jpx-edinet', 'jpx-daily-statistics-pdf'],
    score: null,
    risk_gate: null,
    risk_triggers: [],
    ...overrides,
  };
}

function response(overrides: Record<string, unknown> = {}) {
  return {
    date: DATE,
    kpi: {
      nikkei225: { value: 41000.5, change_pct: 0.8, as_of: DATE },
      topix: { value: 2900.25, change_pct: 0.4, as_of: DATE },
      kospi: null,
      usdjpy: { rate: 150.25, change_pct: 0.2, as_of: DATE },
      usdkrw: { rate: 1380.5, change_pct: -0.1, as_of: DATE },
    },
    rows: [marketRow()],
    ...overrides,
  };
}

describe('JPKR strict frontend adapter', () => {
  test('parses the canonical list wire including both FX KPI snapshots', () => {
    const parsed = parseJpKrMarketResponse(response(), DATE, 'JP');

    expect(parsed.kpi.usdjpy).toEqual({ rate: 150.25, change_pct: 0.2, as_of: DATE });
    expect(parsed.kpi.usdkrw).toEqual({ rate: 1380.5, change_pct: -0.1, as_of: DATE });
    expect(parsed.kpi.kospi).toBeNull();
    expect(parsed.rows[0]).toMatchObject({
      symbol: '7203',
      market: 'JP',
      currency: 'JPY',
      disclosure_events: [{ source: 'jpx-edinet' }],
    });
  });

  test('normalizes absent KPI slots to explicit unavailable nulls', () => {
    const parsed = parseJpKrMarketResponse(response({ kpi: { nikkei225: null } }), DATE, 'JP');

    expect(parsed.kpi).toEqual({
      nikkei225: null,
      topix: null,
      kospi: null,
      usdjpy: null,
      usdkrw: null,
    });
  });

  test('rejects numeric strings and future-dated KPI facts instead of coercing them', () => {
    expect(() =>
      parseJpKrMarketResponse(
        response({
          kpi: {
            nikkei225: null,
            topix: null,
            kospi: null,
            usdjpy: { rate: '150.25', change_pct: 0.2, as_of: DATE },
            usdkrw: null,
          },
        }),
        DATE,
        'JP'
      )
    ).toThrow(/rate must be a finite number/);

    expect(() =>
      parseJpKrMarketResponse(
        response({
          kpi: {
            nikkei225: { value: 41000.5, change_pct: 0.8, as_of: '2026-07-11' },
          },
        }),
        DATE,
        'JP'
      )
    ).toThrow(/cannot be after the requested date/);

    expect(() =>
      parseJpKrMarketResponse(
        response({ kpi: { usdkrw: { rate: 0, change_pct: 0, as_of: DATE } } }),
        DATE,
        'JP'
      )
    ).toThrow(/rate must be greater than zero/);
  });

  test('rejects envelope date, market, and currency mismatches', () => {
    expect(() => parseJpKrMarketResponse(response({ date: '2026-07-09' }), DATE, 'JP')).toThrow(
      /does not match request/
    );
    expect(() =>
      parseJpKrMarketResponse(
        response({ rows: [marketRow({ market: 'KR', currency: 'KRW' })] }),
        DATE,
        'JP'
      )
    ).toThrow(/market does not match request/);
    expect(() =>
      parseJpKrMarketResponse(response({ rows: [marketRow({ currency: 'KRW' })] }), DATE, 'JP')
    ).toThrow(/currency must be JPY for JP/);
  });

  test('rejects untrusted nested shapes, disclosure sources, and extra fields', () => {
    expect(() =>
      parseJpKrMarketResponse(response({ rows: [marketRow({ score: 84 })] }), DATE, 'JP')
    ).toThrow(/score must be an object or null/);
    expect(() =>
      parseJpKrMarketResponse(
        response({
          rows: [
            marketRow({
              disclosure_events: [
                {
                  title: 'notice',
                  doc_type: 'event',
                  filed_at: '2026-07-10T05:00:00Z',
                  source: 'anonymous-feed',
                },
              ],
            }),
          ],
        }),
        DATE,
        'JP'
      )
    ).toThrow(/not an authorized disclosure source/);
    expect(() => parseJpKrMarketResponse({ ...response(), debug: true }, DATE, 'JP')).toThrow(
      /unexpected field/
    );
  });

  test('validates detail rows and binds them to the requested symbol', () => {
    expect(parseJpKrDetailResponse(marketRow(), '7203').symbol).toBe('7203');
    expect(() => parseJpKrDetailResponse(marketRow(), '005930')).toThrow(/does not match request/);
    expect(() => parseJpKrDetailResponse([], '7203')).toThrow(JpKrContractError);
  });
});
