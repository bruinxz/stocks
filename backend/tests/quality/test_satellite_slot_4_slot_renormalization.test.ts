/**
 * @fileoverview Task #12 v2 · §Rounding-Tie-Break SHA-lock 4 断言 · module invocation
 *
 * SHA-lock: refs/heads/main @ 47e8dd1 · §Rounding-Tie-Break
 *
 * 权威锚 (副 · 规则源):
 *   docs/refactor/adr/0001-layering-and-collab.md §附录 §Rounding-Tie-Break
 * 权威锚 (主 · 数值定值表 + slot 命名):
 *   docs/refactor/contracts/strategy.md v1 §Q7.1 (主态 5-slot 定值表)
 *   docs/refactor/contracts/strategy.md v1 §Q7.2 (回落态 4-slot 精算表)
 *   docs/refactor/contracts/strategy.md v1 §Q7.4 (ENABLE_US_DRIVER_SIGNAL 双态切换开关)
 *
 * 承接位: QADocs Task #12 · 契约层数值 + slot 命名 SHA-lock
 * 语义: 契约层 v1 §Q7 slot 命名 + 定值表 + §Rounding-Tie-Break 规则的数值不变守护
 *
 * §Q7 5-slot 主态 slot 命名 (v1 §Q7.1 landed):
 *   us_driver / history_response / quality_proxy / intraday_momentum / news_evidence
 * §Q7 4-slot 回落态 slot 命名 (v1 §Q7.2 landed · us_driver 移除):
 *   history_response / quality_proxy / intraday_momentum / news_evidence
 *
 * 注: 上述 5-slot 命名 ≠ core.factors 5-factor 命名 (Momentum/Value/Quality/Size/LowVol)
 *     satellite 层 vs core 层 · 不同层不同命名 · 参照 §Layer-Separation 层分离原则
 *
 * 版本历史:
 *   v0   - 初稿 · slot 命名错误引 core.factors 5-factor · Strategy msg=b40c2100 blocker
 *   v0.1 - slot 命名修正为 v1 §Q7 官方名 · 二签 · @jest/globals import (未过 run-tests.ts runner)
 *   v2 (本文件) - Task #12 v2 融合位 · hardcoded → module invocation · 语义等价
 *                依 backend/src/backtest/satellite/slot-weight-scheme.ts v1 landed
 *                test 范式改回项目标准 IIFE (assert + process.exit) · 对齐 backend/src/scripts/run-tests.ts runner
 *
 * 运行:
 *   cd backend && npx ts-node --transpile-only tests/quality/test_satellite_slot_4_slot_renormalization.test.ts
 *   cd backend && npm test -- --filter=satellite_slot
 */

import assert from 'node:assert/strict';
import {
  SATELLITE_5_SLOT_MAIN_WEIGHTS,
  SATELLITE_4_SLOT_FALLBACK_WEIGHTS,
  US_DRIVER_MAIN_WEIGHT,
  FALLBACK_RENORMALIZE_DIVISOR,
  renormalizeWeightsRaw,
  renormalizeWeights,
  resolveActiveSlotWeights,
} from '../../src/backtest/satellite/slot-weight-scheme';

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

function assertCloseTo(actual: number, expected: number, digits: number): void {
  const tolerance = Math.pow(10, -digits) / 2;
  const diff = Math.abs(actual - expected);
  assert.ok(
    diff <= tolerance,
    `expected ${actual} to be close to ${expected} (±${tolerance}, diff=${diff})`
  );
}

function main() {
  console.log('§Rounding-Tie-Break · Satellite 5-slot ↔ 4-slot renormalization · SHA-lock @ 47e8dd1');

  it('断言 A · 5-slot 主态权重和归一化 == 1.000', () => {
    // 参照 docs/refactor/contracts/strategy.md v1 §Q7.1 · 5-slot 主态定值表
    const w = SATELLITE_5_SLOT_MAIN_WEIGHTS;
    assertCloseTo(w.us_driver, 0.30, 3);
    assertCloseTo(w.history_response, 0.25, 3);
    assertCloseTo(w.quality_proxy, 0.15, 3);
    assertCloseTo(w.intraday_momentum, 0.15, 3);
    assertCloseTo(w.news_evidence, 0.15, 3);
    const sum =
      w.us_driver + w.history_response + w.quality_proxy + w.intraday_momentum + w.news_evidence;
    assertCloseTo(sum, 1.0, 3);
  });

  it('断言 B · 4-slot 回落态归一化前值 w_i / 0.70 三值等 0.214286', () => {
    // 参照 docs/refactor/contracts/strategy.md v1 §Q7.2 · 4-slot 精算表
    assertCloseTo(US_DRIVER_MAIN_WEIGHT, 0.30, 3);
    assertCloseTo(FALLBACK_RENORMALIZE_DIVISOR, 0.70, 3);

    const raw = renormalizeWeightsRaw(SATELLITE_5_SLOT_MAIN_WEIGHTS);
    assertCloseTo(raw.history_response, 0.357143, 6);
    assertCloseTo(raw.quality_proxy, 0.214286, 6);
    assertCloseTo(raw.intraday_momentum, 0.214286, 6);
    assertCloseTo(raw.news_evidence, 0.214286, 6);

    // 归一化前四值权重和 == 1.000 · 但 3 位小数舍入后需 tie-break（见断言 C）
    const raw_sum =
      raw.history_response + raw.quality_proxy + raw.intraday_momentum + raw.news_evidence;
    assertCloseTo(raw_sum, 1.0, 6);
  });

  it('断言 C · §Rounding-Tie-Break · tie-break +0.001 落 news_evidence slot', () => {
    // 参照 docs/refactor/adr/0001-layering-and-collab.md §附录 §Rounding-Tie-Break
    // §Rounding-Tie-Break 规则: 尾差 +0.001 补偿位落在 news_evidence slot
    const final = renormalizeWeights(SATELLITE_5_SLOT_MAIN_WEIGHTS);

    // module 输出终态与 landed contract §Q7.2 精算表一致
    assert.deepEqual(final, SATELLITE_4_SLOT_FALLBACK_WEIGHTS);

    assertCloseTo(final.news_evidence, 0.215, 3); // 0.214 + 0.001 tie-break
    assertCloseTo(final.history_response, 0.357, 3);
    assertCloseTo(final.quality_proxy, 0.214, 3);
    assertCloseTo(final.intraday_momentum, 0.214, 3);

    const sum =
      final.history_response + final.quality_proxy + final.intraday_momentum + final.news_evidence;
    assertCloseTo(sum, 1.0, 3);
  });

  it('断言 D · 双态互斥 · 4-slot 回落态权重和 = 1.000', () => {
    // 参照 docs/refactor/contracts/strategy.md v1 §Q7.4 · ENABLE_US_DRIVER_SIGNAL 双态切换开关
    const mainState = resolveActiveSlotWeights(true);
    const fallbackState = resolveActiveSlotWeights(false);

    const main_sum =
      ('us_driver' in mainState ? mainState.us_driver : 0) +
      mainState.history_response +
      mainState.quality_proxy +
      mainState.intraday_momentum +
      mainState.news_evidence;
    assertCloseTo(main_sum, 1.0, 3);
    assert.equal('us_driver' in mainState, true);

    const fallback_sum =
      fallbackState.history_response +
      fallbackState.quality_proxy +
      fallbackState.intraday_momentum +
      fallbackState.news_evidence;
    assertCloseTo(fallback_sum, 1.0, 3);
    assert.equal('us_driver' in fallbackState, false);

    assert.deepEqual(fallbackState, SATELLITE_4_SLOT_FALLBACK_WEIGHTS);
  });

  console.log(`\nSummary: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
