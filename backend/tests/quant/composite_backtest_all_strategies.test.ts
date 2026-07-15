/**
 * Signal-First — Composite backtest caller 接通 (当前已注册策略 trade_count > 0).
 *
 *   cd backend && npx ts-node --transpile-only tests/quant/composite_backtest_all_strategies.test.ts
 *
 * 上下文:
 *   - audit S-1 在 QuantBacktestEngine 已落"组合级路径": 当 caller 在
 *     `options.precomputed_composite_signals[strategy_key]` 预填
 *     rebalanceDate → target_portfolio 时, 引擎按 diff 当前持仓产生
 *     BUY/SELL pending orders, 用 next_open 撮合 (见
 *     backend/src/quant/backtest/internal/QuantBacktestEngine.ts:212-270).
 *   - 已有 tests/quant/composite_backtest_smoke.test.ts 用一只 mock 组合级
 *     策略验证该路径; 但 strategyRegistry 实际注册了 13 个组合级策略
 *     (MultiFactorAlpha / DragonHead / Breakout / Earnings / GARP /
 *      GameTrader / HighDividend / LeftSide / Linkage / Northbound /
 *      CTA100 / SectorRotation / Ensemble) — US-016 要求"12 策略 trade_count
 *     > 0".
 *   - 本测试枚举 strategyRegistry, 过滤 `typeof generateSignals === 'function'`
 *     的策略, 对每个真实策略 (不 mock) 喂 5 个 mock symbol × 60 日 bar +
 *     2 个预填 rebalance 信号 (day 5 入 A, day 30 切到 B), 期望 trade_count
 *     ≥ 2 (BUY A + SELL A + BUY B = 至少 2). 这条用例同时是 META-GUARD —
 *     任何 (a) 新加组合级策略忘了 wire / (b) 改坏引擎 composite branch /
 *     (c) 策略 definition.strategy_key 与注册不一致, 都会立刻挂在这里.
 *   - 注意: 这里 NOT 调真实 strategy.generateSignals(...) (那需要 DB +
 *     factor_scores). caller-prefetch 的语义就是把组合级信号"算出来后塞给
 *     引擎", 所以测试用合成 precomputed 信号驱动引擎也是契约的一部分 —
 *     与 audit S-1 的设计意图一致 (caller-prefetch + engine-consume 分离).
 */

import assert from 'node:assert/strict';
import { QuantBacktestEngine } from '../../src/quant/backtest/internal/QuantBacktestEngine';
import { strategyRegistry } from '../../src/quant/engine/StrategyRegistry';
import type { QuantBar, QuantStockContext } from '../../src/quant/types/QuantTypes';

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

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function makeContext(
  symbol: string,
  name: string,
  startDate: string,
  days: number,
  basePrice: number
): QuantStockContext {
  const bars: QuantBar[] = [];
  const start = new Date(`${startDate}T00:00:00Z`);
  for (let i = 0; i < days; i++) {
    const t = new Date(start);
    t.setUTCDate(start.getUTCDate() + i);
    // 跳过周末 (Sat=6 Sun=0) — 与 composite_backtest_smoke.test.ts 同款日历过滤
    const dow = t.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const price = basePrice * (1 + i * 0.001);
    bars.push({
      time: t,
      open: price,
      high: price * 1.005,
      low: price * 0.995,
      close: price,
      volume: 5_000_000,
      turnover: 5_000_000 * price,
      change_percent: 0.1,
    });
  }
  return { stock_id: 0, symbol, name, bars };
}

/**
 * 列出 strategyRegistry 中所有实现了 `generateSignals` 的组合级策略.
 *
 * 这里直接用 list() 拿 definition, 再用 get() 拿实例做 `typeof
 * generateSignals === 'function'` 探测 — 与 QuantBacktestEngine.run()
 * 第 144 行同款判定, 行为对齐.
 */
function listCompositeStrategyKeys(): string[] {
  const keys: string[] = [];
  for (const def of strategyRegistry.list()) {
    const inst = strategyRegistry.get(def.strategy_key);
    if (!inst) continue;
    if (typeof (inst as any).generateSignals === 'function') {
      keys.push(def.strategy_key);
    }
  }
  return [...new Set(keys)].sort();
}

console.log('Signal-First — composite backtest caller 全部已注册策略 trade_count > 0');

const compositeKeys = listCompositeStrategyKeys();
console.log(`  发现 ${compositeKeys.length} 个组合级策略: ${compositeKeys.join(', ')}`);

it('strategyRegistry 至少注册一个 Signal-First 组合级策略', () => {
  assert.ok(
    compositeKeys.length >= 1,
    `期望至少一个组合级策略, 实际 ${compositeKeys.length}: ${compositeKeys.join(', ')}`
  );
});

// 准备 5 个 mock symbol × 60 个交易日 — 与 smoke 文件同款日历
const SYMBOLS = [
  { symbol: 'sh.600519', name: '贵州茅台', basePrice: 100 },
  { symbol: 'sz.000858', name: '五粮液', basePrice: 50 },
  { symbol: 'sz.300750', name: '宁德时代', basePrice: 200 },
  { symbol: 'sh.601318', name: '中国平安', basePrice: 45 },
  { symbol: 'sh.600036', name: '招商银行', basePrice: 35 },
];
const contexts = SYMBOLS.map(s => makeContext(s.symbol, s.name, '2026-04-01', 60, s.basePrice));
const allDates = contexts[0].bars.map(b => isoDate(b.time as Date));
const rebDay1 = allDates[2]; // day 3 → 第一次开仓
const rebDay2 = allDates[20]; // day 21 → 切仓
const rebDay3 = allDates[40]; // day 41 → 全清

const startDate = allDates[0];
const endDate = allDates[allDates.length - 1];

/**
 * 单策略验收 — 喂 caller-prefetch 信号驱动 QuantBacktestEngine.composite path,
 * 验 trade_count > 0 + ≥ 2 (BUY A + SELL A + BUY B = 至少 2 笔).
 *
 * 注意: 不调 strategy.generateSignals(date) — 那需要 DB / factor_scores,
 * caller-prefetch 设计就是把信号算好喂给引擎, 测试模拟同款契约.
 */
function assertCompositeStrategyTradesViaEngine(strategy_key: string) {
  const engine = new QuantBacktestEngine();
  const results = engine.run(contexts, {
    strategy_keys: [strategy_key],
    start_date: startDate,
    end_date: endDate,
    initial_capital: 200_000,
    position_pct: 30,
    max_positions: 2,
    min_score: 0,
    execution_timing: 'next_open',
    block_st_stocks: false,
    precomputed_composite_signals: {
      [strategy_key]: {
        [rebDay1]: { target_portfolio: ['sh.600519'] },
        [rebDay2]: { target_portfolio: ['sz.000858'] },
        [rebDay3]: { target_portfolio: [] },
      },
    },
  });
  assert.equal(results.length, 1, `${strategy_key}: 引擎 results 长度异常`);
  const result = results[0];
  assert.equal(
    result.strategy_key,
    strategy_key,
    `${strategy_key}: result.strategy_key 不匹配 (got ${result.strategy_key})`
  );
  assert.ok(
    result.trade_count > 0,
    `${strategy_key}: trade_count=0 — 组合级路径没走通 (查 QuantBacktestEngine ` +
      `composite branch line 212-270 / precomputed_composite_signals 字段拼写)`
  );
  assert.ok(
    result.trade_count >= 2,
    `${strategy_key}: trade_count=${result.trade_count} < 2 — 期望至少 BUY A + SELL A + BUY B = 2 笔`
  );
}

for (const key of compositeKeys) {
  it(`组合级策略 "${key}" caller-prefetch 走通 engine composite path → trade_count > 0`, () => {
    assertCompositeStrategyTradesViaEngine(key);
  });
}

it('META-GUARD: QuantBacktestEngine.composite branch 必须按 strategy_key 路由 precomputed signals', () => {
  // 验证: 喂错 strategy_key 的 precomputed 信号不应触发 composite path
  // (这是引擎按 strategy_key 路由的契约, 防止"信号串号").
  const engine = new QuantBacktestEngine();
  const results = engine.run(contexts, {
    strategy_keys: [compositeKeys[0]],
    start_date: startDate,
    end_date: endDate,
    initial_capital: 200_000,
    position_pct: 30,
    max_positions: 2,
    min_score: 0,
    execution_timing: 'next_open',
    block_st_stocks: false,
    precomputed_composite_signals: {
      // 故意填错 key — 引擎应回退到 evaluate() 退化路径 (trade_count=0)
      wrong_strategy_key: {
        [rebDay1]: { target_portfolio: ['sh.600519'] },
      },
    },
  });
  assert.equal(results.length, 1);
  assert.equal(
    results[0].trade_count,
    0,
    '错配 strategy_key 时不应有 trade — 否则引擎按 strategy_key 路由的契约破了'
  );
});

setTimeout(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  process.exit(0);
}, 50);
