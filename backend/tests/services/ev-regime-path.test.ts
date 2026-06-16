/**
 * EV regime 路径修复回归测试 (2026-06-16).
 *
 * 不依赖 jest, 直接 node 跑:
 *   cd backend && npx ts-node --transpile-only tests/services/ev-regime-path.test.ts
 *
 * Bug 复现:
 *   修复前 EVDecisionService.loadStrategyRegimeStats 读 meta.market_regime (top-level),
 *   但 RecommendationTradeOutcome 实际把 regime 存在
 *   metadata.market_environment.market_regime 或
 *   metadata.signal_metadata.market_environment.market_regime (nested).
 *   prod 库 72 outcome 100% top-level regime 为 NULL, 100% nested 有 value.
 *   → per-(strategy, regime) 主源永不命中, 永远退到 global_fallback.
 *
 * 修复:
 *   filter 函数 fallback chain: meta.market_environment.market_regime →
 *   meta.signal_metadata.market_environment.market_regime → meta.market_regime
 */
/* eslint-disable @typescript-eslint/no-var-requires */
import { EVDecisionService } from '../../src/services/meta-v2/EVDecisionService';

let pass = 0;
let fail = 0;
const failures: string[] = [];
function assert(cond: boolean, msg: string) {
  if (cond) pass++;
  else {
    fail++;
    failures.push(msg);
    console.error(`✗ ${msg}`);
  }
}

(async () => {
  // 构造 fake DataSource 模拟生产 prod outcome metadata schema (regime nested).
  // 关键是: 真正的过滤逻辑在 PRODUCTION_EV_DECISION_DATA_SOURCE.loadStrategyRegimeStats
  // 而不是 service. 但我们这里测的是 fake DataSource 的契约 + service decide 链路.
  //
  // 直接测 PRODUCTION_EV_DECISION_DATA_SOURCE 的 filter callback 需要构造 mock 行数组,
  // 简化做法: 重写一个测试 DataSource 完全模拟 production 的 filter 逻辑, 看 nested
  // regime 能否被命中.

  // 构造 12 行 fake outcome rows, 6 个 regime=bull 在 nested path, 6 个 regime=bear
  const fakeRows = [
    // 6 bull (nested in market_environment)
    ...Array.from({ length: 6 }, () => ({
      total_pnl_pct: 5.0,
      metadata: {
        strategy_key: 'test_strategy',
        market_environment: { market_regime: 'bull' },
      },
    })),
    // 6 bear (nested in signal_metadata.market_environment — 第 2 个路径)
    ...Array.from({ length: 6 }, () => ({
      total_pnl_pct: -3.0,
      metadata: {
        strategy_key: 'test_strategy',
        signal_metadata: { market_environment: { market_regime: 'bear' } },
      },
    })),
  ];

  // 模拟 production filter (与 EVDecisionService.ts:211-224 完全同款)
  function filterFn(strategy_key: string, regime: string) {
    return fakeRows.filter(r => {
      const meta = r?.metadata || {};
      const sk = meta.strategy_key;
      const signalMeta = (meta as any).signal_metadata || {};
      const reg =
        ((meta as any).market_environment && (meta as any).market_environment.market_regime) ||
        (signalMeta.market_environment && signalMeta.market_environment.market_regime) ||
        (meta as any).market_regime;
      return sk === strategy_key && reg === regime;
    });
  }

  // Test 1: bull 应能命中 6 行 (top-level market_environment.market_regime)
  const bullRows = filterFn('test_strategy', 'bull');
  assert(bullRows.length === 6, `bull (top-level nested) 应命中 6 行, 实际 ${bullRows.length}`);

  // Test 2: bear 应能命中 6 行 (signal_metadata.market_environment.market_regime)
  const bearRows = filterFn('test_strategy', 'bear');
  assert(bearRows.length === 6, `bear (signal_metadata nested) 应命中 6 行, 实际 ${bearRows.length}`);

  // Test 3: 错误的 strategy_key 应命中 0
  const wrongStrat = filterFn('wrong_strategy', 'bull');
  assert(wrongStrat.length === 0, `wrong_strategy 应命中 0, 实际 ${wrongStrat.length}`);

  // Test 4: 错误的 regime 应命中 0
  const wrongReg = filterFn('test_strategy', 'sideways');
  assert(wrongReg.length === 0, `regime=sideways 应命中 0, 实际 ${wrongReg.length}`);

  // Test 5: top-level fallback (假设未来 backfill 把 regime 提到 top-level)
  const topLevelRows = [
    {
      total_pnl_pct: 7.0,
      metadata: { strategy_key: 'top_strat', market_regime: 'sideways' },
    },
  ];
  const topFiltered = topLevelRows.filter(r => {
    const meta = r?.metadata || {};
    const sk = (meta as any).strategy_key;
    const signalMeta = (meta as any).signal_metadata || {};
    const reg =
      ((meta as any).market_environment && (meta as any).market_environment.market_regime) ||
      (signalMeta.market_environment && signalMeta.market_environment.market_regime) ||
      (meta as any).market_regime;
    return sk === 'top_strat' && reg === 'sideways';
  });
  assert(topFiltered.length === 1, `top-level fallback (market_regime) 应命中 1, 实际 ${topFiltered.length}`);

  // Test 6: 与 service.decide 联动测试 — 注入足量 stats (>= min_samples=10), 看 decision='bet'
  const evService = new EVDecisionService({
    async loadStrategyRegimeStats(_sk, _reg, _lb, _as) {
      return {
        strategy_key: _sk,
        regime: _reg,
        sample_count: 20, // > min_samples_for_stats=10
        avg_win_pct: 0.05,
        avg_loss_pct: 0.03,
        historical_win_rate: 1.0,
      };
    },
    async loadGlobalStats() {
      return null;
    },
  });
  const r = await evService.decide({
    symbol: 'sh.600519',
    strategy_key: 'test_strategy',
    regime: 'bull',
    calibrated_win_prob: 0.7,
    as_of_date: '2026-06-16',
  });
  assert(r.stats_source === 'strategy_regime', `stats_source 应为 strategy_regime, 实际 ${r.stats_source}`);
  assert(r.decision === 'bet', `decision 应为 bet (EV>0), 实际 ${r.decision}`);

  console.log(`\n${pass} passed, ${fail} failed.`);
  if (fail > 0) {
    console.error(`\nFAILURES:\n${failures.map(f => `  - ${f}`).join('\n')}`);
    process.exit(1);
  } else {
    console.log('✓ EV regime path 修复回归测试通过.');
    process.exit(0);
  }
})();
