/**
 * EnsembleStrategy 单测（US-028）。
 *
 * 不依赖 jest；node 直接跑：
 *   cd backend && npx ts-node --transpile-only tests/strategies/EnsembleStrategy.test.ts
 *
 * 测试用 FakeSubstrategy（实现 EnsembleSubstrategy 接口）注入到 EnsembleStrategy
 * 构造器，同时用 `marketRegimeOverride` 参数跳过 MarketEnvironmentService DB 调用，
 * 实现完全脱离 DB 的端到端测试。
 *
 * AC 要求至少覆盖 4 种市场环境（bull / bear / range / volatile）；本文件总共覆盖：
 *   - 4 种 raw market regime 全部正确映射到 4 种 ensemble regime
 *   - 4 种 ensemble 环境下默认 allocation 中的子策略权重正确
 *   - 加权投票融合 target_portfolio 正确
 *   - LowVol 缺失时（bear 环境）权重正确合并到 HighDividendValue
 *   - rebalanceMissingWeights=false 时缺失子策略权重作废
 *   - 子策略调用失败时不阻塞其他子策略
 *   - target_positions vs target_portfolio shape 都能正确提取
 *   - BUY / SELL / HOLD 增量信号
 *   - 稳定排序（vote_score 降序 + stock_code 升序 tie-break）
 *   - topN cap
 *   - 空 allocation / 空子策略池 → 全 SELL（previousSelection 清仓）
 *   - evaluate() 信息性 hold
 *   - 无效 trade_date 抛出
 *   - topN <= 0 抛出
 *   - 重复 substrategy_key 构造时抛出
 *   - degraded_substitutions 字段正确记录
 *   - normalizeWeightsToOne / mapToEnsembleRegime / resolveEffectiveAllocation 辅助函数边界
 */

import {
  DEFAULT_ENSEMBLE_ALLOCATION,
  DEFAULT_ENSEMBLE_PARAMS,
  EnsembleStrategy,
  EnsembleSubstrategy,
  EnsembleSubstrategyResult,
  extractTargetStockCodes,
  mapToEnsembleRegime,
  normalizeWeightsToOne,
  resolveEffectiveAllocation,
} from '../../src/quant/strategies/EnsembleStrategy';
import { QuantStockContext } from '../../src/quant/types/QuantTypes';

let failed = 0;

function assert(name: string, cond: boolean, detail = '') {
  if (cond) {
    console.log(`  ok  ${name}${detail ? ` (${detail})` : ''}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}${detail ? ` (${detail})` : ''}`);
  }
}

function expectEqual<T>(name: string, actual: T, expected: T, detail = '') {
  const same =
    JSON.stringify(actual) === JSON.stringify(expected) ||
    (typeof actual === 'number' &&
      typeof expected === 'number' &&
      Math.abs(actual - expected) < 1e-9);
  assert(
    name,
    same,
    detail || `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
  );
}

// ----------------------------------------------------------------
// FakeSubstrategy — 实现 EnsembleSubstrategy 接口，完全确定的产出
// ----------------------------------------------------------------

/**
 * 接收一个 key + 固定的 target stock_codes（或 throw 用于失败注入）。
 */
class FakeSubstrategy implements EnsembleSubstrategy {
  constructor(
    public readonly strategy_key: string,
    private readonly targets: string[] | Error,
    /**
     * 控制返回 shape：'portfolio' (string[]) | 'positions' (object[])
     * 让 ensemble 必须正确处理两种 shape。
     */
    private readonly shape: 'portfolio' | 'positions' = 'portfolio'
  ) {}

  async generateSignals(
    _tradeDate: string,
    _options?: { previousSelection?: string[] }
  ): Promise<EnsembleSubstrategyResult> {
    if (this.targets instanceof Error) throw this.targets;
    if (this.shape === 'portfolio') {
      // 用最小的合法 shape；强制 cast 因为 FakeSubstrategy 不构造真 MFA 结果
      return {
        trade_date: _tradeDate,
        target_portfolio: this.targets.slice(),
        signals: [],
        filtered: { st: 0, new60d: 0, industry_capped: 0, no_factor_data: 0 },
        params: {} as any,
        universe_size: this.targets.length,
        eligible_count: this.targets.length,
      } as any;
    }
    // 'positions' shape
    return {
      trade_date: _tradeDate,
      target_positions: this.targets.map(code => ({ stock_code: code, entry_date: _tradeDate, entry_price: 10 })),
      signals: [],
      filtered: {},
      params: {} as any,
    } as any;
  }
}

// ----------------------------------------------------------------
// 1. 默认参数 + 默认 allocation 校验（AC）
// ----------------------------------------------------------------

(function testDefaultParams() {
  console.log('\n[1] 默认参数 + 默认 allocation 校验');
  const strategy = new EnsembleStrategy([]);
  const def = strategy.definition.default_params;
  expectEqual('default_params.topN', def.topN, 30);
  expectEqual('default_params.benchmarkSymbol', def.benchmarkSymbol, 'sh.000300');
  expectEqual('default_params.rebalanceMissingWeights', def.rebalanceMissingWeights, true);

  // AC: bull = MFA 0.4 + DragonHead 0.3 + Breakout 0.3
  const bull = DEFAULT_ENSEMBLE_ALLOCATION.bull;
  expectEqual('bull length', bull.length, 3);
  expectEqual('bull MFA weight', bull.find(e => e.strategy_key === 'multi_factor_alpha')?.weight, 0.4);
  expectEqual('bull DragonHead weight', bull.find(e => e.strategy_key === 'dragon_head_momentum')?.weight, 0.3);
  expectEqual('bull Breakout weight', bull.find(e => e.strategy_key === 'breakout_strategy')?.weight, 0.3);

  // AC: bear = HighDividendValue 0.6 + LowVol 0.4
  const bear = DEFAULT_ENSEMBLE_ALLOCATION.bear;
  expectEqual('bear length', bear.length, 2);
  expectEqual('bear HDV weight', bear.find(e => e.strategy_key === 'high_dividend_value')?.weight, 0.6);
  expectEqual('bear LowVol weight', bear.find(e => e.strategy_key === 'low_vol_strategy')?.weight, 0.4);

  // AC: range = SectorRotation 0.4 + LeftSideReversal 0.3 + EarningsSurprise 0.3
  const range = DEFAULT_ENSEMBLE_ALLOCATION.range;
  expectEqual('range length', range.length, 3);
  expectEqual('range SR weight', range.find(e => e.strategy_key === 'sector_rotation_leader')?.weight, 0.4);
  expectEqual('range LSR weight', range.find(e => e.strategy_key === 'left_side_reversal')?.weight, 0.3);
  expectEqual('range ES weight', range.find(e => e.strategy_key === 'earnings_surprise')?.weight, 0.3);

  // AC: volatile = GARP 0.5 + HighDividendValue 0.5
  const vol = DEFAULT_ENSEMBLE_ALLOCATION.volatile;
  expectEqual('volatile length', vol.length, 2);
  expectEqual('volatile GARP weight', vol.find(e => e.strategy_key === 'garp_strategy')?.weight, 0.5);
  expectEqual('volatile HDV weight', vol.find(e => e.strategy_key === 'high_dividend_value')?.weight, 0.5);

  // 4 环境权重和都 = 1.0
  for (const regime of ['bull', 'bear', 'range', 'volatile'] as const) {
    const sum = DEFAULT_ENSEMBLE_ALLOCATION[regime].reduce((s, e) => s + e.weight, 0);
    expectEqual(`${regime} weights sum to 1.0`, Math.round(sum * 1000) / 1000, 1.0);
  }
})();

// ----------------------------------------------------------------
// 2. strategy_definition 元数据
// ----------------------------------------------------------------

(function testStrategyDefinition() {
  console.log('\n[2] strategy_definition 元数据');
  const strategy = new EnsembleStrategy([]);
  expectEqual('strategy_key', strategy.definition.strategy_key, 'ensemble_strategy');
  expectEqual('category', strategy.definition.category, 'multi_factor');
  expectEqual('risk_level', strategy.definition.risk_level, 'medium');
  expectEqual('enabled', strategy.definition.enabled, true);
  assert('tags include 集成', strategy.definition.tags.includes('集成'));
  assert('tags include 元策略', strategy.definition.tags.includes('元策略'));
})();

// ----------------------------------------------------------------
// 3. mapToEnsembleRegime 辅助函数（覆盖所有 6 种 raw regime）
// ----------------------------------------------------------------

(function testMapToEnsembleRegime() {
  console.log('\n[3] mapToEnsembleRegime — 6 种 raw → 4 种 ensemble');
  expectEqual('bull → bull', mapToEnsembleRegime('bull'), 'bull');
  expectEqual('bear → bear', mapToEnsembleRegime('bear'), 'bear');
  expectEqual('range → range', mapToEnsembleRegime('range'), 'range');
  expectEqual('rebound → range', mapToEnsembleRegime('rebound'), 'range');
  expectEqual('stress → volatile', mapToEnsembleRegime('stress'), 'volatile');
  expectEqual('unknown → range', mapToEnsembleRegime('unknown'), 'range');
})();

// ----------------------------------------------------------------
// 4. bull 环境 — 3 个子策略全部可用 + 加权投票融合
// ----------------------------------------------------------------

(async function testBullEnvironment() {
  console.log('\n[4] bull 环境 — 3 子策略 + 加权投票');
  // bull: MFA 0.4 + DragonHead 0.3 + Breakout 0.3
  // Fake stocks:
  //   AAA: MFA + DragonHead 都推荐 → vote 0.4 + 0.3 = 0.7
  //   BBB: MFA + Breakout 都推荐 → vote 0.4 + 0.3 = 0.7
  //   CCC: only DragonHead → vote 0.3
  //   DDD: only MFA → vote 0.4
  //   EEE: only Breakout → vote 0.3
  // 排序: AAA & BBB tie (0.7) → AAA 在前（升序）； DDD (0.4); CCC & EEE tie (0.3) → CCC 在前
  const ensemble = new EnsembleStrategy([
    new FakeSubstrategy('multi_factor_alpha', ['AAA', 'BBB', 'DDD']),
    new FakeSubstrategy('dragon_head_momentum', ['AAA', 'CCC'], 'positions'), // structure 测试
    new FakeSubstrategy('breakout_strategy', ['BBB', 'EEE'], 'positions'),
  ]);
  const result = await ensemble.generateSignals('2026-06-05', { marketRegimeOverride: 'bull' });
  expectEqual('market_regime mapped to bull', result.market_regime, 'bull');
  expectEqual('raw_market_regime preserved', result.raw_market_regime, 'bull');
  expectEqual('target portfolio length', result.target_portfolio.length, 5);
  expectEqual('top 1 AAA', result.target_portfolio[0], 'AAA');
  expectEqual('top 2 BBB', result.target_portfolio[1], 'BBB');
  expectEqual('top 3 DDD', result.target_portfolio[2], 'DDD');
  expectEqual('top 4 CCC', result.target_portfolio[3], 'CCC');
  expectEqual('top 5 EEE', result.target_portfolio[4], 'EEE');
  expectEqual('signals all buy (no previous)', result.signals.every(s => s.signal === 'buy'), true);

  // vote scores
  const aaa = result.signals.find(s => s.stock_code === 'AAA')!;
  expectEqual('AAA vote_score', Math.round(aaa.vote_score * 1000) / 1000, 0.7);
  expectEqual('AAA contributors length', aaa.contributing_substrategies.length, 2);
  assert('AAA contributors include mfa', aaa.contributing_substrategies.includes('multi_factor_alpha'));
  assert('AAA contributors include dragon', aaa.contributing_substrategies.includes('dragon_head_momentum'));

  const ddd = result.signals.find(s => s.stock_code === 'DDD')!;
  expectEqual('DDD vote_score = 0.4', Math.round(ddd.vote_score * 1000) / 1000, 0.4);

  // No degradation expected in bull (all 3 substrategies present)
  expectEqual('degraded.length = 0', result.degraded_substitutions.length, 0);
  expectEqual('substrategy diag length', result.substrategy_diagnostics.length, 3);
  expectEqual('effective_weights MFA = 0.4', result.effective_weights['multi_factor_alpha'], 0.4);
})();

// ----------------------------------------------------------------
// 5. bear 环境 — LowVol 缺失 → 权重合并到 HighDividendValue
// ----------------------------------------------------------------

(async function testBearWithLowVolMissing() {
  console.log('\n[5] bear 环境 — LowVol 缺失 → 权重合并到 HDV');
  // bear: HighDividendValue 0.6 + LowVol 0.4（默认配置，LowVol 不在子策略池）
  // 期望: HighDividendValue 拿到 0.6 + 0.4 = 1.0 全部权重
  const ensemble = new EnsembleStrategy([
    new FakeSubstrategy('high_dividend_value', ['HDV1', 'HDV2', 'HDV3']),
  ]);
  const result = await ensemble.generateSignals('2026-06-05', { marketRegimeOverride: 'bear' });
  expectEqual('market_regime mapped to bear', result.market_regime, 'bear');
  expectEqual('effective_weights HDV = 1.0', Math.round(result.effective_weights['high_dividend_value'] * 1000) / 1000, 1.0);
  expectEqual('degraded.length = 1', result.degraded_substitutions.length, 1);
  expectEqual('degraded.missing_strategy', result.degraded_substitutions[0].missing_strategy, 'low_vol_strategy');
  assert(
    'degraded redistributed_to HDV',
    result.degraded_substitutions[0].redistributed_to.includes('high_dividend_value')
  );
  // All 3 HDV stocks should be in target with vote_score = 1.0
  expectEqual('target_portfolio length 3', result.target_portfolio.length, 3);
  const hdv1 = result.signals.find(s => s.stock_code === 'HDV1')!;
  expectEqual('HDV1 vote_score 1.0', Math.round(hdv1.vote_score * 1000) / 1000, 1.0);
})();

// ----------------------------------------------------------------
// 6. range 环境 — 3 子策略全部可用
// ----------------------------------------------------------------

(async function testRangeEnvironment() {
  console.log('\n[6] range 环境 — 3 子策略全部可用');
  const ensemble = new EnsembleStrategy([
    new FakeSubstrategy('sector_rotation_leader', ['S1', 'S2'], 'positions'),
    new FakeSubstrategy('left_side_reversal', ['L1', 'L2'], 'positions'),
    new FakeSubstrategy('earnings_surprise', ['E1', 'E2'], 'positions'),
  ]);
  const result = await ensemble.generateSignals('2026-06-05', { marketRegimeOverride: 'range' });
  expectEqual('market_regime', result.market_regime, 'range');
  expectEqual('target portfolio length 6', result.target_portfolio.length, 6);
  // All stocks should have vote_score = their substrategy weight (0.4 / 0.3 / 0.3)
  const s1 = result.signals.find(s => s.stock_code === 'S1')!;
  expectEqual('S1 vote 0.4', Math.round(s1.vote_score * 1000) / 1000, 0.4);
  const l1 = result.signals.find(s => s.stock_code === 'L1')!;
  expectEqual('L1 vote 0.3', Math.round(l1.vote_score * 1000) / 1000, 0.3);
  expectEqual('degraded.length = 0', result.degraded_substitutions.length, 0);
})();

// ----------------------------------------------------------------
// 7. volatile 环境 — 2 子策略可用
// ----------------------------------------------------------------

(async function testVolatileEnvironment() {
  console.log('\n[7] volatile 环境 — GARP + HDV 平分');
  const ensemble = new EnsembleStrategy([
    new FakeSubstrategy('garp_strategy', ['G1', 'G2', 'COMMON']),
    new FakeSubstrategy('high_dividend_value', ['H1', 'COMMON']),
  ]);
  const result = await ensemble.generateSignals('2026-06-05', { marketRegimeOverride: 'stress' });
  expectEqual('stress raw_regime → volatile mapped', result.market_regime, 'volatile');
  expectEqual('raw_market_regime preserved as stress', result.raw_market_regime, 'stress');
  // COMMON 同时入 GARP + HDV → vote 0.5 + 0.5 = 1.0；其他各 0.5
  const common = result.signals.find(s => s.stock_code === 'COMMON')!;
  expectEqual('COMMON vote 1.0', Math.round(common.vote_score * 1000) / 1000, 1.0);
  expectEqual('top 1 = COMMON', result.target_portfolio[0], 'COMMON');
  // 后续按 stock_code 升序 tie-break: G1 G2 H1 (all 0.5)
  expectEqual('top 2 = G1', result.target_portfolio[1], 'G1');
  expectEqual('top 3 = G2', result.target_portfolio[2], 'G2');
  expectEqual('top 4 = H1', result.target_portfolio[3], 'H1');
})();

// ----------------------------------------------------------------
// 8. rebalanceMissingWeights=false — LowVol 缺失权重作废
// ----------------------------------------------------------------

(async function testRebalanceMissingFalse() {
  console.log('\n[8] rebalanceMissingWeights=false — 缺失权重作废');
  const ensemble = new EnsembleStrategy([
    new FakeSubstrategy('high_dividend_value', ['HDV1']),
  ]);
  const result = await ensemble.generateSignals('2026-06-05', {
    marketRegimeOverride: 'bear',
    params: { rebalanceMissingWeights: false },
  });
  // HDV 权重应保持原 0.6，但归一化后只有 HDV 在场 → 仍归一化到 1.0
  // (no rebalance means LowVol weight is dropped, then remaining is normalized)
  expectEqual('HDV weight normalized to 1.0', Math.round(result.effective_weights['high_dividend_value'] * 1000) / 1000, 1.0);
  expectEqual('degraded LowVol redistributed_to empty', result.degraded_substitutions[0].redistributed_to.length, 0);
})();

// ----------------------------------------------------------------
// 9. 子策略调用失败不阻塞其他子策略
// ----------------------------------------------------------------

(async function testSubstrategyFailureIsolation() {
  console.log('\n[9] 子策略失败不阻塞其他子策略');
  const ensemble = new EnsembleStrategy([
    new FakeSubstrategy('multi_factor_alpha', new Error('mock MFA failed')),
    new FakeSubstrategy('dragon_head_momentum', ['DH1', 'DH2'], 'positions'),
    new FakeSubstrategy('breakout_strategy', ['BO1'], 'positions'),
  ]);
  const result = await ensemble.generateSignals('2026-06-05', { marketRegimeOverride: 'bull' });
  expectEqual('target still produced from 2 surviving', result.target_portfolio.length, 3);
  // Diagnostics include failure
  const mfaDiag = result.substrategy_diagnostics.find(d => d.strategy_key === 'multi_factor_alpha');
  assert('MFA diag has error', mfaDiag !== undefined && mfaDiag.error !== undefined);
  expectEqual('MFA target_size = 0 on failure', mfaDiag?.target_size, 0);
  const dhDiag = result.substrategy_diagnostics.find(d => d.strategy_key === 'dragon_head_momentum');
  expectEqual('DragonHead diag no error', dhDiag?.error, undefined);
  expectEqual('DragonHead target_size 2', dhDiag?.target_size, 2);
})();

// ----------------------------------------------------------------
// 10. extractTargetStockCodes —— 两种 shape
// ----------------------------------------------------------------

(function testExtractTargetStockCodes() {
  console.log('\n[10] extractTargetStockCodes — 两种 shape');
  const portfolioShape: any = { target_portfolio: ['A', 'B', 'C'] };
  expectEqual('portfolio shape', extractTargetStockCodes(portfolioShape), ['A', 'B', 'C']);
  const positionsShape: any = {
    target_positions: [{ stock_code: 'X' }, { stock_code: 'Y' }],
  };
  expectEqual('positions shape', extractTargetStockCodes(positionsShape), ['X', 'Y']);
  const emptyShape: any = {};
  expectEqual('empty shape', extractTargetStockCodes(emptyShape), []);
})();

// ----------------------------------------------------------------
// 11. BUY / SELL / HOLD 增量
// ----------------------------------------------------------------

(async function testBuySellHoldIncremental() {
  console.log('\n[11] BUY / SELL / HOLD 增量');
  // bull 环境：MFA 推荐 [A, B, C]，DragonHead 推荐 [B, D]，Breakout 推荐 [C]
  // target_portfolio: A (0.4) B (0.7) C (0.7) D (0.3) → 排序 B C A D → top 4
  // previousSelection: [A, X, Y]
  //   - A: in target → HOLD
  //   - B: not in prev → BUY
  //   - C: not in prev → BUY
  //   - D: not in prev → BUY
  //   - X: in prev, not in target → SELL
  //   - Y: in prev, not in target → SELL
  const ensemble = new EnsembleStrategy([
    new FakeSubstrategy('multi_factor_alpha', ['A', 'B', 'C']),
    new FakeSubstrategy('dragon_head_momentum', ['B', 'D']),
    new FakeSubstrategy('breakout_strategy', ['C']),
  ]);
  const result = await ensemble.generateSignals('2026-06-05', {
    marketRegimeOverride: 'bull',
    previousSelection: ['A', 'X', 'Y'],
  });

  const sigByCode: Record<string, string> = {};
  for (const s of result.signals) sigByCode[s.stock_code] = s.signal;
  expectEqual('A is hold', sigByCode['A'], 'hold');
  expectEqual('B is buy', sigByCode['B'], 'buy');
  expectEqual('C is buy', sigByCode['C'], 'buy');
  expectEqual('D is buy', sigByCode['D'], 'buy');
  expectEqual('X is sell', sigByCode['X'], 'sell');
  expectEqual('Y is sell', sigByCode['Y'], 'sell');
})();

// ----------------------------------------------------------------
// 12. 稳定排序 — vote_score 降序 + stock_code 升序 tie-break
// ----------------------------------------------------------------

(async function testStableSort() {
  console.log('\n[12] 稳定排序 — vote_score 降序 + stock_code 升序');
  // 同 vote_score 的股票必须按 stock_code 升序，无随机抖动
  const ensemble = new EnsembleStrategy([
    new FakeSubstrategy('multi_factor_alpha', ['ZZZ', 'AAA', 'MMM']),
  ]);
  // 在 bull 但 only MFA available; LowVol/DragonHead/Breakout 全部缺失（mapped from bull）
  // 注意：bull 环境的默认 allocation 是 MFA 0.4 + DragonHead 0.3 + Breakout 0.3
  // 这里只注入 MFA，DragonHead + Breakout 缺失 → 权重合并给 MFA → 1.0
  // 所以 3 只股票 vote 都是 1.0，按 stock_code 升序排
  const result = await ensemble.generateSignals('2026-06-05', { marketRegimeOverride: 'bull' });
  expectEqual('top 1 = AAA', result.target_portfolio[0], 'AAA');
  expectEqual('top 2 = MMM', result.target_portfolio[1], 'MMM');
  expectEqual('top 3 = ZZZ', result.target_portfolio[2], 'ZZZ');
})();

// ----------------------------------------------------------------
// 13. topN cap
// ----------------------------------------------------------------

(async function testTopNCap() {
  console.log('\n[13] topN cap');
  const stocks = Array.from({ length: 50 }, (_, i) => `S${String(i + 1).padStart(3, '0')}`);
  const ensemble = new EnsembleStrategy([new FakeSubstrategy('multi_factor_alpha', stocks)]);
  const result = await ensemble.generateSignals('2026-06-05', {
    marketRegimeOverride: 'bull',
    params: { topN: 10 },
  });
  expectEqual('topN cap 10', result.target_portfolio.length, 10);
  expectEqual('top 1 S001', result.target_portfolio[0], 'S001');
  expectEqual('top 10 S010', result.target_portfolio[9], 'S010');
})();

// ----------------------------------------------------------------
// 14. 空 allocation —— 全 SELL（previousSelection 清仓）
// ----------------------------------------------------------------

(async function testEmptyAllocation() {
  console.log('\n[14] 空 allocation —— previousSelection 清仓');
  const ensemble = new EnsembleStrategy([]);
  const result = await ensemble.generateSignals('2026-06-05', {
    marketRegimeOverride: 'bull',
    previousSelection: ['HELD1', 'HELD2'],
  });
  expectEqual('target_portfolio empty', result.target_portfolio.length, 0);
  expectEqual('all previous sell', result.signals.length, 2);
  expectEqual('all sells signal', result.signals.every(s => s.signal === 'sell'), true);
  // All 3 bull substrategies missing → 3 degraded entries with no redistribution targets
  expectEqual('degraded length = 3', result.degraded_substitutions.length, 3);
  expectEqual('first degraded redistributed empty', result.degraded_substitutions[0].redistributed_to.length, 0);
})();

// ----------------------------------------------------------------
// 15. evaluate() 信息性 hold
// ----------------------------------------------------------------

(function testEvaluateInformationalHold() {
  console.log('\n[15] evaluate() 信息性 hold');
  const ensemble = new EnsembleStrategy([]);
  const context: QuantStockContext = {
    stock_id: 1,
    symbol: '600519.SH',
    name: '贵州茅台',
    bars: [
      {
        time: new Date('2026-06-05T07:00:00Z'),
        open: 1800,
        high: 1810,
        low: 1790,
        close: 1805,
        volume: 1000000,
      },
    ],
    factor_snapshot: null,
  } as any;
  const r = ensemble.evaluate(context);
  expectEqual('evaluate signal=hold', r.signal, 'hold');
  expectEqual('evaluate entry_price = last close', r.entry_price, 1805);
  expectEqual('factors.note machine-readable', (r.factors as any)?.note, 'use_generateSignals_instead');
  assert('reasons mention generateSignals', r.reasons.some(reason => reason.includes('generateSignals')));
})();

// ----------------------------------------------------------------
// 16. 无效 trade_date 抛出
// ----------------------------------------------------------------

(async function testInvalidTradeDate() {
  console.log('\n[16] 无效 trade_date 抛出');
  const ensemble = new EnsembleStrategy([]);
  let threw = false;
  try {
    await ensemble.generateSignals('2026/06/05', { marketRegimeOverride: 'bull' });
  } catch (e: any) {
    threw = true;
    assert('error message contains invalid', e.message.includes('invalid'));
  }
  assert('invalid trade_date throws', threw);
})();

// ----------------------------------------------------------------
// 17. topN <= 0 抛出
// ----------------------------------------------------------------

(async function testTopNZeroThrows() {
  console.log('\n[17] topN <= 0 抛出');
  const ensemble = new EnsembleStrategy([]);
  let threw = false;
  try {
    await ensemble.generateSignals('2026-06-05', {
      marketRegimeOverride: 'bull',
      params: { topN: 0 },
    });
  } catch (e: any) {
    threw = true;
    assert('error message contains topN', e.message.includes('topN'));
  }
  assert('topN=0 throws', threw);

  let threwNeg = false;
  try {
    await ensemble.generateSignals('2026-06-05', {
      marketRegimeOverride: 'bull',
      params: { topN: -5 },
    });
  } catch (e: any) {
    threwNeg = true;
  }
  assert('topN=-5 throws', threwNeg);
})();

// ----------------------------------------------------------------
// 18. 重复 substrategy_key 构造抛出
// ----------------------------------------------------------------

(function testDuplicateSubstrategyKey() {
  console.log('\n[18] 重复 substrategy_key 构造抛出');
  let threw = false;
  try {
    new EnsembleStrategy([
      new FakeSubstrategy('a', ['X']),
      new FakeSubstrategy('a', ['Y']),
    ]);
  } catch (e: any) {
    threw = true;
    assert('error message contains duplicate', e.message.includes('duplicate'));
  }
  assert('duplicate key throws', threw);
})();

// ----------------------------------------------------------------
// 19. resolveEffectiveAllocation 辅助函数边界
// ----------------------------------------------------------------

(function testResolveEffectiveAllocation() {
  console.log('\n[19] resolveEffectiveAllocation 边界用例');
  const pool = new Map<string, EnsembleSubstrategy>();
  pool.set('A', new FakeSubstrategy('A', []));
  pool.set('B', new FakeSubstrategy('B', []));

  // 所有 present
  let r = resolveEffectiveAllocation(
    [{ strategy_key: 'A', weight: 0.3 }, { strategy_key: 'B', weight: 0.7 }],
    pool,
    true
  );
  expectEqual('all present length 2', r.effectiveAllocation.length, 2);
  expectEqual('all present degraded 0', r.degraded.length, 0);
  expectEqual('all present A weight', Math.round(r.effectiveAllocation[0].weight * 1000) / 1000, 0.3);

  // 部分缺失 + rebalance
  r = resolveEffectiveAllocation(
    [{ strategy_key: 'A', weight: 0.3 }, { strategy_key: 'C', weight: 0.7 }],
    pool,
    true
  );
  expectEqual('partial missing length 1', r.effectiveAllocation.length, 1);
  expectEqual('A picks up everything', Math.round(r.effectiveAllocation[0].weight * 1000) / 1000, 1.0);
  expectEqual('C degraded recorded', r.degraded[0].missing_strategy, 'C');

  // 全部缺失
  r = resolveEffectiveAllocation(
    [{ strategy_key: 'X', weight: 0.5 }, { strategy_key: 'Y', weight: 0.5 }],
    pool,
    true
  );
  expectEqual('all missing length 0', r.effectiveAllocation.length, 0);
  expectEqual('all missing degraded 2', r.degraded.length, 2);
  expectEqual('all missing redistributed empty', r.degraded[0].redistributed_to.length, 0);

  // rebalanceMissing=false
  r = resolveEffectiveAllocation(
    [{ strategy_key: 'A', weight: 0.3 }, { strategy_key: 'C', weight: 0.7 }],
    pool,
    false
  );
  // weight 不会重分配；但 normalize 后 A 仍归一化到 1.0
  expectEqual('no rebalance: A normalized to 1.0', Math.round(r.effectiveAllocation[0].weight * 1000) / 1000, 1.0);
  expectEqual('no rebalance: C degraded empty redistribution', r.degraded[0].redistributed_to.length, 0);
})();

// ----------------------------------------------------------------
// 20. normalizeWeightsToOne 辅助函数
// ----------------------------------------------------------------

(function testNormalizeWeightsToOne() {
  console.log('\n[20] normalizeWeightsToOne 边界');
  let r = normalizeWeightsToOne([
    { strategy_key: 'A', weight: 1 },
    { strategy_key: 'B', weight: 1 },
  ]);
  expectEqual('balanced 0.5 / 0.5', r.map(e => Math.round(e.weight * 1000) / 1000), [0.5, 0.5]);

  r = normalizeWeightsToOne([
    { strategy_key: 'A', weight: 3 },
    { strategy_key: 'B', weight: 1 },
  ]);
  expectEqual('3:1 = 0.75/0.25', r.map(e => Math.round(e.weight * 1000) / 1000), [0.75, 0.25]);

  // 单个负值 + 单个正值 → 负值变 0
  r = normalizeWeightsToOne([
    { strategy_key: 'A', weight: -0.5 },
    { strategy_key: 'B', weight: 1 },
  ]);
  expectEqual('A clamps to 0', r[0].weight, 0);
  expectEqual('B = 1.0', r[1].weight, 1);

  // 全 0 → 全 0
  r = normalizeWeightsToOne([
    { strategy_key: 'A', weight: 0 },
    { strategy_key: 'B', weight: 0 },
  ]);
  expectEqual('all 0 stays 0', r.map(e => e.weight), [0, 0]);
})();

// ----------------------------------------------------------------
// 21. 自定义 allocation override
// ----------------------------------------------------------------

(async function testCustomAllocation() {
  console.log('\n[21] 自定义 allocation override');
  const ensemble = new EnsembleStrategy([
    new FakeSubstrategy('multi_factor_alpha', ['MFA1', 'MFA2']),
    new FakeSubstrategy('breakout_strategy', ['BO1']),
  ]);
  const result = await ensemble.generateSignals('2026-06-05', {
    marketRegimeOverride: 'bull',
    params: {
      allocation: {
        bull: [{ strategy_key: 'multi_factor_alpha', weight: 0.9 }, { strategy_key: 'breakout_strategy', weight: 0.1 }],
        bear: [],
        range: [],
        volatile: [],
      },
    },
  });
  // MFA 推 2 只，weight 0.9 → vote 0.9；BO 推 1 只，weight 0.1 → vote 0.1
  const mfa1 = result.signals.find(s => s.stock_code === 'MFA1')!;
  expectEqual('MFA1 vote 0.9', Math.round(mfa1.vote_score * 1000) / 1000, 0.9);
  const bo1 = result.signals.find(s => s.stock_code === 'BO1')!;
  expectEqual('BO1 vote 0.1', Math.round(bo1.vote_score * 1000) / 1000, 0.1);
  // ordering by vote: MFA1 / MFA2 / BO1
  expectEqual('top 1 MFA1', result.target_portfolio[0], 'MFA1');
  expectEqual('top 2 MFA2', result.target_portfolio[1], 'MFA2');
  expectEqual('top 3 BO1', result.target_portfolio[2], 'BO1');
})();

// ----------------------------------------------------------------
// 22. params.allocation 显式空 bear → 全 SELL
// ----------------------------------------------------------------

(async function testEmptyRegimeAllocation() {
  console.log('\n[22] regime 对应空 allocation → previous 清仓');
  const ensemble = new EnsembleStrategy([
    new FakeSubstrategy('multi_factor_alpha', ['M1', 'M2']),
  ]);
  const result = await ensemble.generateSignals('2026-06-05', {
    marketRegimeOverride: 'bull',
    previousSelection: ['HELD'],
    params: {
      allocation: {
        bull: [],
        bear: [],
        range: [],
        volatile: [],
      },
    },
  });
  expectEqual('target empty', result.target_portfolio.length, 0);
  expectEqual('HELD sell', result.signals.length, 1);
  expectEqual('HELD sell signal', result.signals[0].signal, 'sell');
})();

// ----------------------------------------------------------------
// 23. 实际默认子策略池构造（不传 substrategies）
// ----------------------------------------------------------------

(function testDefaultSubstrategyPool() {
  console.log('\n[23] 默认子策略池构造（不传 substrategies）');
  // 不传 substrategies → 自动 new MultiFactorAlphaStrategy 等 8 个实例
  // 不应该 throw（即使各子策略生产 DataSource 需要 DB 也是惰性的）
  const ensemble = new EnsembleStrategy();
  expectEqual('strategy_key', ensemble.definition.strategy_key, 'ensemble_strategy');
  // 不调 generateSignals 因为生产 DataSource 会 hit DB
})();

// ----------------------------------------------------------------
// 24. previousSelection 内的股票出现在 target 应该是 HOLD
// ----------------------------------------------------------------

(async function testPreviousInTargetIsHold() {
  console.log('\n[24] previousSelection 在 target 内 → HOLD');
  const ensemble = new EnsembleStrategy([
    new FakeSubstrategy('multi_factor_alpha', ['A', 'B', 'C']),
  ]);
  const result = await ensemble.generateSignals('2026-06-05', {
    marketRegimeOverride: 'bull',
    previousSelection: ['A', 'B'],
  });
  const aSig = result.signals.find(s => s.stock_code === 'A')!;
  const bSig = result.signals.find(s => s.stock_code === 'B')!;
  const cSig = result.signals.find(s => s.stock_code === 'C')!;
  expectEqual('A is hold', aSig.signal, 'hold');
  expectEqual('B is hold', bSig.signal, 'hold');
  expectEqual('C is buy', cSig.signal, 'buy');
  expectEqual('reason for hold contains 保留', aSig.reason.includes('保留'), true);
  expectEqual('reason for buy contains 新进', cSig.reason.includes('新进'), true);
})();

// ----------------------------------------------------------------
// 25. SELL 信号包含 vote_score (即使子策略未推荐 = 0)
// ----------------------------------------------------------------

(async function testSellSignalVoteScore() {
  console.log('\n[25] SELL 信号有 vote_score 字段');
  const ensemble = new EnsembleStrategy([
    new FakeSubstrategy('multi_factor_alpha', ['NEW1']),
  ]);
  const result = await ensemble.generateSignals('2026-06-05', {
    marketRegimeOverride: 'bull',
    previousSelection: ['OLD1'],
  });
  const sellSig = result.signals.find(s => s.stock_code === 'OLD1')!;
  expectEqual('OLD1 signal sell', sellSig.signal, 'sell');
  expectEqual('OLD1 vote_score = 0', sellSig.vote_score, 0);
  expectEqual('OLD1 no contributors', sellSig.contributing_substrategies.length, 0);
})();

// ----------------------------------------------------------------
// 26. params override 传部分参数
// ----------------------------------------------------------------

(async function testPartialParamsOverride() {
  console.log('\n[26] params override 仅传 topN');
  const ensemble = new EnsembleStrategy([
    new FakeSubstrategy('multi_factor_alpha', ['A', 'B', 'C', 'D', 'E']),
  ]);
  const result = await ensemble.generateSignals('2026-06-05', {
    marketRegimeOverride: 'bull',
    params: { topN: 3 },
  });
  expectEqual('topN cap 3', result.target_portfolio.length, 3);
  // benchmarkSymbol / rebalanceMissingWeights 仍是 default
  expectEqual('benchmark default', result.params.benchmarkSymbol, 'sh.000300');
  expectEqual('rebalance default', result.params.rebalanceMissingWeights, true);
})();

// ----------------------------------------------------------------
// 27. range / unknown raw regime 都映射到 range ensemble
// ----------------------------------------------------------------

(async function testUnknownToRange() {
  console.log('\n[27] unknown raw → range ensemble');
  const ensemble = new EnsembleStrategy([
    new FakeSubstrategy('sector_rotation_leader', ['SR1']),
    new FakeSubstrategy('left_side_reversal', ['LSR1']),
    new FakeSubstrategy('earnings_surprise', ['ES1']),
  ]);
  const result = await ensemble.generateSignals('2026-06-05', { marketRegimeOverride: 'unknown' });
  expectEqual('unknown → range', result.market_regime, 'range');
  expectEqual('raw preserved as unknown', result.raw_market_regime, 'unknown');
  expectEqual('target 3 stocks', result.target_portfolio.length, 3);
})();

// ----------------------------------------------------------------
// 28. rebound → range
// ----------------------------------------------------------------

(async function testReboundToRange() {
  console.log('\n[28] rebound raw → range ensemble');
  const ensemble = new EnsembleStrategy([
    new FakeSubstrategy('sector_rotation_leader', ['SR1']),
    new FakeSubstrategy('left_side_reversal', ['LSR1']),
    new FakeSubstrategy('earnings_surprise', ['ES1']),
  ]);
  const result = await ensemble.generateSignals('2026-06-05', { marketRegimeOverride: 'rebound' });
  expectEqual('rebound → range', result.market_regime, 'range');
  expectEqual('raw preserved as rebound', result.raw_market_regime, 'rebound');
})();

// ----------------------------------------------------------------
// 29. substrategy_diagnostics 完整字段
// ----------------------------------------------------------------

(async function testSubstrategyDiagnostics() {
  console.log('\n[29] substrategy_diagnostics 完整字段');
  const ensemble = new EnsembleStrategy([
    new FakeSubstrategy('multi_factor_alpha', ['A', 'B', 'C']),
    new FakeSubstrategy('dragon_head_momentum', ['B'], 'positions'),
    new FakeSubstrategy('breakout_strategy', new Error('breakout died')),
  ]);
  const result = await ensemble.generateSignals('2026-06-05', { marketRegimeOverride: 'bull' });
  expectEqual('diag length 3', result.substrategy_diagnostics.length, 3);
  for (const d of result.substrategy_diagnostics) {
    assert(`${d.strategy_key} has weight_used`, typeof d.weight_used === 'number');
    assert(`${d.strategy_key} has target_size`, typeof d.target_size === 'number');
    assert(`${d.strategy_key} has elapsed_ms`, typeof d.elapsed_ms === 'number');
  }
  const mfaDiag = result.substrategy_diagnostics.find(d => d.strategy_key === 'multi_factor_alpha')!;
  expectEqual('MFA target_size 3', mfaDiag.target_size, 3);
  const boDiag = result.substrategy_diagnostics.find(d => d.strategy_key === 'breakout_strategy')!;
  assert('breakout has error', boDiag.error !== undefined);
})();

// ----------------------------------------------------------------
// 30. effective_weights 含全部生效子策略
// ----------------------------------------------------------------

(async function testEffectiveWeights() {
  console.log('\n[30] effective_weights 含全部生效子策略');
  const ensemble = new EnsembleStrategy([
    new FakeSubstrategy('multi_factor_alpha', ['A']),
    new FakeSubstrategy('dragon_head_momentum', ['B']),
    new FakeSubstrategy('breakout_strategy', ['C']),
  ]);
  const result = await ensemble.generateSignals('2026-06-05', { marketRegimeOverride: 'bull' });
  expectEqual('effective_weights keys length 3', Object.keys(result.effective_weights).length, 3);
  expectEqual('MFA 0.4', Math.round(result.effective_weights['multi_factor_alpha'] * 1000) / 1000, 0.4);
  expectEqual('DragonHead 0.3', Math.round(result.effective_weights['dragon_head_momentum'] * 1000) / 1000, 0.3);
  expectEqual('Breakout 0.3', Math.round(result.effective_weights['breakout_strategy'] * 1000) / 1000, 0.3);
})();

// ----------------------------------------------------------------
// Phase 4+ NEW: disabled strategy (kill_switch 触发后) 自动跳过 + 走 redistribute
// ----------------------------------------------------------------

(async function testDisabledStrategySkipped() {
  console.log('\n[N+1] Phase 4+ kill_switch — disabled 子策略走 redistribute 路径');
  // bull: MFA 0.4 + DragonHead 0.3 + Breakout 0.3
  // 模拟 DragonHead 被 kill_switch 触发 enabled=false
  // 期望: DragonHead 的 0.3 权重 redistribute → MFA 与 Breakout
  //       degraded_substitutions[0].reason='disabled' (区别 'not_implemented')
  const ensemble = new EnsembleStrategy(
    [
      new FakeSubstrategy('multi_factor_alpha', ['M1', 'M2'], 'portfolio'),
      new FakeSubstrategy('dragon_head_momentum', ['D1'], 'positions'),
      new FakeSubstrategy('breakout_strategy', ['B1'], 'positions'),
    ],
    async () => new Set(['dragon_head_momentum']) // fake disabled loader
  );
  const result = await ensemble.generateSignals('2026-06-05', { marketRegimeOverride: 'bull' });
  expectEqual('market_regime', result.market_regime, 'bull');
  // dragon_head 不应该出现在 effective_weights
  assert(
    'dragon_head_momentum 不在 effective_weights',
    result.effective_weights['dragon_head_momentum'] === undefined
  );
  // MFA + Breakout 总和 = 1.0
  const sum =
    (result.effective_weights['multi_factor_alpha'] ?? 0) +
    (result.effective_weights['breakout_strategy'] ?? 0);
  expectEqual('剩余 weights 归一化总和 = 1.0', Math.round(sum * 1000) / 1000, 1.0);
  // degraded 长度 = 1，reason = 'disabled'
  expectEqual('degraded.length = 1', result.degraded_substitutions.length, 1);
  expectEqual(
    'degraded.missing_strategy = dragon_head_momentum',
    result.degraded_substitutions[0].missing_strategy,
    'dragon_head_momentum'
  );
  expectEqual(
    'degraded.reason = "disabled" (Phase 4+)',
    result.degraded_substitutions[0].reason,
    'disabled'
  );
  assert(
    'degraded.redistributed_to 含 MFA 与 Breakout',
    result.degraded_substitutions[0].redistributed_to.includes('multi_factor_alpha') &&
      result.degraded_substitutions[0].redistributed_to.includes('breakout_strategy')
  );
})();

(async function testDisabledLoaderFailsFailsOpen() {
  console.log('\n[N+2] Phase 4+ kill_switch — disabledLoader 抛错 → fail-OPEN (返回 empty set)');
  // disabledLoader 抛错 → catch 返回 empty Set → ensemble 不该把任何子策略当 disabled
  const ensemble = new EnsembleStrategy(
    [
      new FakeSubstrategy('multi_factor_alpha', ['M1'], 'portfolio'),
      new FakeSubstrategy('dragon_head_momentum', ['D1'], 'positions'),
      new FakeSubstrategy('breakout_strategy', ['B1'], 'positions'),
    ],
    async () => {
      throw new Error('fake DB outage');
    }
  );
  const result = await ensemble.generateSignals('2026-06-05', { marketRegimeOverride: 'bull' });
  // 3 个子策略都应在 effective_weights
  expectEqual('effective_weights keys = 3', Object.keys(result.effective_weights).length, 3);
  expectEqual('degraded.length = 0', result.degraded_substitutions.length, 0);
})();

(async function testDisabledAndNotImplementedMixed() {
  console.log('\n[N+3] Phase 4+ kill_switch — mixed disabled + not_implemented (bear 环境)');
  // bear: HDV 0.6 + LowVol 0.4
  // LowVol 本就不在 pool (not_implemented)，HDV 又被 disabled
  // 期望: effective_allocation 为空 → 返回空 target
  const ensemble = new EnsembleStrategy(
    [new FakeSubstrategy('high_dividend_value', ['HDV1'], 'portfolio')],
    async () => new Set(['high_dividend_value'])
  );
  const result = await ensemble.generateSignals('2026-06-05', { marketRegimeOverride: 'bear' });
  expectEqual('target_portfolio empty', result.target_portfolio.length, 0);
  expectEqual('signals empty (只有 0 个候选)', result.signals.length, 0);
  expectEqual('degraded.length = 2 (HDV + LowVol)', result.degraded_substitutions.length, 2);
  const hdvDegraded = result.degraded_substitutions.find(d => d.missing_strategy === 'high_dividend_value');
  const lvDegraded = result.degraded_substitutions.find(d => d.missing_strategy === 'low_vol_strategy');
  expectEqual('HDV reason=disabled', hdvDegraded?.reason, 'disabled');
  expectEqual('LowVol reason=not_implemented', lvDegraded?.reason, 'not_implemented');
})();

// ----------------------------------------------------------------
// 测试运行入口
// ----------------------------------------------------------------

(async function main() {
  // 上面的所有 IIFE 都已经触发了；只需等待异步完成
  // 给一个 tick 让所有 async IIFEs 完成
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setTimeout(resolve, 100));
  console.log('\n');
  if (failed === 0) {
    console.log('all ok');
    process.exit(0);
  } else {
    console.error(`${failed} test(s) failed`);
    process.exit(1);
  }
})();
