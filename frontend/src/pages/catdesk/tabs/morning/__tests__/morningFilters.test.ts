import { describe, expect, test } from '@jest/globals';
import type { CandidateListEntry } from '../../c1Types';
import { matchesMorningCatalyst, morningCatalystKind } from '../morningFilters';

function candidate(latest_catalyst?: CandidateListEntry['latest_catalyst']): CandidateListEntry {
  return {
    symbol: '600000',
    name: '浦发银行',
    latest_catalyst,
  } as CandidateListEntry;
}

describe('morning catalyst filters', () => {
  test('treats a missing catalyst as the displayed unclassified category', () => {
    const row = candidate();

    expect(morningCatalystKind(row)).toBe('unclassified');
    expect(matchesMorningCatalyst(row, 'unclassified')).toBe(true);
    expect(matchesMorningCatalyst(row, 'earnings')).toBe(false);
  });

  test('matches an explicit catalyst kind without changing it', () => {
    const row = candidate({
      kind: 'product',
      title: '新品发布',
      occurred_at: '2026-07-17T01:00:00Z',
    });

    expect(morningCatalystKind(row)).toBe('product');
    expect(matchesMorningCatalyst(row, 'product')).toBe(true);
    expect(matchesMorningCatalyst(row, 'unclassified')).toBe(false);
  });
});
