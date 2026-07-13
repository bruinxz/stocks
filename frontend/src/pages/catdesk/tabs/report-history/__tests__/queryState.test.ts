import { describe, expect, test } from '@jest/globals';
import { mergeHistoryQuery, parseHistoryQuery } from '../queryState';

describe('report history query state', () => {
  test('parses explicit date/profile/scope/search and bounded pagination', () => {
    expect(
      parseHistoryQuery(
        '?date=2026-07-10&profile=us_preferred&market_scope=us&search=AAPL&page=2&page_size=500'
      )
    ).toEqual({
      date: '2026-07-10',
      profile: 'us_preferred',
      market_scope: 'us',
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

  test('rejects incompatible profile/scope pairs', () => {
    expect(() => parseHistoryQuery('?profile=japan_blue_chip&market_scope=us&page=1')).toThrow(
      /incompatible/
    );
  });
});
