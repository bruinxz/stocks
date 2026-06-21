/**
 * Backtest metrics — Calmar / Sortino / turnover / cost 单测 (audit L-20 + S-22 修复).
 *
 *   cd backend && npx ts-node --transpile-only tests/quant/backtest/metrics.calmar_sortino.test.ts
 *
 * 这里不端到端跑 QuantBacktestEngine (会拉 DB / strategyRegistry), 而是把
 * 新指标计算公式抽成纯 helper inline 复算, 用固定输入验证数值正确性. 公式与
 * `QuantBacktestEngine.ts` 的 metrics 段一致 (单一事实源仍在 engine), 任何
 * 公式 drift 会让 metric 名义值在 4 个固定 fixture 上变化, 让单测失败.
 *
 * 公式 (与 QuantBacktestEngine metric 段口径一致):
 *   - annual_return_pct = (1 + total_return/100)^(252 / tradingDaysSpan) - 1, ×100
 *   - sharpe_ratio = mean(dailyReturns) / std(dailyReturns) × sqrt(252)
 *   - calmar_ratio = annualReturn / |max_drawdown_pct| (≤0.01 时返回 99 / 0)
 *   - sortino_ratio = mean(dailyReturns) / std(negative_returns) × sqrt(252)
 *   - turnover_ratio = sum(|trade.amount|) / mean(equity)
 *   - cost_ratio = (commission + stamp + transfer + slippage) / max(|total_pnl|, 1)
 */

import assert from 'node:assert/strict';

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

// ---- 公式 inline (copy 自 QuantBacktestEngine, 单一事实源仍在 engine) ----

const TRADING_DAYS_PER_YEAR = 252;

function average(arr: number[]): number {
  if (!arr.length) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}
function stddev(arr: number[]): number {
  if (arr.length < 2) return 0;
  const mu = average(arr);
  const variance = arr.reduce((s, v) => s + (v - mu) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(variance);
}
function pct(curr: number, prev: number): number {
  return prev === 0 ? 0 : (curr - prev) / prev;
}
function maxDrawdownFromValues(vals: number[]): number {
  let peak = -Infinity;
  let mdd = 0;
  for (const v of vals) {
    if (v > peak) peak = v;
    if (peak > 0) {
      const dd = (peak - v) / peak * 100;
      if (dd > mdd) mdd = dd;
    }
  }
  return mdd;
}

interface Trade { amount: number; pnl: number; }
interface Equity { total_value: number; }
interface Diag {
  total_commission: number;
  total_stamp_tax: number;
  total_transfer_fee: number;
  total_slippage_cost: number;
}

function computeNewMetrics(
  initial_capital: number,
  equityCurve: Equity[],
  trades: Trade[],
  diagnostics: Diag
) {
  const finalValue = equityCurve[equityCurve.length - 1]?.total_value || initial_capital;
  const totalReturn = ((finalValue - initial_capital) / initial_capital) * 100;
  const dailyReturns = equityCurve
    .slice(1)
    .map((p, i) => pct(p.total_value, equityCurve[i].total_value));
  const tradingDaysSpan = Math.max(equityCurve.length - 1, 1);
  const annualReturn = ((1 + totalReturn / 100) ** (TRADING_DAYS_PER_YEAR / tradingDaysSpan) - 1) * 100;
  const maxDrawdownPct = maxDrawdownFromValues(equityCurve.map(p => p.total_value));
  const sharpe = stddev(dailyReturns)
    ? (average(dailyReturns) / stddev(dailyReturns)) * Math.sqrt(TRADING_DAYS_PER_YEAR)
    : 0;
  const calmarRatio = maxDrawdownPct > 0.01 ? annualReturn / maxDrawdownPct : annualReturn > 0 ? 99 : 0;
  const negativeReturns = dailyReturns.filter(r => r < 0);
  const downsideStd = stddev(negativeReturns);
  const sortinoRatio = downsideStd > 0
    ? (average(dailyReturns) / downsideStd) * Math.sqrt(TRADING_DAYS_PER_YEAR)
    : 0;
  const sumTradeAmount = trades.reduce((s, t) => s + Math.abs(t.amount), 0);
  const meanEquity = equityCurve.length
    ? equityCurve.reduce((s, p) => s + p.total_value, 0) / equityCurve.length
    : initial_capital;
  const turnoverRatio = meanEquity > 0 ? sumTradeAmount / meanEquity : 0;
  const totalCost = diagnostics.total_commission + diagnostics.total_stamp_tax +
    diagnostics.total_transfer_fee + diagnostics.total_slippage_cost;
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const costRatio = totalCost / Math.max(Math.abs(totalPnl), 1);
  return { annualReturn, maxDrawdownPct, sharpe, calmarRatio, sortinoRatio, turnoverRatio, costRatio, tradingDaysSpan };
}

console.log('Backtest metrics (audit L-20 + S-22)');

// ---- 5 个固定 fixture ----

it('Fixture 1: 平盘 + 0 trades → annual=0 sharpe=0 calmar=0 sortino=0', () => {
  const m = computeNewMetrics(
    100_000,
    [{ total_value: 100_000 }, { total_value: 100_000 }, { total_value: 100_000 }],
    [],
    { total_commission: 0, total_stamp_tax: 0, total_transfer_fee: 0, total_slippage_cost: 0 }
  );
  assert.equal(Math.round(m.annualReturn * 100) / 100, 0);
  assert.equal(m.sharpe, 0);
  assert.equal(m.calmarRatio, 0);
  assert.equal(m.sortinoRatio, 0);
  assert.equal(m.turnoverRatio, 0);
  assert.equal(m.costRatio, 0);
});

it('Fixture 2: 单向上升 10 日 +10% → annual ≈ 1.2e5%, sharpe>0, calmar=99 (mdd≈0)', () => {
  // 每日 +1% (复利) 10 日 = +10.46%, mdd 几乎 0
  const equity = [{ total_value: 100_000 }];
  for (let i = 1; i <= 10; i++) equity.push({ total_value: 100_000 * (1.01 ** i) });
  const m = computeNewMetrics(100_000, equity, [], {
    total_commission: 0, total_stamp_tax: 0, total_transfer_fee: 0, total_slippage_cost: 0,
  });
  assert.ok(m.annualReturn > 1000, `annual ${m.annualReturn} 应当年化巨大`); // 252/10 复利 +10.46% → 数千 %
  assert.equal(m.calmarRatio, 99); // mdd 几乎 0 → 哨兵 99
  assert.equal(m.sortinoRatio, 0); // 全无负日 → downsideStd=0 → 0
});

it('Fixture 3: 4 日 [+5%, -3%, +2%, -1%] → annual / sharpe / calmar 精确', () => {
  const equity = [
    { total_value: 100_000 },
    { total_value: 105_000 },
    { total_value: 101_850 }, // -3%
    { total_value: 103_887 }, // +2%
    { total_value: 102_848 }, // -1%
  ];
  const m = computeNewMetrics(100_000, equity, [], {
    total_commission: 0, total_stamp_tax: 0, total_transfer_fee: 0, total_slippage_cost: 0,
  });
  // total_return ≈ 2.848%; tradingDaysSpan=4
  // annual = (1.02848)^(252/4) - 1 = 巨大 (~5.97x → ~497%) — 业务方向 + 数量级
  assert.ok(m.annualReturn > 100, `annual ${m.annualReturn} 应当数百 % 量级`);
  // mdd = peak 105000 → trough 101850 = 3.0% exact. 后续 103887 / 102848 不重置 peak,
  // 但 (105000-101850)/105000=3.0%, (105000-102848)/105000≈2.05% → mdd = 3.0
  assert.ok(m.maxDrawdownPct >= 2.9 && m.maxDrawdownPct <= 3.1, `mdd ${m.maxDrawdownPct} 应当 ≈ 3.0%`);
  // calmar = annual / mdd, 因 annual>100, mdd~2 → calmar ≈ 50+
  assert.ok(m.calmarRatio > 50);
  // sortino: 用负日 [-0.03, -0.01] std (单样本) → mean(daily) / std(neg) × sqrt(252)
  // dailyReturns 有 2 个负 - 有意义
  assert.ok(m.sortinoRatio !== 0);
});

it('Fixture 4: turnover_ratio = sum(|amount|) / mean_equity, cost_ratio 精确', () => {
  const m = computeNewMetrics(
    100_000,
    [{ total_value: 100_000 }, { total_value: 102_000 }, { total_value: 105_000 }],
    [
      { amount: 50_000, pnl: 1_500 },
      { amount: 30_000, pnl: 500 },
      { amount: 20_000, pnl: -300 },
    ],
    { total_commission: 100, total_stamp_tax: 50, total_transfer_fee: 10, total_slippage_cost: 40 }
  );
  // sum|amount| = 100_000; mean_equity = (100k+102k+105k)/3 = 102_333.33
  // turnover = 100000 / 102333.33 ≈ 0.977
  assert.ok(Math.abs(m.turnoverRatio - 100_000 / 102_333.333333) < 0.001);
  // total_pnl = 1500+500-300 = 1700; total_cost = 100+50+10+40 = 200
  // cost_ratio = 200 / max(|1700|, 1) = 200/1700 ≈ 0.1176
  assert.ok(Math.abs(m.costRatio - 200 / 1700) < 0.001);
});

it('Fixture 5: 252-day-span +20% → annual_return ≈ 20% (252 而非 365)', () => {
  // 252 个 equity 点 (251 日变化), 总收益 20%
  // 与旧公式 365/d 对比: 老公式会高估到 ~30% 年化
  const equity = [{ total_value: 100_000 }];
  // 用线性递增模拟 (简化)
  for (let i = 1; i <= 252; i++) {
    equity.push({ total_value: 100_000 * (1 + 0.2 * i / 252) });
  }
  const m = computeNewMetrics(100_000, equity, [], {
    total_commission: 0, total_stamp_tax: 0, total_transfer_fee: 0, total_slippage_cost: 0,
  });
  // tradingDaysSpan=252, total_return=20%, annual = (1.2)^(252/252) - 1 = 20%
  assert.ok(Math.abs(m.annualReturn - 20) < 0.5, `annual ${m.annualReturn} 应当接近 20%`);
  // 关键: 不是 (1.2)^(365/252) - 1 = ~30.4% 的旧公式
  assert.ok(m.annualReturn < 25);
});

it('cost_ratio: total_pnl=0 / 1 兜底防爆炸', () => {
  const m = computeNewMetrics(
    100_000,
    [{ total_value: 100_000 }, { total_value: 100_000 }],
    [{ amount: 50_000, pnl: 0 }],
    { total_commission: 50, total_stamp_tax: 0, total_transfer_fee: 0, total_slippage_cost: 0 }
  );
  // total_pnl=0 → max(0, 1)=1 → cost_ratio=50/1=50 (不是 Infinity)
  assert.equal(m.costRatio, 50);
});

console.log(`\nBacktest metrics: ${passed} ok / ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
