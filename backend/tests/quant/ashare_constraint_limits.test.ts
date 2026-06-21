/**
 * AShareConstraintEngine — 涨跌停精确路径 (audit S-2 修复).
 *
 * 不依赖 jest:
 *   cd backend && npx ts-node --transpile-only tests/quant/ashare_constraint_limits.test.ts
 *
 * 覆盖维度: 5 个市场段的 BUY/SELL 拒单 / 允单 + ST 跨段 + 缺 prev_close 兜底
 */

import assert from 'node:assert/strict';
import {
  AShareConstraintEngine,
  DEFAULT_CONSTRAINT_SETTINGS,
  DEFAULT_FEE_SETTINGS,
  DEFAULT_SLIPPAGE_SETTINGS,
  RejectionReason,
} from '../../src/quant/backtest/AShareConstraintEngine';
import type { QuantBar } from '../../src/quant/types/QuantTypes';

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

function makeBar(close: number, change_percent: number | null = null): QuantBar {
  return {
    time: new Date('2026-05-15T15:00:00Z'),
    open: close,
    high: close,
    low: close,
    close,
    volume: 1_000_000,
    turnover: 1_000_000 * close,
    change_percent,
  };
}

const engine = new AShareConstraintEngine(
  DEFAULT_CONSTRAINT_SETTINGS,
  DEFAULT_FEE_SETTINGS,
  DEFAULT_SLIPPAGE_SETTINGS
);

console.log('AShareConstraintEngine (audit S-2)');

// ---------- 主板 sh.6xx 涨 9.9% → 允单 / 涨 10% → 拒单 ----------
it('main sh.6xx +9.9% → 允单', () => {
  const result = engine.evaluateOrder({
    side: 'buy',
    bar: makeBar(10.99),
    symbol: 'sh.603001',
    prev_close: 10.0,
    trade_date: '2026-05-15',
  });
  assert.equal(result.ok, true);
});
it('main sh.6xx +10% → 拒单', () => {
  const result = engine.evaluateOrder({
    side: 'buy',
    bar: makeBar(11.00),
    symbol: 'sh.603001',
    prev_close: 10.0,
    trade_date: '2026-05-15',
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, RejectionReason.LIMIT_UP_BLOCK_BUY);
});

// ---------- 创业板 sz.3xx 涨 12% → 允单 / 涨 20% → 拒单 ----------
it('chinext sz.3xx +12% → 允单 (旧 limit_up_pct=9.8 路径会拒, 新精确路径放行)', () => {
  const result = engine.evaluateOrder({
    side: 'buy',
    bar: makeBar(11.2),
    symbol: 'sz.300033',
    prev_close: 10.0,
    trade_date: '2026-05-15',
  });
  assert.equal(result.ok, true);
});
it('chinext sz.3xx +20% → 拒单', () => {
  const result = engine.evaluateOrder({
    side: 'buy',
    bar: makeBar(12.0),
    symbol: 'sz.300033',
    prev_close: 10.0,
    trade_date: '2026-05-15',
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, RejectionReason.LIMIT_UP_BLOCK_BUY);
});

// ---------- 科创板 sh.688 涨 18% → 允单 ----------
it('star sh.688 +18% → 允单', () => {
  const result = engine.evaluateOrder({
    side: 'buy',
    bar: makeBar(11.8),
    symbol: 'sh.688001',
    prev_close: 10.0,
    trade_date: '2026-05-15',
  });
  assert.equal(result.ok, true);
});

// ---------- 北交所 bj.92 涨 25% → 允单 / 涨 30% → 拒单 ----------
it('bj.92 +25% → 允单 (旧 limit_up_pct=9.8 路径会拒)', () => {
  const result = engine.evaluateOrder({
    side: 'buy',
    bar: makeBar(12.5),
    symbol: 'bj.920003',
    prev_close: 10.0,
    trade_date: '2026-05-15',
  });
  assert.equal(result.ok, true);
});
it('bj.92 +30% → 拒单', () => {
  const result = engine.evaluateOrder({
    side: 'buy',
    bar: makeBar(13.0),
    symbol: 'bj.920003',
    prev_close: 10.0,
    trade_date: '2026-05-15',
  });
  assert.equal(result.ok, false);
});

// ---------- ST 股涨 4.5% → 允单 / 涨 5% → 拒单 ----------
// 默认 settings.block_st_stocks=true 会先把 ST 过滤掉,
// 这里 override settings.block_st_stocks=false 让涨跌停规则可被验证。
it('ST 股 +4.5% → 允单 (block_st=off, 仅看涨跌停)', () => {
  const result = engine.evaluateOrder({
    side: 'buy',
    bar: makeBar(10.45),
    symbol: 'sh.600001',
    stock_name: 'ST 邯郸',
    prev_close: 10.0,
    trade_date: '2026-05-15',
    settings: { block_st_stocks: false },
  });
  assert.equal(result.ok, true);
});
it('ST 股 +5% → 拒单 (block_st=off, 触发涨停)', () => {
  const result = engine.evaluateOrder({
    side: 'buy',
    bar: makeBar(10.5),
    symbol: 'sh.600001',
    stock_name: 'ST 邯郸',
    prev_close: 10.0,
    trade_date: '2026-05-15',
    settings: { block_st_stocks: false },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, RejectionReason.LIMIT_UP_BLOCK_BUY);
});
it('ST 股默认 settings 仍被 ST guard 拦截 (block_st=on)', () => {
  const result = engine.evaluateOrder({
    side: 'buy',
    bar: makeBar(10.45),
    symbol: 'sh.600001',
    stock_name: 'ST 邯郸',
    prev_close: 10.0,
    trade_date: '2026-05-15',
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, RejectionReason.ST_FILTERED);
});

// ---------- 跌停 SELL: 创业板 -19.9% → 允卖 / -20% → 拒卖 ----------
it('chinext SELL -19.9% → 允卖', () => {
  const result = engine.evaluateOrder({
    side: 'sell',
    bar: makeBar(8.01),
    symbol: 'sz.300033',
    prev_close: 10.0,
    trade_date: '2026-05-15',
  });
  assert.equal(result.ok, true);
});
it('chinext SELL -20% → 拒卖', () => {
  const result = engine.evaluateOrder({
    side: 'sell',
    bar: makeBar(8.0),
    symbol: 'sz.300033',
    prev_close: 10.0,
    trade_date: '2026-05-15',
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, RejectionReason.LIMIT_DOWN_BLOCK_SELL);
});

// ---------- 缺 prev_close 时回退到 change_percent legacy 路径 ----------
it('缺 prev_close + change_percent=9.5% → 主板 legacy 路径允单', () => {
  const result = engine.evaluateOrder({
    side: 'buy',
    bar: makeBar(10.95, 9.5),
    symbol: 'sh.603001',
    trade_date: '2026-05-15',
  });
  assert.equal(result.ok, true);
});
it('缺 prev_close + change_percent=10% → legacy 路径拒单', () => {
  const result = engine.evaluateOrder({
    side: 'buy',
    bar: makeBar(11.0, 10.0),
    symbol: 'sh.603001',
    trade_date: '2026-05-15',
  });
  assert.equal(result.ok, false);
});
it('缺 symbol + change_percent=21% → legacy 路径误判按主板拒 (旧行为兼容)', () => {
  const result = engine.evaluateOrder({
    side: 'buy',
    bar: makeBar(12.1, 21),
    // 注意: 不传 symbol → legacy 用 settings.limit_up_pct=9.8 判定
    trade_date: '2026-05-15',
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, RejectionReason.LIMIT_UP_BLOCK_BUY);
});

// ---------- executionPrice round_to_tick 验证 ----------
it('executionPrice round_to_tick (买入加滑点 round 到 0.01)', () => {
  // 默认 dynamic slippage 开 + turnover=12.345M < 30M → slippage * 1.8 = 0.0036
  // 12.345 * (1 + 0.0036) = 12.389442 → round 12.39
  const out = engine.executionPrice(makeBar(12.345), 'buy', 'same_close');
  assert.equal(out.price, 12.39);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
