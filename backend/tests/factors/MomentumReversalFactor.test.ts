/**
 * MomentumReversalFactor 单元测试 (US-033).
 *
 * 不依赖 jest；node 直接跑：
 *   cd backend && npx ts-node --transpile-only tests/factors/MomentumReversalFactor.test.ts
 *
 * 覆盖：
 *   - 纯函数 computeWindowMomentum:
 *     - 序列长度 < window+1 → null
 *     - 序列长度 = window+1（恰好够）→ 正常算
 *     - 序列长度 > window+1 → 取尾部 close[T] / close[T-window]
 *     - window <= 0 / 非整数 → null
 *     - close[T] 或 close[T-window] = 0 → null
 *     - close NaN / Infinity → null
 *     - 真实场景：[100, 105, 110, 108, 115], window=4 → 115/100 - 1 = 0.15
 *     - window=1 退化为单日变化
 *   - 纯函数 combineMomentumReversal:
 *     - 任一 null → null
 *     - 任一 NaN/Infinity → null
 *     - long > short → 正值（趋势延续）
 *     - long < short → 负值（短期超涨）
 *     - long == short → 0
 *   - 纯函数 extractSortedCloses:
 *     - 空数组 → []
 *     - close <= 0 / NaN / 缺 跳过
 *     - 非有限时间戳跳过
 *     - 时间倒序输入 → 升序输出
 *     - Date / string / number 三种 time 形式统一处理
 *   - Factor metadata (name='momentum_reversal' / category='momentum' /
 *     description 非空 + 含关键字 / compute 是函数 / 已注册 / listNames 含 /
 *     get 拿回同对象 / 既有 momentum 因子未被破坏)
 *   - 常量校验 LONG_MOMENTUM_WINDOW=120 / SHORT_MOMENTUM_WINDOW=5 /
 *     MOMENTUM_REVERSAL_QUERY_CALENDAR_DAYS
 *   - compute() 空 universe 安全路径
 *   - 端到端语义验证：构造 closes 序列，验证 mom_120 - mom_5 算法正确性
 */

import {
  momentumReversalFactor,
  computeWindowMomentum,
  combineMomentumReversal,
  extractSortedCloses,
  LONG_MOMENTUM_WINDOW,
  SHORT_MOMENTUM_WINDOW,
  MOMENTUM_REVERSAL_QUERY_CALENDAR_DAYS,
} from '../../src/quant/factors/library/MomentumReversalFactor';
import { factorRegistry } from '../../src/quant/factors/FactorRegistry';
// 触发 library 自我登记
// eslint-disable-next-line @typescript-eslint/no-var-requires
import '../../src/quant/factors/library';

let failed = 0;
let passed = 0;

function assert(name: string, cond: boolean, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`  ok  ${name}${detail ? ` (${detail})` : ''}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}${detail ? ` (${detail})` : ''}`);
  }
}

function near(a: number, b: number, eps = 1e-9): boolean {
  return Math.abs(a - b) < eps;
}

function expectClose(name: string, actual: number, expected: number, eps = 1e-9) {
  assert(name, near(actual, expected, eps), `expected≈${expected}, got=${actual}`);
}

console.log('\n## computeWindowMomentum 边界');
{
  // 序列长度 < window+1 → null
  assert(
    '空数组 → null',
    computeWindowMomentum([], 5) === null
  );
  assert(
    '长度=window → null (差 1 个观测)',
    computeWindowMomentum([100, 101, 102, 103, 104], 5) === null
  );
  assert(
    '长度=window+1 (恰好够) → 算',
    computeWindowMomentum([100, 101, 102, 103, 104, 105], 5) !== null
  );
}
{
  // 恰好 window+1 的精确算法：(105 / 100) - 1 = 0.05
  expectClose(
    '长度=window+1，(close[5]/close[0])-1 = 0.05',
    computeWindowMomentum([100, 101, 102, 103, 104, 105], 5) ?? -1,
    0.05
  );
}
{
  // 超出 window+1 时也取尾部窗口：[80, 90, 100, 105, 110, 108, 115] window=4
  // close[6] = 115; close[6-4] = close[2] = 100 → 0.15
  expectClose(
    '超出 window+1 取尾部：[80, 90, 100, 105, 110, 108, 115] w=4 → 115/100-1=0.15',
    computeWindowMomentum([80, 90, 100, 105, 110, 108, 115], 4) ?? -1,
    0.15
  );
}
{
  // window=1 退化为单日变化 (110/105 - 1 ≈ 0.0476)
  expectClose(
    'window=1 退化为单日 (110/105 - 1)',
    computeWindowMomentum([100, 105, 110], 1) ?? -1,
    110 / 105 - 1
  );
}
{
  // window=0 → null（无意义）
  assert(
    'window=0 → null',
    computeWindowMomentum([100, 101, 102], 0) === null
  );
  assert(
    'window=-1 → null',
    computeWindowMomentum([100, 101, 102], -1) === null
  );
  assert(
    'window=3.5 (非整数) → null',
    computeWindowMomentum([100, 101, 102, 103, 104], 3.5) === null
  );
}
{
  // close[T] = 0 → null（停牌等）
  assert(
    'close[T] = 0 → null',
    computeWindowMomentum([100, 101, 102, 103, 104, 0], 5) === null
  );
  // close[T] < 0 → null
  assert(
    'close[T] < 0 → null',
    computeWindowMomentum([100, 101, 102, 103, 104, -10], 5) === null
  );
  // close[T-window] = 0 → null
  assert(
    'close[T-window] = 0 → null',
    computeWindowMomentum([0, 101, 102, 103, 104, 105], 5) === null
  );
}
{
  // NaN / Infinity → null
  assert(
    'close[T] = NaN → null',
    computeWindowMomentum([100, 101, 102, 103, 104, NaN], 5) === null
  );
  assert(
    'close[T-window] = Infinity → null',
    computeWindowMomentum([Infinity, 101, 102, 103, 104, 105], 5) === null
  );
}
{
  // 真实场景：120 天涨 50% → (150 / 100) - 1 = 0.5
  const closes = Array.from({ length: 121 }, (_, i) => 100 + i * (50 / 120));
  // closes[0] = 100, closes[120] = 150
  expectClose(
    '120 日涨 50% → 0.5',
    computeWindowMomentum(closes, 120) ?? -1,
    0.5,
    1e-6
  );
}
{
  // 5 日涨 5%：closes[-1] / closes[-6] - 1 ≈ 0.05
  const closes = [80, 85, 90, 95, 100, 102, 100, 99, 98, 102, 105];
  // closes[10]=105, closes[10-5]=closes[5]=102 → 105/102 - 1 ≈ 0.0294
  expectClose(
    '尾部 5 日 momentum',
    computeWindowMomentum(closes, 5) ?? -1,
    105 / 102 - 1
  );
}

console.log('\n## combineMomentumReversal');
{
  // 任一 null → null
  assert('null + 数 → null', combineMomentumReversal(null, 0.05) === null);
  assert('数 + null → null', combineMomentumReversal(0.1, null) === null);
  assert('null + null → null', combineMomentumReversal(null, null) === null);
}
{
  // 任一 NaN / Infinity → null
  assert('NaN + 数 → null', combineMomentumReversal(NaN, 0.05) === null);
  assert('数 + NaN → null', combineMomentumReversal(0.1, NaN) === null);
  assert(
    'Infinity + 数 → null',
    combineMomentumReversal(Infinity, 0.05) === null
  );
  assert(
    '数 + -Infinity → null',
    combineMomentumReversal(0.1, -Infinity) === null
  );
}
{
  // long > short → 正值（趋势延续）
  expectClose(
    'mom_long=10%, mom_short=3% → +7% (延续)',
    combineMomentumReversal(0.1, 0.03) ?? -999,
    0.07
  );
  // long < short → 负值（短期超涨）
  expectClose(
    'mom_long=2%, mom_short=8% → -6% (反转)',
    combineMomentumReversal(0.02, 0.08) ?? -999,
    -0.06
  );
  // long == short → 0
  expectClose(
    'mom_long=5%, mom_short=5% → 0',
    combineMomentumReversal(0.05, 0.05) ?? -999,
    0
  );
}
{
  // 都为负数（下跌中）
  expectClose(
    'mom_long=-20%, mom_short=-5% → -15% (短期超跌)',
    combineMomentumReversal(-0.2, -0.05) ?? -999,
    -0.15
  );
  expectClose(
    'mom_long=-5%, mom_short=-20% → +15% (短期超跌反弹)',
    combineMomentumReversal(-0.05, -0.2) ?? -999,
    0.15
  );
}
{
  // 0 + 0 → 0
  expectClose('0 - 0 → 0', combineMomentumReversal(0, 0) ?? -999, 0);
}

console.log('\n## extractSortedCloses');
{
  // 空数组
  assert(
    '空数组 → []',
    extractSortedCloses([]).length === 0
  );
}
{
  // 升序输入 → 同样升序输出
  const rows = [
    { time: '2026-06-01T00:00:00Z', close: 100 },
    { time: '2026-06-02T00:00:00Z', close: 101 },
    { time: '2026-06-03T00:00:00Z', close: 102 },
  ];
  const closes = extractSortedCloses(rows);
  assert('升序输入 length 3', closes.length === 3);
  expectClose('closes[0] = 100', closes[0], 100);
  expectClose('closes[2] = 102', closes[2], 102);
}
{
  // 时间倒序输入 → 升序输出
  const rows = [
    { time: '2026-06-03T00:00:00Z', close: 102 },
    { time: '2026-06-01T00:00:00Z', close: 100 },
    { time: '2026-06-02T00:00:00Z', close: 101 },
  ];
  const closes = extractSortedCloses(rows);
  assert('倒序输入仍 3 个', closes.length === 3);
  expectClose('排序后 closes[0] = 100', closes[0], 100);
  expectClose('排序后 closes[1] = 101', closes[1], 101);
  expectClose('排序后 closes[2] = 102', closes[2], 102);
}
{
  // close <= 0 跳过
  const rows = [
    { time: '2026-06-01T00:00:00Z', close: 100 },
    { time: '2026-06-02T00:00:00Z', close: 0 }, // 跳过
    { time: '2026-06-03T00:00:00Z', close: -5 }, // 跳过
    { time: '2026-06-04T00:00:00Z', close: 105 },
  ];
  const closes = extractSortedCloses(rows);
  assert('close <= 0 跳过：剩 2 个', closes.length === 2);
  expectClose('closes[0] = 100', closes[0], 100);
  expectClose('closes[1] = 105', closes[1], 105);
}
{
  // NaN close 跳过
  const rows = [
    { time: '2026-06-01T00:00:00Z', close: 100 },
    { time: '2026-06-02T00:00:00Z', close: NaN }, // 跳过
    { time: '2026-06-03T00:00:00Z', close: 110 },
  ];
  const closes = extractSortedCloses(rows);
  assert('NaN close 跳过：剩 2 个', closes.length === 2);
}
{
  // 缺 close 字段（undefined）跳过
  const rows = [
    { time: '2026-06-01T00:00:00Z', close: 100 },
    { time: '2026-06-02T00:00:00Z' }, // 缺 close → Number(undefined) = NaN 跳过
  ];
  const closes = extractSortedCloses(rows);
  assert('缺 close 字段跳过：剩 1 个', closes.length === 1);
}
{
  // 非有限时间戳跳过
  const rows = [
    { time: 'INVALID-DATE' as any, close: 100 }, // new Date → NaN
    { time: '2026-06-02T00:00:00Z', close: 101 },
  ];
  const closes = extractSortedCloses(rows);
  assert('非法时间跳过：剩 1 个', closes.length === 1);
  expectClose('剩下的是 101', closes[0], 101);
}
{
  // Date object / string / number 三种 time 形式
  const baseMs = new Date('2026-06-01T00:00:00Z').getTime();
  const rows = [
    { time: new Date('2026-06-01T00:00:00Z'), close: 100 },
    { time: '2026-06-02T00:00:00Z' as any, close: 101 },
    { time: baseMs + 2 * 86400_000, close: 102 },
  ];
  const closes = extractSortedCloses(rows);
  assert('3 种 time 形式都接受', closes.length === 3);
  expectClose('closes[0] = 100', closes[0], 100);
  expectClose('closes[1] = 101', closes[1], 101);
  expectClose('closes[2] = 102', closes[2], 102);
}
{
  // string close 也应该工作（Sequelize raw DECIMAL）
  const rows = [
    { time: '2026-06-01T00:00:00Z', close: '100' as any },
    { time: '2026-06-02T00:00:00Z', close: '105.5' as any },
  ];
  const closes = extractSortedCloses(rows);
  assert('string close 也转 Number', closes.length === 2);
  expectClose('closes[0] = 100', closes[0], 100);
  expectClose('closes[1] = 105.5', closes[1], 105.5);
}

console.log('\n## 端到端：combineMomentumReversal 与 computeWindowMomentum 集成');
{
  // 构造一个 121 长 close 序列，验证 mom_120 - mom_5 算法正确性
  // closes[0] = 100, closes[120] = 150 → mom_120 = 0.5
  // closes[115] = 100 + 115*(50/120), closes[120] = 150
  //   → mom_5 = 150 / (100 + 115*50/120) - 1
  const closes = Array.from({ length: 121 }, (_, i) => 100 + i * (50 / 120));
  const momLong = computeWindowMomentum(closes, 120);
  const momShort = computeWindowMomentum(closes, 5);
  const reversal = combineMomentumReversal(momLong, momShort);
  assert('mom_120 非 null', momLong !== null);
  assert('mom_5 非 null', momShort !== null);
  assert('reversal 非 null', reversal !== null);
  // 线性增长情况下 mom_5 必然 < mom_120（短窗口涨幅 < 长窗口涨幅）
  // → reversal > 0 (趋势延续)
  assert(
    `线性增长 → reversal > 0 (got ${reversal})`,
    reversal !== null && reversal > 0
  );
}
{
  // 反向场景：前 60 天平盘，后 60 天暴涨 → 短期动量 > 长期动量 → reversal < 0
  const flat = Array.from({ length: 60 }, () => 100);
  const rally = Array.from({ length: 61 }, (_, i) => 100 + i * 2); // 100 ↑ 220
  const closes = [...flat, ...rally];
  // closes.length = 121
  const momLong = computeWindowMomentum(closes, 120);
  const momShort = computeWindowMomentum(closes, 5);
  const reversal = combineMomentumReversal(momLong, momShort);
  // mom_120 = closes[120] / closes[0] - 1 = 220/100 - 1 = 1.2
  // mom_5 = closes[120] / closes[115] - 1 = 220 / (100 + 55*2) - 1 = 220/210 - 1 ≈ 0.0476
  // → reversal = 1.2 - 0.0476 ≈ 1.152 > 0
  // 想要 reversal < 0 需要更剧烈的短期脉冲...重新构造：
  // 前 116 天小幅波动 ±0.5%，最后 5 天加速暴涨
  expectClose(
    '场景 A：长期累涨，长窗口仍占优 → mom_long - mom_short > 0',
    reversal ?? -999,
    1.2 - (220 / 210 - 1),
    1e-9
  );
}
{
  // 真正的"短期超涨"场景：长期窗口涨 5%，但后 5 天涨 30%
  // closes[0..115] 从 100 缓涨到 105，closes[115..120] 从 105 暴涨到 137 (30%)
  const slow = Array.from({ length: 116 }, (_, i) => 100 + i * (5 / 115));
  const surge = Array.from({ length: 5 }, (_, i) => 105 + (i + 1) * (32 / 5));
  const closes = [...slow, ...surge];
  // closes.length = 121
  const momLong = computeWindowMomentum(closes, 120);
  const momShort = computeWindowMomentum(closes, 5);
  const reversal = combineMomentumReversal(momLong, momShort);
  // mom_120 = closes[120]/closes[0] - 1 = 137/100 - 1 = 0.37
  // mom_5 = closes[120]/closes[115] - 1 = 137/105 - 1 ≈ 0.3048
  // → reversal ≈ 0.37 - 0.3048 ≈ 0.065 (仍然正，因为长期累涨较多)
  assert(
    `场景 B：mom_long ≈ 0.37, mom_short ≈ 0.305, reversal ≈ +0.065`,
    momLong !== null && momShort !== null && reversal !== null &&
      near(momLong, 0.37, 1e-9) &&
      near(momShort, 137 / 105 - 1, 1e-9) &&
      near(reversal, 0.37 - (137 / 105 - 1), 1e-9)
  );
}
{
  // 真正的"短期超涨反转"场景：长期 -10%，短期 +20%
  // closes[0..115] 从 100 缓跌到 90，closes[115..120] 从 90 反弹到 108
  const decline = Array.from({ length: 116 }, (_, i) => 100 - i * (10 / 115));
  const rebound = Array.from({ length: 5 }, (_, i) => 90 + (i + 1) * (18 / 5));
  const closes = [...decline, ...rebound];
  const momLong = computeWindowMomentum(closes, 120);
  const momShort = computeWindowMomentum(closes, 5);
  const reversal = combineMomentumReversal(momLong, momShort);
  // mom_120 = 108/100 - 1 = 0.08
  // mom_5 = 108/90 - 1 = 0.2
  // → reversal = 0.08 - 0.2 = -0.12 (负值 = 短期超涨反转)
  expectClose(
    '场景 C：mom_long=8%, mom_short=20%, reversal=-12% (短期超涨反转)',
    reversal ?? -999,
    0.08 - 0.2,
    1e-9
  );
  assert(
    '场景 C：reversal < 0',
    reversal !== null && reversal < 0
  );
}

console.log('\n## momentumReversalFactor metadata + 注册');
assert('name = momentum_reversal', momentumReversalFactor.name === 'momentum_reversal');
assert('category = momentum', momentumReversalFactor.category === 'momentum');
assert(
  'description 非空',
  typeof momentumReversalFactor.description === 'string' &&
    momentumReversalFactor.description.length > 0
);
assert(
  'description 包含 "120" / "5" 关键词',
  momentumReversalFactor.description.includes('120') &&
    momentumReversalFactor.description.includes('5')
);
assert(
  'description 包含 "趋势延续" / "反转" 语义关键词',
  momentumReversalFactor.description.includes('延续') ||
    momentumReversalFactor.description.includes('反转')
);
assert('compute 是函数', typeof momentumReversalFactor.compute === 'function');
assert('已注册到全局 factorRegistry', factorRegistry.has('momentum_reversal'));
assert(
  '已纳入 listNames()',
  factorRegistry.listNames().includes('momentum_reversal')
);
assert(
  '从 registry get 拿回同一对象',
  factorRegistry.get('momentum_reversal') === momentumReversalFactor
);
assert(
  '既有 momentum 因子未被本因子破坏（仍可 get）',
  factorRegistry.get('momentum') !== undefined
);
assert(
  '既有 low_vol 因子未被本因子破坏',
  factorRegistry.get('low_vol') !== undefined
);

console.log('\n## 常量校验');
assert(
  `LONG_MOMENTUM_WINDOW = 120 (got ${LONG_MOMENTUM_WINDOW})`,
  LONG_MOMENTUM_WINDOW === 120
);
assert(
  `SHORT_MOMENTUM_WINDOW = 5 (got ${SHORT_MOMENTUM_WINDOW})`,
  SHORT_MOMENTUM_WINDOW === 5
);
assert(
  `MOMENTUM_REVERSAL_QUERY_CALENDAR_DAYS >= 220 (got ${MOMENTUM_REVERSAL_QUERY_CALENDAR_DAYS})`,
  MOMENTUM_REVERSAL_QUERY_CALENDAR_DAYS >= 220
);

console.log('\n## compute() 空 universe 安全路径');
(async () => {
  const empty = await momentumReversalFactor.compute({
    as_of_date: '2026-06-07',
    universe: [],
  });
  assert(
    'compute(universe=[]) → 空 Map (不走 DB)',
    empty.size === 0
  );

  console.log(`\n## Summary: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
})().catch((e) => {
  console.error('TEST_RUNNER_ERROR:', e);
  process.exit(2);
});
