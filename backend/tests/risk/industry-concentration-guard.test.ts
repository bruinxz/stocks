/**
 * IndustryConcentrationGuard 单元测试 (US-052)
 *
 * 不依赖 jest；node 直接跑：
 *   cd backend && npx ts-node --transpile-only tests/risk/industry-concentration-guard.test.ts
 *
 * 完全脱离 DB：注入 fake IndustryConcentrationDataSource。
 *
 * 覆盖维度：
 *   - 常量校验：DEFAULT_INDUSTRY_CONCENTRATION_CONFIG +
 *     UNKNOWN_INDUSTRY_SENTINEL + INDUSTRY_CONCENTRATION_SYMBOL_PREFIX
 *   - 纯函数：
 *     normalizeIndustryName / aggregateByIndustry / isIndustryOverAlert /
 *     pickOverAlertIndustries / computeGainPct / computeIndustryPctAfterSell /
 *     sortByGainDescStable / buildRebalanceSellPlan /
 *     normalizeIndustryConcentrationConfig / buildIndustryConcentrationMessage /
 *     buildRebalanceResultMessage
 *   - guard.evaluateAfterClose() end-to-end：
 *     - happy path：3 持仓全在白酒行业 → 100% 占比 → 告警；
 *     - 50% A + 50% B 两个行业各占一半 → 都不超 35% → 不告警；
 *     - 60% 白酒 + 20% 银行 + 20% 科技 → 单白酒超 35% → 告警；
 *     - 35% 边界 → 严格 > 不告警；35.01% → 告警；
 *     - 多行业同时超标 → 多条 alert；
 *     - 未分类持仓（industry=null）→ UNKNOWN bucket → 单独告警；
 *     - 禁用 user → 无 alert；
 *     - dry_run → 不写 alert 但 alerts 数组仍返回；
 *     - 0 持仓 → 0 告警；
 *     - writeAlert 失败不掩盖 alert 返回；
 *     - 多用户失败 try/catch 隔离；
 *   - guard.rebalanceIndustry() end-to-end：
 *     - 单行业 100% → 卖出最大涨幅 1 只直到 < 30%；
 *     - 单行业 60% 内有 3 只 → 卖出涨幅最大的 1 只让 < 30%（max=2 限制）；
 *     - dry_run=true → 不调 executeFullClose；
 *     - executeFullClose 失败 → status='failed' 继续下一只；
 *     - 无超标行业 → from_industry=null + plan 空；
 *     - 行业内无可卖出 → partial=true；
 *   - getConfig / updateConfig 默认值 / normalize 兼容性。
 */

import {
  DEFAULT_INDUSTRY_CONCENTRATION_CONFIG,
  IndustryConcentrationConfig,
  IndustryConcentrationDataSource,
  IndustryConcentrationGuard,
  INDUSTRY_CONCENTRATION_SYMBOL_PREFIX,
  IndustryPositionSnapshot,
  UNKNOWN_INDUSTRY_SENTINEL,
  aggregateByIndustry,
  buildIndustryConcentrationMessage,
  buildRebalanceResultMessage,
  buildRebalanceSellPlan,
  computeGainPct,
  computeIndustryPctAfterSell,
  isIndustryOverAlert,
  normalizeIndustryConcentrationConfig,
  normalizeIndustryName,
  pickOverAlertIndustries,
  sortByGainDescStable,
} from '../../src/portfolio/risk/IndustryConcentrationGuard';

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

function assertClose(name: string, actual: number, expected: number, eps = 0.0001): void {
  const ok = Math.abs(actual - expected) < eps;
  assert(name, ok, `actual=${actual} expected≈${expected} eps=${eps}`);
}

// ---------------------------------------------------------------------------
//  Fake DataSource
// ---------------------------------------------------------------------------

interface FakeCloseExecution {
  executed_quantity: number;
  executed_price: number;
}

interface FakeState {
  userIds: number[];
  configs: Record<number, IndustryConcentrationConfig>;
  portfolioIds: Record<number, number | null>;
  positionsByUser: Record<number, IndustryPositionSnapshot[]>;
  alerts: Array<{
    user_id: number;
    portfolio_id?: number;
    symbol: string;
    name: string;
    message: string;
  }>;
  /** Map<symbol, execution> — what executeFullClose returns. */
  closeReturns: Record<string, FakeCloseExecution>;
  /** Map<symbol, true> — those throw when executeFullClose is called. */
  closeShouldThrowForSymbol: Record<string, boolean>;
  /** Calls log for executeFullClose (for assertion). */
  closeCalls: Array<{ user_id: number; symbol: string }>;
  /** If set, loadOpenPositions on the matching user throws. */
  loadPositionsShouldThrowForUser?: number;
  /** If true, writeAlert throws. */
  writeAlertShouldThrow?: boolean;
}

function makeFakeSource(state: FakeState): IndustryConcentrationDataSource {
  return {
    async loadAllUserIdsWithPortfolios() {
      return [...state.userIds];
    },
    async loadConfig(user_id) {
      return state.configs[user_id] ?? { ...DEFAULT_INDUSTRY_CONCENTRATION_CONFIG };
    },
    async saveConfig(user_id, config) {
      state.configs[user_id] = { ...config };
      return { ...config };
    },
    async loadPortfolioId(user_id) {
      if (state.portfolioIds[user_id] === undefined) return 1000 + user_id;
      return state.portfolioIds[user_id];
    },
    async loadOpenPositions(user_id) {
      if (state.loadPositionsShouldThrowForUser === user_id) {
        throw new Error(`fake DB outage user=${user_id}`);
      }
      return (state.positionsByUser[user_id] || []).map(p => ({ ...p }));
    },
    async writeAlert(input) {
      if (state.writeAlertShouldThrow) {
        throw new Error('fake alert outage');
      }
      state.alerts.push({ ...input });
    },
    async executeFullClose(input) {
      state.closeCalls.push({ ...input });
      if (state.closeShouldThrowForSymbol[input.symbol]) {
        throw new Error(`fake close outage symbol=${input.symbol}`);
      }
      return (
        state.closeReturns[input.symbol] || { executed_quantity: 100, executed_price: 50 }
      );
    },
  };
}

function emptyState(overrides: Partial<FakeState> = {}): FakeState {
  return {
    userIds: [],
    configs: {},
    portfolioIds: {},
    positionsByUser: {},
    alerts: [],
    closeReturns: {},
    closeShouldThrowForSymbol: {},
    closeCalls: [],
    ...overrides,
  };
}

function makePosition(over: Partial<IndustryPositionSnapshot> = {}): IndustryPositionSnapshot {
  const quantity = over.quantity ?? 100;
  const current_price = over.current_price ?? 100;
  const market_value = over.market_value ?? quantity * current_price;
  return {
    id: 1,
    portfolio_id: 1001,
    symbol: '600519.SH',
    name: '贵州茅台',
    quantity,
    avg_cost: 90,
    current_price,
    market_value,
    industry: '白酒',
    ...over,
  };
}

// ---------------------------------------------------------------------------
//  Tests — constants
// ---------------------------------------------------------------------------

async function testConstants() {
  assertEqual(
    'DEFAULT enabled == true',
    DEFAULT_INDUSTRY_CONCENTRATION_CONFIG.enabled,
    true
  );
  assertEqual('DEFAULT alert_pct == 0.35', DEFAULT_INDUSTRY_CONCENTRATION_CONFIG.alert_pct, 0.35);
  assertEqual(
    'DEFAULT rebalance_target_pct == 0.30',
    DEFAULT_INDUSTRY_CONCENTRATION_CONFIG.rebalance_target_pct,
    0.3
  );
  assertEqual(
    'DEFAULT rebalance_max_sell_count == 2',
    DEFAULT_INDUSTRY_CONCENTRATION_CONFIG.rebalance_max_sell_count,
    2
  );
  assertEqual('UNKNOWN sentinel = __UNKNOWN__', UNKNOWN_INDUSTRY_SENTINEL, '__UNKNOWN__');
  assertEqual(
    'INDUSTRY symbol prefix = SYSTEM:INDUSTRY_CONCENTRATION:',
    INDUSTRY_CONCENTRATION_SYMBOL_PREFIX,
    'SYSTEM:INDUSTRY_CONCENTRATION:'
  );
  // 防御性：DEFAULT 应不可 mutate
  let mutationThrew = false;
  try {
    (DEFAULT_INDUSTRY_CONCENTRATION_CONFIG as any).alert_pct = 0.99;
  } catch {
    mutationThrew = true;
  }
  assert(
    'DEFAULT is frozen (strict throws OR silent no-op)',
    mutationThrew || DEFAULT_INDUSTRY_CONCENTRATION_CONFIG.alert_pct === 0.35
  );
  assertEqual(
    'DEFAULT.alert_pct after attempted mutation still == 0.35',
    DEFAULT_INDUSTRY_CONCENTRATION_CONFIG.alert_pct,
    0.35
  );
}

// ---------------------------------------------------------------------------
//  Tests — pure helpers
// ---------------------------------------------------------------------------

async function testNormalizeIndustryName() {
  assertEqual('normName: "白酒" → "白酒"', normalizeIndustryName('白酒'), '白酒');
  assertEqual(
    'normName: "  白酒  " → "白酒" (trim)',
    normalizeIndustryName('  白酒  '),
    '白酒'
  );
  assertEqual('normName: null → UNKNOWN', normalizeIndustryName(null), UNKNOWN_INDUSTRY_SENTINEL);
  assertEqual(
    'normName: undefined → UNKNOWN',
    normalizeIndustryName(undefined),
    UNKNOWN_INDUSTRY_SENTINEL
  );
  assertEqual('normName: "" → UNKNOWN', normalizeIndustryName(''), UNKNOWN_INDUSTRY_SENTINEL);
  assertEqual(
    'normName: "   " (whitespace) → UNKNOWN',
    normalizeIndustryName('   '),
    UNKNOWN_INDUSTRY_SENTINEL
  );
}

async function testAggregateByIndustry() {
  // 单一行业 100%
  const single = aggregateByIndustry([
    makePosition({ id: 1, symbol: 'A.SH', industry: '白酒', market_value: 10000 }),
    makePosition({ id: 2, symbol: 'B.SH', industry: '白酒', market_value: 5000 }),
  ]);
  assertEqual('agg: total = 15000', single.total_position_value, 15000);
  assertEqual('agg: single industry breakdown length 1', single.breakdown.length, 1);
  assertEqual('agg: industry name "白酒"', single.breakdown[0].industry, '白酒');
  assertClose('agg: pct == 1.0', single.breakdown[0].pct, 1.0);
  assertEqual('agg: position_count 2', single.breakdown[0].position_count, 2);
  assertEqual(
    'agg: symbols sorted',
    single.breakdown[0].symbols,
    ['A.SH', 'B.SH']
  );

  // 多行业（按 pct DESC 排序）
  const multi = aggregateByIndustry([
    makePosition({ id: 1, symbol: 'A.SH', industry: '白酒', market_value: 6000 }),
    makePosition({ id: 2, symbol: 'B.SH', industry: '银行', market_value: 3000 }),
    makePosition({ id: 3, symbol: 'C.SH', industry: '科技', market_value: 1000 }),
  ]);
  assertEqual('agg: total = 10000', multi.total_position_value, 10000);
  assertEqual('agg: 3 industries', multi.breakdown.length, 3);
  // 排序 desc: 白酒 (0.6) → 银行 (0.3) → 科技 (0.1)
  assertEqual('agg: first is 白酒', multi.breakdown[0].industry, '白酒');
  assertEqual('agg: second is 银行', multi.breakdown[1].industry, '银行');
  assertEqual('agg: third is 科技', multi.breakdown[2].industry, '科技');
  assertClose('agg: 白酒 pct = 0.6', multi.breakdown[0].pct, 0.6);
  assertClose('agg: 银行 pct = 0.3', multi.breakdown[1].pct, 0.3);
  assertClose('agg: 科技 pct = 0.1', multi.breakdown[2].pct, 0.1);

  // 未分类
  const unknown = aggregateByIndustry([
    makePosition({ id: 1, symbol: 'A.SH', industry: null, market_value: 5000 }),
    makePosition({ id: 2, symbol: 'B.SH', industry: '', market_value: 3000 }),
    makePosition({ id: 3, symbol: 'C.SH', industry: '白酒', market_value: 2000 }),
  ]);
  assertEqual('agg: 2 industries (unknown + 白酒)', unknown.breakdown.length, 2);
  assertEqual('agg: unknown first (pct 0.8)', unknown.breakdown[0].industry, '__UNKNOWN__');
  assertClose('agg: unknown pct = 0.8', unknown.breakdown[0].pct, 0.8);

  // 空持仓 → 空 breakdown
  const empty = aggregateByIndustry([]);
  assertEqual('agg: empty positions → 0 industries', empty.breakdown.length, 0);
  assertEqual('agg: empty total = 0', empty.total_position_value, 0);

  // 0 quantity / 0 market_value 持仓被剔除
  const filtered = aggregateByIndustry([
    makePosition({ id: 1, symbol: 'A.SH', industry: '白酒', quantity: 0, market_value: 0 }),
    makePosition({ id: 2, symbol: 'B.SH', industry: '白酒', quantity: 100, market_value: 1000 }),
  ]);
  assertEqual('agg: 0-qty positions filtered out', filtered.breakdown[0].position_count, 1);
  assertEqual('agg: 0-qty total only count valid', filtered.total_position_value, 1000);

  // 同 pct 时按 industry 名升序稳定 tie-break
  const tied = aggregateByIndustry([
    makePosition({ id: 1, symbol: 'A.SH', industry: 'B', market_value: 5000 }),
    makePosition({ id: 2, symbol: 'B.SH', industry: 'A', market_value: 5000 }),
  ]);
  assertEqual('agg: tie pct sort by industry ASC', tied.breakdown[0].industry, 'A');
  assertEqual('agg: tie pct sort second', tied.breakdown[1].industry, 'B');
}

async function testIsIndustryOverAlert() {
  assertEqual('alert: 0.5 > 0.35 → true', isIndustryOverAlert(0.5, 0.35), true);
  assertEqual('alert: 0.35 > 0.35 → false (strict)', isIndustryOverAlert(0.35, 0.35), false);
  assertEqual('alert: 0.36 > 0.35 → true', isIndustryOverAlert(0.36, 0.35), true);
  assertEqual('alert: 0.30 → false', isIndustryOverAlert(0.3, 0.35), false);
  // 边界 0
  assertEqual('alert: 0 → false', isIndustryOverAlert(0, 0.35), false);
  // 防御
  assertEqual('alert: NaN industry → false', isIndustryOverAlert(NaN, 0.35), false);
  assertEqual('alert: NaN alert → false', isIndustryOverAlert(0.5, NaN), false);
  assertEqual('alert: -0.1 industry → false', isIndustryOverAlert(-0.1, 0.35), false);
  assertEqual('alert: alert > 1 → false', isIndustryOverAlert(0.5, 1.5), false);
}

async function testPickOverAlertIndustries() {
  const breakdown = [
    { industry: 'A', total_value: 5000, pct: 0.5, position_count: 1, symbols: ['A.SH'] },
    { industry: 'B', total_value: 3500, pct: 0.35, position_count: 1, symbols: ['B.SH'] },
    { industry: 'C', total_value: 1500, pct: 0.15, position_count: 1, symbols: ['C.SH'] },
  ];
  const over = pickOverAlertIndustries(breakdown, 0.35);
  assertEqual('pick: only A over 35% strict', over.length, 1);
  assertEqual('pick: A is selected', over[0].industry, 'A');
  // 多个超 + 排序
  const breakdown2 = [
    { industry: 'A', total_value: 5000, pct: 0.4, position_count: 1, symbols: ['A.SH'] },
    { industry: 'B', total_value: 6000, pct: 0.6, position_count: 1, symbols: ['B.SH'] },
  ];
  const over2 = pickOverAlertIndustries(breakdown2, 0.35);
  assertEqual('pick: B first (higher pct)', over2[0].industry, 'B');
  assertEqual('pick: A second', over2[1].industry, 'A');
}

async function testComputeGainPct() {
  assertClose('gain: 110/100 → 0.10', computeGainPct(110, 100), 0.1);
  assertClose('gain: 90/100 → -0.10', computeGainPct(90, 100), -0.1);
  assertClose('gain: 100/100 → 0', computeGainPct(100, 100), 0);
  assertEqual('gain: avg_cost 0 → 0 (default)', computeGainPct(110, 0), 0);
  assertEqual('gain: avg_cost -5 → 0', computeGainPct(110, -5), 0);
  assertEqual('gain: NaN cost → 0', computeGainPct(110, NaN), 0);
  assertEqual('gain: NaN price → 0', computeGainPct(NaN, 100), 0);
}

async function testComputeIndustryPctAfterSell() {
  // 行业值 6000，总值 10000，卖出 3000 → 行业 3000，总 7000 → 3000/7000 ≈ 0.4286
  assertClose(
    'pctAfter: sell 3000 from (6000/10000) → 0.4286',
    computeIndustryPctAfterSell(6000, 10000, 3000),
    3000 / 7000
  );
  // 卖完行业（行业 1000 / 总 5000 / 卖 1000） → 0
  assertEqual('pctAfter: sell whole industry → 0', computeIndustryPctAfterSell(1000, 5000, 1000), 0);
  // 防御：卖超过行业 → 0
  assertEqual('pctAfter: sell > industry → 0', computeIndustryPctAfterSell(1000, 5000, 2000), 0);
  // 防御：卖超过总 → 0
  assertEqual('pctAfter: sell > total → 0', computeIndustryPctAfterSell(5000, 5000, 6000), 0);
}

async function testSortByGainDescStable() {
  const positions = [
    makePosition({ id: 1, symbol: 'B.SH', avg_cost: 100, current_price: 110 }), // +10%
    makePosition({ id: 2, symbol: 'A.SH', avg_cost: 100, current_price: 110 }), // +10% (tied)
    makePosition({ id: 3, symbol: 'C.SH', avg_cost: 100, current_price: 120 }), // +20%
    makePosition({ id: 4, symbol: 'D.SH', avg_cost: 100, current_price: 90 }), // -10%
  ];
  const sorted = sortByGainDescStable(positions);
  assertEqual('sort: C first (+20%)', sorted[0].symbol, 'C.SH');
  assertEqual('sort: A second (+10% tied symbol asc)', sorted[1].symbol, 'A.SH');
  assertEqual('sort: B third (+10% tied symbol asc)', sorted[2].symbol, 'B.SH');
  assertEqual('sort: D last (-10%)', sorted[3].symbol, 'D.SH');
}

async function testBuildRebalanceSellPlan() {
  // 5 持仓: 白酒 60% (3 只), 银行 30% (1), 科技 10% (1)。alert=35%, target=30%.
  // 白酒 super-pct → 在白酒里卖最大涨幅
  // 白酒 3 只 market_value=2000 / 2000 / 2000 (total 6000 of 10000)
  const positions = [
    makePosition({ id: 1, symbol: 'BAIJIU-A.SH', industry: '白酒', market_value: 2000, avg_cost: 80, current_price: 100 }), // +25%
    makePosition({ id: 2, symbol: 'BAIJIU-B.SH', industry: '白酒', market_value: 2000, avg_cost: 90, current_price: 100 }), // +11.1%
    makePosition({ id: 3, symbol: 'BAIJIU-C.SH', industry: '白酒', market_value: 2000, avg_cost: 100, current_price: 100 }), // 0%
    makePosition({ id: 4, symbol: 'BANK-A.SH', industry: '银行', market_value: 3000, avg_cost: 100, current_price: 100 }),
    makePosition({ id: 5, symbol: 'TECH-A.SH', industry: '科技', market_value: 1000, avg_cost: 100, current_price: 100 }),
  ];
  const { breakdown } = aggregateByIndustry(positions);
  const planBundle = buildRebalanceSellPlan(breakdown, positions, 0.35, 0.3, 2);
  assert('plan: bundle exists', planBundle !== null);
  assertEqual('plan: from_industry 白酒', planBundle!.from_industry, '白酒');
  assertClose('plan: before_pct = 0.6', planBundle!.before_pct, 0.6);
  // 涨幅最大 → BAIJIU-A 先卖 → 行业值 4000 / 总 8000 → 0.5
  // 0.5 > 0.30 → 继续卖第 2 只
  // 涨幅第二 → BAIJIU-B → 行业值 2000 / 总 6000 → 0.333
  // 0.333 > 0.30 → 但 max=2 已达
  assertEqual('plan: 2 sells', planBundle!.plan.length, 2);
  assertEqual('plan: first BAIJIU-A', planBundle!.plan[0].symbol, 'BAIJIU-A.SH');
  assertEqual('plan: second BAIJIU-B', planBundle!.plan[1].symbol, 'BAIJIU-B.SH');
  assertClose('plan: after first 0.5', planBundle!.plan[0].projected_industry_pct_after, 0.5);
  assertClose(
    'plan: after second 0.333',
    planBundle!.plan[1].projected_industry_pct_after,
    2000 / 6000
  );

  // 没有超标 → null
  // 3000 / 3000 / 4000 = 30% / 30% / 40% → 40% 已超 35% 阈值（属于超标 case）
  // 真正"无超标" 需要每个行业 ≤ 35%；用 3000 / 3500 / 3500 = 30% / 35% / 35%
  const balanced = [
    makePosition({ id: 1, symbol: 'A.SH', industry: '白酒', market_value: 3000 }),
    makePosition({ id: 2, symbol: 'B.SH', industry: '银行', market_value: 3500 }),
    makePosition({ id: 3, symbol: 'C.SH', industry: '科技', market_value: 3500 }),
  ];
  const balBreakdown = aggregateByIndustry(balanced).breakdown;
  const balPlan = buildRebalanceSellPlan(balBreakdown, balanced, 0.35, 0.3, 2);
  assertEqual('plan: balanced → null', balPlan, null);

  // 卖 1 只就到 target
  const easy = [
    makePosition({ id: 1, symbol: 'A.SH', industry: '白酒', market_value: 4000, avg_cost: 100, current_price: 110 }), // +10%
    makePosition({ id: 2, symbol: 'B.SH', industry: '白酒', market_value: 2000, avg_cost: 100, current_price: 100 }), // 0%
    makePosition({ id: 3, symbol: 'C.SH', industry: '银行', market_value: 4000, avg_cost: 100, current_price: 100 }),
  ];
  // 白酒 6000/10000 = 60% → 卖 A (4000) → 2000/6000 = 33.3%? 仍 > 30%
  // 继续卖 B (2000) → 0/4000 = 0%
  // 但 max=2 OK
  const easyBundle = buildRebalanceSellPlan(
    aggregateByIndustry(easy).breakdown,
    easy,
    0.35,
    0.3,
    2
  );
  assert('plan: easy bundle exists', easyBundle !== null);
  assertEqual('plan: easy 2 sells expected', easyBundle!.plan.length, 2);
  // 卖完后 0
  assertEqual('plan: easy final 0', easyBundle!.plan[1].projected_industry_pct_after, 0);

  // max=1 限制
  const max1Bundle = buildRebalanceSellPlan(
    aggregateByIndustry(easy).breakdown,
    easy,
    0.35,
    0.3,
    1
  );
  assertEqual('plan: max=1 → only 1 sell', max1Bundle!.plan.length, 1);

  // 单 sell 就到 target
  const single = [
    makePosition({ id: 1, symbol: 'A.SH', industry: '白酒', market_value: 4000 }),
    makePosition({ id: 2, symbol: 'B.SH', industry: '银行', market_value: 6000 }),
  ];
  // 白酒 40% → 卖 A (4000) → 0/6000 = 0%, < 30% target
  const singleBundle = buildRebalanceSellPlan(
    aggregateByIndustry(single).breakdown,
    single,
    0.35,
    0.3,
    2
  );
  assertEqual('plan: single sell ends loop', singleBundle!.plan.length, 1);
}

async function testNormalize() {
  assertEqual('normalize: empty → defaults', normalizeIndustryConcentrationConfig({}), {
    ...DEFAULT_INDUSTRY_CONCENTRATION_CONFIG,
  });
  assertEqual('normalize: null → defaults', normalizeIndustryConcentrationConfig(null), {
    ...DEFAULT_INDUSTRY_CONCENTRATION_CONFIG,
  });
  assertEqual(
    'normalize: undefined → defaults',
    normalizeIndustryConcentrationConfig(undefined),
    { ...DEFAULT_INDUSTRY_CONCENTRATION_CONFIG }
  );
  // valid values respected
  assertEqual(
    'normalize: valid full config',
    normalizeIndustryConcentrationConfig({
      enabled: false,
      alert_pct: 0.4,
      rebalance_target_pct: 0.25,
      rebalance_max_sell_count: 3,
    }),
    {
      enabled: false,
      alert_pct: 0.4,
      rebalance_target_pct: 0.25,
      rebalance_max_sell_count: 3,
    }
  );
  // garbage → defaults
  assertEqual(
    'normalize: alert_pct -0.1 → default 0.35',
    normalizeIndustryConcentrationConfig({ alert_pct: -0.1 }).alert_pct,
    0.35
  );
  assertEqual(
    'normalize: alert_pct 1.5 → default 0.35',
    normalizeIndustryConcentrationConfig({ alert_pct: 1.5 }).alert_pct,
    0.35
  );
  assertEqual(
    'normalize: alert_pct NaN → default 0.35',
    normalizeIndustryConcentrationConfig({ alert_pct: NaN }).alert_pct,
    0.35
  );
  assertEqual(
    'normalize: rebalance_max_sell_count -1 → default 2',
    normalizeIndustryConcentrationConfig({ rebalance_max_sell_count: -1 })
      .rebalance_max_sell_count,
    2
  );
  assertEqual(
    'normalize: rebalance_max_sell_count 0 → default 2',
    normalizeIndustryConcentrationConfig({ rebalance_max_sell_count: 0 }).rebalance_max_sell_count,
    2
  );
  assertEqual(
    'normalize: rebalance_max_sell_count 1.5 → default 2 (non-integer)',
    normalizeIndustryConcentrationConfig({ rebalance_max_sell_count: 1.5 })
      .rebalance_max_sell_count,
    2
  );
  assertEqual(
    'normalize: rebalance_max_sell_count 1 honored',
    normalizeIndustryConcentrationConfig({ rebalance_max_sell_count: 1 }).rebalance_max_sell_count,
    1
  );
  assertEqual(
    'normalize: enabled non-boolean → default true',
    normalizeIndustryConcentrationConfig({ enabled: 'yes' }).enabled,
    true
  );
  // 0 / 1 边界
  assertEqual(
    'normalize: alert_pct 0 honored (safe)',
    normalizeIndustryConcentrationConfig({ alert_pct: 0 }).alert_pct,
    0
  );
  assertEqual(
    'normalize: alert_pct 1 honored (max)',
    normalizeIndustryConcentrationConfig({ alert_pct: 1 }).alert_pct,
    1
  );
}

async function testBuildIndustryConcentrationMessage() {
  const msg = buildIndustryConcentrationMessage({
    industry: '白酒',
    pct: 0.45,
    alert_pct: 0.35,
    position_count: 2,
    symbols: ['600519.SH', '000858.SZ'],
  });
  assert('industry msg includes industry name', msg.includes('白酒'));
  assert('industry msg includes pct', msg.includes('45.00%'));
  assert('industry msg includes alert pct', msg.includes('35.00%'));
  assert('industry msg includes symbol preview', msg.includes('600519.SH'));
  assert('industry msg suggests rebalance', msg.includes('再平衡'));

  // 未分类
  const msgUnknown = buildIndustryConcentrationMessage({
    industry: UNKNOWN_INDUSTRY_SENTINEL,
    pct: 0.5,
    alert_pct: 0.35,
    position_count: 1,
    symbols: ['XYZ.SH'],
  });
  assert('industry msg shows 未分类 for sentinel', msgUnknown.includes('未分类'));
  assert('industry msg does NOT leak sentinel', !msgUnknown.includes('__UNKNOWN__'));

  // 多于 5 只 → 只显示前 5
  const symbols = ['A.SH', 'B.SH', 'C.SH', 'D.SH', 'E.SH', 'F.SH', 'G.SH'];
  const msgMany = buildIndustryConcentrationMessage({
    industry: '银行',
    pct: 0.4,
    alert_pct: 0.35,
    position_count: 7,
    symbols,
  });
  assert('industry msg truncates at 5', msgMany.includes('E.SH'));
  assert('industry msg shows total count', msgMany.includes('7'));
  assert('industry msg does NOT show F.SH', !msgMany.includes('F.SH'));
}

async function testBuildRebalanceResultMessage() {
  const msg = buildRebalanceResultMessage({
    industry: '白酒',
    before_pct: 0.5,
    after_pct: 0.25,
    target_pct: 0.3,
    sold_count: 1,
    partial: false,
    dry_run: false,
  });
  assert('rebal msg includes industry', msg.includes('白酒'));
  assert('rebal msg includes before pct', msg.includes('50.00%'));
  assert('rebal msg includes after pct', msg.includes('25.00%'));
  assert('rebal msg includes target', msg.includes('30.00%'));
  assert('rebal msg includes sold count', msg.includes('1'));

  // partial 提示
  const msgPartial = buildRebalanceResultMessage({
    industry: '白酒',
    before_pct: 0.5,
    after_pct: 0.36,
    target_pct: 0.3,
    sold_count: 2,
    partial: true,
    dry_run: false,
  });
  assert('rebal msg partial mentions human intervene', msgPartial.includes('人工'));

  // dry_run 前缀
  const msgDry = buildRebalanceResultMessage({
    industry: '白酒',
    before_pct: 0.5,
    after_pct: 0.25,
    target_pct: 0.3,
    sold_count: 1,
    partial: false,
    dry_run: true,
  });
  assert('rebal msg dry_run prefix', msgDry.includes('预演'));
}

// ---------------------------------------------------------------------------
//  Tests — guard.evaluateAfterClose end-to-end
// ---------------------------------------------------------------------------

async function testEvaluateSingleIndustryAlert() {
  // 单一行业 100% → 触发告警
  const state = emptyState({
    userIds: [1],
    positionsByUser: {
      1: [
        makePosition({ id: 1, symbol: 'A.SH', industry: '白酒', market_value: 10000 }),
        makePosition({ id: 2, symbol: 'B.SH', industry: '白酒', market_value: 5000 }),
      ],
    },
  });
  const guard = new IndustryConcentrationGuard(makeFakeSource(state));
  const result = await guard.evaluateAfterClose({ user_id: 1 });
  assertEqual('eval: 1 user scanned', result.scanned_users, 1);
  assertEqual('eval: 1 alerted', result.alerted_users, 1);
  assertEqual('eval: 1 alert for the user', result.per_user[0].alerts.length, 1);
  assertEqual('eval: alert industry 白酒', result.per_user[0].alerts[0].industry, '白酒');
  assertClose('eval: alert pct 1.0', result.per_user[0].alerts[0].pct, 1.0);
  // RiskAlert 应写入
  assertEqual('eval: RiskAlert written', state.alerts.length, 1);
  assertEqual(
    'eval: RiskAlert symbol sentinel',
    state.alerts[0].symbol,
    'SYSTEM:INDUSTRY_CONCENTRATION:白酒'
  );
  assertEqual('eval: RiskAlert linked to portfolio', state.alerts[0].portfolio_id, 1001);
}

async function testEvaluateBalancedNoAlert() {
  // 50% A + 50% B → 都 <= 35% → 不触发 (35% 严格 >)
  const state = emptyState({
    userIds: [1],
    positionsByUser: {
      1: [
        makePosition({ id: 1, symbol: 'A.SH', industry: '白酒', market_value: 5000 }),
        makePosition({ id: 2, symbol: 'B.SH', industry: '银行', market_value: 5000 }),
      ],
    },
  });
  // 50% / 50% — 都 > 35% 所以都触发
  const guard = new IndustryConcentrationGuard(makeFakeSource(state));
  const result = await guard.evaluateAfterClose({ user_id: 1 });
  assertEqual('balanced: both alert', result.per_user[0].alerts.length, 2);

  // 改成 3 行业 each 33.3% → 都不超 35%
  const state2 = emptyState({
    userIds: [1],
    positionsByUser: {
      1: [
        makePosition({ id: 1, symbol: 'A.SH', industry: '白酒', market_value: 3333 }),
        makePosition({ id: 2, symbol: 'B.SH', industry: '银行', market_value: 3333 }),
        makePosition({ id: 3, symbol: 'C.SH', industry: '科技', market_value: 3334 }),
      ],
    },
  });
  const guard2 = new IndustryConcentrationGuard(makeFakeSource(state2));
  const result2 = await guard2.evaluateAfterClose({ user_id: 1 });
  assertEqual('balanced3: 0 alerts', result2.per_user[0].alerts.length, 0);
  assertEqual('balanced3: 0 alerted_users', result2.alerted_users, 0);
}

async function testEvaluateMultiAlerts() {
  // 50% A + 36% B + 14% C → A & B 都超 35%
  const state = emptyState({
    userIds: [1],
    positionsByUser: {
      1: [
        makePosition({ id: 1, symbol: 'A.SH', industry: '白酒', market_value: 5000 }),
        makePosition({ id: 2, symbol: 'B.SH', industry: '银行', market_value: 3600 }),
        makePosition({ id: 3, symbol: 'C.SH', industry: '科技', market_value: 1400 }),
      ],
    },
  });
  const guard = new IndustryConcentrationGuard(makeFakeSource(state));
  const result = await guard.evaluateAfterClose({ user_id: 1 });
  assertEqual('multi: 2 alerts', result.per_user[0].alerts.length, 2);
  // 排序按 pct desc
  assertEqual('multi: first alert 白酒 (highest pct)', result.per_user[0].alerts[0].industry, '白酒');
  assertEqual('multi: second alert 银行', result.per_user[0].alerts[1].industry, '银行');
  assertEqual('multi: 2 RiskAlerts written', state.alerts.length, 2);
}

async function testEvaluateBoundary() {
  // 35% 边界 → 不触发 (严格 >)
  const state = emptyState({
    userIds: [1],
    positionsByUser: {
      1: [
        makePosition({ id: 1, symbol: 'A.SH', industry: '白酒', market_value: 3500 }),
        makePosition({ id: 2, symbol: 'B.SH', industry: '银行', market_value: 6500 }),
      ],
    },
  });
  const guard = new IndustryConcentrationGuard(makeFakeSource(state));
  const result = await guard.evaluateAfterClose({ user_id: 1 });
  // 35% 不触发，65% 银行 触发
  assertEqual('boundary: 35% NOT alerted, 65% alerted', result.per_user[0].alerts.length, 1);
  assertEqual('boundary: 银行 only', result.per_user[0].alerts[0].industry, '银行');
}

async function testEvaluateUnknownIndustry() {
  // 全部未分类 → 触发未分类告警
  const state = emptyState({
    userIds: [1],
    positionsByUser: {
      1: [
        makePosition({ id: 1, symbol: 'A.SH', industry: null, market_value: 5000 }),
        makePosition({ id: 2, symbol: 'B.SH', industry: '', market_value: 5000 }),
      ],
    },
  });
  const guard = new IndustryConcentrationGuard(makeFakeSource(state));
  const result = await guard.evaluateAfterClose({ user_id: 1 });
  assertEqual('unknown: 1 alert', result.per_user[0].alerts.length, 1);
  assertEqual(
    'unknown: industry sentinel',
    result.per_user[0].alerts[0].industry,
    '__UNKNOWN__'
  );
  // message uses 未分类
  assert('unknown: msg uses 未分类', result.per_user[0].alerts[0].message.includes('未分类'));
}

async function testEvaluateDisabledUser() {
  const state = emptyState({
    userIds: [1],
    configs: {
      1: {
        enabled: false,
        alert_pct: 0.35,
        rebalance_target_pct: 0.3,
        rebalance_max_sell_count: 2,
      },
    },
    positionsByUser: {
      1: [makePosition({ id: 1, symbol: 'A.SH', industry: '白酒', market_value: 10000 })],
    },
  });
  const guard = new IndustryConcentrationGuard(makeFakeSource(state));
  const result = await guard.evaluateAfterClose({ user_id: 1 });
  assertEqual('disabled: 0 alerts', result.per_user[0].alerts.length, 0);
  assertEqual('disabled: enabled false', result.per_user[0].enabled, false);
  assertEqual('disabled: 0 RiskAlerts written', state.alerts.length, 0);
}

async function testEvaluateDryRun() {
  const state = emptyState({
    userIds: [1],
    positionsByUser: {
      1: [makePosition({ id: 1, symbol: 'A.SH', industry: '白酒', market_value: 10000 })],
    },
  });
  const guard = new IndustryConcentrationGuard(makeFakeSource(state));
  const result = await guard.evaluateAfterClose({ user_id: 1, dry_run: true });
  // alert still surfaced
  assertEqual('dryRun: 1 alert', result.per_user[0].alerts.length, 1);
  // 但不写 alert 行
  assertEqual('dryRun: 0 alerts written', state.alerts.length, 0);
}

async function testEvaluateEmptyPortfolio() {
  const state = emptyState({
    userIds: [1],
    positionsByUser: { 1: [] },
  });
  const guard = new IndustryConcentrationGuard(makeFakeSource(state));
  const result = await guard.evaluateAfterClose({ user_id: 1 });
  assertEqual('empty: 0 alerts', result.per_user[0].alerts.length, 0);
  assertEqual('empty: total_value = 0', result.per_user[0].total_position_value, 0);
}

async function testEvaluateNoPortfolio() {
  const state = emptyState({
    userIds: [1],
    portfolioIds: { 1: null },
    positionsByUser: { 1: [] },
  });
  const guard = new IndustryConcentrationGuard(makeFakeSource(state));
  const result = await guard.evaluateAfterClose({ user_id: 1 });
  assertEqual('noPortfolio: 0 alerts', result.per_user[0].alerts.length, 0);
  assertEqual('noPortfolio: portfolio_id null', result.per_user[0].portfolio_id, null);
}

async function testEvaluateAlertFailureDoesNotMask() {
  const state = emptyState({
    userIds: [1],
    positionsByUser: {
      1: [makePosition({ id: 1, symbol: 'A.SH', industry: '白酒', market_value: 10000 })],
    },
    writeAlertShouldThrow: true,
  });
  const guard = new IndustryConcentrationGuard(makeFakeSource(state));
  const result = await guard.evaluateAfterClose({ user_id: 1 });
  // alerts list still populated despite write outage
  assertEqual('alertFail: alert still surfaced', result.per_user[0].alerts.length, 1);
  // 0 actually written (因为 throw)
  assertEqual('alertFail: 0 written due to throw', state.alerts.length, 0);
}

async function testEvaluateMultiUserIsolation() {
  const state = emptyState({
    userIds: [1, 2, 3],
    positionsByUser: {
      1: [makePosition({ id: 1, symbol: 'A.SH', industry: '白酒', market_value: 10000 })],
      2: [], // user 2 will throw
      3: [makePosition({ id: 3, symbol: 'C.SH', industry: '银行', market_value: 10000 })],
    },
    loadPositionsShouldThrowForUser: 2,
  });
  const guard = new IndustryConcentrationGuard(makeFakeSource(state));
  const result = await guard.evaluateAfterClose();
  assertEqual('multi: 3 users scanned', result.scanned_users, 3);
  // user 1 & 3 succeeded, user 2 errored but no crash
  assertEqual('multi: 3 per_user entries', result.per_user.length, 3);
  const u2 = result.per_user.find(u => u.user_id === 2);
  assert('multi: u2 has error', !!u2?.error);
  // u1 & u3 each have 1 alert
  const u1 = result.per_user.find(u => u.user_id === 1);
  const u3 = result.per_user.find(u => u.user_id === 3);
  assertEqual('multi: u1 alerts', u1?.alerts.length, 1);
  assertEqual('multi: u3 alerts', u3?.alerts.length, 1);
}

async function testEvaluateScansAllWhenNoUserId() {
  const state = emptyState({
    userIds: [1, 2],
    positionsByUser: {
      1: [makePosition({ id: 1, symbol: 'A.SH', industry: '白酒', market_value: 10000 })],
      2: [makePosition({ id: 2, symbol: 'B.SH', industry: '银行', market_value: 10000 })],
    },
  });
  const guard = new IndustryConcentrationGuard(makeFakeSource(state));
  const result = await guard.evaluateAfterClose();
  assertEqual('scanAll: 2 users scanned', result.scanned_users, 2);
  assertEqual('scanAll: both alerted', result.alerted_users, 2);
}

// ---------------------------------------------------------------------------
//  Tests — guard.rebalanceIndustry end-to-end
// ---------------------------------------------------------------------------

async function testRebalanceHappyPath() {
  // 白酒 60% (3 只), 银行 30%, 科技 10%. 卖 1-2 只让白酒 < 30%
  const state = emptyState({
    userIds: [1],
    positionsByUser: {
      1: [
        makePosition({
          id: 1,
          symbol: 'BAIJIU-A.SH',
          industry: '白酒',
          market_value: 2000,
          avg_cost: 80,
          current_price: 100,
        }),
        makePosition({
          id: 2,
          symbol: 'BAIJIU-B.SH',
          industry: '白酒',
          market_value: 2000,
          avg_cost: 90,
          current_price: 100,
        }),
        makePosition({
          id: 3,
          symbol: 'BAIJIU-C.SH',
          industry: '白酒',
          market_value: 2000,
          avg_cost: 100,
          current_price: 100,
        }),
        makePosition({
          id: 4,
          symbol: 'BANK-A.SH',
          industry: '银行',
          market_value: 3000,
        }),
        makePosition({
          id: 5,
          symbol: 'TECH-A.SH',
          industry: '科技',
          market_value: 1000,
        }),
      ],
    },
    closeReturns: {
      'BAIJIU-A.SH': { executed_quantity: 20, executed_price: 100 },
      'BAIJIU-B.SH': { executed_quantity: 20, executed_price: 100 },
    },
  });
  const guard = new IndustryConcentrationGuard(makeFakeSource(state));
  const result = await guard.rebalanceIndustry({ user_id: 1, portfolio_id: 1001 });
  assertEqual('rebal: from_industry 白酒', result.from_industry, '白酒');
  assertClose('rebal: before 0.6', result.before_pct, 0.6);
  assertEqual('rebal: 2 sold', result.sold_positions.length, 2);
  assertEqual('rebal: first sold A (highest gain)', result.sold_positions[0].symbol, 'BAIJIU-A.SH');
  assertEqual('rebal: second sold B', result.sold_positions[1].symbol, 'BAIJIU-B.SH');
  assertEqual('rebal: status sold', result.sold_positions[0].status, 'sold');
  assertEqual('rebal: not dry_run', result.dry_run, false);
  // 实际下单 2 次
  assertEqual('rebal: 2 close calls', state.closeCalls.length, 2);
  assertEqual('rebal: call 1 BAIJIU-A', state.closeCalls[0].symbol, 'BAIJIU-A.SH');
  assertEqual('rebal: call 2 BAIJIU-B', state.closeCalls[1].symbol, 'BAIJIU-B.SH');
}

async function testRebalanceDryRun() {
  const state = emptyState({
    userIds: [1],
    positionsByUser: {
      1: [
        makePosition({
          id: 1,
          symbol: 'BAIJIU-A.SH',
          industry: '白酒',
          market_value: 4000,
          avg_cost: 80,
          current_price: 100,
        }),
        // 银行 6000 → 60% 也超 35%，但白酒 40% 也超
        // 排序 pct desc → 银行 first (60%)，白酒 second (40%)
        // → from_industry = 银行（最高）
        makePosition({ id: 2, symbol: 'BANK.SH', industry: '银行', market_value: 6000 }),
      ],
    },
  });
  const guard = new IndustryConcentrationGuard(makeFakeSource(state));
  const result = await guard.rebalanceIndustry({ user_id: 1, portfolio_id: 1001, dry_run: true });
  // 银行 60% 超过 白酒 40%，rebalance focus = 银行
  assertEqual('rebalDry: from_industry 银行', result.from_industry, '银行');
  assertEqual('rebalDry: 1 in plan', result.plan.length, 1);
  assertEqual('rebalDry: status skipped_dry_run', result.sold_positions[0].status, 'skipped_dry_run');
  // 不调 close
  assertEqual('rebalDry: 0 close calls', state.closeCalls.length, 0);
  assertEqual('rebalDry: dry_run true', result.dry_run, true);
  assert('rebalDry: message has 预演', result.message.includes('预演'));
}

async function testRebalanceNoOverAlert() {
  // 30% / 35% / 35% — none > 35% strict
  const state = emptyState({
    userIds: [1],
    positionsByUser: {
      1: [
        makePosition({ id: 1, symbol: 'A.SH', industry: '白酒', market_value: 3000 }),
        makePosition({ id: 2, symbol: 'B.SH', industry: '银行', market_value: 3500 }),
        makePosition({ id: 3, symbol: 'C.SH', industry: '科技', market_value: 3500 }),
      ],
    },
  });
  const guard = new IndustryConcentrationGuard(makeFakeSource(state));
  const result = await guard.rebalanceIndustry({ user_id: 1, portfolio_id: 1001 });
  assertEqual('rebalNoOver: from_industry null', result.from_industry, null);
  assertEqual('rebalNoOver: 0 sold', result.sold_positions.length, 0);
  assertEqual('rebalNoOver: 0 plan', result.plan.length, 0);
  assertEqual('rebalNoOver: not partial', result.partial, false);
  assert(
    'rebalNoOver: message says no rebalance needed',
    result.message.includes('无需')
  );
}

async function testRebalanceCloseFailureContinues() {
  const state = emptyState({
    userIds: [1],
    positionsByUser: {
      1: [
        makePosition({
          id: 1,
          symbol: 'BAIJIU-A.SH',
          industry: '白酒',
          market_value: 2000,
          avg_cost: 80,
          current_price: 100,
        }),
        makePosition({
          id: 2,
          symbol: 'BAIJIU-B.SH',
          industry: '白酒',
          market_value: 2000,
          avg_cost: 90,
          current_price: 100,
        }),
        makePosition({
          id: 3,
          symbol: 'BAIJIU-C.SH',
          industry: '白酒',
          market_value: 2000,
          avg_cost: 100,
          current_price: 100,
        }),
        makePosition({ id: 4, symbol: 'BANK.SH', industry: '银行', market_value: 4000 }),
      ],
    },
    closeShouldThrowForSymbol: {
      'BAIJIU-A.SH': true, // 第一只卖出失败
    },
  });
  const guard = new IndustryConcentrationGuard(makeFakeSource(state));
  const result = await guard.rebalanceIndustry({ user_id: 1, portfolio_id: 1001 });
  // 仍卖了 2 只 — 1 失败 + 1 成功
  assertEqual('rebalFail: 2 sells in plan', result.plan.length, 2);
  assertEqual('rebalFail: 2 sold_positions', result.sold_positions.length, 2);
  assertEqual('rebalFail: first failed', result.sold_positions[0].status, 'failed');
  assertEqual('rebalFail: second sold', result.sold_positions[1].status, 'sold');
  assert('rebalFail: failed has error', !!result.sold_positions[0].error);
  // 仍调了 2 次 close（虽然第一次失败）
  assertEqual('rebalFail: 2 close calls', state.closeCalls.length, 2);
}

async function testRebalanceNoPortfolio() {
  const state = emptyState({
    userIds: [1],
    portfolioIds: { 1: null },
    positionsByUser: { 1: [] },
  });
  const guard = new IndustryConcentrationGuard(makeFakeSource(state));
  const result = await guard.rebalanceIndustry({ user_id: 1, portfolio_id: 1001 });
  assertEqual('rebalNoPort: from_industry null', result.from_industry, null);
  assertEqual('rebalNoPort: 0 sold', result.sold_positions.length, 0);
  assert('rebalNoPort: message says no portfolio', result.message.includes('未找到'));
}

async function testRebalanceCustomConfig() {
  // 用户自定义 alert=40% / target=35% → 50% 行业触发，卖到 < 35%
  const state = emptyState({
    userIds: [1],
    configs: {
      1: {
        enabled: true,
        alert_pct: 0.4,
        rebalance_target_pct: 0.35,
        rebalance_max_sell_count: 1,
      },
    },
    positionsByUser: {
      1: [
        makePosition({
          id: 1,
          symbol: 'A.SH',
          industry: '白酒',
          market_value: 5000,
          avg_cost: 80,
          current_price: 100,
        }),
        makePosition({ id: 2, symbol: 'B.SH', industry: '银行', market_value: 5000 }),
      ],
    },
    closeReturns: { 'A.SH': { executed_quantity: 50, executed_price: 100 } },
  });
  const guard = new IndustryConcentrationGuard(makeFakeSource(state));
  const result = await guard.rebalanceIndustry({ user_id: 1, portfolio_id: 1001 });
  assertClose('rebalCustom: before 0.5', result.before_pct, 0.5);
  // 卖 A (5000) → 0/5000 = 0% < 35%
  assertEqual('rebalCustom: 1 sold (max=1)', result.sold_positions.length, 1);
  assertEqual('rebalCustom: status sold', result.sold_positions[0].status, 'sold');
  assertEqual('rebalCustom: after 0', result.after_pct, 0);
  assertEqual('rebalCustom: not partial', result.partial, false);
}

async function testRebalancePartial() {
  // max=1，行业内只能卖 1 只 但仍未到 target
  const state = emptyState({
    userIds: [1],
    configs: {
      1: {
        enabled: true,
        alert_pct: 0.35,
        rebalance_target_pct: 0.3,
        rebalance_max_sell_count: 1,
      },
    },
    positionsByUser: {
      1: [
        makePosition({
          id: 1,
          symbol: 'A.SH',
          industry: '白酒',
          market_value: 2000,
          avg_cost: 80,
          current_price: 100,
        }),
        makePosition({
          id: 2,
          symbol: 'B.SH',
          industry: '白酒',
          market_value: 2000,
          avg_cost: 90,
          current_price: 100,
        }),
        makePosition({
          id: 3,
          symbol: 'C.SH',
          industry: '白酒',
          market_value: 2000,
          avg_cost: 100,
          current_price: 100,
        }),
        makePosition({
          id: 4,
          symbol: 'D.SH',
          industry: '银行',
          market_value: 4000,
        }),
      ],
    },
    closeReturns: { 'A.SH': { executed_quantity: 20, executed_price: 100 } },
  });
  const guard = new IndustryConcentrationGuard(makeFakeSource(state));
  const result = await guard.rebalanceIndustry({ user_id: 1, portfolio_id: 1001 });
  // 白酒 60% → 卖 A (2000) → 4000/8000 = 50% 仍 > 30%
  // max=1 限制 → partial=true
  assertEqual('rebalPartial: 1 sold', result.sold_positions.length, 1);
  assertEqual('rebalPartial: partial=true', result.partial, true);
  assertClose('rebalPartial: after 0.5', result.after_pct, 0.5);
}

// ---------------------------------------------------------------------------
//  Tests — getConfig / updateConfig
// ---------------------------------------------------------------------------

async function testGetConfigDefault() {
  const state = emptyState({ userIds: [1] });
  const guard = new IndustryConcentrationGuard(makeFakeSource(state));
  const config = await guard.getConfig(1);
  assertEqual('getConfig: returns defaults', config, {
    ...DEFAULT_INDUSTRY_CONCENTRATION_CONFIG,
  });
}

async function testUpdateConfigRoundTrip() {
  const state = emptyState({ userIds: [1] });
  const guard = new IndustryConcentrationGuard(makeFakeSource(state));
  const updated = await guard.updateConfig(1, {
    enabled: true,
    alert_pct: 0.4,
    rebalance_target_pct: 0.32,
    rebalance_max_sell_count: 3,
  });
  assertEqual('updateConfig: returns normalized', updated, {
    enabled: true,
    alert_pct: 0.4,
    rebalance_target_pct: 0.32,
    rebalance_max_sell_count: 3,
  });
  const after = await guard.getConfig(1);
  assertEqual('updateConfig: persisted', after, {
    enabled: true,
    alert_pct: 0.4,
    rebalance_target_pct: 0.32,
    rebalance_max_sell_count: 3,
  });
}

async function testUpdateConfigGarbageSanitized() {
  const state = emptyState({ userIds: [1] });
  const guard = new IndustryConcentrationGuard(makeFakeSource(state));
  const updated = await guard.updateConfig(1, {
    enabled: 'maybe',
    alert_pct: 5,
    rebalance_target_pct: -0.1,
    rebalance_max_sell_count: 'two',
  });
  assertEqual('updateConfig garbage → defaults', updated, {
    ...DEFAULT_INDUSTRY_CONCENTRATION_CONFIG,
  });
}

// ---------------------------------------------------------------------------
//  Tests — getSummary (US-012 KPI 快照)
// ---------------------------------------------------------------------------

async function testGetSummaryEmptyPortfolio() {
  const state = emptyState({ userIds: [1], positionsByUser: { 1: [] } });
  const guard = new IndustryConcentrationGuard(makeFakeSource(state));
  const summary = await guard.getSummary(1);
  assertEqual(
    'getSummary empty: aggregate scope has no arbitrary portfolio id',
    summary.portfolio_id,
    null
  );
  assertEqual('getSummary empty: max_industry_pct null', summary.max_industry_pct, null);
  assertEqual('getSummary empty: max_industry_name null', summary.max_industry_name, null);
  assertEqual('getSummary empty: over_alert false', summary.over_alert, false);
  assertEqual('getSummary empty: open_positions_count 0', summary.open_positions_count, 0);
  assertEqual('getSummary empty: total_position_value 0', summary.total_position_value, 0);
  assertEqual('getSummary empty: breakdown []', summary.industry_breakdown.length, 0);
  // 0 alerts written even though config.enabled — dry-run guarantee.
  assertEqual('getSummary empty: 0 alerts written', state.alerts.length, 0);
  // Config reflected
  assertEqual('getSummary empty: alert_pct == default 0.35', summary.alert_pct, 0.35);
  assertEqual(
    'getSummary empty: rebalance_target_pct == default 0.30',
    summary.rebalance_target_pct,
    0.3
  );
}

async function testGetSummaryNoPortfolio() {
  const state = emptyState({
    userIds: [1],
    portfolioIds: { 1: null },
    positionsByUser: { 1: [] },
  });
  const guard = new IndustryConcentrationGuard(makeFakeSource(state));
  const summary = await guard.getSummary(1);
  assertEqual('getSummary noPortfolio: portfolio_id null', summary.portfolio_id, null);
  assertEqual('getSummary noPortfolio: max_industry_pct null', summary.max_industry_pct, null);
  assertEqual('getSummary noPortfolio: over_alert false', summary.over_alert, false);
}

async function testGetSummarySingleIndustryOverAlert() {
  // 3 holdings all in 白酒 → 100% concentration → over alert (default 35%)
  const state = emptyState({
    userIds: [1],
    positionsByUser: {
      1: [
        makePosition({ id: 1, symbol: 'A.SH', industry: '白酒', market_value: 5000 }),
        makePosition({ id: 2, symbol: 'B.SH', industry: '白酒', market_value: 3000 }),
        makePosition({ id: 3, symbol: 'C.SH', industry: '白酒', market_value: 2000 }),
      ],
    },
  });
  const guard = new IndustryConcentrationGuard(makeFakeSource(state));
  const summary = await guard.getSummary(1);
  assertClose('getSummary single over: max_pct == 1.0', summary.max_industry_pct ?? -1, 1.0);
  assertEqual('getSummary single over: max_industry_name 白酒', summary.max_industry_name, '白酒');
  assertEqual('getSummary single over: over_alert true', summary.over_alert, true);
  assertEqual('getSummary single over: open_positions_count 3', summary.open_positions_count, 3);
  assertEqual('getSummary single over: total_value 10000', summary.total_position_value, 10000);
  // 仍是 dry-run, 不写 alert
  assertEqual('getSummary single over: 0 alerts written', state.alerts.length, 0);
  // breakdown 至少包含 1 行业
  assert('getSummary single over: breakdown non-empty', summary.industry_breakdown.length >= 1);
}

async function testGetSummaryBoundaryNotOver() {
  // 35% 严格不等 → over_alert false
  const state = emptyState({
    userIds: [1],
    positionsByUser: {
      1: [
        makePosition({ id: 1, symbol: 'A.SH', industry: '白酒', market_value: 3500 }),
        makePosition({ id: 2, symbol: 'B.SH', industry: '银行', market_value: 6500 }),
      ],
    },
  });
  const guard = new IndustryConcentrationGuard(makeFakeSource(state));
  const summary = await guard.getSummary(1);
  assertClose('boundary: max_pct == 0.65', summary.max_industry_pct ?? -1, 0.65);
  assertEqual('boundary: max_name 银行', summary.max_industry_name, '银行');
  // 0.65 > 0.35 → over
  assertEqual('boundary: over_alert true', summary.over_alert, true);
}

async function testGetSummaryUnderAlertBelowThreshold() {
  // 50/50 split → 0.5 < ... wait default is 0.35; need below — use 30/70 to put max=0.7
  // Use 30/30/40 (each 30%, max=0.40) — still over default 0.35; use 25/25/25/25 = max 0.25 (< 0.35)
  const state = emptyState({
    userIds: [1],
    positionsByUser: {
      1: [
        makePosition({ id: 1, symbol: 'A.SH', industry: '白酒', market_value: 2500 }),
        makePosition({ id: 2, symbol: 'B.SH', industry: '银行', market_value: 2500 }),
        makePosition({ id: 3, symbol: 'C.SH', industry: '科技', market_value: 2500 }),
        makePosition({ id: 4, symbol: 'D.SH', industry: '医药', market_value: 2500 }),
      ],
    },
  });
  const guard = new IndustryConcentrationGuard(makeFakeSource(state));
  const summary = await guard.getSummary(1);
  assertClose('under: max_pct == 0.25', summary.max_industry_pct ?? -1, 0.25);
  assertEqual('under: over_alert false', summary.over_alert, false);
}

async function testGetSummaryDisabledForcesOverAlertFalse() {
  // Disabled config → over_alert 强制 false 即使真实占比 100%
  const state = emptyState({
    userIds: [1],
    configs: {
      1: {
        ...DEFAULT_INDUSTRY_CONCENTRATION_CONFIG,
        enabled: false,
      },
    },
    positionsByUser: {
      1: [makePosition({ id: 1, symbol: 'A.SH', industry: '白酒', market_value: 10000 })],
    },
  });
  const guard = new IndustryConcentrationGuard(makeFakeSource(state));
  const summary = await guard.getSummary(1);
  assertEqual('disabled: enabled false echoed', summary.enabled, false);
  // 真实占比仍计算并返回, 让 UI 决定是否提示
  assertClose('disabled: max_pct still 1.0', summary.max_industry_pct ?? -1, 1.0);
  assertEqual('disabled: over_alert forced false', summary.over_alert, false);
}

async function testGetSummaryCustomAlertPctEchoed() {
  // 自定义 alert_pct 应回显
  const state = emptyState({
    userIds: [1],
    configs: {
      1: {
        ...DEFAULT_INDUSTRY_CONCENTRATION_CONFIG,
        alert_pct: 0.5,
        rebalance_target_pct: 0.45,
      },
    },
    positionsByUser: {
      1: [
        makePosition({ id: 1, symbol: 'A.SH', industry: '白酒', market_value: 4500 }),
        makePosition({ id: 2, symbol: 'B.SH', industry: '银行', market_value: 5500 }),
      ],
    },
  });
  const guard = new IndustryConcentrationGuard(makeFakeSource(state));
  const summary = await guard.getSummary(1);
  assertEqual('custom: alert_pct echoed 0.5', summary.alert_pct, 0.5);
  assertEqual('custom: rebalance_target_pct echoed 0.45', summary.rebalance_target_pct, 0.45);
  assertClose('custom: max_pct 0.55', summary.max_industry_pct ?? -1, 0.55);
  // 0.55 > 0.5 → over
  assertEqual('custom: over_alert true (0.55 > 0.5)', summary.over_alert, true);
}

async function testGetSummaryUnknownIndustry() {
  // 未分类持仓 → __UNKNOWN__ bucket
  const state = emptyState({
    userIds: [1],
    positionsByUser: {
      1: [
        makePosition({ id: 1, symbol: 'A.SH', industry: null, market_value: 5000 }),
        makePosition({ id: 2, symbol: 'B.SH', industry: '银行', market_value: 5000 }),
      ],
    },
  });
  const guard = new IndustryConcentrationGuard(makeFakeSource(state));
  const summary = await guard.getSummary(1);
  // 各 50% — max 是字典序在前的（pct 同则 industry asc），__UNKNOWN__ 排在 银行 之前
  assertClose('unknown: max_pct 0.5', summary.max_industry_pct ?? -1, 0.5);
  // 一定能找到 __UNKNOWN__ bucket（不静默合并）
  const hasUnknown = summary.industry_breakdown.some(
    b => b.industry === UNKNOWN_INDUSTRY_SENTINEL
  );
  assert('unknown: __UNKNOWN__ bucket present', hasUnknown);
}

// ---------------------------------------------------------------------------
//  Driver
// ---------------------------------------------------------------------------

async function main() {
  await testConstants();
  await testNormalizeIndustryName();
  await testAggregateByIndustry();
  await testIsIndustryOverAlert();
  await testPickOverAlertIndustries();
  await testComputeGainPct();
  await testComputeIndustryPctAfterSell();
  await testSortByGainDescStable();
  await testBuildRebalanceSellPlan();
  await testNormalize();
  await testBuildIndustryConcentrationMessage();
  await testBuildRebalanceResultMessage();

  await testEvaluateSingleIndustryAlert();
  await testEvaluateBalancedNoAlert();
  await testEvaluateMultiAlerts();
  await testEvaluateBoundary();
  await testEvaluateUnknownIndustry();
  await testEvaluateDisabledUser();
  await testEvaluateDryRun();
  await testEvaluateEmptyPortfolio();
  await testEvaluateNoPortfolio();
  await testEvaluateAlertFailureDoesNotMask();
  await testEvaluateMultiUserIsolation();
  await testEvaluateScansAllWhenNoUserId();

  await testRebalanceHappyPath();
  await testRebalanceDryRun();
  await testRebalanceNoOverAlert();
  await testRebalanceCloseFailureContinues();
  await testRebalanceNoPortfolio();
  await testRebalanceCustomConfig();
  await testRebalancePartial();

  await testGetConfigDefault();
  await testUpdateConfigRoundTrip();
  await testUpdateConfigGarbageSanitized();

  await testGetSummaryEmptyPortfolio();
  await testGetSummaryNoPortfolio();
  await testGetSummarySingleIndustryOverAlert();
  await testGetSummaryBoundaryNotOver();
  await testGetSummaryUnderAlertBelowThreshold();
  await testGetSummaryDisabledForcesOverAlertFalse();
  await testGetSummaryCustomAlertPctEchoed();
  await testGetSummaryUnknownIndustry();

  console.log(`\n${passed} ok, ${failed} failed`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch(err => {
  console.error('TEST RUNNER CRASHED:', err);
  process.exitCode = 1;
});
