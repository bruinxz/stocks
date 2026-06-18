/**
 * QuantBacktestEngine composite path smoke test (audit S-1 修复).
 *
 *   cd backend && npx ts-node --transpile-only tests/quant/composite_backtest_smoke.test.ts
 *
 * 验证组合级策略 (实现了 generateSignals(date)) 通过
 * `options.precomputed_composite_signals` 在 backtest engine 内能产生真实
 * 成交 (trade_count > 0), 而不是退化为 evaluate() 'hold'。
 *
 * 测试构造:
 *   - 一只 mock 组合级策略 (test_composite_smoke)，evaluate() 返 hold,
 *     generateSignals() 返 fixed target_portfolio (不在本测试内调用，仅证明
 *     engine 走 precomputed 分支)。
 *   - 3 个 symbol + 30 天日 bar。
 *   - precomputed: day 1 选 [A], day 15 切到 [B] + 卖 [A], day 30 全清。
 *   - 期望 trade_count >= 2 (至少 BUY A + SELL A + BUY B 一组)。
 */

import assert from 'node:assert/strict';
import { QuantBacktestEngine } from '../../src/quant/backtest/internal/QuantBacktestEngine';
import { strategyRegistry } from '../../src/quant/engine/StrategyRegistry';
import { QuantStrategy } from '../../src/quant/strategies/QuantStrategy';
import type {
  QuantBar,
  QuantSignalResult,
  QuantStockContext,
  QuantStrategyDefinition,
  QuantStrategyRuntimeOptions,
} from '../../src/quant/types/QuantTypes';

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

class CompositeSmokeStrategy extends QuantStrategy {
  readonly definition: QuantStrategyDefinition = {
    strategy_key: 'test_composite_smoke',
    name: '测试用 组合级 smoke',
    description: 'evaluate() 退化 hold; generateSignals 由 caller pre-compute',
    category: 'multi_factor',
    default_params: { min_bars: 1, topN: 1 },
    enabled: true,
    risk_level: 'medium',
    tags: ['test'],
  };

  evaluate(_context: QuantStockContext, _options?: QuantStrategyRuntimeOptions): QuantSignalResult {
    return {
      strategy_key: this.definition.strategy_key,
      symbol: _context.symbol,
      name: _context.name,
      signal: 'hold',
      score: 0,
      confidence: 0,
      reasons: ['use generateSignals'],
      risk_flags: [],
      factors: { note: 'use_generateSignals_instead' },
    };
  }

  async generateSignals(_tradeDate: string, _options?: { previousSelection?: string[] }) {
    // 单测不真正调用 — 由 caller pre-compute 传给 engine
    return { target_portfolio: [], trade_date: _tradeDate };
  }
}

if (!strategyRegistry.get('test_composite_smoke')) {
  strategyRegistry.register(new CompositeSmokeStrategy());
}

function isoDate(d: Date) {
  return d.toISOString().slice(0, 10);
}

function makeContext(symbol: string, name: string, startDate: string, days: number, basePrice: number): QuantStockContext {
  const bars: QuantBar[] = [];
  const start = new Date(`${startDate}T00:00:00Z`);
  for (let i = 0; i < days; i++) {
    const t = new Date(start);
    t.setUTCDate(start.getUTCDate() + i);
    // 跳过周末 (Sat=6 Sun=0)
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

console.log('CompositeBacktest smoke test (audit S-1)');

it('precomputed composite signals → engine 产生真实 BUY/SELL trade', () => {
  const ctxA = makeContext('sh.600519', '贵州茅台', '2026-04-01', 60, 100);
  const ctxB = makeContext('sz.000858', '五粮液', '2026-04-01', 60, 50);
  const ctxC = makeContext('sz.300750', '宁德时代', '2026-04-01', 60, 200);

  // 取 3 个 rebalance 日 (用 ctxA bars 的索引)
  const rebDay1 = isoDate(ctxA.bars[2].time as Date);
  const rebDay2 = isoDate(ctxA.bars[20].time as Date);
  const rebDay3 = isoDate(ctxA.bars[40].time as Date);

  const engine = new QuantBacktestEngine();
  const results = engine.run([ctxA, ctxB, ctxC], {
    strategy_keys: ['test_composite_smoke'],
    start_date: isoDate(ctxA.bars[0].time as Date),
    end_date: isoDate(ctxA.bars[ctxA.bars.length - 1].time as Date),
    initial_capital: 200_000,
    position_pct: 30,
    max_positions: 2,
    min_score: 0,
    execution_timing: 'next_open',
    block_st_stocks: false,
    precomputed_composite_signals: {
      test_composite_smoke: {
        [rebDay1]: { target_portfolio: ['sh.600519'] },
        [rebDay2]: { target_portfolio: ['sz.000858'] },
        [rebDay3]: { target_portfolio: [] },
      },
    },
  });

  assert.equal(results.length, 1);
  const result = results[0];
  console.log(
    `  composite smoke: trade_count=${result.trade_count}, total_return=${result.total_return_pct.toFixed(2)}%`
  );
  assert.ok(result.trade_count > 0, '组合级路径必须产生 trade');
  assert.ok(
    result.trade_count >= 2,
    `调仓 3 次至少应有 BUY A + SELL A + BUY B + SELL B = 4 trade; 实际 ${result.trade_count}`
  );
});

it('未提供 precomputed_composite_signals 时 — 组合级策略仍走 evaluate() 退化路径 (trade_count=0)', () => {
  const ctxA = makeContext('sh.600519', '贵州茅台', '2026-04-01', 30, 100);
  const engine = new QuantBacktestEngine();
  const results = engine.run([ctxA], {
    strategy_keys: ['test_composite_smoke'],
    start_date: isoDate(ctxA.bars[0].time as Date),
    end_date: isoDate(ctxA.bars[ctxA.bars.length - 1].time as Date),
    initial_capital: 200_000,
    position_pct: 50,
    max_positions: 1,
    min_score: 0,
    execution_timing: 'next_open',
    block_st_stocks: false,
    // 故意不传 precomputed_composite_signals
  });

  assert.equal(results[0].trade_count, 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
process.exit(0);
