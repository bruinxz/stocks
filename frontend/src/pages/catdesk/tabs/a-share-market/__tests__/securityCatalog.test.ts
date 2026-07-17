import { describe, expect, test } from '@jest/globals';
import {
  buildSecurityListParams,
  securityTypeLabel,
  type SecurityDescriptor,
  type SecurityTypeLabel,
} from '../securityCatalog';

const TYPE_CASES: Array<[SecurityDescriptor, SecurityTypeLabel]> = [
  [{ type: 'stock', name: '贵州茅台' }, '股票'],
  [{ type: 'index', name: '沪深300' }, '指数'],
  [{ type: 'fund', industry: 'ETF', name: '沪深300ETF' }, 'ETF'],
  [{ type: 'fund', industry: '公募基金', name: '某开放式基金' }, '基金'],
  [{ type: 'bond', name: '国开债' }, '债券'],
  [{ type: null, industry: 'ETF', name: '历史ETF行' }, 'ETF'],
  [{ type: null, name: '待整理证券' }, '未分类'],
];

describe('A-share security catalogue', () => {
  test.each(TYPE_CASES)('maps %j to %s', (security, expected) => {
    expect(securityTypeLabel(security)).toBe(expected);
  });

  test('does not add a type filter that would hide indices or ETFs', () => {
    const params = buildSecurityListParams({
      page: 2,
      limit: 50,
      market: '',
      search: '沪深300',
    });

    expect(params).toEqual({
      page: 2,
      limit: 50,
      listedOnly: 'true',
      search: '沪深300',
    });
    expect(params).not.toHaveProperty('type');
    expect(params).not.toHaveProperty('instrument_type');
  });
});
