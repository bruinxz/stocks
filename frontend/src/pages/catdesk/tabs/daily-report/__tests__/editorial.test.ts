import { describe, expect, test } from '@jest/globals';
import { buildAShareEditorialCopy, recommendationDisplayName, signedPercent } from '../editorial';
import { reportFixture } from '../testFixtures';

const brief = {
  trade_date: '2026-07-16',
  generated_at: '2026-07-17T08:00:00Z',
  indices: [
    {
      symbol: 'sh.000001',
      name: '上证指数',
      current_price: 3800,
      change: -40,
      change_percent: -1.04,
      five_day_change_percent: -2.1,
    },
    {
      symbol: 'sh.000300',
      name: '沪深300',
      current_price: 4500,
      change: -80,
      change_percent: -1.75,
      five_day_change_percent: -3.2,
    },
    {
      symbol: 'sz.399001',
      name: '深证成指',
      current_price: 13800,
      change: -420,
      change_percent: -2.95,
      five_day_change_percent: -4.5,
    },
    {
      symbol: 'sz.399006',
      name: '创业板指',
      current_price: 3480,
      change: -170,
      change_percent: -4.66,
      five_day_change_percent: -6.1,
    },
  ],
  breadth: { total_count: 5573, advancing_count: 914, declining_count: 4521, flat_count: 138 },
  sectors: {
    leaders: [
      {
        industry: '银行',
        average_change_percent: 0.72,
        advancing_count: 32,
        declining_count: 3,
        stock_count: 37,
        leading_stock_name: '中国银行',
        leading_stock_change_percent: 2.42,
      },
      {
        industry: '公用事业',
        average_change_percent: 0.41,
        advancing_count: 43,
        declining_count: 19,
        stock_count: 66,
        leading_stock_name: '华能水电',
        leading_stock_change_percent: 6.2,
      },
    ],
    laggards: [
      {
        industry: '半导体',
        average_change_percent: -4.2,
        advancing_count: 11,
        declining_count: 178,
        stock_count: 190,
        leading_stock_name: '测试股',
        leading_stock_change_percent: 2.1,
      },
    ],
  },
  movers: {
    gainers: [{ symbol: 'sh.600000', name: '甲公司', industry: '银行', change_percent: 10 }],
    laggards: [{ symbol: 'sz.000002', name: '乙公司', industry: '地产', change_percent: -10 }],
  },
};

describe('daily report editorial copy', () => {
  test('builds an A-share-first close article from complete-day evidence', () => {
    const report = reportFixture();
    const copy = buildAShareEditorialCopy(brief, report);
    expect(copy.tone).toBe('cautious');
    expect(copy.headline).toBe('A股收盘：主要指数集体回落，创业板指跌幅居前');
    expect(copy.lead).toContain('上涨 914 家、下跌 4521 家');
    expect(copy.sector_paragraph).toContain('银行+0.72%');
    expect(copy.sector_paragraph).toContain('半导体-4.20%');
    expect(copy.mover_paragraph).toContain('甲公司涨幅居前');
    expect(copy.watch_paragraph).toContain('AAPL');
  });

  test('formats signed percentages and extracts a human company name from evidence', () => {
    expect(signedPercent(1.234)).toBe('+1.23%');
    expect(signedPercent(-0.8)).toBe('-0.80%');
    const item = reportFixture().snapshot.items[0];
    item.recommendation.evidence_refs[0].short_text = '苹果公司：季度证据';
    expect(recommendationDisplayName(item)).toBe('苹果公司');
  });
});
