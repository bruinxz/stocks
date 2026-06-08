/**
 * ShareholderConcentrationFactor 单元测试 (US-035).
 *
 * 不依赖 jest；node 直接跑：
 *   cd backend && npx ts-node --transpile-only tests/factors/ShareholderConcentrationFactor.test.ts
 *
 * 覆盖：
 *   - 纯函数 computeConcentrationChange:
 *       - 空 observations → null
 *       - 缺 asOfDate → null
 *       - 总观测 < MIN_OBSERVATIONS_TOTAL (=2) → null
 *       - holder_count <= 0 (异常) → 被剔除 + 不足则 null
 *       - 数据卫生：null/undefined/NaN/string 安全跳过
 *       - lookahead bias guard (report_date > as_of_date) → 剔除
 *       - 最新一期 share_change != 0 + excludeShareChangePeriods=true → null
 *       - 最新一期 share_change != 0 + excludeShareChangePeriods=false → 仍算
 *       - 户数下降（集中） → raw_value 正值（业务校验）
 *       - 户数上升（分散） → raw_value 负值
 *       - 户数不变 → raw_value = 0
 *       - 多期数据自动取最新两期
 *       - 排序：observation 输入乱序时仍按 report_date 升序取最新
 *   - Factor metadata (name / category / description / 已注册 / 从 registry get)
 *   - 3 个常量校验
 *   - 端到端业务校验：业务场景 (机构吸筹 / 散户接盘) → raw_value 方向正确
 *   - 空 universe 路径不爆 (compute() ctx.universe=[] → 空 Map)
 *   - 15 个因子全部存在断言（确认 ShareholderConcentrationFactor 已注册）
 */

import {
  shareholderConcentrationFactor,
  computeConcentrationChange,
  LOOKBACK_DAYS,
  MIN_OBSERVATIONS_TOTAL,
  EXCLUDE_SHARE_CHANGE_PERIODS,
  ShareholderObservation,
} from '../../src/quant/factors/library/ShareholderConcentrationFactor';
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

console.log('\n## computeConcentrationChange() — 边界 / 退化路径');

assert('空 observations → null', computeConcentrationChange([], '2026-06-07') === null);
assert(
  'null observations → null',
  computeConcentrationChange(null as unknown as ShareholderObservation[], '2026-06-07') === null
);
assert(
  '缺 asOfDate → null',
  computeConcentrationChange([{ report_date: '2026-03-31', holder_count: 10000 }], '') === null
);
assert(
  '只有 1 期观测（不足 MIN_OBSERVATIONS_TOTAL=2） → null',
  computeConcentrationChange([{ report_date: '2026-03-31', holder_count: 10000 }], '2026-06-07') ===
    null
);

console.log('\n## computeConcentrationChange() — 数据卫生');
assert(
  '所有 holder_count=null → null',
  computeConcentrationChange(
    [
      { report_date: '2026-03-31', holder_count: null },
      { report_date: '2025-12-31', holder_count: null },
    ],
    '2026-06-07'
  ) === null
);
assert(
  '所有 holder_count=undefined → null',
  computeConcentrationChange(
    [
      { report_date: '2026-03-31', holder_count: undefined },
      { report_date: '2025-12-31', holder_count: undefined },
    ],
    '2026-06-07'
  ) === null
);
assert(
  'holder_count=NaN → 被剔除',
  computeConcentrationChange(
    [
      { report_date: '2026-03-31', holder_count: NaN as unknown as number },
      { report_date: '2025-12-31', holder_count: 10000 },
    ],
    '2026-06-07'
  ) === null
);
assert(
  'holder_count=0 → 被剔除 (≤ 0)',
  computeConcentrationChange(
    [
      { report_date: '2026-03-31', holder_count: 0 },
      { report_date: '2025-12-31', holder_count: 10000 },
    ],
    '2026-06-07'
  ) === null
);
assert(
  'holder_count<0 → 被剔除',
  computeConcentrationChange(
    [
      { report_date: '2026-03-31', holder_count: -100 },
      { report_date: '2025-12-31', holder_count: 10000 },
    ],
    '2026-06-07'
  ) === null
);

console.log('\n## computeConcentrationChange() — lookahead bias guard');
{
  const r = computeConcentrationChange(
    [
      { report_date: '2025-12-31', holder_count: 10000 },
      { report_date: '2026-03-31', holder_count: 9500 },
      { report_date: '2026-09-30', holder_count: 1 }, // 未来日期，必须被剔除
    ],
    '2026-06-07'
  );
  assert('未来 report_date 被剔除（lookahead guard）', r !== null);
  if (r !== null) {
    expectClose('最新期 = 2026-03-31 not 2026-09-30 (未来已剔)', r.latest_count, 9500);
    assert('latest_report_date = 2026-03-31', r.latest_report_date === '2026-03-31');
  }
}

console.log('\n## computeConcentrationChange() — share_change 过滤');
{
  // 默认 excludeShareChangePeriods=true：最新一期 share_change != 0 → null
  const r1 = computeConcentrationChange(
    [
      { report_date: '2025-12-31', holder_count: 10000, share_change: 0 },
      { report_date: '2026-03-31', holder_count: 12000, share_change: 5000000 },
    ],
    '2026-06-07'
  );
  assert(
    '最新期发生股本变动 + 默认 exclude=true → null',
    r1 === null,
    '送转股后 holder_count 自然增加，环比无意义'
  );

  const r2 = computeConcentrationChange(
    [
      { report_date: '2025-12-31', holder_count: 10000, share_change: 0 },
      { report_date: '2026-03-31', holder_count: 12000, share_change: 5000000 },
    ],
    '2026-06-07',
    false // 关闭过滤
  );
  assert('exclude=false → 即使股本变动也算', r2 !== null);
  if (r2 !== null) {
    expectClose('latest_count = 12000', r2.latest_count, 12000);
    expectClose('prev_count = 10000', r2.prev_count, 10000);
    expectClose('raw_change_pct = +0.20', r2.raw_change_pct, 0.2);
    expectClose('raw_value = -0.20 (上升 = 负分)', r2.raw_value, -0.2);
  }

  // 最新期 share_change=0 但上期 != 0 → 仍算（只看最新期）
  const r3 = computeConcentrationChange(
    [
      { report_date: '2025-12-31', holder_count: 10000, share_change: 5000000 },
      { report_date: '2026-03-31', holder_count: 9500, share_change: 0 },
    ],
    '2026-06-07'
  );
  assert('上期股本变动 + 最新期无变动 → 仍算', r3 !== null);
  if (r3 !== null) {
    expectClose('raw_change_pct = -0.05 (集中)', r3.raw_change_pct, -0.05);
    expectClose('raw_value = +0.05 (取负后)', r3.raw_value, 0.05);
  }

  // share_change=null 视为 0（保守不剔除）
  const r4 = computeConcentrationChange(
    [
      { report_date: '2025-12-31', holder_count: 10000, share_change: null },
      { report_date: '2026-03-31', holder_count: 9500, share_change: null },
    ],
    '2026-06-07'
  );
  assert('share_change=null 视为 0，不剔除', r4 !== null);
  if (r4 !== null) {
    expectClose('raw_value = +0.05', r4.raw_value, 0.05);
  }

  // share_change 字段缺失（undefined）→ 视为 null → 不剔除
  const r5 = computeConcentrationChange(
    [
      { report_date: '2025-12-31', holder_count: 10000 },
      { report_date: '2026-03-31', holder_count: 9500 },
    ],
    '2026-06-07'
  );
  assert('share_change 字段缺失 → 不剔除', r5 !== null);
  if (r5 !== null) {
    expectClose('raw_value = +0.05', r5.raw_value, 0.05);
  }
}

console.log('\n## computeConcentrationChange() — 业务方向校验');
{
  // 户数下降（集中）→ 比率为负 → 取负后 raw_value 正
  const decreasing = computeConcentrationChange(
    [
      { report_date: '2025-12-31', holder_count: 10000, share_change: 0 },
      { report_date: '2026-03-31', holder_count: 9000, share_change: 0 },
    ],
    '2026-06-07'
  );
  assert('户数下降 → result 非 null', decreasing !== null);
  if (decreasing !== null) {
    expectClose('latest 9000', decreasing.latest_count, 9000);
    expectClose('prev 10000', decreasing.prev_count, 10000);
    expectClose('raw_change_pct = -0.10 (下降 10%)', decreasing.raw_change_pct, -0.1);
    expectClose('raw_value = +0.10 (集中得正分)', decreasing.raw_value, 0.1);
    assert(
      'raw_value 正 = 筹码集中 = alpha 信号',
      decreasing.raw_value > 0,
      `raw_value=${decreasing.raw_value}`
    );
  }

  // 户数上升（分散）→ 比率为正 → 取负后 raw_value 负
  const increasing = computeConcentrationChange(
    [
      { report_date: '2025-12-31', holder_count: 10000, share_change: 0 },
      { report_date: '2026-03-31', holder_count: 11500, share_change: 0 },
    ],
    '2026-06-07'
  );
  assert('户数上升 → result 非 null', increasing !== null);
  if (increasing !== null) {
    expectClose('raw_change_pct = +0.15', increasing.raw_change_pct, 0.15);
    expectClose('raw_value = -0.15 (分散得负分)', increasing.raw_value, -0.15);
    assert(
      'raw_value 负 = 筹码分散 = 减仓信号',
      increasing.raw_value < 0,
      `raw_value=${increasing.raw_value}`
    );
  }

  // 户数不变 → raw_value = 0
  const unchanged = computeConcentrationChange(
    [
      { report_date: '2025-12-31', holder_count: 10000, share_change: 0 },
      { report_date: '2026-03-31', holder_count: 10000, share_change: 0 },
    ],
    '2026-06-07'
  );
  assert('户数不变 → result 非 null', unchanged !== null);
  if (unchanged !== null) {
    expectClose('raw_value = 0 (不变)', unchanged.raw_value, 0);
  }
}

console.log('\n## computeConcentrationChange() — 多期排序');
{
  // 输入乱序 → 仍按 report_date 升序取最新两期
  const unsorted = computeConcentrationChange(
    [
      { report_date: '2026-03-31', holder_count: 9500, share_change: 0 },
      { report_date: '2025-06-30', holder_count: 11000, share_change: 0 },
      { report_date: '2025-09-30', holder_count: 10500, share_change: 0 },
      { report_date: '2025-12-31', holder_count: 10000, share_change: 0 },
    ],
    '2026-06-07'
  );
  assert('乱序 4 期数据 → 仍能计算', unsorted !== null);
  if (unsorted !== null) {
    assert(
      'latest_report_date = 2026-03-31 (排序后最新)',
      unsorted.latest_report_date === '2026-03-31'
    );
    assert(
      'prev_report_date = 2025-12-31 (排序后倒数第 2)',
      unsorted.prev_report_date === '2025-12-31'
    );
    expectClose('latest 9500', unsorted.latest_count, 9500);
    expectClose('prev 10000', unsorted.prev_count, 10000);
    expectClose('raw_value = +0.05 (5% 集中)', unsorted.raw_value, 0.05);
  }
}

console.log('\n## computeConcentrationChange() — 部分行 holder_count 缺失');
{
  // 中间一期 holder_count 缺失 → 仍能用剩余 2 期算
  const r = computeConcentrationChange(
    [
      { report_date: '2025-09-30', holder_count: 11000, share_change: 0 },
      { report_date: '2025-12-31', holder_count: null, share_change: 0 }, // 跳过
      { report_date: '2026-03-31', holder_count: 9500, share_change: 0 },
    ],
    '2026-06-07'
  );
  assert('中间一期 null → 仍能算（剩余 2 期）', r !== null);
  if (r !== null) {
    expectClose('latest 9500', r.latest_count, 9500);
    expectClose('prev 11000 (跳过 null 的 2025-12-31, 取倒数第 2)', r.prev_count, 11000);
    expectClose('raw_change_pct ≈ -0.13636', r.raw_change_pct, -0.1363636363636, 1e-7);
    expectClose('raw_value ≈ +0.13636 (集中)', r.raw_value, 0.1363636363636, 1e-7);
  }
}

console.log('\n## Factor metadata');
assert('factor.name = shareholder_concentration', shareholderConcentrationFactor.name === 'shareholder_concentration');
assert(
  "factor.category = 'flow'",
  shareholderConcentrationFactor.category === 'flow',
  `actual=${shareholderConcentrationFactor.category}`
);
assert(
  'factor.description 含 "环比变化"',
  shareholderConcentrationFactor.description.includes('环比变化')
);
assert(
  'factor.description 含 "筹码集中" 或 "集中"',
  shareholderConcentrationFactor.description.includes('集中')
);
assert(
  'factor.compute 是函数',
  typeof shareholderConcentrationFactor.compute === 'function'
);

console.log('\n## Registry 集成');
assert(
  "registry.has('shareholder_concentration')",
  factorRegistry.has('shareholder_concentration')
);
assert(
  "registry.listNames() 含 'shareholder_concentration'",
  factorRegistry.listNames().includes('shareholder_concentration')
);
{
  const got = factorRegistry.get('shareholder_concentration');
  assert(
    'registry.get() 返回同一对象引用',
    got === shareholderConcentrationFactor
  );
}

console.log('\n## 常量校验');
assert(`LOOKBACK_DAYS = 200`, LOOKBACK_DAYS === 200, `actual=${LOOKBACK_DAYS}`);
assert(
  `MIN_OBSERVATIONS_TOTAL = 2`,
  MIN_OBSERVATIONS_TOTAL === 2,
  `actual=${MIN_OBSERVATIONS_TOTAL}`
);
assert(
  `EXCLUDE_SHARE_CHANGE_PERIODS = true`,
  EXCLUDE_SHARE_CHANGE_PERIODS === true,
  `actual=${EXCLUDE_SHARE_CHANGE_PERIODS}`
);

console.log('\n## 17 个因子全部存在');
{
  const expectedFactors = [
    'analyst_consensus',
    'dragon_tiger',
    'earnings_surprise',
    'east_money_qa',
    'gradual_breakout',
    'growth',
    'insider_trade',
    'liquidity',
    'low_vol',
    'momentum',
    'momentum_reversal',
    'money_flow',
    'northbound',
    'quality',
    'quality_high',
    'shareholder_concentration',
    'value',
  ];
  const registered = factorRegistry.listNames().sort();
  assert(
    `共 17 个因子注册`,
    registered.length === 17,
    `actual=${registered.length}: [${registered.join(', ')}]`
  );
  for (const f of expectedFactors) {
    assert(`因子 ${f} 已注册`, factorRegistry.has(f));
  }
}

console.log('\n## 端到端业务校验 — 机构吸筹场景');
{
  // 模拟某只股票连续 4 期数据，最近一期户数下降（机构吸筹）
  // 2025-06-30: 50000 户
  // 2025-09-30: 48000 户
  // 2025-12-31: 46000 户
  // 2026-03-31: 42000 户 (集中度 = -(42000-46000)/46000 = +0.0869)
  const accumulation = computeConcentrationChange(
    [
      { report_date: '2025-06-30', holder_count: 50000, share_change: 0 },
      { report_date: '2025-09-30', holder_count: 48000, share_change: 0 },
      { report_date: '2025-12-31', holder_count: 46000, share_change: 0 },
      { report_date: '2026-03-31', holder_count: 42000, share_change: 0 },
    ],
    '2026-06-07'
  );
  assert('机构吸筹 4 期数据 → 可计算', accumulation !== null);
  if (accumulation !== null) {
    expectClose('raw_value > 0 (集中)', accumulation.raw_value, 4 / 46);
    assert('raw_value 正 → buy signal', accumulation.raw_value > 0);
  }
}

console.log('\n## 端到端业务校验 — 散户接盘场景');
{
  // 散户接盘：股价上涨吸引大量小投资者，机构 / 大户减持
  const distribution = computeConcentrationChange(
    [
      { report_date: '2025-12-31', holder_count: 30000, share_change: 0 },
      { report_date: '2026-03-31', holder_count: 45000, share_change: 0 },
    ],
    '2026-06-07'
  );
  assert('散户接盘 → 可计算', distribution !== null);
  if (distribution !== null) {
    expectClose('raw_change_pct = +0.5 (15000/30000)', distribution.raw_change_pct, 0.5);
    expectClose('raw_value = -0.5 (分散得负分)', distribution.raw_value, -0.5);
    assert('raw_value 负 → sell signal', distribution.raw_value < 0);
  }
}

console.log('\n## 空 universe 路径不爆');
(async () => {
  const out = await shareholderConcentrationFactor.compute({
    as_of_date: '2026-06-07',
    universe: [],
    lookbackDays: 200,
  });
  assert('空 universe → out 是 Map', out instanceof Map);
  assert('空 universe → out.size = 0', out.size === 0);

  console.log(`\nResults: ${passed} ok, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
