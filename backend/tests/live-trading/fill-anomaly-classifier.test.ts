/**
 * fill-anomaly-classifier.test.ts — US-138 [EX-013] 实盘 fill 异常分类 单测
 *
 *   cd backend && npx ts-node --transpile-only tests/live-trading/fill-anomaly-classifier.test.ts
 *
 * 覆盖:
 *   [1] classifyFillAnomaly 全状态枚举映射 (filled / partially_filled / cancelled+filled
 *       / cancelled+unfilled / failed / failed+rejected metadata / rejected / expired /
 *       aborted / in-flight / pending / unknown)
 *   [2] cancel_order command 单独分支: cancelled / filled / failed / expired / aborted /
 *       in_flight / unknown
 *   [3] aggregateFillAnomalies 计数器 + anomaly_total / terminal_total / anomaly_rate
 *       (含 in_flight 排除 / 空集 / 全 filled / 全异常)
 *   [4] 不变量:
 *       - FILL_ANOMALY_CATEGORIES Object.frozen (防意外 mutate)
 *       - FILL_ANOMALY_CATEGORY_LABELS Object.frozen, key 与枚举完全对齐
 *       - ANOMALY_CATEGORIES 不含 filled_full / in_flight / unknown (异常率口径正确)
 *       - by_category 顺序与 FILL_ANOMALY_CATEGORIES 一致
 *
 * DB-less, 纯函数; 与 broker-bridge fail-safe 同款 IIFE + process.exit 约定.
 */

import {
  classifyFillAnomaly,
  aggregateFillAnomalies,
  FILL_ANOMALY_CATEGORIES,
  FILL_ANOMALY_CATEGORY_LABELS,
  ANOMALY_CATEGORIES,
  FillAnomalyCategory,
} from '../../src/live-trading/services/fillAnomalyClassifier';

let passed = 0;
let failed = 0;

function assert(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed += 1;
    console.log(`  ok  ${name}${detail ? ` (${detail})` : ''}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}${detail ? ` (${detail})` : ''}`);
  }
}

function assertEq<T>(name: string, actual: T, expected: T): void {
  assert(name, actual === expected, `expected=${String(expected)} actual=${String(actual)}`);
}

(async function run() {
  console.log('--- [1] classifyFillAnomaly place_order 全状态枚举映射 ---');
  assertEq(
    'filled → filled_full',
    classifyFillAnomaly({ status: 'filled', quantity: 100, filled_quantity: 100 }),
    'filled_full'
  );
  assertEq(
    'partially_filled → partial_only',
    classifyFillAnomaly({ status: 'partially_filled', quantity: 100, filled_quantity: 30 }),
    'partial_only'
  );
  assertEq(
    'cancelled + filled>0 → cancelled_partial',
    classifyFillAnomaly({ status: 'cancelled', quantity: 100, filled_quantity: 30 }),
    'cancelled_partial'
  );
  assertEq(
    'cancelled + filled=0 → cancelled_unfilled',
    classifyFillAnomaly({ status: 'cancelled', quantity: 100, filled_quantity: 0 }),
    'cancelled_unfilled'
  );
  assertEq(
    'failed (no metadata) → failed',
    classifyFillAnomaly({ status: 'failed', quantity: 100, filled_quantity: 0 }),
    'failed'
  );
  assertEq(
    'failed + metadata.error_kind=rejected_by_broker → rejected',
    classifyFillAnomaly({
      status: 'failed',
      quantity: 100,
      filled_quantity: 0,
      metadata: { error_kind: 'rejected_by_broker' },
    }),
    'rejected'
  );
  assertEq(
    'failed + metadata.reason_code=reject_price → rejected',
    classifyFillAnomaly({
      status: 'failed',
      quantity: 100,
      filled_quantity: 0,
      metadata: { reason_code: 'reject_price_out_of_range' },
    }),
    'rejected'
  );
  assertEq(
    'failed + metadata.rejected=true → rejected',
    classifyFillAnomaly({
      status: 'failed',
      quantity: 100,
      filled_quantity: 0,
      metadata: { rejected: true },
    }),
    'rejected'
  );
  assertEq(
    'status=rejected (direct) → rejected',
    classifyFillAnomaly({ status: 'rejected', quantity: 100, filled_quantity: 0 }),
    'rejected'
  );
  assertEq(
    'expired (filled=0) → expired',
    classifyFillAnomaly({ status: 'expired', quantity: 100, filled_quantity: 0 }),
    'expired'
  );
  assertEq(
    'expired (filled>0, partial) → expired (主动 vs 被动区分)',
    classifyFillAnomaly({ status: 'expired', quantity: 100, filled_quantity: 50 }),
    'expired'
  );
  assertEq(
    'aborted → aborted',
    classifyFillAnomaly({ status: 'aborted', quantity: 100, filled_quantity: 0 }),
    'aborted'
  );

  console.log('--- [1b] in-flight 状态 → in_flight ---');
  for (const s of ['pending', 'dispatching', 'dispatched', 'submitted']) {
    assertEq(
      `${s} → in_flight`,
      classifyFillAnomaly({ status: s, quantity: 100, filled_quantity: 0 }),
      'in_flight'
    );
  }

  console.log('--- [1c] 未知 status 走 unknown ---');
  assertEq(
    'fake_status → unknown',
    classifyFillAnomaly({ status: 'fake_status', quantity: 100, filled_quantity: 0 }),
    'unknown'
  );
  assertEq(
    'null status → unknown',
    classifyFillAnomaly({ status: null as any, quantity: 100, filled_quantity: 0 }),
    'unknown'
  );
  assertEq('null input → unknown', classifyFillAnomaly(null as any), 'unknown');

  console.log('--- [2] classifyFillAnomaly cancel_order 单独分支 ---');
  assertEq(
    'cancel + cancelled → filled_full (撤单达成意图)',
    classifyFillAnomaly({ status: 'cancelled', command_type: 'cancel_order' }),
    'filled_full'
  );
  assertEq(
    'cancel + filled → filled_full (异步路径)',
    classifyFillAnomaly({ status: 'filled', command_type: 'cancel_order' }),
    'filled_full'
  );
  assertEq(
    'cancel + failed → failed (broker 已成交)',
    classifyFillAnomaly({ status: 'failed', command_type: 'cancel_order' }),
    'failed'
  );
  assertEq(
    'cancel + cancel_error → failed',
    classifyFillAnomaly({ status: 'cancel_error', command_type: 'cancel_order' }),
    'failed'
  );
  assertEq(
    'cancel + expired → expired',
    classifyFillAnomaly({ status: 'expired', command_type: 'cancel_order' }),
    'expired'
  );
  assertEq(
    'cancel + aborted → aborted',
    classifyFillAnomaly({ status: 'aborted', command_type: 'cancel_order' }),
    'aborted'
  );
  assertEq(
    'cancel + pending → in_flight',
    classifyFillAnomaly({ status: 'pending', command_type: 'cancel_order' }),
    'in_flight'
  );
  assertEq(
    'cancel + fake → unknown',
    classifyFillAnomaly({ status: 'fake', command_type: 'cancel_order' }),
    'unknown'
  );

  console.log('--- [3] aggregateFillAnomalies ---');
  const empty = aggregateFillAnomalies([]);
  assertEq('empty total=0', empty.total, 0);
  assertEq('empty anomaly_total=0', empty.anomaly_total, 0);
  assertEq('empty terminal_total=0', empty.terminal_total, 0);
  assertEq('empty anomaly_rate=0', empty.anomaly_rate, 0);
  assertEq(
    'empty by_category has 10 entries (全枚举 0 填充)',
    empty.by_category.length,
    FILL_ANOMALY_CATEGORIES.length
  );

  const allFilled = aggregateFillAnomalies(['filled_full', 'filled_full', 'filled_full']);
  assertEq('allFilled total=3', allFilled.total, 3);
  assertEq('allFilled anomaly_total=0', allFilled.anomaly_total, 0);
  assertEq('allFilled terminal_total=3', allFilled.terminal_total, 3);
  assertEq('allFilled anomaly_rate=0', allFilled.anomaly_rate, 0);

  const mixed = aggregateFillAnomalies([
    'filled_full',
    'filled_full',
    'cancelled_partial',
    'rejected',
    'failed',
    'in_flight',
  ]);
  assertEq('mixed total=6', mixed.total, 6);
  assertEq('mixed anomaly_total=3', mixed.anomaly_total, 3);
  assertEq('mixed terminal_total=5 (in_flight 排除)', mixed.terminal_total, 5);
  assert(
    'mixed anomaly_rate=3/5=0.6',
    Math.abs(mixed.anomaly_rate - 0.6) < 1e-9,
    `actual=${mixed.anomaly_rate}`
  );

  const cancelledOnly = mixed.by_category.find(b => b.category === 'cancelled_partial')!;
  assertEq('mixed by_category cancelled_partial=1', cancelledOnly.count, 1);
  const filledBucket = mixed.by_category.find(b => b.category === 'filled_full')!;
  assertEq('mixed by_category filled_full=2', filledBucket.count, 2);
  assertEq(
    'mixed by_category 顺序首位=filled_full',
    mixed.by_category[0].category,
    'filled_full'
  );
  assertEq(
    'mixed by_category 末位=unknown',
    mixed.by_category[mixed.by_category.length - 1].category,
    'unknown'
  );
  assertEq(
    'mixed by_category label=人读',
    cancelledOnly.label,
    FILL_ANOMALY_CATEGORY_LABELS.cancelled_partial
  );

  // unknown category 防御性映射
  const withFake = aggregateFillAnomalies([
    'filled_full',
    'not_a_real_category' as unknown as FillAnomalyCategory,
  ]);
  assertEq('withFake unknown=1 (未知 category 落 unknown)', withFake.by_category[9].count, 1);

  console.log('--- [4] 不变量 ---');
  assert(
    'FILL_ANOMALY_CATEGORIES is frozen',
    Object.isFrozen(FILL_ANOMALY_CATEGORIES),
    'Object.freeze 必须真生效, 防意外 push 漂移'
  );
  assert(
    'FILL_ANOMALY_CATEGORY_LABELS is frozen',
    Object.isFrozen(FILL_ANOMALY_CATEGORY_LABELS),
    'Object.freeze 必须真生效'
  );
  const labelKeys = Object.keys(FILL_ANOMALY_CATEGORY_LABELS).sort();
  const enumKeys = [...FILL_ANOMALY_CATEGORIES].sort();
  assert(
    'LABELS key 集与枚举集对齐',
    JSON.stringify(labelKeys) === JSON.stringify(enumKeys),
    `labels=${labelKeys.join(',')} enum=${enumKeys.join(',')}`
  );
  assert(
    'ANOMALY_CATEGORIES 不含 filled_full',
    !ANOMALY_CATEGORIES.has('filled_full'),
    '异常率口径: filled_full 算正常'
  );
  assert(
    'ANOMALY_CATEGORIES 不含 in_flight',
    !ANOMALY_CATEGORIES.has('in_flight'),
    '异常率口径: in_flight 算分母排除项 (未终态)'
  );
  assert(
    'ANOMALY_CATEGORIES 不含 unknown',
    !ANOMALY_CATEGORIES.has('unknown'),
    '异常率口径: unknown 不计入分子'
  );

  console.log('\n--- summary ---');
  console.log(`  passed=${passed}  failed=${failed}`);
  if (failed > 0) process.exit(1);
  process.exit(0);
})().catch(err => {
  console.error('uncaught error:', err);
  process.exit(1);
});
