/**
 * US-083 dry-run mode 单元测试。
 *
 * 不依赖 jest；node 直接跑：
 *   cd backend && npx ts-node --transpile-only tests/strategies/QuantStrategyDryRun.test.ts
 *
 * 覆盖 US-083 全部三层 dry-run 实现：
 *
 * 1) QuantStrategy 基类：
 *    - dryRun 默认 false
 *    - setDryRun(true) / setDryRun(false) / setDryRun('true') / setDryRun(undefined)
 *      / setDryRun(null) / setDryRun(0) / setDryRun(1) 的强类型转换
 *    - isDryRun(options) 的优先级：runtime options.dryRun > instance.dryRun
 *
 * 2) QuantStrategyService 纯函数 pickDryRunStrategyKeysFromRecords：
 *    - lifecycle_policy.dry_run === true → 入选
 *    - lifecycle_policy.dry_run === 'true' (字符串) → 入选 (JSONB 兼容)
 *    - lifecycle_policy.dry_run === false / undefined / null → 不入选
 *    - lifecycle_policy 非对象 / null → 不入选
 *    - strategy_key 空字符串 → 不入选
 *    - 去重保留顺序
 *    - 空数组 / undefined 输入安全返回 []
 *
 * 3) PaperTradingAutomationService 纯函数 signalIsDryRunByStrategy：
 *    - 空 dryRunStrategyKeys → 永远 false（语义：没人是 dry-run，全走真实下单）
 *    - signal metadata.strategy_key 命中 → true
 *    - signal metadata.strategy_variant.strategy_key 命中 → true
 *    - signal metadata 中 strategy_keys[] 数组命中 → true
 *    - signal metadata 中 consensus_variants[] 命中 → true
 *    - signal metadata 无 strategy 信息 → 兜底为 'unknown'，仅当 'unknown' 在 dry-run 集合
 *      时才匹配
 *    - 多 key 中只要一个命中即匹配
 *    - signal metadata 缺失或 null → 不抛
 */

import { QuantStrategy } from '../../src/quant/strategies/QuantStrategy';
import {
  QuantSignalResult,
  QuantStockContext,
  QuantStrategyDefinition,
  QuantStrategyRuntimeOptions,
} from '../../src/quant/types/QuantTypes';
import { pickDryRunStrategyKeysFromRecords } from '../../src/quant/engine/internal/QuantStrategyService';
import { signalIsDryRunByStrategy } from '../../src/portfolio/internal/PaperTradingAutomationService';

let failed = 0;
let passed = 0;

function assert(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`❌ ${name}${detail ? '  detail=' + detail : ''}`);
  }
}

function assertEqual<T>(name: string, actual: T, expected: T): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  assert(name, ok, `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
}

// ----------------------------------------------------------------
//  Fake QuantStrategy subclass for instance-level tests
// ----------------------------------------------------------------

class FakeStrategy extends QuantStrategy {
  readonly definition: QuantStrategyDefinition = {
    strategy_key: 'fake_dryrun_test',
    name: 'Fake DryRun Test Strategy',
    description: 'Inert strategy used only to exercise dryRun base-class plumbing.',
    category: 'multi_factor',
    default_params: {},
    enabled: true,
    risk_level: 'medium',
    tags: [],
  };

  evaluate(_context: QuantStockContext, _options?: QuantStrategyRuntimeOptions): QuantSignalResult {
    // Inert — these tests do not invoke evaluate().
    return {
      score: 50,
      signal: 'hold',
      confidence: 0.5,
      reasons: [],
      risk_flags: [],
      factors: {},
    };
  }
}

// ----------------------------------------------------------------
//  Section 1 — QuantStrategy.setDryRun / isDryRun
// ----------------------------------------------------------------

(function testQuantStrategyDryRunBase() {
  const s = new FakeStrategy();
  assertEqual('default dryRun is false', s.dryRun, false);
  assertEqual('default isDryRun() is false', s.isDryRun(), false);

  s.setDryRun(true);
  assertEqual('setDryRun(true) → dryRun true', s.dryRun, true);
  assertEqual('isDryRun() honors instance true', s.isDryRun(), true);

  s.setDryRun(false);
  assertEqual('setDryRun(false) → dryRun false', s.dryRun, false);
  assertEqual('isDryRun() honors instance false', s.isDryRun(), false);

  s.setDryRun('true');
  assertEqual('setDryRun("true") string → dryRun true (JSONB compat)', s.dryRun, true);

  s.setDryRun('false');
  assertEqual('setDryRun("false") string → dryRun false', s.dryRun, false);

  s.setDryRun(undefined);
  assertEqual('setDryRun(undefined) → false (safe coercion)', s.dryRun, false);

  s.setDryRun(null);
  assertEqual('setDryRun(null) → false', s.dryRun, false);

  s.setDryRun(0);
  assertEqual('setDryRun(0) → false (non-strict, only true / "true" set true)', s.dryRun, false);

  s.setDryRun(1);
  assertEqual('setDryRun(1) → false (non-true number stays false)', s.dryRun, false);

  s.setDryRun('TRUE');
  assertEqual('setDryRun("TRUE") uppercase → false (string match is exact "true")', s.dryRun, false);

  // runtime option override
  s.setDryRun(false);
  assertEqual(
    'isDryRun({dryRun: true}) runtime override wins over instance false',
    s.isDryRun({ dryRun: true }),
    true
  );
  s.setDryRun(true);
  assertEqual(
    'isDryRun({dryRun: false}) runtime override wins over instance true',
    s.isDryRun({ dryRun: false }),
    false
  );
  assertEqual(
    'isDryRun({}) (no dryRun key) falls back to instance true',
    s.isDryRun({}),
    true
  );
  s.setDryRun(false);
  assertEqual(
    'isDryRun({}) (no dryRun key) falls back to instance false',
    s.isDryRun({}),
    false
  );
  assertEqual(
    'isDryRun(undefined) (no options) falls back to instance false',
    s.isDryRun(undefined),
    false
  );
})();

// ----------------------------------------------------------------
//  Section 2 — pickDryRunStrategyKeysFromRecords
// ----------------------------------------------------------------

(function testPickDryRunStrategyKeysFromRecords() {
  // Empty / undefined
  assertEqual('empty array → []', pickDryRunStrategyKeysFromRecords([]), []);
  assertEqual('undefined input → []', pickDryRunStrategyKeysFromRecords(undefined as any), []);

  // True values picked
  assertEqual(
    'lifecycle.dry_run === true picked',
    pickDryRunStrategyKeysFromRecords([
      { strategy_key: 'mfa', lifecycle_policy: { dry_run: true } },
    ]),
    ['mfa']
  );

  // JSONB legacy: string "true"
  assertEqual(
    'lifecycle.dry_run === "true" string also picked (JSONB legacy)',
    pickDryRunStrategyKeysFromRecords([
      { strategy_key: 'breakout', lifecycle_policy: { dry_run: 'true' } },
    ]),
    ['breakout']
  );

  // False / undefined / null not picked
  assertEqual(
    'lifecycle.dry_run === false NOT picked',
    pickDryRunStrategyKeysFromRecords([
      { strategy_key: 'a', lifecycle_policy: { dry_run: false } },
    ]),
    []
  );
  assertEqual(
    'lifecycle.dry_run undefined NOT picked',
    pickDryRunStrategyKeysFromRecords([{ strategy_key: 'b', lifecycle_policy: {} }]),
    []
  );
  assertEqual(
    'lifecycle.dry_run null NOT picked',
    pickDryRunStrategyKeysFromRecords([
      { strategy_key: 'c', lifecycle_policy: { dry_run: null } },
    ]),
    []
  );
  assertEqual(
    'lifecycle_policy undefined NOT picked',
    pickDryRunStrategyKeysFromRecords([{ strategy_key: 'd' } as any]),
    []
  );
  assertEqual(
    'lifecycle_policy null NOT picked',
    pickDryRunStrategyKeysFromRecords([
      { strategy_key: 'e', lifecycle_policy: null as any },
    ]),
    []
  );
  assertEqual(
    'lifecycle_policy is string (not object) NOT picked',
    pickDryRunStrategyKeysFromRecords([
      { strategy_key: 'f', lifecycle_policy: 'true' as any },
    ]),
    []
  );

  // Mixed: only the dry-run ones surface, order preserved
  assertEqual(
    'mixed list → only dry-run keys in original order',
    pickDryRunStrategyKeysFromRecords([
      { strategy_key: 'a', lifecycle_policy: { dry_run: true } },
      { strategy_key: 'b', lifecycle_policy: { dry_run: false } },
      { strategy_key: 'c', lifecycle_policy: { dry_run: 'true' } },
      { strategy_key: 'd', lifecycle_policy: {} },
      { strategy_key: 'e', lifecycle_policy: { dry_run: true } },
    ]),
    ['a', 'c', 'e']
  );

  // Empty strategy_key skipped
  assertEqual(
    'empty strategy_key not picked even if dry_run=true',
    pickDryRunStrategyKeysFromRecords([
      { strategy_key: '', lifecycle_policy: { dry_run: true } },
      { strategy_key: '  ', lifecycle_policy: { dry_run: true } },
      { strategy_key: 'real', lifecycle_policy: { dry_run: true } },
    ]),
    ['real']
  );

  // Dedup
  assertEqual(
    'duplicate strategy_key deduped, first wins',
    pickDryRunStrategyKeysFromRecords([
      { strategy_key: 'a', lifecycle_policy: { dry_run: true } },
      { strategy_key: 'a', lifecycle_policy: { dry_run: true } },
      { strategy_key: 'b', lifecycle_policy: { dry_run: true } },
    ]),
    ['a', 'b']
  );

  // Strategy_key trimmed
  assertEqual(
    'strategy_key with whitespace trimmed',
    pickDryRunStrategyKeysFromRecords([
      { strategy_key: '  trimmed_key  ', lifecycle_policy: { dry_run: true } },
    ]),
    ['trimmed_key']
  );
})();

// ----------------------------------------------------------------
//  Section 3 — signalIsDryRunByStrategy
// ----------------------------------------------------------------

(function testSignalIsDryRunByStrategy() {
  // Fake signal builder — we only need `.metadata` access; cast as any.
  function makeSignal(metadata: any): any {
    return { metadata };
  }

  // Empty dry-run list → never matches (semantic: no one is dry-run → all live)
  assertEqual(
    'empty dryRunStrategyKeys → always false (even when metadata has strategy_key)',
    signalIsDryRunByStrategy(makeSignal({ strategy_key: 'mfa' }), []),
    false
  );

  // Direct strategy_key match
  assertEqual(
    'metadata.strategy_key in dry-run set → true',
    signalIsDryRunByStrategy(makeSignal({ strategy_key: 'mfa' }), ['mfa']),
    true
  );
  assertEqual(
    'metadata.strategy_key NOT in dry-run set → false',
    signalIsDryRunByStrategy(makeSignal({ strategy_key: 'mfa' }), ['breakout']),
    false
  );

  // Nested strategy_variant
  assertEqual(
    'metadata.strategy_variant.strategy_key in set → true',
    signalIsDryRunByStrategy(
      makeSignal({ strategy_variant: { strategy_key: 'dragon_head' } }),
      ['dragon_head']
    ),
    true
  );

  // strategy_keys[] array inside strategy_variant
  assertEqual(
    'metadata.strategy_variant.strategy_keys[] in set → true',
    signalIsDryRunByStrategy(
      makeSignal({ strategy_variant: { strategy_keys: ['a', 'b', 'c'] } }),
      ['b']
    ),
    true
  );

  // consensus_variants[]
  assertEqual(
    'metadata.consensus_variants[] in set → true',
    signalIsDryRunByStrategy(makeSignal({ consensus_variants: ['x', 'y'] }), ['y']),
    true
  );

  // Multiple dry-run keys: any-of match wins
  assertEqual(
    'multi-key set: any-of match → true',
    signalIsDryRunByStrategy(makeSignal({ strategy_key: 'mfa' }), ['breakout', 'mfa', 'cta']),
    true
  );
  assertEqual(
    'multi-key set: none match → false',
    signalIsDryRunByStrategy(makeSignal({ strategy_key: 'other' }), ['breakout', 'mfa', 'cta']),
    false
  );

  // Missing strategy info: helper falls back to 'unknown' sentinel.  signal is
  // dry-run only if 'unknown' explicitly added to the dry-run set (typically not
  // the case in production).
  assertEqual(
    'metadata with no strategy info → false against real-key set',
    signalIsDryRunByStrategy(makeSignal({}), ['mfa']),
    false
  );
  assertEqual(
    "metadata with no strategy info, 'unknown' in set → true (matches sentinel)",
    signalIsDryRunByStrategy(makeSignal({}), ['unknown']),
    true
  );

  // Metadata null / undefined safe
  assertEqual(
    'metadata=null safe (no throw, returns false)',
    signalIsDryRunByStrategy(makeSignal(null), ['mfa']),
    false
  );
  assertEqual(
    'metadata=undefined safe',
    signalIsDryRunByStrategy(makeSignal(undefined), ['mfa']),
    false
  );

  // paperTradingMetaForPortfolio path: strategy_key wrapped in paper trading meta
  // (paperTradingMetaForPortfolio reads metadata.paper_trading_meta or root)
  assertEqual(
    'metadata.paper_trading.strategy_key in set → true (paperTrading branch)',
    signalIsDryRunByStrategy(
      makeSignal({ paper_trading: { strategy_key: 'pt_strat' } }),
      ['pt_strat']
    ),
    true
  );
})();

// ----------------------------------------------------------------
//  Test runner entry
// ----------------------------------------------------------------

(async function main() {
  await new Promise(resolve => setImmediate(resolve));
  console.log('\n');
  console.log(`passed=${passed} failed=${failed}`);
  if (failed === 0) {
    console.log('all ok');
    process.exit(0);
  } else {
    console.error(`${failed} test(s) failed`);
    process.exit(1);
  }
})();
