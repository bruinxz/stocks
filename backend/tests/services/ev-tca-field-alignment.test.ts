/**
 * EVDecisionService / TCAService 字段对齐回归测试 (Sprint 44 后修复).
 *
 * 不依赖 DB / jest, 直接 node 跑:
 *   cd backend && npx ts-node --transpile-only tests/services/ev-tca-field-alignment.test.ts
 *
 * 背景:
 *   修复前 PRODUCTION_EV_DECISION_DATA_SOURCE / PRODUCTION_TCA_DATA_SOURCE 用 `status` /
 *   `closed_at` / `profit_pct` / `strategy_key` 4 个 RecommendationTradeOutcome 模型里
 *   不存在的字段, 导致 .findAll() 在 Postgres 报 "column does not exist" 然后被 try/catch
 *   吞掉, 4 级 fallback 全部退到 default 5%/3%, 让 EV gate 退化为静态阈值.
 *
 * 这里测的是 fake DataSource 路径在 caller (autoBuyFromSignals) 视角下的 contract:
 *   1. loadStrategyRegimeStats 输入 (strategy_key, regime, lookback, as_of) 返回 stats
 *   2. fake 注入足够样本时, stats_source = 'strategy_regime' 不会退回 fallback
 *   3. fake 返回 null 时, 走 loadGlobalStats / default fallback
 *
 * Production 字段对齐由 grep + 手工 review 保证 (本测试不连 DB), 见 commit msg.
 */
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

// ----- Test 1: fake DataSource 返回足量样本 → stats_source='strategy_regime' -----
(async () => {
  const fakeSource = {
    async loadStrategyRegimeStats(
      strategy_key: string,
      regime: string,
      _lookback: number,
      _as_of: string
    ) {
      return {
        strategy_key,
        regime,
        sample_count: 20,
        avg_win_pct: 0.07, // 7%
        avg_loss_pct: 0.04, // 4%
        historical_win_rate: 0.55,
      };
    },
    async loadGlobalStats() {
      return null;
    },
  };
  const ev = new EVDecisionService(fakeSource as any);
  const result = await ev.decide({
    symbol: 'sh.600519',
    strategy_key: 'mean_reversion_strategy',
    regime: 'bull',
    calibrated_win_prob: 0.6,
    as_of_date: '2026-06-16',
  });
  assert(
    result.stats_source === 'strategy_regime',
    `期望 stats_source=strategy_regime, 实际 ${result.stats_source}`
  );
  assert(
    Math.abs(result.avg_win_pct - 0.07) < 1e-9,
    `期望 avg_win_pct=0.07, 实际 ${result.avg_win_pct}`
  );
  assert(
    Math.abs(result.avg_loss_pct - 0.04) < 1e-9,
    `期望 avg_loss_pct=0.04, 实际 ${result.avg_loss_pct}`
  );
  // EV = 0.6 × 0.07 - 0.4 × 0.04 - 0.003 = 0.042 - 0.016 - 0.003 = 0.023 → bet
  assert(result.decision === 'bet', `期望 decision=bet, 实际 ${result.decision}`);
  assert(
    Math.abs(result.ev - (0.6 * 0.07 - 0.4 * 0.04 - 0.003)) < 1e-9,
    `EV 计算错: ${result.ev}`
  );

  // ----- Test 2: per-strategy fake null → 走 global fallback -----
  const fakeSource2 = {
    async loadStrategyRegimeStats() {
      return null;
    },
    async loadGlobalStats() {
      return {
        sample_count: 50,
        avg_win_pct: 0.06,
        avg_loss_pct: 0.035,
      };
    },
  };
  const ev2 = new EVDecisionService(fakeSource2 as any);
  const result2 = await ev2.decide({
    symbol: 'sh.600519',
    strategy_key: 'mean_reversion_strategy',
    regime: 'bull',
    calibrated_win_prob: 0.6,
    as_of_date: '2026-06-16',
  });
  assert(
    result2.stats_source === 'global_fallback',
    `期望 stats_source=global_fallback, 实际 ${result2.stats_source}`
  );
  assert(
    Math.abs(result2.avg_win_pct - 0.06) < 1e-9,
    `Test 2 avg_win_pct 错: ${result2.avg_win_pct}`
  );

  // ----- Test 3: 全部 null → default_fallback (5%/3%) -----
  const fakeSource3 = {
    async loadStrategyRegimeStats() {
      return null;
    },
    async loadGlobalStats() {
      return null;
    },
  };
  const ev3 = new EVDecisionService(fakeSource3 as any);
  const result3 = await ev3.decide({
    symbol: 'sh.600519',
    strategy_key: 'mean_reversion_strategy',
    regime: 'bull',
    calibrated_win_prob: 0.6,
    as_of_date: '2026-06-16',
  });
  assert(
    result3.stats_source === 'default_fallback',
    `期望 stats_source=default_fallback, 实际 ${result3.stats_source}`
  );
  assert(
    Math.abs(result3.avg_win_pct - 0.05) < 1e-9,
    `Test 3 avg_win_pct 应为默认 5%, 实际 ${result3.avg_win_pct}`
  );

  // ----- Test 4: sample_count < min_samples_for_stats (默认 10) → 走 fallback -----
  const fakeSource4 = {
    async loadStrategyRegimeStats() {
      return {
        strategy_key: 'x',
        regime: 'bull',
        sample_count: 3, // 不足
        avg_win_pct: 0.99,
        avg_loss_pct: 0.99,
        historical_win_rate: 0.5,
      };
    },
    async loadGlobalStats() {
      return {
        sample_count: 100,
        avg_win_pct: 0.06,
        avg_loss_pct: 0.03,
      };
    },
  };
  const ev4 = new EVDecisionService(fakeSource4 as any);
  const result4 = await ev4.decide({
    symbol: 'sh.600519',
    strategy_key: 'x',
    regime: 'bull',
    calibrated_win_prob: 0.6,
    as_of_date: '2026-06-16',
  });
  assert(
    result4.stats_source === 'global_fallback',
    `Test 4 期望 global_fallback (per-strategy 样本不足), 实际 ${result4.stats_source}`
  );
  assert(
    Math.abs(result4.avg_win_pct - 0.06) < 1e-9,
    `Test 4 avg_win_pct 应来自 global, 实际 ${result4.avg_win_pct}`
  );

  console.log(`\n${pass} passed, ${fail} failed.`);
  if (fail > 0) {
    console.error(`\nFAILURES:\n${failures.map(f => `  - ${f}`).join('\n')}`);
    process.exit(1);
  } else {
    console.log('✓ EV/TCA field alignment regression tests passed.');
    process.exit(0);
  }
})();
