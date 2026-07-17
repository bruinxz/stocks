import { describe, expect, test } from '@jest/globals';
import { mergeHistoryQuery, parseHistoryQuery } from '../queryState';

describe('report history query state', () => {
  test('keeps report history on the detailed A-share scope', () => {
    expect(
      parseHistoryQuery(
        '?date=2026-07-10&profile=us_preferred&market_scope=us&search=AAPL&page=2&page_size=500'
      )
    ).toEqual({
      date: '2026-07-10',
      profile: 'us_preferred',
      market_scope: 'cn_a',
      search: 'AAPL',
      page: 2,
      page_size: 100,
    });
  });

  test('preserves unrelated query state and removes cleared filters', () => {
    expect(
      mergeHistoryQuery('?tab=history&portfolio=core&search=AAPL', {
        search: undefined,
        profile: 'japan_blue_chip',
        market_scope: 'jp',
        page: 1,
      })
    ).toBe('?tab=history&portfolio=core&profile=japan_blue_chip&market_scope=jp&page=1');
  });

  test('ignores overseas deep-link scopes instead of rendering per-stock overseas reports', () => {
    expect(parseHistoryQuery('?profile=japan_blue_chip&market_scope=jp&page=1')).toMatchObject({
      profile: 'us_preferred',
      market_scope: 'cn_a',
    });
  });
});
