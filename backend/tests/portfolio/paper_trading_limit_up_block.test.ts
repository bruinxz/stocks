/**
 * PaperTradingFacade.evaluateLimitUpDownBlock — audit S-3 涨跌停 pre-trade 拦截.
 *
 * 不依赖 jest / DB:
 *   cd backend && npx ts-node --transpile-only tests/portfolio/paper_trading_limit_up_block.test.ts
 *
 * 覆盖 5 个市场段 × BUY/SELL + ST 跨段 + bypass + 缺数据 fallback。
 */

import assert from 'node:assert/strict';
import { evaluateLimitUpDownBlock } from '../../src/portfolio/PaperTradingFacade';

let passed = 0;
let failed = 0;

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

console.log('PaperTradingFacade.evaluateLimitUpDownBlock');

// ---------- BUY: 各市场段 ----------
it('主板 BUY 涨 9.9% → 放行', () => {
  const out = evaluateLimitUpDownBlock({
    symbol: 'sh.600519',
    direction: 'BUY',
    prev_close: 10.0,
    reference_price: 10.99,
  });
  assert.equal(out.ok, true);
});
it('主板 BUY 涨 10% → 拒单', () => {
  const out = evaluateLimitUpDownBlock({
    symbol: 'sh.600519',
    direction: 'BUY',
    prev_close: 10.0,
    reference_price: 11.0,
  });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'LIMIT_UP_BLOCK_BUY');
  assert.ok(out.message?.includes('涨停'));
  assert.equal(out.detail?.segment, 'main');
});
it('创业板 BUY 涨 18% → 放行 (新精确路径)', () => {
  const out = evaluateLimitUpDownBlock({
    symbol: 'sz.300033',
    direction: 'BUY',
    prev_close: 10.0,
    reference_price: 11.8,
  });
  assert.equal(out.ok, true);
});
it('创业板 BUY 涨 20% → 拒单', () => {
  const out = evaluateLimitUpDownBlock({
    symbol: 'sz.300033',
    direction: 'BUY',
    prev_close: 10.0,
    reference_price: 12.0,
  });
  assert.equal(out.ok, false);
  assert.equal(out.detail?.segment, 'chinext');
  assert.equal(out.detail?.limit_pct, 0.20);
});
it('科创板 BUY 涨 19.8% → 放行', () => {
  const out = evaluateLimitUpDownBlock({
    symbol: 'sh.688001',
    direction: 'BUY',
    prev_close: 10.0,
    reference_price: 11.98,
  });
  assert.equal(out.ok, true);
});
it('北交所 BUY 涨 25% → 放行 (新精确路径)', () => {
  const out = evaluateLimitUpDownBlock({
    symbol: 'bj.920003',
    direction: 'BUY',
    prev_close: 10.0,
    reference_price: 12.5,
  });
  assert.equal(out.ok, true);
});
it('北交所 BUY 涨 30% → 拒单', () => {
  const out = evaluateLimitUpDownBlock({
    symbol: 'bj.920003',
    direction: 'BUY',
    prev_close: 10.0,
    reference_price: 13.0,
  });
  assert.equal(out.ok, false);
  assert.equal(out.detail?.segment, 'bj');
});

// ---------- ST 跨段 ----------
it('ST 股 BUY 涨 4.5% → 放行', () => {
  const out = evaluateLimitUpDownBlock({
    symbol: 'sh.600001',
    stock_name: 'ST 邯郸',
    direction: 'BUY',
    prev_close: 10.0,
    reference_price: 10.45,
  });
  assert.equal(out.ok, true);
});
it('ST 股 BUY 涨 5% → 拒单', () => {
  const out = evaluateLimitUpDownBlock({
    symbol: 'sh.600001',
    stock_name: 'ST 邯郸',
    direction: 'BUY',
    prev_close: 10.0,
    reference_price: 10.5,
  });
  assert.equal(out.ok, false);
  assert.equal(out.detail?.is_st, true);
  assert.equal(out.detail?.limit_pct, 0.05);
});

// ---------- SELL 跌停 ----------
it('主板 SELL 跌 -9.9% → 放行', () => {
  const out = evaluateLimitUpDownBlock({
    symbol: 'sh.600519',
    direction: 'SELL',
    prev_close: 10.0,
    reference_price: 9.01,
  });
  assert.equal(out.ok, true);
});
it('主板 SELL 跌 -10% → 拒单', () => {
  const out = evaluateLimitUpDownBlock({
    symbol: 'sh.600519',
    direction: 'SELL',
    prev_close: 10.0,
    reference_price: 9.0,
  });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'LIMIT_DOWN_BLOCK_SELL');
  assert.ok(out.message?.includes('跌停'));
});
it('创业板 SELL 跌 -20% → 拒单', () => {
  const out = evaluateLimitUpDownBlock({
    symbol: 'sz.300033',
    direction: 'SELL',
    prev_close: 10.0,
    reference_price: 8.0,
  });
  assert.equal(out.ok, false);
});

// ---------- bypass / 缺数据 ----------
it('bypass=true → 放行 (即使涨停)', () => {
  const out = evaluateLimitUpDownBlock({
    symbol: 'sh.600519',
    direction: 'BUY',
    prev_close: 10.0,
    reference_price: 11.0,
    bypass: true,
  });
  assert.equal(out.ok, true);
});
it('prev_close=null → 安全 fallback 放行', () => {
  const out = evaluateLimitUpDownBlock({
    symbol: 'sh.600519',
    direction: 'BUY',
    prev_close: null,
    reference_price: 100,
  });
  assert.equal(out.ok, true);
});
it('reference_price=0 → 安全 fallback 放行', () => {
  const out = evaluateLimitUpDownBlock({
    symbol: 'sh.600519',
    direction: 'BUY',
    prev_close: 10.0,
    reference_price: 0,
  });
  assert.equal(out.ok, true);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
process.exit(0);
