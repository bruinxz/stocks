/**
 * InsiderTradeFactor 单元测试 (US-090).
 *
 * 不依赖 jest; node 直接跑:
 *   cd backend && npx ts-node --transpile-only tests/factors/InsiderTradeFactor.test.ts
 *
 * 覆盖:
 *   - 纯函数 computeNetInsiderInflow:
 *       - 空 trades → null
 *       - 缺 asOfDate → null
 *       - 全部 trade_amount=null → null
 *       - 全部 direction 未知 → null
 *       - 单条增持 → buy_amount = amount, sell = 0, net = amount
 *       - 单条减持 → buy = 0, sell = amount, net = -amount
 *       - 混合多条 → net = sum(buy) - sum(sell)
 *       - 数据卫生: trade_amount=NaN/undefined/null/string/负值 → 跳过
 *       - 未知 direction (other / 空 / null) → 跳过
 *       - lookahead bias guard (announce_date > as_of_date) → 剔除
 *   - 同时也测试 classifyShareholderType:
 *       - 机构关键词命中: 基金 / 投资 / 合伙企业 / 信托 / Capital
 *       - 自然人 (2-4 字中文姓名)
 *       - 其他: 空 / 单字符 / 含特殊字符
 *       - 高管类型暂保留, 当前永不返回
 *   - Factor metadata (name / category / description / 已注册 / 从 registry get)
 *   - 常量校验 (WINDOW_DAYS=60)
 *   - 端到端业务校验: 内部人增持 → 正分; 减持 → 负分; 进退两难 → 接近 0
 *   - 空 universe 路径不爆 (compute() ctx.universe=[] → 空 Map)
 *   - 17 个因子全部存在断言 (确认 InsiderTradeFactor 已注册)
 */

import {
  insiderTradeFactor,
  computeNetInsiderInflow,
  WINDOW_DAYS,
  TradeObservation,
} from '../../src/quant/factors/library/InsiderTradeFactor';
import {
  classifyShareholderType,
  INSTITUTION_KEYWORDS,
} from '../../src/data/services/ShareholderTradeSyncService';
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

function near(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) < eps;
}

function expectClose(name: string, actual: number, expected: number, eps = 1e-6) {
  assert(name, near(actual, expected, eps), `expected≈${expected}, got=${actual}`);
}

// ===========================================================================
// computeNetInsiderInflow() 测试
// ===========================================================================
console.log('\n## computeNetInsiderInflow() — 边界 / 退化路径');

assert('空 trades → null', computeNetInsiderInflow([], '2026-06-07') === null);
assert(
  'null trades → null',
  computeNetInsiderInflow(null as unknown as TradeObservation[], '2026-06-07') === null
);
assert(
  '缺 asOfDate → null',
  computeNetInsiderInflow(
    [{ announce_date: '2026-05-01', trade_direction: '增持', trade_amount: 100000 }],
    ''
  ) === null
);
assert(
  '全部 trade_amount=null → null',
  computeNetInsiderInflow(
    [
      { announce_date: '2026-05-01', trade_direction: '增持', trade_amount: null },
      { announce_date: '2026-05-02', trade_direction: '减持', trade_amount: null },
    ],
    '2026-06-07'
  ) === null
);
assert(
  '全部 direction 未知 → null',
  computeNetInsiderInflow(
    [
      { announce_date: '2026-05-01', trade_direction: '其他', trade_amount: 100000 },
      { announce_date: '2026-05-02', trade_direction: null, trade_amount: 200000 },
    ],
    '2026-06-07'
  ) === null
);

console.log('\n## computeNetInsiderInflow() — 数据卫生');
{
  // trade_amount=NaN 被跳过 + 剩余可算
  const r = computeNetInsiderInflow(
    [
      { announce_date: '2026-05-01', trade_direction: '增持', trade_amount: NaN as number },
      { announce_date: '2026-05-02', trade_direction: '增持', trade_amount: 100000 },
    ],
    '2026-06-07'
  );
  assert('NaN amount 被跳过, 剩余可算', r !== null);
  if (r !== null) {
    expectClose('buy_amount = 100000 (NaN 行剔除)', r.buy_amount, 100000);
    expectClose('net_inflow = 100000', r.net_inflow, 100000);
    expectClose('trade_count = 1', r.trade_count, 1);
  }
}
{
  // 负 amount 被剔除 (脏数据)
  const r = computeNetInsiderInflow(
    [
      { announce_date: '2026-05-01', trade_direction: '增持', trade_amount: -50000 },
      { announce_date: '2026-05-02', trade_direction: '增持', trade_amount: 100000 },
    ],
    '2026-06-07'
  );
  assert('负 amount 被剔除', r !== null);
  if (r !== null) {
    expectClose('buy_amount = 100000 (负值剔除)', r.buy_amount, 100000);
  }
}
{
  // trade_amount=undefined 跳过
  const r = computeNetInsiderInflow(
    [
      {
        announce_date: '2026-05-01',
        trade_direction: '增持',
        trade_amount: undefined as unknown as number,
      },
      { announce_date: '2026-05-02', trade_direction: '增持', trade_amount: 100000 },
    ],
    '2026-06-07'
  );
  assert('undefined amount 跳过, 剩余可算', r !== null);
  if (r !== null) expectClose('buy = 100000', r.buy_amount, 100000);
}

console.log('\n## computeNetInsiderInflow() — 单条 / 多条聚合');
{
  // 单条增持
  const r = computeNetInsiderInflow(
    [{ announce_date: '2026-05-01', trade_direction: '增持', trade_amount: 500000 }],
    '2026-06-07'
  );
  assert('单条增持 → 非 null', r !== null);
  if (r !== null) {
    expectClose('buy_amount = 500000', r.buy_amount, 500000);
    expectClose('sell_amount = 0', r.sell_amount, 0);
    expectClose('net_inflow = +500000', r.net_inflow, 500000);
    expectClose('trade_count = 1', r.trade_count, 1);
  }
}
{
  // 单条减持
  const r = computeNetInsiderInflow(
    [{ announce_date: '2026-05-01', trade_direction: '减持', trade_amount: 300000 }],
    '2026-06-07'
  );
  assert('单条减持 → 非 null', r !== null);
  if (r !== null) {
    expectClose('buy_amount = 0', r.buy_amount, 0);
    expectClose('sell_amount = 300000', r.sell_amount, 300000);
    expectClose('net_inflow = -300000', r.net_inflow, -300000);
  }
}
{
  // 混合多条
  const r = computeNetInsiderInflow(
    [
      { announce_date: '2026-05-01', trade_direction: '增持', trade_amount: 1000000 },
      { announce_date: '2026-05-15', trade_direction: '增持', trade_amount: 500000 },
      { announce_date: '2026-05-20', trade_direction: '减持', trade_amount: 700000 },
      { announce_date: '2026-06-01', trade_direction: '减持', trade_amount: 200000 },
    ],
    '2026-06-07'
  );
  assert('混合多条 → 非 null', r !== null);
  if (r !== null) {
    expectClose('buy_amount = 1500000', r.buy_amount, 1500000);
    expectClose('sell_amount = 900000', r.sell_amount, 900000);
    expectClose('net_inflow = +600000', r.net_inflow, 600000);
    expectClose('trade_count = 4', r.trade_count, 4);
  }
}
{
  // direction 未知不计入
  const r = computeNetInsiderInflow(
    [
      { announce_date: '2026-05-01', trade_direction: '增持', trade_amount: 100000 },
      { announce_date: '2026-05-02', trade_direction: '其他', trade_amount: 999999 },
      { announce_date: '2026-05-03', trade_direction: null, trade_amount: 888888 },
    ],
    '2026-06-07'
  );
  assert('direction 未知不计入', r !== null);
  if (r !== null) {
    expectClose('buy_amount = 100000 (仅有效增持)', r.buy_amount, 100000);
    expectClose('trade_count = 1 (其他 + null 不计)', r.trade_count, 1);
  }
}

console.log('\n## computeNetInsiderInflow() — lookahead bias guard');
{
  const r = computeNetInsiderInflow(
    [
      { announce_date: '2026-05-01', trade_direction: '增持', trade_amount: 100000 },
      // 未来日期, 必须被剔除
      { announce_date: '2026-12-01', trade_direction: '增持', trade_amount: 999999999 },
    ],
    '2026-06-07'
  );
  assert('未来 announce_date 被剔除 (lookahead guard)', r !== null);
  if (r !== null) {
    expectClose('buy = 100000 (未来巨额已剔除)', r.buy_amount, 100000);
    expectClose('trade_count = 1', r.trade_count, 1);
  }
}
{
  // 所有公告都在未来 → null
  const r = computeNetInsiderInflow(
    [{ announce_date: '2026-12-01', trade_direction: '增持', trade_amount: 100000 }],
    '2026-06-07'
  );
  assert('全部未来日期 → null', r === null);
}

console.log('\n## computeNetInsiderInflow() — 业务方向校验');
{
  // 增持主导 → net > 0
  const r = computeNetInsiderInflow(
    [
      { announce_date: '2026-05-01', trade_direction: '增持', trade_amount: 3000000 },
      { announce_date: '2026-05-10', trade_direction: '减持', trade_amount: 500000 },
    ],
    '2026-06-07'
  );
  assert('增持主导 → net > 0 (alpha buy signal)', r !== null && r.net_inflow > 0);
  if (r !== null) expectClose('net = +2500000', r.net_inflow, 2500000);
}
{
  // 减持主导 → net < 0
  const r = computeNetInsiderInflow(
    [
      { announce_date: '2026-05-01', trade_direction: '增持', trade_amount: 500000 },
      { announce_date: '2026-05-10', trade_direction: '减持', trade_amount: 3000000 },
    ],
    '2026-06-07'
  );
  assert('减持主导 → net < 0 (sell signal)', r !== null && r.net_inflow < 0);
  if (r !== null) expectClose('net = -2500000', r.net_inflow, -2500000);
}
{
  // 进退两难 → net ≈ 0
  const r = computeNetInsiderInflow(
    [
      { announce_date: '2026-05-01', trade_direction: '增持', trade_amount: 1000000 },
      { announce_date: '2026-05-10', trade_direction: '减持', trade_amount: 1000000 },
    ],
    '2026-06-07'
  );
  assert('进退两难 → net = 0', r !== null && r.net_inflow === 0);
  if (r !== null) {
    expectClose('buy = sell = 1000000', r.buy_amount, 1000000);
    expectClose('trade_count = 2', r.trade_count, 2);
  }
}

// ===========================================================================
// classifyShareholderType() 测试
// ===========================================================================
console.log('\n## classifyShareholderType() — 机构关键词');
assert('"中信证券" → 机构投资者', classifyShareholderType('中信证券') === '机构投资者');
assert('"易方达基金" → 机构投资者', classifyShareholderType('易方达基金') === '机构投资者');
assert(
  '"北京华夏资本管理有限公司" → 机构投资者',
  classifyShareholderType('北京华夏资本管理有限公司') === '机构投资者'
);
assert(
  '"宁波睿远私募基金管理" → 机构投资者',
  classifyShareholderType('宁波睿远私募基金管理') === '机构投资者'
);
assert(
  '"海南迈顺投资合伙企业(有限合伙)" → 机构投资者',
  classifyShareholderType('海南迈顺投资合伙企业(有限合伙)') === '机构投资者'
);
assert(
  '"合肥京坤股权投资合伙企业(有限合伙)" → 机构投资者',
  classifyShareholderType('合肥京坤股权投资合伙企业(有限合伙)') === '机构投资者'
);
assert(
  '"Sequoia Capital Pte" → 机构投资者 (英文混合)',
  classifyShareholderType('Sequoia Capital Pte') === '机构投资者'
);
assert('"QFII 香港分行" → 机构投资者', classifyShareholderType('QFII 香港分行') === '机构投资者');

console.log('\n## classifyShareholderType() — 自然人');
assert('"张三" → 自然人 (2 字)', classifyShareholderType('张三') === '自然人');
assert('"李志强" → 自然人 (3 字)', classifyShareholderType('李志强') === '自然人');
assert(
  '"司马相如" → 自然人 (4 字, 复姓)',
  classifyShareholderType('司马相如') === '自然人',
  `got=${classifyShareholderType('司马相如')}`
);

console.log('\n## classifyShareholderType() — 其他 / 边界');
assert('"" → 其他 (空)', classifyShareholderType('') === '其他');
assert('null → 其他', classifyShareholderType(null) === '其他');
assert('undefined → 其他', classifyShareholderType(undefined) === '其他');
assert('"A" → 其他 (单字符)', classifyShareholderType('A') === '其他');
assert('"张" → 其他 (单中文字)', classifyShareholderType('张') === '其他');
assert(
  '"John Doe" → 其他 (英文非机构)',
  classifyShareholderType('John Doe') === '其他'
);
assert(
  '"张三-某某" → 其他 (含特殊字符 非纯中文)',
  classifyShareholderType('张三-某某') === '其他'
);
assert(
  '"五字以上无机构关键词" → 其他 (中文 5 字)',
  classifyShareholderType('五字以上无机') === '其他'
);

console.log('\n## classifyShareholderType() — 高管类目保留但永不返回');
{
  // 当前数据集中无法从 shareholder_name 稳定识别 "高管", 类型签名保留
  // 留给未来 AKShare endpoint 补 "高管职务" 字段时启用
  const allReturnValues = [
    classifyShareholderType('王某'),
    classifyShareholderType('马云'),
    classifyShareholderType('张三公司董事长'),
    classifyShareholderType(''),
    classifyShareholderType('易方达基金'),
  ];
  const hasGaoguan = allReturnValues.some(v => v === '高管');
  assert(
    '当前 classifyShareholderType 永不返回 "高管" (留待 endpoint 升级)',
    !hasGaoguan
  );
}

console.log('\n## INSTITUTION_KEYWORDS 完整性');
assert('INSTITUTION_KEYWORDS 是 readonly array', Array.isArray(INSTITUTION_KEYWORDS));
assert(
  'INSTITUTION_KEYWORDS 至少 15 个关键词',
  INSTITUTION_KEYWORDS.length >= 15,
  `actual=${INSTITUTION_KEYWORDS.length}`
);
assert('包含 "基金"', INSTITUTION_KEYWORDS.includes('基金'));
assert('包含 "信托"', INSTITUTION_KEYWORDS.includes('信托'));
assert('包含 "投资合伙"', INSTITUTION_KEYWORDS.includes('投资合伙'));
assert(
  '包含 "qfii" (小写, 因 toLowerCase 检查)',
  INSTITUTION_KEYWORDS.includes('qfii')
);

// ===========================================================================
// Factor metadata
// ===========================================================================
console.log('\n## Factor metadata');
assert(`factor.name = insider_trade`, insiderTradeFactor.name === 'insider_trade');
assert(
  "factor.category = 'flow'",
  insiderTradeFactor.category === 'flow',
  `actual=${insiderTradeFactor.category}`
);
assert(
  'factor.description 含 "内部人"',
  insiderTradeFactor.description.includes('内部人')
);
assert(
  'factor.description 含 "净买入"',
  insiderTradeFactor.description.includes('净买入')
);
assert('factor.compute 是函数', typeof insiderTradeFactor.compute === 'function');

console.log('\n## Registry 集成');
assert("registry.has('insider_trade')", factorRegistry.has('insider_trade'));
assert(
  "registry.listNames() 含 'insider_trade'",
  factorRegistry.listNames().includes('insider_trade')
);
{
  const got = factorRegistry.get('insider_trade');
  assert('registry.get() 返回同一对象引用', got === insiderTradeFactor);
}

console.log('\n## 常量校验');
assert(`WINDOW_DAYS = 60`, WINDOW_DAYS === 60, `actual=${WINDOW_DAYS}`);

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
console.log('\n## 端到端业务校验 — 内部人增持场景');
{
  // 某只股票近 60 日内多个股东 + 高管连续增持, 单笔金额从几百万到几千万
  // 增持累计 1.05 亿元, 减持累计 0.5 千万元
  const accumulation = computeNetInsiderInflow(
    [
      { announce_date: '2026-04-15', trade_direction: '增持', trade_amount: 30000000 },
      { announce_date: '2026-04-22', trade_direction: '增持', trade_amount: 20000000 },
      { announce_date: '2026-05-08', trade_direction: '增持', trade_amount: 40000000 },
      { announce_date: '2026-05-20', trade_direction: '增持', trade_amount: 15000000 },
      { announce_date: '2026-06-01', trade_direction: '减持', trade_amount: 5000000 },
    ],
    '2026-06-07'
  );
  assert('内部人增持 5 条记录 → 可计算', accumulation !== null);
  if (accumulation !== null) {
    expectClose('buy_amount = 1.05 亿', accumulation.buy_amount, 105000000);
    expectClose('sell_amount = 500 万', accumulation.sell_amount, 5000000);
    expectClose('net_inflow = +1 亿', accumulation.net_inflow, 100000000);
    assert(
      'net_inflow 正 → 因子 buy signal',
      accumulation.net_inflow > 0
    );
  }
}

console.log('\n## 端到端业务校验 — 大股东减持套现场景');
{
  // 大股东集中减持套现
  const distribution = computeNetInsiderInflow(
    [
      { announce_date: '2026-04-10', trade_direction: '减持', trade_amount: 80000000 },
      { announce_date: '2026-05-05', trade_direction: '减持', trade_amount: 60000000 },
      { announce_date: '2026-05-25', trade_direction: '减持', trade_amount: 40000000 },
    ],
    '2026-06-07'
  );
  assert('大股东减持 3 条 → 可计算', distribution !== null);
  if (distribution !== null) {
    expectClose('buy_amount = 0', distribution.buy_amount, 0);
    expectClose('sell_amount = 1.8 亿', distribution.sell_amount, 180000000);
    expectClose('net_inflow = -1.8 亿', distribution.net_inflow, -180000000);
    assert(
      'net_inflow 负 → 因子 sell signal',
      distribution.net_inflow < 0
    );
  }
}

console.log('\n## 空 universe 路径不爆');
(async () => {
  const out = await insiderTradeFactor.compute({
    as_of_date: '2026-06-07',
    universe: [],
    lookbackDays: 60,
  });
  assert('空 universe → out 是 Map', out instanceof Map);
  assert('空 universe → out.size = 0', out.size === 0);

  console.log(`\nResults: ${passed} ok, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
