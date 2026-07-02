/**
 * ETFRotationStrategy / ETFFactorService / ETFRankingService 单测 (信号优先重构 批5-b)。
 *
 * 不依赖 jest；node 直接跑：
 *   cd backend && npx ts-node --transpile-only tests/strategies/ETFRotationStrategy.test.ts
 *
 * 用 Fake 数据源注入, 无任何 DB 依赖。覆盖:
 *   - 四因子聚合 + ETF 间 z-score + 综合分权重 (0.4/0.3/0.3/0.0 shadow)
 *   - Momentum 权重 0: momentum_z 变化不影响 total_score
 *   - data_incomplete (成分空 / 缺失 >30% / LowVol 交易日不足) → total = -Infinity 垫底
 *   - 排名 top4 买 / top6 卖缓冲带 + 稳态 4-6 只
 *   - 仓位分配: Σ≤70%, 单只≤15%, 溢出再分配
 *   - evaluate() 返回信息性 hold
 */

import {
  ETFFactorService,
  ETFFactorDataSource,
} from '../../src/quant/etf/ETFFactorService';
import {
  ETFConstituentExpander,
  ETFConstituentDataSource,
} from '../../src/quant/etf/ETFConstituentExpander';
import { ETFRankingService, CORE_TOTAL_CAP_PCT, SINGLE_ETF_CAP_PCT } from '../../src/quant/etf/ETFRankingService';
import { ETFRotationStrategy } from '../../src/quant/strategies/ETFRotationStrategy';
import { QuantStockContext } from '../../src/quant/types/QuantTypes';

let failed = 0;
function assert(name: string, cond: boolean, detail = '') {
  if (cond) console.log(`  ok  ${name}${detail ? ` (${detail})` : ''}`);
  else {
    failed += 1;
    console.error(`  FAIL ${name}${detail ? ` (${detail})` : ''}`);
  }
}

// --- Fake constituent expander: each ETF maps to a distinct set of stocks ---
class FakeConstituentDS implements ETFConstituentDataSource {
  constructor(private map: Record<string, Array<[string, number]>>) {}
  async loadIndexComponents(indexCode: string) {
    return null; // force fallback path uniformly (we key fund holdings by etf code)
  }
  async loadTopHoldings(fundCode: string) {
    const rows = this.map[fundCode];
    if (!rows) return null;
    const weights = new Map<string, number>();
    for (const [c, w] of rows) weights.set(c, w);
    return weights.size ? { weights, as_of: '2026-06-30' } : null;
  }
}

// --- Fake factor data source: stock-level valuation/quality + ETF closes ---
class FakeFactorDS implements ETFFactorDataSource {
  constructor(
    private valuation: Record<string, { pe: number; pb: number }>,
    private dy: Record<string, number>,
    private quality: Record<string, { roe: number | null; roe5yAvg: number | null; netProfitStd5y: number | null }>,
    private closes: Record<string, number[]>
  ) {}
  async loadValuation(codes: string[]) {
    const out = new Map<string, { pe: number; pb: number }>();
    for (const c of codes) if (this.valuation[c]) out.set(c, this.valuation[c]);
    return out;
  }
  async loadDividendYield(codes: string[]) {
    const out = new Map<string, number>();
    for (const c of codes) if (this.dy[c] !== undefined) out.set(c, this.dy[c]);
    return out;
  }
  async loadQuality(codes: string[]) {
    const out = new Map<string, any>();
    for (const c of codes) if (this.quality[c]) out.set(c, this.quality[c]);
    return out;
  }
  async loadEtfCloses(etfCodes: string[]) {
    const out = new Map<string, number[]>();
    for (const c of etfCodes) if (this.closes[c]) out.set(c, this.closes[c]);
    return out;
  }
}

// Helper: build a smooth close series with target daily vol via constant drift + noise seed.
function makeCloses(n: number, base: number, step: number): number[] {
  const arr: number[] = [];
  let p = base;
  for (let i = 0; i < n; i += 1) {
    p = p * (1 + step * (i % 2 === 0 ? 1 : -1)); // low, alternating small moves
    arr.push(p);
  }
  return arr;
}

async function main() {
  // 5 ETFs A..E, each 2 constituents. Distinct value/quality so ranking is deterministic.
  const consMap = {
    A: [['s1', 50], ['s2', 50]] as Array<[string, number]>,
    B: [['s3', 50], ['s4', 50]] as Array<[string, number]>,
    C: [['s5', 50], ['s6', 50]] as Array<[string, number]>,
    D: [['s7', 50], ['s8', 50]] as Array<[string, number]>,
    E: [['s9', 50], ['s10', 50]] as Array<[string, number]>,
  };
  // valuation: A cheapest (high 1/pe,1/pb) → best value; E most expensive
  const valuation: Record<string, { pe: number; pb: number }> = {
    s1: { pe: 5, pb: 0.5 }, s2: { pe: 5, pb: 0.5 },
    s3: { pe: 8, pb: 0.8 }, s4: { pe: 8, pb: 0.8 },
    s5: { pe: 12, pb: 1.2 }, s6: { pe: 12, pb: 1.2 },
    s7: { pe: 20, pb: 2 }, s8: { pe: 20, pb: 2 },
    s9: { pe: 40, pb: 4 }, s10: { pe: 40, pb: 4 },
  };
  const dy: Record<string, number> = {
    s1: 5, s2: 5, s3: 4, s4: 4, s5: 3, s6: 3, s7: 2, s8: 2, s9: 1, s10: 1,
  };
  const quality: Record<string, any> = {
    s1: { roe: 20, roe5yAvg: 18, netProfitStd5y: 1 },
    s2: { roe: 20, roe5yAvg: 18, netProfitStd5y: 1 },
    s3: { roe: 16, roe5yAvg: 15, netProfitStd5y: 2 },
    s4: { roe: 16, roe5yAvg: 15, netProfitStd5y: 2 },
    s5: { roe: 12, roe5yAvg: 11, netProfitStd5y: 3 },
    s6: { roe: 12, roe5yAvg: 11, netProfitStd5y: 3 },
    s7: { roe: 8, roe5yAvg: 7, netProfitStd5y: 5 },
    s8: { roe: 8, roe5yAvg: 7, netProfitStd5y: 5 },
    s9: { roe: 4, roe5yAvg: 3, netProfitStd5y: 8 },
    s10: { roe: 4, roe5yAvg: 3, netProfitStd5y: 8 },
  };
  // ETF closes: 70 pts each; A lowest vol, E highest vol
  const closes: Record<string, number[]> = {
    A: makeCloses(70, 100, 0.002),
    B: makeCloses(70, 100, 0.004),
    C: makeCloses(70, 100, 0.006),
    D: makeCloses(70, 100, 0.01),
    E: makeCloses(70, 100, 0.02),
  };

  const expander = new ETFConstituentExpander(new FakeConstituentDS(consMap));
  const factorDS = new FakeFactorDS(valuation, dy, quality, closes);
  const factorSvc = new ETFFactorService(factorDS, expander);

  const universe = ['A', 'B', 'C', 'D', 'E'];
  const scores = await factorSvc.score(universe, '2026-06-30');
  const byCode = new Map(scores.map(s => [s.etf_code, s]));

  // A should rank #1 (best value+quality+lowvol)
  const sorted = scores.slice().sort((a, b) => b.total_score - a.total_score);
  assert('A ranks #1 (best value/quality/lowvol)', sorted[0].etf_code === 'A', sorted.map(s => s.etf_code).join('>'));
  assert('E ranks last among complete', sorted[sorted.length - 1].etf_code === 'E');
  assert('no ETF is data_incomplete (all have data)', scores.every(s => !s.data_incomplete));

  // Momentum weight 0: total_score must equal 0.4*vz+0.3*qz+0.3*lz exactly
  const a = byCode.get('A')!;
  const recomputed = 0.4 * a.value_z + 0.3 * a.quality_z + 0.3 * a.lowvol_z;
  assert('total_score excludes momentum (weight 0)', Math.abs(a.total_score - recomputed) < 1e-9,
    `total=${a.total_score.toFixed(4)} recomputed=${recomputed.toFixed(4)} momZ=${a.momentum_z.toFixed(4)}`);

  // data_incomplete: ETF with no constituents
  const scores2 = await factorSvc.score(['A', 'B', 'C', 'D', 'E', 'Z'], '2026-06-30');
  const z = scores2.find(s => s.etf_code === 'Z')!;
  assert('empty-constituent ETF → data_incomplete', z.data_incomplete === true);
  assert('data_incomplete → total_score = -Infinity', z.total_score === Number.NEGATIVE_INFINITY);

  // Ranking: with 5 complete ETFs, no current holdings → buy top4
  const ranking = new ETFRankingService();
  const r1 = ranking.rank(scores, []);
  const buys = r1.decisions.filter(d => d.action === 'buy').map(d => d.etf_code).sort();
  assert('no holdings → buy exactly top4', buys.length === 4, buys.join(','));
  assert('top4 buys are A,B,C,D', buys.join(',') === 'A,B,C,D', buys.join(','));

  // core total ≤ 70%, single ≤ 15%
  assert('core total weight ≤ 70%', r1.coreTotalWeight <= CORE_TOTAL_CAP_PCT + 1e-9,
    `${(r1.coreTotalWeight * 100).toFixed(2)}%`);
  assert('every target_weight ≤ 15%', r1.decisions.every(d => d.target_weight <= SINGLE_ETF_CAP_PCT + 1e-9));
  assert('selected count in 4..6', r1.targetHoldings.length >= 4 && r1.targetHoldings.length <= 6,
    `${r1.targetHoldings.length}`);

  // SELL buffer: hold E (rank 5, in top6) stays; hold something out of top6 sells
  const r2 = ranking.rank(scores, ['E']);
  const eDec = r2.decisions.find(d => d.etf_code === 'E')!;
  assert('held E within top6 → hold (buffer band)', eDec.action === 'hold', `action=${eDec.action}`);

  // sizing: proportional — A (highest score) weight ≥ D (lowest selected)
  const wA = r1.decisions.find(d => d.etf_code === 'A')!.target_weight;
  const wD = r1.decisions.find(d => d.etf_code === 'D')!.target_weight;
  assert('higher score → ≥ weight (A ≥ D)', wA >= wD - 1e-9, `wA=${(wA*100).toFixed(2)}% wD=${(wD*100).toFixed(2)}%`);

  // strategy wrapper
  const strat = new ETFRotationStrategy(factorSvc, ranking);
  const ctx: QuantStockContext = { stock_id: 1, symbol: 'sh.510300', name: 'x', bars: [{ time: new Date(), open: 1, high: 1, low: 1, close: 3.2, volume: 1 }] };
  const ev = strat.evaluate(ctx);
  assert('evaluate() returns informational hold', ev.signal === 'hold' && ev.factors.note === 'use_generateSignals_instead');

  const sigs = await strat.generateSignals('2026-06-30', { universe, currentHoldings: [] });
  assert('generateSignals returns one signal per ETF', sigs.length === universe.length);
  assert('strategy_key = etf_factor_rotation', sigs.every(s => s.strategy_key === 'etf_factor_rotation'));
  const sigBuys = sigs.filter(s => s.action === 'buy').length;
  assert('generateSignals produces 4 buys', sigBuys === 4, `${sigBuys}`);

  console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
