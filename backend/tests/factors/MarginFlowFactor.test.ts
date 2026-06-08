/**
 * MarginFlowFactor 单元测试 (US-091).
 *
 * 不依赖 jest; node 直接跑:
 *   cd backend && npx ts-node --transpile-only tests/factors/MarginFlowFactor.test.ts
 *
 * 覆盖:
 *   - 纯函数 computeFinBalanceChange:
 *       - 空 series → null
 *       - 单条 series → null (无 baseline)
 *       - 缺 asOfDate → null
 *       - windowTradeDays 非法值 (0 / 负 / NaN / 浮点) → null
 *       - 全部 trade_date > asOfDate (lookahead) → null
 *       - latest 不是 asOfDate → null (当日无数据)
 *       - baseline fin_balance ≤ 0 → null (防分母爆炸)
 *       - baseline = latest (只有一条有效数据) → null
 *       - 已知数值: 5 日内 +20% / -10% / 平
 *       - 数据足够时取倒数第 windowTradeDays+1 条
 *       - 数据不足 (< windowTradeDays+1 条) 时取最早一条作为 baseline
 *   - Factor metadata (name / category / description / 已注册 / 从 registry get)
 *   - 常量校验 (WINDOW_TRADE_DAYS=5, LOOKBACK_CALENDAR_DAYS=15)
 *   - 端到端业务校验: 杠杆资金加仓 → 正分; 撤退 → 负分
 *   - 空 universe 路径不爆 (compute() ctx.universe=[] → 空 Map)
 *   - 18 个因子全部存在断言 (确认 MarginFlowFactor 已注册 + InsiderTradeFactor + 16 既有)
 */

import {
  marginFlowFactor,
  computeFinBalanceChange,
  WINDOW_TRADE_DAYS,
  LOOKBACK_CALENDAR_DAYS,
  FinBalanceObservation,
} from '../../src/quant/factors/library/MarginFlowFactor';
import { factorRegistry } from '../../src/quant/factors/FactorRegistry';
// 触发 library 自我登记
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

function near(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) < eps;
}

function expectClose(name: string, actual: number, expected: number, eps = 1e-6) {
  assert(name, near(actual, expected, eps), `expected≈${expected}, got=${actual}`);
}

// ===========================================================================
// computeFinBalanceChange() — 边界 / 退化路径
// ===========================================================================
console.log('\n## computeFinBalanceChange() — 边界 / 退化路径');

assert('空 series → null', computeFinBalanceChange([], '2026-06-07') === null);
assert(
  'null series → null',
  computeFinBalanceChange(null as unknown as FinBalanceObservation[], '2026-06-07') === null
);
assert(
  '单条 series → null',
  computeFinBalanceChange(
    [{ trade_date: '2026-06-07', fin_balance: 1_000_000 }],
    '2026-06-07'
  ) === null
);
assert(
  '缺 asOfDate → null',
  computeFinBalanceChange(
    [
      { trade_date: '2026-06-01', fin_balance: 1_000_000 },
      { trade_date: '2026-06-07', fin_balance: 1_100_000 },
    ],
    ''
  ) === null
);

console.log('\n## computeFinBalanceChange() — windowTradeDays 非法值');
assert(
  'windowTradeDays=0 → null',
  computeFinBalanceChange(
    [
      { trade_date: '2026-06-01', fin_balance: 1_000_000 },
      { trade_date: '2026-06-07', fin_balance: 1_100_000 },
    ],
    '2026-06-07',
    0
  ) === null
);
assert(
  'windowTradeDays=-3 → null',
  computeFinBalanceChange(
    [
      { trade_date: '2026-06-01', fin_balance: 1_000_000 },
      { trade_date: '2026-06-07', fin_balance: 1_100_000 },
    ],
    '2026-06-07',
    -3
  ) === null
);
assert(
  'windowTradeDays=NaN → null',
  computeFinBalanceChange(
    [
      { trade_date: '2026-06-01', fin_balance: 1_000_000 },
      { trade_date: '2026-06-07', fin_balance: 1_100_000 },
    ],
    '2026-06-07',
    NaN
  ) === null
);
assert(
  'windowTradeDays=2.5 (浮点) → null',
  computeFinBalanceChange(
    [
      { trade_date: '2026-06-01', fin_balance: 1_000_000 },
      { trade_date: '2026-06-07', fin_balance: 1_100_000 },
    ],
    '2026-06-07',
    2.5
  ) === null
);

console.log('\n## computeFinBalanceChange() — lookahead bias guard');
{
  // 所有 trade_date 都在 asOfDate 之后 → null
  const r = computeFinBalanceChange(
    [
      { trade_date: '2026-07-01', fin_balance: 1_000_000 },
      { trade_date: '2026-07-07', fin_balance: 1_100_000 },
    ],
    '2026-06-07'
  );
  assert('全部 trade_date > asOfDate → null', r === null);
}
{
  // 部分未来日剔除, 剩余仍能算
  const r = computeFinBalanceChange(
    [
      { trade_date: '2026-06-01', fin_balance: 1_000_000 },
      { trade_date: '2026-06-07', fin_balance: 1_200_000 },
      { trade_date: '2026-12-01', fin_balance: 999_999_999 }, // 未来巨额
    ],
    '2026-06-07'
  );
  assert('部分未来日被剔除, 剩余可算', r !== null);
  if (r !== null) {
    expectClose('change = +20% (1.2M / 1.0M - 1)', r, 0.2);
  }
}

console.log('\n## computeFinBalanceChange() — latest 不是 asOfDate');
{
  // latest 比 asOfDate 早 → 当日无数据 → null
  const r = computeFinBalanceChange(
    [
      { trade_date: '2026-06-01', fin_balance: 1_000_000 },
      { trade_date: '2026-06-05', fin_balance: 1_100_000 },
    ],
    '2026-06-07'
  );
  assert('latest=2026-06-05 ≠ asOfDate=2026-06-07 → null', r === null);
}

console.log('\n## computeFinBalanceChange() — baseline 数据卫生');
{
  // baseline fin_balance = 0 → null
  const r = computeFinBalanceChange(
    [
      { trade_date: '2026-06-01', fin_balance: 0 },
      { trade_date: '2026-06-07', fin_balance: 1_000_000 },
    ],
    '2026-06-07'
  );
  assert('baseline=0 → null', r === null);
}
{
  // baseline fin_balance 负 → null
  const r = computeFinBalanceChange(
    [
      { trade_date: '2026-06-01', fin_balance: -100 },
      { trade_date: '2026-06-07', fin_balance: 1_000_000 },
    ],
    '2026-06-07'
  );
  assert('baseline=-100 → null', r === null);
}

console.log('\n## computeFinBalanceChange() — 已知数值');
{
  // 5 日内 +20% (baseline 1M / latest 1.2M)
  const r = computeFinBalanceChange(
    [
      { trade_date: '2026-06-01', fin_balance: 1_000_000 },
      { trade_date: '2026-06-02', fin_balance: 1_050_000 },
      { trade_date: '2026-06-03', fin_balance: 1_100_000 },
      { trade_date: '2026-06-04', fin_balance: 1_120_000 },
      { trade_date: '2026-06-05', fin_balance: 1_150_000 },
      { trade_date: '2026-06-07', fin_balance: 1_200_000 },
    ],
    '2026-06-07'
  );
  assert('6 条 baseline 取倒数 6 (即首条) → 应取 windowTradeDays+1', r !== null);
  if (r !== null) {
    expectClose('change = +20% (1.2M / 1.0M - 1)', r, 0.2);
  }
}
{
  // 5 日内 -10% (baseline 1M / latest 0.9M)
  const r = computeFinBalanceChange(
    [
      { trade_date: '2026-06-01', fin_balance: 1_000_000 },
      { trade_date: '2026-06-02', fin_balance: 1_000_000 },
      { trade_date: '2026-06-03', fin_balance: 990_000 },
      { trade_date: '2026-06-04', fin_balance: 950_000 },
      { trade_date: '2026-06-05', fin_balance: 920_000 },
      { trade_date: '2026-06-07', fin_balance: 900_000 },
    ],
    '2026-06-07'
  );
  assert('-10% 场景', r !== null);
  if (r !== null) {
    expectClose('change = -10% (0.9M / 1.0M - 1)', r, -0.1);
  }
}
{
  // 持平 (baseline = latest)
  const r = computeFinBalanceChange(
    [
      { trade_date: '2026-06-01', fin_balance: 1_000_000 },
      { trade_date: '2026-06-02', fin_balance: 1_050_000 },
      { trade_date: '2026-06-07', fin_balance: 1_000_000 },
    ],
    '2026-06-07'
  );
  assert('5 日持平 → 接近 0', r !== null);
  if (r !== null) {
    expectClose('change ≈ 0', r, 0);
  }
}

console.log('\n## computeFinBalanceChange() — baseline 选择策略');
{
  // 数据足够 (8 条), windowTradeDays=5, baseline 取倒数第 6 条
  // (filtered.length - 1 - 5 = 8 - 1 - 5 = 2, 即 series[2])
  const r = computeFinBalanceChange(
    [
      { trade_date: '2026-05-25', fin_balance: 100 }, // 0
      { trade_date: '2026-05-26', fin_balance: 200 }, // 1
      { trade_date: '2026-05-30', fin_balance: 1_000_000 }, // 2 ← baseline
      { trade_date: '2026-06-01', fin_balance: 1_050_000 }, // 3
      { trade_date: '2026-06-02', fin_balance: 1_100_000 }, // 4
      { trade_date: '2026-06-03', fin_balance: 1_120_000 }, // 5
      { trade_date: '2026-06-04', fin_balance: 1_150_000 }, // 6
      { trade_date: '2026-06-07', fin_balance: 2_000_000 }, // 7 ← latest
    ],
    '2026-06-07',
    5
  );
  assert('8 条数据时 baseline 取倒数第 6 条 (series[2])', r !== null);
  if (r !== null) {
    // (2_000_000 - 1_000_000) / 1_000_000 = 1.0 (+100%)
    expectClose('change = +100% (2M / 1M - 1)', r, 1.0);
  }
}
{
  // 数据不足 (3 条 < windowTradeDays+1=6), baseline 兜底取最早一条
  const r = computeFinBalanceChange(
    [
      { trade_date: '2026-06-01', fin_balance: 500_000 }, // baseline (兜底)
      { trade_date: '2026-06-05', fin_balance: 800_000 },
      { trade_date: '2026-06-07', fin_balance: 1_000_000 },
    ],
    '2026-06-07',
    5
  );
  assert('3 条数据时 baseline 兜底取最早', r !== null);
  if (r !== null) {
    // (1_000_000 - 500_000) / 500_000 = 1.0 (+100%)
    expectClose('change = +100% (1M / 500k - 1)', r, 1.0);
  }
}

console.log('\n## computeFinBalanceChange() — 排序鲁棒性 (输入乱序)');
{
  // 输入乱序, 函数内必须重排
  const r = computeFinBalanceChange(
    [
      { trade_date: '2026-06-07', fin_balance: 1_200_000 },
      { trade_date: '2026-06-01', fin_balance: 1_000_000 },
      { trade_date: '2026-06-05', fin_balance: 1_100_000 },
      { trade_date: '2026-06-03', fin_balance: 1_050_000 },
    ],
    '2026-06-07'
  );
  assert('乱序输入下函数能正确排序', r !== null);
  if (r !== null) {
    // 4 条 < 6, baseline 取最早 (2026-06-01: 1M), latest (2026-06-07: 1.2M)
    expectClose('change = +20% (1.2M / 1.0M - 1)', r, 0.2);
  }
}

// ===========================================================================
// Factor metadata
// ===========================================================================
console.log('\n## Factor metadata');
assert(`factor.name = margin_flow`, marginFlowFactor.name === 'margin_flow');
assert(
  "factor.category = 'flow'",
  marginFlowFactor.category === 'flow',
  `actual=${marginFlowFactor.category}`
);
assert(
  'factor.description 含 "融资"',
  marginFlowFactor.description.includes('融资')
);
assert('factor.compute 是函数', typeof marginFlowFactor.compute === 'function');

console.log('\n## Registry 集成');
assert("registry.has('margin_flow')", factorRegistry.has('margin_flow'));
assert(
  "registry.listNames() 含 'margin_flow'",
  factorRegistry.listNames().includes('margin_flow')
);
{
  const got = factorRegistry.get('margin_flow');
  assert('registry.get() 返回同一对象引用', got === marginFlowFactor);
}

console.log('\n## 常量校验');
assert(`WINDOW_TRADE_DAYS = 5`, WINDOW_TRADE_DAYS === 5, `actual=${WINDOW_TRADE_DAYS}`);
assert(
  `LOOKBACK_CALENDAR_DAYS = 15`,
  LOOKBACK_CALENDAR_DAYS === 15,
  `actual=${LOOKBACK_CALENDAR_DAYS}`
);

console.log('\n## 18 个因子全部存在');
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
    'margin_flow',
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
    `共 18 个因子注册`,
    registered.length === 18,
    `actual=${registered.length}: [${registered.join(', ')}]`
  );
  for (const f of expectedFactors) {
    assert(`因子 ${f} 已注册`, factorRegistry.has(f));
  }
}

// ===========================================================================
// 端到端业务校验
// ===========================================================================
console.log('\n## 端到端业务校验 — 杠杆资金加仓场景');
{
  // 某只股票近 5 个交易日融资余额从 5 千万快速涨到 6.5 千万 (+30%)
  const accumulation = computeFinBalanceChange(
    [
      { trade_date: '2026-05-30', fin_balance: 50_000_000 },
      { trade_date: '2026-06-01', fin_balance: 52_000_000 },
      { trade_date: '2026-06-02', fin_balance: 55_000_000 },
      { trade_date: '2026-06-03', fin_balance: 58_000_000 },
      { trade_date: '2026-06-04', fin_balance: 62_000_000 },
      { trade_date: '2026-06-07', fin_balance: 65_000_000 },
    ],
    '2026-06-07'
  );
  assert('杠杆资金加仓 → 可计算', accumulation !== null);
  if (accumulation !== null) {
    expectClose('change = +30% (65M / 50M - 1)', accumulation, 0.3);
    assert('change 正 → 因子 buy signal', accumulation > 0);
  }
}

console.log('\n## 端到端业务校验 — 杠杆资金撤退场景');
{
  // 某只股票近 5 个交易日融资余额从 8 千万快速跌到 5.6 千万 (-30%)
  const distribution = computeFinBalanceChange(
    [
      { trade_date: '2026-05-30', fin_balance: 80_000_000 },
      { trade_date: '2026-06-01', fin_balance: 78_000_000 },
      { trade_date: '2026-06-02', fin_balance: 72_000_000 },
      { trade_date: '2026-06-03', fin_balance: 68_000_000 },
      { trade_date: '2026-06-04', fin_balance: 62_000_000 },
      { trade_date: '2026-06-07', fin_balance: 56_000_000 },
    ],
    '2026-06-07'
  );
  assert('杠杆资金撤退 → 可计算', distribution !== null);
  if (distribution !== null) {
    expectClose('change = -30% (56M / 80M - 1)', distribution, -0.3);
    assert('change 负 → 因子 sell signal', distribution < 0);
  }
}

console.log('\n## 空 universe 路径不爆');
(async () => {
  const out = await marginFlowFactor.compute({
    as_of_date: '2026-06-07',
    universe: [],
    lookbackDays: WINDOW_TRADE_DAYS,
  });
  assert('空 universe → out 是 Map', out instanceof Map);
  assert('空 universe → out.size = 0', out.size === 0);

  console.log(`\nResults: ${passed} ok, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
