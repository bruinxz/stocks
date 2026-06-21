/**
 * marketLimits — unit tests (audit S-2 + S-3 修复).
 *
 * 不依赖 jest；直接 ts-node：
 *   cd backend && npx ts-node --transpile-only tests/quant/marketLimits.test.ts
 *
 * 覆盖维度：
 *   - inferMarketSegment: sh.6xx / sh.688 / sz.0xx / sz.3xx / bj.92 / bj.43 /
 *                          后缀格式 / 北交所 BJ
 *   - getLimitPct: main 10% / chinext + star 20% / bj 30% / ST 5% (跨段)
 *   - roundToTick: half-up / 浮点尾巴 / 负数
 *   - getLimitPrices: prevClose ≤ 0 抛错 / 边界值精确
 *   - isAtLimitUp / isAtLimitDown: 严格 / open / high / close 任一即命中
 *   - 业务级 5 段 × 涨跌停: 300033 +12% / 688001 +18% / 920001 +25% / 600519 +9.9% / ST +4.5%
 *   - describeLimits: 一步出 segment + is_st + limit_pct
 *   - isBeijingExchange: bj* / sh* / sz*
 */

import assert from 'node:assert/strict';
import {
  MarketSegment,
  MAIN_LIMIT_PCT,
  CHINEXT_LIMIT_PCT,
  STAR_LIMIT_PCT,
  BJ_LIMIT_PCT,
  ST_LIMIT_PCT,
  inferMarketSegment,
  getLimitPct,
  roundToTick,
  getLimitPrices,
  isAtLimitUp,
  isAtLimitDown,
  isBeijingExchange,
  describeLimits,
} from '../../src/quant/marketLimits';

let failed = 0;
let passed = 0;

function it(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok  ${name}`);
    passed += 1;
  } catch (err: any) {
    console.error(`  FAIL ${name}: ${err?.message || err}`);
    if (err?.stack) console.error(err.stack);
    failed += 1;
  }
}

async function main() {
  console.log('marketLimits');

  // ---------- inferMarketSegment ----------
  it('sh.6xx → main', () => {
    assert.equal(inferMarketSegment('sh.600519'), 'main');
    assert.equal(inferMarketSegment('sh.601318'), 'main');
  });
  it('sh.688 → star', () => {
    assert.equal(inferMarketSegment('sh.688001'), 'star');
    assert.equal(inferMarketSegment('688001'), 'star');
    assert.equal(inferMarketSegment('688001.SH'), 'star');
  });
  it('sz.3xx → chinext', () => {
    assert.equal(inferMarketSegment('sz.300033'), 'chinext');
    assert.equal(inferMarketSegment('300033'), 'chinext');
    assert.equal(inferMarketSegment('300033.SZ'), 'chinext');
  });
  it('sz.0xx → main', () => {
    assert.equal(inferMarketSegment('sz.000001'), 'main');
    assert.equal(inferMarketSegment('000001'), 'main');
  });
  it('sz.2xx → main (中小板已并入主板)', () => {
    assert.equal(inferMarketSegment('sz.002594'), 'main');
  });
  it('bj.92xxxx → bj', () => {
    assert.equal(inferMarketSegment('bj.920003'), 'bj');
    assert.equal(inferMarketSegment('920003'), 'bj');
    assert.equal(inferMarketSegment('920003.BJ'), 'bj');
  });
  it('bj.43xxxx → bj', () => {
    assert.equal(inferMarketSegment('bj.430139'), 'bj');
    assert.equal(inferMarketSegment('430139'), 'bj');
  });
  it('bj.8xxxxx → bj', () => {
    assert.equal(inferMarketSegment('bj.873169'), 'bj');
    assert.equal(inferMarketSegment('873169'), 'bj');
  });
  it('bj.4xxxxx (无显式 bj 前缀) → bj', () => {
    assert.equal(inferMarketSegment('430139'), 'bj');
  });
  it('null / empty / 不识别 → unknown', () => {
    assert.equal(inferMarketSegment(null), 'unknown');
    assert.equal(inferMarketSegment(undefined), 'unknown');
    assert.equal(inferMarketSegment(''), 'unknown');
    assert.equal(inferMarketSegment('xx.000000'), 'main'); // unknown prefix, code "000000" -> main (0 开头)
  });

  // ---------- getLimitPct ----------
  it('main 段非 ST = 10%', () => {
    assert.equal(getLimitPct('main', false), MAIN_LIMIT_PCT);
    assert.equal(getLimitPct('main', false), 0.10);
  });
  it('chinext 段非 ST = 20%', () => {
    assert.equal(getLimitPct('chinext', false), CHINEXT_LIMIT_PCT);
    assert.equal(getLimitPct('chinext', false), 0.20);
  });
  it('star 段非 ST = 20%', () => {
    assert.equal(getLimitPct('star', false), STAR_LIMIT_PCT);
  });
  it('bj 段非 ST = 30%', () => {
    assert.equal(getLimitPct('bj', false), BJ_LIMIT_PCT);
  });
  it('ST 跨段全部 5%', () => {
    assert.equal(getLimitPct('main', true), ST_LIMIT_PCT);
    assert.equal(getLimitPct('chinext', true), ST_LIMIT_PCT);
    assert.equal(getLimitPct('star', true), ST_LIMIT_PCT);
    assert.equal(getLimitPct('bj', true), ST_LIMIT_PCT); // 北交所 ST 仍 5%
    assert.equal(getLimitPct('unknown', true), ST_LIMIT_PCT);
  });
  it('unknown 段非 ST = 10% (兜底主板)', () => {
    assert.equal(getLimitPct('unknown', false), MAIN_LIMIT_PCT);
  });

  // ---------- roundToTick ----------
  it('half-up rounding to 0.01', () => {
    assert.equal(roundToTick(12.345), 12.35);
    assert.equal(roundToTick(12.344), 12.34);
    assert.equal(roundToTick(12.341), 12.34);
  });
  it('浮点尾巴清理', () => {
    assert.equal(roundToTick(0.1 + 0.2), 0.30); // 0.30000000000004 → 0.30
  });
  it('负数 half-away-from-zero', () => {
    assert.equal(roundToTick(-1.235), -1.24);
    assert.equal(roundToTick(-1.234), -1.23);
  });
  it('非 finite → 原值', () => {
    assert.equal(roundToTick(NaN), NaN);
    assert.equal(roundToTick(Infinity), Infinity);
  });

  // ---------- getLimitPrices ----------
  it('prevClose ≤ 0 抛 RangeError', () => {
    assert.throws(() => getLimitPrices(0, 'main', false), /invalid prev_close/);
    assert.throws(() => getLimitPrices(-1, 'main', false), /invalid prev_close/);
    assert.throws(() => getLimitPrices(NaN, 'main', false), /invalid prev_close/);
  });
  it('main 段 10% 涨跌停', () => {
    const { upper, lower } = getLimitPrices(10.0, 'main', false);
    assert.equal(upper, 11.0);
    assert.equal(lower, 9.0);
  });
  it('chinext 段 20% 涨跌停', () => {
    const { upper, lower } = getLimitPrices(10.0, 'chinext', false);
    assert.equal(upper, 12.0);
    assert.equal(lower, 8.0);
  });
  it('star 段 20% 涨跌停 (含 tick round)', () => {
    const { upper, lower } = getLimitPrices(12.34, 'star', false);
    // 12.34 * 1.2 = 14.808 → round-tick 14.81
    assert.equal(upper, 14.81);
    // 12.34 * 0.8 = 9.872 → 9.87
    assert.equal(lower, 9.87);
  });
  it('bj 段 30% 涨跌停', () => {
    const { upper, lower } = getLimitPrices(10.0, 'bj', false);
    assert.equal(upper, 13.0);
    assert.equal(lower, 7.0);
  });
  it('ST 5% 涨跌停', () => {
    const { upper, lower } = getLimitPrices(10.0, 'main', true);
    assert.equal(upper, 10.5);
    assert.equal(lower, 9.5);
  });
  it('ST + 北交所仍 5%', () => {
    const { upper } = getLimitPrices(10.0, 'bj', true);
    assert.equal(upper, 10.5);
  });

  // ---------- isAtLimitUp / isAtLimitDown 业务级 5 段 case ----------
  it('300033 涨 12% → 不拦截 (chinext 上限 20%)', () => {
    // prev_close=10, today close=11.2 (+12%)
    const segment = inferMarketSegment('sz.300033');
    const hit = isAtLimitUp({ open: 11.0, high: 11.2, close: 11.2 }, segment, false, 10.0);
    assert.equal(hit, false);
  });
  it('300033 涨 20% → 拦截', () => {
    const segment = inferMarketSegment('sz.300033');
    const hit = isAtLimitUp({ open: 11.0, high: 12.0, close: 12.0 }, segment, false, 10.0);
    assert.equal(hit, true);
  });
  it('688001 涨 18% → 不拦截 (star 上限 20%)', () => {
    const segment = inferMarketSegment('sh.688001');
    const hit = isAtLimitUp({ open: 11.0, high: 11.8, close: 11.8 }, segment, false, 10.0);
    assert.equal(hit, false);
  });
  it('920001 涨 25% → 不拦截 (bj 上限 30%)', () => {
    const segment = inferMarketSegment('bj.920001');
    const hit = isAtLimitUp({ open: 11.0, high: 12.5, close: 12.5 }, segment, false, 10.0);
    assert.equal(hit, false);
  });
  it('600519 涨 9.9% → 不拦截 (main 上限 10%)', () => {
    const segment = inferMarketSegment('sh.600519');
    const hit = isAtLimitUp({ open: 10.5, high: 10.99, close: 10.99 }, segment, false, 10.0);
    assert.equal(hit, false);
  });
  it('600519 涨 10% → 拦截', () => {
    const segment = inferMarketSegment('sh.600519');
    const hit = isAtLimitUp({ open: 10.5, high: 11.0, close: 11.0 }, segment, false, 10.0);
    assert.equal(hit, true);
  });
  it('600519 涨 9.95% → 不拦截 (差距大于 1bp epsilon)', () => {
    // upper = 11.0, threshold = 11.0 * (1-1e-4) = 10.99890
    // high=10.995 < 10.99890 → 不拦截
    const segment = inferMarketSegment('sh.600519');
    const hit = isAtLimitUp({ open: 10.5, high: 10.995, close: 10.995 }, segment, false, 10.0);
    assert.equal(hit, false);
  });
  it('ST 股涨 4.5% → 不拦截 (ST 上限 5%)', () => {
    const segment = inferMarketSegment('sh.600001');
    const hit = isAtLimitUp({ open: 10.3, high: 10.45, close: 10.45 }, segment, true, 10.0);
    assert.equal(hit, false);
  });
  it('ST 股涨 5% → 拦截', () => {
    const segment = inferMarketSegment('sh.600001');
    const hit = isAtLimitUp({ open: 10.3, high: 10.5, close: 10.5 }, segment, true, 10.0);
    assert.equal(hit, true);
  });
  it('open 高开涨停亦命中 (close 未到也算)', () => {
    const segment: MarketSegment = 'main';
    const hit = isAtLimitUp({ open: 11.0, high: 11.0, close: 10.5 }, segment, false, 10.0);
    assert.equal(hit, true);
  });
  it('跌停: 跌 -10% → 命中', () => {
    const hit = isAtLimitDown({ open: 9.5, low: 9.0, close: 9.0 }, 'main', false, 10.0);
    assert.equal(hit, true);
  });
  it('跌停: 跌 -9.9% → 不命中', () => {
    const hit = isAtLimitDown({ open: 9.5, low: 9.01, close: 9.01 }, 'main', false, 10.0);
    assert.equal(hit, false);
  });
  it('跌停 chinext: 跌 -19.9% → 不命中', () => {
    const hit = isAtLimitDown({ open: 8.5, low: 8.01, close: 8.01 }, 'chinext', false, 10.0);
    assert.equal(hit, false);
  });
  it('跌停 chinext: 跌 -20% → 命中', () => {
    const hit = isAtLimitDown({ open: 8.5, low: 8.0, close: 8.0 }, 'chinext', false, 10.0);
    assert.equal(hit, true);
  });

  // ---------- isBeijingExchange ----------
  it('isBeijingExchange', () => {
    assert.equal(isBeijingExchange('bj.920003'), true);
    assert.equal(isBeijingExchange('920003.BJ'), true);
    assert.equal(isBeijingExchange('430139'), true);
    assert.equal(isBeijingExchange('873169'), true);
    assert.equal(isBeijingExchange('sh.600519'), false);
    assert.equal(isBeijingExchange('sz.300033'), false);
    assert.equal(isBeijingExchange(null), false);
  });

  // ---------- describeLimits ----------
  it('describeLimits — 创业板正常', () => {
    const out = describeLimits('sz.300033', '中科曙光', 12.0);
    assert.equal(out.segment, 'chinext');
    assert.equal(out.is_st, false);
    assert.equal(out.limit_pct, 0.20);
    assert.equal(out.upper, 14.40);
    assert.equal(out.lower, 9.60);
  });
  it('describeLimits — ST 股 5% 覆盖市场段', () => {
    const out = describeLimits('sh.600001', 'ST 邯郸', 10.0);
    assert.equal(out.is_st, true);
    assert.equal(out.limit_pct, 0.05);
    assert.equal(out.upper, 10.50);
    assert.equal(out.lower, 9.50);
  });
  it('describeLimits — prev_close 缺失 upper/lower 为 null', () => {
    const out = describeLimits('sh.600519', '贵州茅台', 0);
    assert.equal(out.upper, null);
    assert.equal(out.lower, null);
    assert.equal(out.segment, 'main');
  });

  // ---------- prev_close 缺失时 isAtLimitUp/Down 安全返回 false ----------
  it('prev_close ≤ 0 时 isAtLimitUp 返回 false (不抛错)', () => {
    assert.equal(isAtLimitUp({ open: 11, high: 12, close: 12 }, 'main', false, 0), false);
    assert.equal(isAtLimitDown({ open: 9, low: 8, close: 8 }, 'main', false, NaN), false);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
