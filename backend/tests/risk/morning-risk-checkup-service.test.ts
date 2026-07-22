/**
 * MorningRiskCheckupService 单元测试 (US-054)
 *
 * 不依赖 jest；node 直接跑：
 *   cd backend && npx ts-node --transpile-only tests/risk/morning-risk-checkup-service.test.ts
 *
 * 完全脱离 DB：注入 fake MorningRiskCheckupDataSource。
 *
 * 覆盖维度：
 *   - 常量校验：DEFAULT_MORNING_RISK_CHECKUP_CONFIG
 *   - 纯函数：
 *     normalizeMorningRiskCheckupConfig / computeMaxSingleStockPct /
 *     computeMaxIndustryPct / computeWeeklyReturnPct / buildCheckupMessage /
 *     buildTopPositions / buildTopIndustries
 *   - service.runMorningCheckup() end-to-end：
 *     - happy path: 3 持仓 + snapshot 历史 → 所有 6 维度落库 + message 拼装；
 *     - 0 持仓 → 单股/行业占比 null + drawdown null（不写 zeros 误导）；
 *     - 新账户 snapshot 历史 < 7 日 → weekly_return_pct=null；
 *     - 行业聚合复用 US-052 aggregateByIndustry → 与 IndustryConcentrationGuard 数字对齐；
 *     - 回撤复用 US-049 computePeakValue → 与 DrawdownCircuitBreaker 数字对齐；
 *     - dry_run=true 跳过 DB 写入但 message 仍返回；
 *     - 禁用 user → 全部默认值不写表；
 *     - 单 user upsertCheckup 失败 try/catch 隔离不阻塞其他 user；
 *     - countUnresolvedAlerts 直接 surface 到 unresolved_alerts_count；
 *     - 多用户：默认 scope = 全用户；user_id 指定单 user；
 *     - 体检只生成并持久化快照，不进入外部通知链；
 *   - service.getTodayCheckup() 优先返回今日行 / fallback 最新行 / null；
 *   - getConfig / updateConfig 默认值 / normalize 兼容性。
 */

import {
  DEFAULT_MORNING_RISK_CHECKUP_CONFIG,
  MorningRiskCheckupConfig,
  MorningRiskCheckupDataSource,
  MorningRiskCheckupService,
  CheckupPositionSnapshot,
  CheckupSnapshotRow,
  buildCheckupMessage,
  buildTopIndustries,
  buildTopPositions,
  computeMaxIndustryPct,
  computeMaxSingleStockPct,
  computeWeeklyReturnPct,
  normalizeMorningRiskCheckupConfig,
  UNKNOWN_INDUSTRY_SENTINEL,
} from '../../src/portfolio/risk/MorningRiskCheckupService';
import { MorningRiskCheckup } from '../../src/models/MorningRiskCheckup';

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

interface FakeState {
  userIds: number[];
  configs: Record<number, MorningRiskCheckupConfig>;
  portfolioHeaders: Record<
    number,
    | { id: number; name?: string; total_value: number }
    | Array<{ id: number; name?: string; total_value: number }>
    | null
  >;
  positionsByUser: Record<number, CheckupPositionSnapshot[]>;
  positionsByPortfolio?: Record<number, CheckupPositionSnapshot[]>;
  snapshotsByPortfolio: Record<number, CheckupSnapshotRow[]>;
  alertCountByUser: Record<number, number>;
  /** Captured upsert calls (used for assertions). */
  upserts: Array<{
    user_id: number;
    date: string;
    positions_count: number;
    max_single_pct: number | null;
    max_single_symbol: string | null;
    max_industry_pct: number | null;
    max_industry_name: string | null;
    current_total_value: number | null;
    peak_value: number | null;
    drawdown_pct: number | null;
    weekly_return_pct: number | null;
    unresolved_alerts_count: number;
    breakdown: Record<string, unknown> | null;
    message: string;
    error: string | null;
  }>;
  /** When set to a user_id, upsertCheckup throws (used to test fail-OPEN). */
  upsertShouldThrowForUser?: number;
  /** When set to a user_id, loadOpenPositions throws (per-user isolation test). */
  loadPositionsShouldThrowForUser?: number;
  /** Latest checkup stored by user_id (for getTodayCheckup tests). */
  latestByUser?: Record<number, MorningRiskCheckup | null>;
  /** For-date checkup lookup. */
  forDateByUser?: Record<number, Record<string, MorningRiskCheckup | null>>;
}

function makeFakeSource(state: FakeState): MorningRiskCheckupDataSource {
  return {
    async loadAllUserIdsWithPortfolios() {
      return [...state.userIds];
    },
    async loadConfig(user_id) {
      return state.configs[user_id] ?? { ...DEFAULT_MORNING_RISK_CHECKUP_CONFIG };
    },
    async saveConfig(user_id, config) {
      state.configs[user_id] = { ...config };
      return { ...config };
    },
    async loadPortfolioHeaders(user_id) {
      const header = state.portfolioHeaders[user_id];
      if (header === null) return [];
      const resolved = header ?? { id: 1000 + user_id, total_value: 0 };
      const rows = Array.isArray(resolved) ? resolved : [resolved];
      return rows.map(row => ({ ...row, name: row.name || `测试盘${row.id}` }));
    },
    async loadOpenPositions(portfolio_id) {
      const userEntry = Object.entries(state.portfolioHeaders).find(([, header]) =>
        Array.isArray(header)
          ? header.some(item => item.id === portfolio_id)
          : header?.id === portfolio_id
      );
      const user_id = userEntry ? Number(userEntry[0]) : portfolio_id - 1000;
      if (state.loadPositionsShouldThrowForUser === user_id) {
        throw new Error(`fake DB outage user=${user_id}`);
      }
      return (
        state.positionsByPortfolio?.[portfolio_id] ||
        state.positionsByUser[user_id] ||
        []
      ).map(p => ({ ...p }));
    },
    async loadRecentSnapshots(portfolio_id, _asOfDate, _lookbackDays) {
      return (state.snapshotsByPortfolio[portfolio_id] || []).map(s => ({ ...s }));
    },
    async countUnresolvedAlerts(user_id, _portfolio_id) {
      return state.alertCountByUser[user_id] ?? 0;
    },
    async loadSystemHealthSnapshot(_user_id, _portfolio_id) {
      // 测试默认不注入 system health；如需测试可在某 case 内 monkey-patch
      return state.systemHealthByUser?.[_user_id] ?? null;
    },
    async upsertCheckup(input) {
      if (state.upsertShouldThrowForUser === input.user_id) {
        throw new Error(`fake upsert outage user=${input.user_id}`);
      }
      state.upserts.push({ ...input });
    },
    async loadLatestCheckup(user_id) {
      return state.latestByUser?.[user_id] ?? null;
    },
    async loadCheckupForDate(user_id, date) {
      return state.forDateByUser?.[user_id]?.[date] ?? null;
    },
  };
}

function emptyState(overrides: Partial<FakeState> = {}): FakeState {
  return {
    userIds: [],
    configs: {},
    portfolioHeaders: {},
    positionsByUser: {},
    snapshotsByPortfolio: {},
    alertCountByUser: {},
    upserts: [],
    ...overrides,
  };
}

function makePosition(over: Partial<CheckupPositionSnapshot> = {}): CheckupPositionSnapshot {
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
//  Pure helper tests
// ---------------------------------------------------------------------------

async function testConstants() {
  assertEqual(
    'DEFAULT_MORNING_RISK_CHECKUP_CONFIG values',
    {
      enabled: DEFAULT_MORNING_RISK_CHECKUP_CONFIG.enabled,
      weekly_lookback_days: DEFAULT_MORNING_RISK_CHECKUP_CONFIG.weekly_lookback_days,
      drawdown_lookback_days: DEFAULT_MORNING_RISK_CHECKUP_CONFIG.drawdown_lookback_days,
      include_breakdown_in_message:
        DEFAULT_MORNING_RISK_CHECKUP_CONFIG.include_breakdown_in_message,
    },
    {
      enabled: true,
      weekly_lookback_days: 7,
      drawdown_lookback_days: 365,
      include_breakdown_in_message: true,
    }
  );
  // Object.freeze guard
  let mutated = false;
  try {
    (DEFAULT_MORNING_RISK_CHECKUP_CONFIG as any).enabled = false;
  } catch {
    mutated = true;
  }
  assert(
    'DEFAULT_MORNING_RISK_CHECKUP_CONFIG is frozen',
    Object.isFrozen(DEFAULT_MORNING_RISK_CHECKUP_CONFIG) || mutated
  );
}

async function testNormalize() {
  assertEqual('normalize empty → defaults', normalizeMorningRiskCheckupConfig({}), {
    ...DEFAULT_MORNING_RISK_CHECKUP_CONFIG,
  });
  assertEqual('normalize null → defaults', normalizeMorningRiskCheckupConfig(null), {
    ...DEFAULT_MORNING_RISK_CHECKUP_CONFIG,
  });
  assertEqual(
    'normalize garbage enabled→default true',
    normalizeMorningRiskCheckupConfig({ enabled: 'yes' }).enabled,
    true
  );
  assertEqual(
    'normalize false enabled preserved',
    normalizeMorningRiskCheckupConfig({ enabled: false }).enabled,
    false
  );
  assertEqual(
    'normalize negative days → default',
    normalizeMorningRiskCheckupConfig({ weekly_lookback_days: -5 }).weekly_lookback_days,
    7
  );
  assertEqual(
    'normalize floating days → default',
    normalizeMorningRiskCheckupConfig({ weekly_lookback_days: 3.5 }).weekly_lookback_days,
    7
  );
  assertEqual(
    'normalize custom days preserved',
    normalizeMorningRiskCheckupConfig({ weekly_lookback_days: 14 }).weekly_lookback_days,
    14
  );
  assertEqual(
    'normalize drawdown_lookback_days custom preserved',
    normalizeMorningRiskCheckupConfig({ drawdown_lookback_days: 730 }).drawdown_lookback_days,
    730
  );
  assertEqual(
    'normalize include_breakdown_in_message=false preserved',
    normalizeMorningRiskCheckupConfig({ include_breakdown_in_message: false })
      .include_breakdown_in_message,
    false
  );
}

async function testComputeMaxSingleStockPct() {
  assertEqual('empty positions → null', computeMaxSingleStockPct([]), null);
  // 0 quantity dropped
  assertEqual(
    'all 0 quantity → null',
    computeMaxSingleStockPct([makePosition({ quantity: 0 })]),
    null
  );
  // 1 position → 100%
  const res1 = computeMaxSingleStockPct([
    makePosition({ symbol: 'A', quantity: 100, current_price: 10, market_value: 1000 }),
  ]);
  assertEqual('1 position → 100%', res1, { pct: 1.0, symbol: 'A' });
  // 3 positions with different weights
  const positions = [
    makePosition({ symbol: 'A', quantity: 100, current_price: 10, market_value: 1000 }),
    makePosition({ symbol: 'B', quantity: 100, current_price: 20, market_value: 2000 }),
    makePosition({ symbol: 'C', quantity: 100, current_price: 30, market_value: 3000 }),
  ];
  const res3 = computeMaxSingleStockPct(positions)!;
  assertEqual('top symbol=C', res3.symbol, 'C');
  assertClose('top pct=3000/6000=0.5', res3.pct, 0.5);
  // Tie-break by symbol ASC
  const tie = [
    makePosition({ symbol: 'AAA', quantity: 100, current_price: 10, market_value: 1000 }),
    makePosition({ symbol: 'BBB', quantity: 100, current_price: 10, market_value: 1000 }),
  ];
  const tieRes = computeMaxSingleStockPct(tie)!;
  assertEqual('tie-break symbol AAA wins', tieRes.symbol, 'AAA');
}

async function testComputeMaxIndustryPct() {
  assertEqual('empty positions → null', computeMaxIndustryPct([]), null);
  // 100% one industry
  const single = computeMaxIndustryPct([
    makePosition({ symbol: 'A', industry: '白酒', market_value: 1000 }),
  ])!;
  assertEqual('100% 白酒', single, { pct: 1.0, industry: '白酒' });
  // mixed
  const mixed = computeMaxIndustryPct([
    makePosition({ symbol: 'A', industry: '白酒', market_value: 6000 }),
    makePosition({ symbol: 'B', industry: '银行', market_value: 4000 }),
  ])!;
  assertEqual('top industry 白酒', mixed.industry, '白酒');
  assertClose('top pct 6000/10000=0.6', mixed.pct, 0.6);
  // unknown industry bucket
  const unknown = computeMaxIndustryPct([
    makePosition({ symbol: 'A', industry: null, market_value: 1000 }),
    makePosition({ symbol: 'B', industry: '白酒', market_value: 500 }),
  ])!;
  assertEqual('top industry UNKNOWN', unknown.industry, UNKNOWN_INDUSTRY_SENTINEL);
  assertClose('top pct 1000/1500≈0.667', unknown.pct, 2 / 3);
}

async function testComputeWeeklyReturnPct() {
  const asOf = new Date('2026-06-08T08:30:00.000Z');
  // No snapshots → null
  assertEqual('no snapshots → null', computeWeeklyReturnPct([], 100000, asOf, 7), null);
  // Only snapshots within last 7 days (no baseline) → null
  const recent = [
    { date: '2026-06-05', total_value: 99000 },
    { date: '2026-06-06', total_value: 99500 },
  ];
  assertEqual('all within 7d → null', computeWeeklyReturnPct(recent, 100000, asOf, 7), null);
  // baseline exists at ≥ 7 days ago
  const withBaseline = [
    { date: '2026-05-30', total_value: 95000 }, // 9 days ago
    { date: '2026-06-01', total_value: 96000 }, // 7 days ago — eligible
    { date: '2026-06-05', total_value: 99000 }, // 3 days ago — NOT eligible
  ];
  const ret = computeWeeklyReturnPct(withBaseline, 100000, asOf, 7);
  assertClose('weekly_return (100000-96000)/96000', ret ?? -1, (100000 - 96000) / 96000);
  // Most recent baseline within window wins (most recent ≤ cutoff)
  const recentBaselineWins = [
    { date: '2026-05-30', total_value: 90000 },
    { date: '2026-06-01', total_value: 96000 },
  ];
  const ret2 = computeWeeklyReturnPct(recentBaselineWins, 100000, asOf, 7);
  // baseline picks 06-01=96000 (most recent ≤ 06-01 cutoff)
  assertClose('most recent baseline wins', ret2 ?? -1, (100000 - 96000) / 96000);
  // baseline ≤ 0 → null
  const bad = [{ date: '2026-05-30', total_value: 0 }];
  assertEqual('baseline 0 → null', computeWeeklyReturnPct(bad, 100000, asOf, 7), null);
  // current non-finite → null
  assertEqual('current NaN → null', computeWeeklyReturnPct(withBaseline, NaN, asOf, 7), null);
  // invalid lookback → null
  assertEqual(
    'invalid lookback → null',
    computeWeeklyReturnPct(withBaseline, 100000, asOf, -1),
    null
  );
}

async function testBuildCheckupMessage() {
  const date = '2026-06-08';
  const minimal = buildCheckupMessage({
    date,
    positions_count: 0,
    max_single_pct: null,
    max_single_symbol: null,
    max_industry_pct: null,
    max_industry_name: null,
    drawdown_pct: null,
    weekly_return_pct: null,
    unresolved_alerts_count: 0,
    current_total_value: null,
    include_breakdown: false,
  });
  assert('minimal message contains date', minimal.includes('2026-06-08'));
  assert('minimal message contains 持仓数', minimal.includes('持仓数：0 只'));
  assert('minimal message no breakdown header', !minimal.includes('持仓占比 Top'));
  // long mode with breakdown
  const long = buildCheckupMessage({
    date,
    positions_count: 3,
    max_single_pct: 0.4,
    max_single_symbol: '600519.SH',
    max_industry_pct: 0.5,
    max_industry_name: '白酒',
    drawdown_pct: 0.08,
    weekly_return_pct: 0.025,
    unresolved_alerts_count: 2,
    current_total_value: 500000,
    include_breakdown: true,
    top_positions: [
      { symbol: '600519.SH', pct: 0.4 },
      { symbol: '600036.SH', pct: 0.35 },
      { symbol: '000001.SZ', pct: 0.25 },
    ],
    top_industries: [
      { industry: '白酒', pct: 0.4 },
      { industry: '银行', pct: 0.35 },
      { industry: UNKNOWN_INDUSTRY_SENTINEL, pct: 0.25 },
    ],
  });
  assert('long message contains breakdown header', long.includes('持仓占比 Top 3'));
  assert('long message contains industry header', long.includes('行业占比 Top 3'));
  assert('long message renders UNKNOWN as 未分类', long.includes('未分类'));
  assert('long message contains weekly_return with sign', long.includes('+2.50%'));
  assert('long message contains alerts hint', long.includes('未读告警详情'));
  // negative weekly return
  const negative = buildCheckupMessage({
    date,
    positions_count: 1,
    max_single_pct: 1.0,
    max_single_symbol: 'X',
    max_industry_pct: 1.0,
    max_industry_name: '银行',
    drawdown_pct: 0.05,
    weekly_return_pct: -0.03,
    unresolved_alerts_count: 0,
    current_total_value: 1000,
    include_breakdown: false,
  });
  assert('negative weekly_return rendered with sign', negative.includes('-3.00%'));

  // Phase 2+/4+/5+ system_health 嵌入 message
  const withHealth = buildCheckupMessage({
    date,
    positions_count: 3,
    max_single_pct: 0.3,
    max_single_symbol: 'X',
    max_industry_pct: 0.3,
    max_industry_name: '银行',
    drawdown_pct: 0.02,
    weekly_return_pct: 0.01,
    unresolved_alerts_count: 0,
    current_total_value: 1000,
    include_breakdown: true,
    system_health: {
      sizing_7d_count: 5,
      sizing_7d_hard_count: 2,
      sizing_methods_active: 'kelly,vol_target',
      strategies_disabled_count: 1,
      strategies_with_killswitch: 29,
      strategies_total: 29,
      outcomes_closed_count: 20,
      outcomes_with_root_cause: 18,
      outcomes_with_postmortem: 5,
      root_cause_coverage_pct: 90.0,
    },
  });
  assert('system_health section header rendered', withHealth.includes('系统健康（Phase 2/4/5）'));
  assert('sizing line rendered', withHealth.includes('Sizing：7d 5 决策'));
  assert('sizing hard count rendered', withHealth.includes('2 hard'));
  assert('sizing method tag rendered', withHealth.includes('method=kelly,vol_target'));
  assert('kill_switch disabled warning rendered', withHealth.includes('1/29 策略已禁用'));
  assert(
    'root_cause coverage rendered with green tick',
    withHealth.includes('90.0%') && withHealth.includes('18/20')
  );
  assert('postmortem count rendered', withHealth.includes('5 自动复盘'));

  // system_health 但默认 sizing/kill 不动情况
  const baselineHealth = buildCheckupMessage({
    date,
    positions_count: 1,
    max_single_pct: 1.0,
    max_single_symbol: 'X',
    max_industry_pct: 1.0,
    max_industry_name: '银行',
    drawdown_pct: 0.0,
    weekly_return_pct: 0.0,
    unresolved_alerts_count: 0,
    current_total_value: 1000,
    include_breakdown: true,
    system_health: {
      sizing_7d_count: 0,
      sizing_7d_hard_count: 0,
      sizing_methods_active: '—',
      strategies_disabled_count: 0,
      strategies_with_killswitch: 29,
      strategies_total: 29,
      outcomes_closed_count: 0,
      outcomes_with_root_cause: 0,
      outcomes_with_postmortem: 0,
      root_cause_coverage_pct: 0,
    },
  });
  assert('sizing 0 → equal_pct 默认提示', baselineHealth.includes('仍是 equal_pct 默认'));
  assert('kill_switch 全正常 → 显示无禁用', baselineHealth.includes('全部正常'));
  // 0 闭环时不显示 root_cause 行（避免 0% 看起来像 bug）
  assert('0 closed 时不显示 root_cause 行', !baselineHealth.includes('根因覆盖'));

  // include_breakdown=false 时 system_health 即使传也不显示（紧凑视图）
  const shortHealth = buildCheckupMessage({
    date,
    positions_count: 0,
    max_single_pct: null,
    max_single_symbol: null,
    max_industry_pct: null,
    max_industry_name: null,
    drawdown_pct: null,
    weekly_return_pct: null,
    unresolved_alerts_count: 0,
    current_total_value: null,
    include_breakdown: false,
    system_health: {
      sizing_7d_count: 5,
      sizing_7d_hard_count: 1,
      sizing_methods_active: 'kelly',
      strategies_disabled_count: 0,
      strategies_with_killswitch: 29,
      strategies_total: 29,
      outcomes_closed_count: 10,
      outcomes_with_root_cause: 10,
      outcomes_with_postmortem: 3,
      root_cause_coverage_pct: 100,
    },
  });
  assert('short mode 不渲染 system_health', !shortHealth.includes('系统健康'));
}

async function testBuildTopPositions() {
  assertEqual('empty → []', buildTopPositions([], 3), []);
  const positions = [
    makePosition({ symbol: 'A', market_value: 1000 }),
    makePosition({ symbol: 'B', market_value: 2000 }),
    makePosition({ symbol: 'C', market_value: 3000 }),
    makePosition({ symbol: 'D', market_value: 4000 }),
  ];
  const top3 = buildTopPositions(positions, 3);
  assertEqual(
    'top 3 ordered desc',
    top3.map(p => p.symbol),
    ['D', 'C', 'B']
  );
  assertClose('top D pct=4000/10000=0.4', top3[0].pct, 0.4);
}

async function testBuildTopIndustries() {
  const positions = [
    makePosition({ symbol: 'A', industry: '白酒', market_value: 5000 }),
    makePosition({ symbol: 'B', industry: '银行', market_value: 3000 }),
    makePosition({ symbol: 'C', industry: '科技', market_value: 2000 }),
  ];
  const top = buildTopIndustries(positions, 2);
  assertEqual(
    'top 2 industries',
    top.map(t => t.industry),
    ['白酒', '银行']
  );
  assertClose('top industry 白酒 0.5', top[0].pct, 0.5);
}

// ---------------------------------------------------------------------------
//  End-to-end service tests
// ---------------------------------------------------------------------------

async function testEvaluateHappyPath() {
  const state = emptyState({
    userIds: [42],
    portfolioHeaders: { 42: { id: 1042, total_value: 100000 } },
    positionsByUser: {
      42: [
        makePosition({
          id: 1,
          symbol: '600519.SH',
          industry: '白酒',
          quantity: 100,
          current_price: 100,
          market_value: 10000,
        }),
        makePosition({
          id: 2,
          symbol: '600036.SH',
          industry: '银行',
          quantity: 200,
          current_price: 50,
          market_value: 10000,
        }),
        makePosition({
          id: 3,
          symbol: '000001.SZ',
          industry: '银行',
          quantity: 100,
          current_price: 200,
          market_value: 20000,
        }),
      ],
    },
    snapshotsByPortfolio: {
      1042: [
        { date: '2026-05-30', total_value: 110000 }, // ≥ 7d ago — baseline
        { date: '2026-06-05', total_value: 105000 },
      ],
    },
    alertCountByUser: { 42: 3 },
  });
  const svc = new MorningRiskCheckupService(makeFakeSource(state));
  const asOf = new Date('2026-06-08T00:30:00.000Z');
  const result = await svc.runMorningCheckup({ asOfDate: asOf });
  assertEqual('scanned_users=1', result.scanned_users, 1);
  assertEqual('checked_users=1', result.checked_users, 1);
  assertEqual('per_user length 1', result.per_user.length, 1);
  const u = result.per_user[0];
  assertEqual('positions_count=3', u.positions_count, 3);
  // total mv = 40000; top single = 000001.SZ 20000 → 0.5
  assertClose('max_single_pct=0.5', u.max_single_pct ?? -1, 0.5);
  assertEqual('max_single_symbol=000001.SZ', u.max_single_symbol, '000001.SZ');
  // industries: 银行 30000 / 白酒 10000 → top 银行 0.75
  assertClose('max_industry_pct=0.75', u.max_industry_pct ?? -1, 0.75);
  assertEqual('max_industry_name=银行', u.max_industry_name, '银行');
  // drawdown: peak = max(110000, 105000, 100000) = 110000; current 100000 → 0.0909
  assertClose('drawdown_pct ≈ 0.0909', u.drawdown_pct ?? -1, (110000 - 100000) / 110000);
  // weekly_return: baseline 110000 (most recent ≤ cutoff at 2026-06-01) → (100000-110000)/110000 ≈ -0.0909
  assertClose('weekly_return ≈ -0.0909', u.weekly_return_pct ?? -1, (100000 - 110000) / 110000);
  assertEqual('unresolved=3', u.unresolved_alerts_count, 3);
  assertEqual('persisted=true', u.persisted, true);
  assertEqual('upsert called once', state.upserts.length, 1);
  assertEqual('upsert.date=2026-06-08', state.upserts[0].date, '2026-06-08');
  assert('upsert.message contains industry', state.upserts[0].message.includes('行业最大占比'));
}

async function testSnapshotPersistenceIsNotificationFree() {
  const state = emptyState({
    userIds: [42],
    portfolioHeaders: { 42: { id: 1042, total_value: 100000 } },
    positionsByUser: { 42: [] },
    snapshotsByPortfolio: {},
    alertCountByUser: { 42: 0 },
  });
  const svc = new MorningRiskCheckupService(makeFakeSource(state));
  const result = await svc.runMorningCheckup({
    asOfDate: new Date('2026-06-08T00:30:00.000Z'),
  });
  assertEqual('morning checkup persists one snapshot', state.upserts.length, 1);
  assertEqual('morning checkup result is persisted', result.per_user[0].persisted, true);
  assert(
    'morning checkup result has no delivery state',
    !('notification_status' in result.per_user[0]) &&
      !('notification_outbox_id' in result.per_user[0])
  );

  await svc.runMorningCheckup({
    asOfDate: new Date('2026-06-09T00:30:00.000Z'),
    dry_run: true,
  });
  assertEqual('morning checkup dry_run does not persist', state.upserts.length, 1);
}

async function testEvaluateEmptyPortfolio() {
  const state = emptyState({
    userIds: [7],
    portfolioHeaders: { 7: { id: 1007, total_value: 200000 } },
    positionsByUser: { 7: [] },
    snapshotsByPortfolio: {},
    alertCountByUser: { 7: 0 },
  });
  const svc = new MorningRiskCheckupService(makeFakeSource(state));
  const result = await svc.runMorningCheckup();
  const u = result.per_user[0];
  assertEqual('0 positions', u.positions_count, 0);
  assertEqual('max_single_pct null', u.max_single_pct, null);
  assertEqual('max_industry_pct null', u.max_industry_pct, null);
  // peak = max(0, current=200000) = 200000; current >= peak → drawdown_pct=0 then null clamp
  // since peak_value > 0, drawdown_pct shows 0 (not null)
  assertEqual('drawdown_pct=0 not null when peak > 0', u.drawdown_pct, 0);
  assertEqual('peak_value=200000', u.peak_value, 200000);
}

async function testEvaluateNewAccountWithinWeek() {
  // Snapshots all WITHIN 7 days → no baseline → weekly_return=null
  const state = emptyState({
    userIds: [9],
    portfolioHeaders: { 9: { id: 1009, total_value: 100000 } },
    positionsByUser: { 9: [makePosition({ symbol: 'A', market_value: 50000 })] },
    snapshotsByPortfolio: {
      1009: [
        { date: '2026-06-05', total_value: 95000 },
        { date: '2026-06-06', total_value: 97000 },
      ],
    },
    alertCountByUser: { 9: 0 },
  });
  const svc = new MorningRiskCheckupService(makeFakeSource(state));
  const result = await svc.runMorningCheckup({ asOfDate: new Date('2026-06-08T00:00:00.000Z') });
  const u = result.per_user[0];
  assertEqual('weekly_return_pct null (snapshot < 7d)', u.weekly_return_pct, null);
}

async function testEvaluateDryRun() {
  const state = emptyState({
    userIds: [55],
    portfolioHeaders: { 55: { id: 1055, total_value: 80000 } },
    positionsByUser: { 55: [makePosition({ symbol: 'X', market_value: 40000 })] },
    snapshotsByPortfolio: {},
    alertCountByUser: { 55: 1 },
  });
  const svc = new MorningRiskCheckupService(makeFakeSource(state));
  const result = await svc.runMorningCheckup({ dry_run: true });
  assertEqual('dry_run flag forwarded', result.dry_run, true);
  assertEqual('no upserts in dry_run', state.upserts.length, 0);
  const u = result.per_user[0];
  // dry_run still counts as "checked" — checked_users tracks "we ran the calc"
  assertEqual('dry_run still checked=1', result.checked_users, 1);
  // persisted=false in dry_run because nothing was written
  assertEqual('persisted=false in dry_run', u.persisted, false);
  // result still has the computed message
  assert('dry_run message still populated', u.message.length > 0);
}

async function testEvaluateDisabledUser() {
  const state = emptyState({
    userIds: [88],
    configs: {
      88: {
        ...DEFAULT_MORNING_RISK_CHECKUP_CONFIG,
        enabled: false,
      },
    },
    portfolioHeaders: { 88: { id: 1088, total_value: 100000 } },
    positionsByUser: { 88: [makePosition({ symbol: 'X', market_value: 50000 })] },
    snapshotsByPortfolio: {},
    alertCountByUser: { 88: 5 },
  });
  const svc = new MorningRiskCheckupService(makeFakeSource(state));
  const result = await svc.runMorningCheckup();
  const u = result.per_user[0];
  assertEqual('disabled user enabled=false', u.enabled, false);
  assertEqual('disabled user persisted=false', u.persisted, false);
  assertEqual('disabled user no upsert', state.upserts.length, 0);
  // positions_count still 0 in disabled response — we don't compute when disabled
  assertEqual('disabled user positions_count=0', u.positions_count, 0);
}

async function testEvaluateNoPortfolio() {
  const state = emptyState({
    userIds: [11],
    portfolioHeaders: { 11: null },
    positionsByUser: {},
    snapshotsByPortfolio: {},
  });
  const svc = new MorningRiskCheckupService(makeFakeSource(state));
  const result = await svc.runMorningCheckup();
  assertEqual('no portfolio → no result rows', result.per_user.length, 0);
  assertEqual('no portfolio → no upsert', state.upserts.length, 0);
}

async function testEvaluateUpsertFailureFailOpen() {
  const state = emptyState({
    userIds: [777],
    portfolioHeaders: { 777: { id: 7777, total_value: 100000 } },
    positionsByUser: { 777: [makePosition({ symbol: 'A', market_value: 50000 })] },
    snapshotsByPortfolio: {},
    alertCountByUser: { 777: 0 },
    upsertShouldThrowForUser: 777,
  });
  const svc = new MorningRiskCheckupService(makeFakeSource(state));
  const result = await svc.runMorningCheckup();
  const u = result.per_user[0];
  // result is still returned with error message even when persistence fails
  assert('error message captured', !!u.error);
  assertEqual('persisted=false on failure', u.persisted, false);
  // message still rendered
  assert('message still populated despite failure', u.message.length > 0);
}

async function testEvaluateMultiUserIsolation() {
  const state = emptyState({
    userIds: [1, 2, 3],
    portfolioHeaders: {
      1: { id: 1001, total_value: 50000 },
      2: { id: 1002, total_value: 60000 },
      3: { id: 1003, total_value: 70000 },
    },
    positionsByUser: {
      1: [makePosition({ symbol: 'A', market_value: 30000 })],
      2: [makePosition({ symbol: 'B', market_value: 40000 })],
      3: [makePosition({ symbol: 'C', market_value: 50000 })],
    },
    snapshotsByPortfolio: {},
    alertCountByUser: { 1: 0, 2: 1, 3: 2 },
    loadPositionsShouldThrowForUser: 2, // user 2's positions load throws
  });
  const svc = new MorningRiskCheckupService(makeFakeSource(state));
  const result = await svc.runMorningCheckup();
  assertEqual('scanned 3 users', result.scanned_users, 3);
  assertEqual('per_user 3 rows', result.per_user.length, 3);
  // user 2 error captured
  const u2 = result.per_user.find(u => u.user_id === 2)!;
  assert('user 2 error captured', !!u2.error);
  assertEqual('user 2 persisted=false', u2.persisted, false);
  // user 1 and 3 still persisted
  const u1 = result.per_user.find(u => u.user_id === 1)!;
  assertEqual('user 1 persisted=true', u1.persisted, true);
  const u3 = result.per_user.find(u => u.user_id === 3)!;
  assertEqual('user 3 persisted=true', u3.persisted, true);
  assertEqual('2 upserts (user 1 + 3)', state.upserts.length, 2);
}

async function testEvaluateOneUserMultiplePortfolios() {
  const state = emptyState({
    userIds: [42],
    portfolioHeaders: {
      42: [
        { id: 1042, name: '主盘', total_value: 100000 },
        { id: 2042, name: '空盘', total_value: 200000 },
      ],
    },
    positionsByUser: {},
    positionsByPortfolio: {
      1042: [makePosition({ portfolio_id: 1042, symbol: 'A', market_value: 50000 })],
      2042: [],
    },
    snapshotsByPortfolio: {
      1042: [{ date: '2026-06-01', total_value: 95000 }],
      2042: [{ date: '2026-06-01', total_value: 200000 }],
    },
  });
  const svc = new MorningRiskCheckupService(makeFakeSource(state));
  const result = await svc.runMorningCheckup({
    asOfDate: new Date('2026-06-08T00:30:00.000Z'),
  });
  assertEqual('multi-account creates two independent rows', result.per_user.length, 2);
  assertEqual('multi-account creates two upserts', state.upserts.length, 2);
  assertEqual(
    'multi-account values never aggregate',
    result.per_user.map(row => row.current_total_value),
    [100000, 200000]
  );
  assert('first snapshot identifies its portfolio', result.per_user[0].message.includes('主盘'));
  assert('second snapshot identifies its portfolio', result.per_user[1].message.includes('空盘'));
}

async function testEvaluateSingleUserScope() {
  const state = emptyState({
    userIds: [10, 20, 30], // 3 users in DB
    portfolioHeaders: {
      10: { id: 1010, total_value: 10000 },
      20: { id: 1020, total_value: 20000 },
      30: { id: 1030, total_value: 30000 },
    },
    positionsByUser: {},
    snapshotsByPortfolio: {},
  });
  const svc = new MorningRiskCheckupService(makeFakeSource(state));
  const result = await svc.runMorningCheckup({ user_id: 20 });
  assertEqual('scanned 1 user (scope=20)', result.scanned_users, 1);
  assertEqual('per_user 20 only', result.per_user[0].user_id, 20);
}

async function testGetTodayCheckup() {
  const todayIso = new Date().toISOString().slice(0, 10);
  const todayRow = { id: 1, date: todayIso } as MorningRiskCheckup;
  const olderRow = { id: 2, date: '2026-05-01' } as MorningRiskCheckup;
  const state = emptyState({
    userIds: [],
    latestByUser: { 1: olderRow, 2: null, 3: olderRow },
    forDateByUser: {
      1: { [todayIso]: todayRow },
      // user 2 has no today row, latest also null → expect null
      // user 3 has no today row, latest=olderRow → expect olderRow
    },
  });
  const svc = new MorningRiskCheckupService(makeFakeSource(state));
  const u1 = await svc.getTodayCheckup(1);
  assertEqual('user 1 returns today row', u1?.id, 1);
  const u2 = await svc.getTodayCheckup(2);
  assertEqual('user 2 returns null when never checked', u2, null);
  const u3 = await svc.getTodayCheckup(3);
  assertEqual('user 3 returns older row as fallback', u3?.id, 2);
}

async function testGetConfigUpdateConfigRoundTrip() {
  const state = emptyState({ userIds: [42] });
  const svc = new MorningRiskCheckupService(makeFakeSource(state));
  // Initial config = default
  const initial = await svc.getConfig(42);
  assertEqual('initial enabled=true', initial.enabled, true);
  assertEqual('initial weekly_lookback_days=7', initial.weekly_lookback_days, 7);
  // Update
  const saved = await svc.updateConfig(42, {
    enabled: false,
    weekly_lookback_days: 30,
    include_breakdown_in_message: false,
  });
  assertEqual('saved enabled=false', saved.enabled, false);
  assertEqual('saved weekly_lookback_days=30', saved.weekly_lookback_days, 30);
  assertEqual('saved include_breakdown=false', saved.include_breakdown_in_message, false);
  // Roundtrip — getConfig now reflects update
  const after = await svc.getConfig(42);
  assertEqual('after enabled=false', after.enabled, false);
  assertEqual('after weekly_lookback_days=30', after.weekly_lookback_days, 30);
  // Garbage input → silently revert to defaults (not 4xx)
  const sanitized = await svc.updateConfig(42, {
    enabled: 'maybe',
    weekly_lookback_days: -5,
    drawdown_lookback_days: 'a year',
    include_breakdown_in_message: 1,
  });
  assertEqual('garbage enabled→default true', sanitized.enabled, true);
  assertEqual('garbage weekly_lookback_days→default 7', sanitized.weekly_lookback_days, 7);
  assertEqual('garbage drawdown_lookback_days→default 365', sanitized.drawdown_lookback_days, 365);
  assertEqual(
    'garbage include_breakdown_in_message→default true',
    sanitized.include_breakdown_in_message,
    true
  );
}

async function testNoSnapshotsDrawdownStillComputed() {
  // No snapshots — peak = current → drawdown = 0 (not null since peak > 0)
  const state = emptyState({
    userIds: [5],
    portfolioHeaders: { 5: { id: 1005, total_value: 100000 } },
    positionsByUser: { 5: [makePosition({ symbol: 'A', market_value: 50000 })] },
    snapshotsByPortfolio: { 1005: [] },
    alertCountByUser: { 5: 0 },
  });
  const svc = new MorningRiskCheckupService(makeFakeSource(state));
  const result = await svc.runMorningCheckup();
  const u = result.per_user[0];
  assertEqual('drawdown=0 with no snapshots + peak>0', u.drawdown_pct, 0);
  assertEqual('peak=100000', u.peak_value, 100000);
}

async function testZeroPortfolioPeak() {
  // total_value = 0 → peak = 0 → drawdown null
  const state = emptyState({
    userIds: [99],
    portfolioHeaders: { 99: { id: 1099, total_value: 0 } },
    positionsByUser: { 99: [] },
    snapshotsByPortfolio: {},
    alertCountByUser: { 99: 0 },
  });
  const svc = new MorningRiskCheckupService(makeFakeSource(state));
  const result = await svc.runMorningCheckup();
  const u = result.per_user[0];
  assertEqual('drawdown null when peak=0', u.drawdown_pct, null);
  assertEqual('peak_value null when 0', u.peak_value, null);
}

// ---------------------------------------------------------------------------
//  Main runner
// ---------------------------------------------------------------------------

async function main() {
  await testConstants();
  await testNormalize();
  await testComputeMaxSingleStockPct();
  await testComputeMaxIndustryPct();
  await testComputeWeeklyReturnPct();
  await testBuildCheckupMessage();
  await testBuildTopPositions();
  await testBuildTopIndustries();

  await testEvaluateHappyPath();
  await testSnapshotPersistenceIsNotificationFree();
  await testEvaluateEmptyPortfolio();
  await testEvaluateNewAccountWithinWeek();
  await testEvaluateDryRun();
  await testEvaluateDisabledUser();
  await testEvaluateNoPortfolio();
  await testEvaluateUpsertFailureFailOpen();
  await testEvaluateMultiUserIsolation();
  await testEvaluateOneUserMultiplePortfolios();
  await testEvaluateSingleUserScope();
  await testNoSnapshotsDrawdownStillComputed();
  await testZeroPortfolioPeak();

  await testGetTodayCheckup();
  await testGetConfigUpdateConfigRoundTrip();

  console.log(`\n${passed} ok, ${failed} failed`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch(err => {
  console.error('TEST RUNNER CRASHED:', err);
  process.exitCode = 1;
});
