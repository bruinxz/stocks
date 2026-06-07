/**
 * PerStockStopLossGuard 单元测试 (US-051)
 *
 * 不依赖 jest；node 直接跑：
 *   cd backend && npx ts-node --transpile-only tests/risk/per-stock-stop-loss-guard.test.ts
 *
 * 完全脱离 DB：注入 fake PerStockStopLossDataSource。
 *
 * 覆盖维度：
 *   - 常量校验：DEFAULT_PER_STOCK_STOP_LOSS_CONFIG + PER_STOCK_STOP_LOSS_MASS_SYMBOL
 *   - 纯函数：
 *     pickEffectivePct / computeLossRatio / evaluatePerStockStopLossTrigger /
 *     evaluateMassTrigger / normalizePerStockStopLossConfig /
 *     buildPerStockStopLossMessage / buildMassTriggerMessage
 *   - guard.evaluateAfterClose() end-to-end：
 *     - happy path：1 持仓亏损 -8% 触发；2 持仓 1 亏 -3% / 1 亏 -10% 仅后者触发；
 *     - per-position stop_loss_pct 覆盖（紧 5% 让 -6% 触发；松 15% 让 -8% 不触发）
 *     - DailyBar 缺当日数据 → skipped_no_bar
 *     - avg_cost ≤ 0 → skipped_bad_cost（除零保护）
 *     - quantity ≤ 0 → skipped_no_quantity
 *     - 禁用 user → 全持仓 no_trigger 且不写任何 alert
 *     - 边界 loss_ratio == -pct → 触发（≤ 包含 boundary）
 *   - mass-trigger 50% 阈值：
 *     - 2 仓位中 1 触发 → mass（Math.ceil(2×0.5)=1，1≥1）
 *     - 3 仓位中 1 触发 → 非 mass（Math.ceil(3×0.5)=2，1<2）
 *     - 3 仓位中 2 触发 → mass
 *     - 4 仓位中 2 触发 → mass
 *     - 5 仓位中 2 触发 → 非 mass（Math.ceil(5×0.5)=3，2<3）
 *     - 0 仓位 → 非 mass（防御性除零）
 *     - 自定义 threshold_ratio=0.3 → 1/3 触发即 mass
 *   - 告警写入：
 *     - 个股触发写 RiskAlert(symbol=持仓 symbol)
 *     - mass 触发额外写 RiskAlert(symbol='SYSTEM:PER_STOCK_STOP_LOSS_MASS')
 *     - dry_run=true 不写任何 alert 但 trigger / per_user / level 仍返回
 *     - writeAlert 失败不应该掩盖 trigger
 *   - 多用户：
 *     - 单 user loadOpenPositions 失败 try/catch 隔离不阻塞其他 user
 *     - 默认 scope = 全用户；user_id 指定单 user
 *   - getConfig / updateConfig：
 *     - 默认值落地
 *     - normalize 兼容性（>1 / 负 / NaN pct → 退回默认；非 boolean enabled → 默认）
 *     - mass_threshold_ratio normalize 同款
 */

import {
  DEFAULT_PER_STOCK_STOP_LOSS_CONFIG,
  PER_STOCK_STOP_LOSS_MASS_SYMBOL,
  PerStockStopLossConfig,
  PerStockStopLossDataSource,
  PerStockStopLossGuard,
  PositionSnapshot,
  buildMassTriggerMessage,
  buildPerStockStopLossMessage,
  computeLossRatio,
  evaluateMassTrigger,
  evaluatePerStockStopLossTrigger,
  normalizePerStockStopLossConfig,
  pickEffectivePct,
} from '../../src/portfolio/risk/PerStockStopLossGuard';

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
  configs: Record<number, PerStockStopLossConfig>;
  portfolioIds: Record<number, number | null>;
  positionsByUser: Record<number, PositionSnapshot[]>;
  /** Map<symbol, { close, date }> — fake returns this for loadLatestClose. */
  bars: Record<string, { close: number; date: Date } | null>;
  /** RiskAlerts written via writeAlert. */
  alerts: Array<{ user_id: number; symbol: string; name: string; message: string }>;
  /** If set, loadOpenPositions on the matching user throws. */
  loadPositionsShouldThrowForUser?: number;
  /** If true, writeAlert throws. */
  writeAlertShouldThrow?: boolean;
}

function makeFakeSource(state: FakeState): PerStockStopLossDataSource {
  return {
    async loadAllUserIdsWithPortfolios() {
      return [...state.userIds];
    },
    async loadConfig(user_id) {
      return state.configs[user_id] ?? { ...DEFAULT_PER_STOCK_STOP_LOSS_CONFIG };
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
    async loadLatestClose(symbol) {
      return state.bars[symbol] ?? null;
    },
    async writeAlert(input) {
      if (state.writeAlertShouldThrow) {
        throw new Error('fake alert outage');
      }
      state.alerts.push({ ...input });
    },
  };
}

function emptyState(overrides: Partial<FakeState> = {}): FakeState {
  return {
    userIds: [],
    configs: {},
    portfolioIds: {},
    positionsByUser: {},
    bars: {},
    alerts: [],
    ...overrides,
  };
}

function makePosition(over: Partial<PositionSnapshot> = {}): PositionSnapshot {
  return {
    id: 1,
    portfolio_id: 1001,
    symbol: '600519.SH',
    name: '贵州茅台',
    quantity: 100,
    avg_cost: 100,
    current_price: 100,
    stop_loss_pct: null,
    ...over,
  };
}

// ---------------------------------------------------------------------------
//  Tests — constants
// ---------------------------------------------------------------------------

async function testConstants() {
  assertEqual('DEFAULT enabled == true', DEFAULT_PER_STOCK_STOP_LOSS_CONFIG.enabled, true);
  assertEqual('DEFAULT pct == 0.07', DEFAULT_PER_STOCK_STOP_LOSS_CONFIG.pct, 0.07);
  assertEqual(
    'DEFAULT mass_threshold_ratio == 0.5',
    DEFAULT_PER_STOCK_STOP_LOSS_CONFIG.mass_threshold_ratio,
    0.5
  );
  assertEqual(
    'MASS sentinel symbol = SYSTEM:PER_STOCK_STOP_LOSS_MASS',
    PER_STOCK_STOP_LOSS_MASS_SYMBOL,
    'SYSTEM:PER_STOCK_STOP_LOSS_MASS'
  );
  // 防御性：默认对象应不可 mutate
  let mutationThrew = false;
  try {
    (DEFAULT_PER_STOCK_STOP_LOSS_CONFIG as any).pct = 0.99;
  } catch {
    mutationThrew = true;
  }
  assert(
    'DEFAULT is frozen (strict throws OR silent no-op)',
    mutationThrew || DEFAULT_PER_STOCK_STOP_LOSS_CONFIG.pct === 0.07
  );
  assertEqual(
    'DEFAULT.pct after attempted mutation still == 0.07',
    DEFAULT_PER_STOCK_STOP_LOSS_CONFIG.pct,
    0.07
  );
}

// ---------------------------------------------------------------------------
//  Tests — pure helpers
// ---------------------------------------------------------------------------

async function testPickEffectivePct() {
  // Position pct valid → wins
  assertEqual('pick: position 0.05 wins over user 0.07', pickEffectivePct(0.05, 0.07), 0.05);
  // Position pct invalid → fall to user
  assertEqual('pick: position null → user 0.10', pickEffectivePct(null, 0.1), 0.1);
  assertEqual('pick: position undefined → user 0.10', pickEffectivePct(undefined, 0.1), 0.1);
  assertEqual('pick: position NaN → user 0.10', pickEffectivePct(NaN, 0.1), 0.1);
  assertEqual('pick: position -0.05 → user 0.10', pickEffectivePct(-0.05, 0.1), 0.1);
  assertEqual('pick: position 1.5 → user 0.10', pickEffectivePct(1.5, 0.1), 0.1);
  // User pct invalid → fall to DEFAULT (0.07)
  assertEqual('pick: both null → DEFAULT 0.07', pickEffectivePct(null, null), 0.07);
  assertEqual('pick: user NaN → DEFAULT 0.07', pickEffectivePct(null, NaN), 0.07);
  assertEqual('pick: user 2.0 → DEFAULT 0.07', pickEffectivePct(null, 2.0), 0.07);
  // Boundary
  assertEqual('pick: position 0 honored', pickEffectivePct(0, 0.07), 0);
  assertEqual('pick: position 1 honored', pickEffectivePct(1, 0.07), 1);
}

async function testComputeLossRatio() {
  // 正常：close=92, cost=100 → -0.08
  assertClose('loss: close 92 / cost 100 → -0.08', computeLossRatio(92, 100)!, -0.08);
  // 盈利：close=110, cost=100 → 0.10
  assertClose('loss: close 110 / cost 100 → +0.10', computeLossRatio(110, 100)!, 0.1);
  // 持平：close=100, cost=100 → 0
  assertClose('loss: close == cost → 0', computeLossRatio(100, 100)!, 0);
  // avg_cost ≤ 0 → null
  assertEqual('loss: avg_cost = 0 → null', computeLossRatio(90, 0), null);
  assertEqual('loss: avg_cost = -10 → null', computeLossRatio(90, -10), null);
  assertEqual('loss: avg_cost NaN → null', computeLossRatio(90, NaN), null);
  // close NaN → null
  assertEqual('loss: close NaN → null', computeLossRatio(NaN, 100), null);
}

async function testEvaluateTrigger() {
  // loss -8% ≤ -7% → triggered
  assertEqual('trigger: -0.08 ≤ -0.07 → true', evaluatePerStockStopLossTrigger(-0.08, 0.07), true);
  // loss -7% ≤ -7% → triggered (boundary)
  assertEqual(
    'trigger: -0.07 == -0.07 → true (boundary ≤)',
    evaluatePerStockStopLossTrigger(-0.07, 0.07),
    true
  );
  // loss -6% > -7% → not triggered
  assertEqual(
    'trigger: -0.06 > -0.07 → false',
    evaluatePerStockStopLossTrigger(-0.06, 0.07),
    false
  );
  // gain → not triggered
  assertEqual('trigger: +0.10 → false', evaluatePerStockStopLossTrigger(0.1, 0.07), false);
  // null loss → false
  assertEqual('trigger: null loss → false', evaluatePerStockStopLossTrigger(null, 0.07), false);
  // pct = 0 → false (永远不触发)
  assertEqual('trigger: pct 0 → false', evaluatePerStockStopLossTrigger(-0.5, 0), false);
  // pct negative → false
  assertEqual('trigger: pct -0.1 → false', evaluatePerStockStopLossTrigger(-0.5, -0.1), false);
  // pct NaN → false
  assertEqual('trigger: pct NaN → false', evaluatePerStockStopLossTrigger(-0.5, NaN), false);
}

async function testEvaluateMassTrigger() {
  // 2 仓位中 1 触发 → mass (ceil(2*0.5)=1, 1≥1)
  assertEqual('mass: 1/2 @ 50% → true', evaluateMassTrigger(1, 2, 0.5), true);
  // 3 仓位中 1 触发 → 非 mass (ceil(3*0.5)=2, 1<2)
  assertEqual('mass: 1/3 @ 50% → false', evaluateMassTrigger(1, 3, 0.5), false);
  // 3 仓位中 2 触发 → mass
  assertEqual('mass: 2/3 @ 50% → true', evaluateMassTrigger(2, 3, 0.5), true);
  // 4 仓位中 2 触发 → mass
  assertEqual('mass: 2/4 @ 50% → true', evaluateMassTrigger(2, 4, 0.5), true);
  // 5 仓位中 2 触发 → 非 mass (ceil(5*0.5)=3, 2<3)
  assertEqual('mass: 2/5 @ 50% → false', evaluateMassTrigger(2, 5, 0.5), false);
  // 5 仓位中 3 触发 → mass
  assertEqual('mass: 3/5 @ 50% → true', evaluateMassTrigger(3, 5, 0.5), true);
  // 10 仓位中 5 触发 → mass
  assertEqual('mass: 5/10 @ 50% → true', evaluateMassTrigger(5, 10, 0.5), true);
  // 10 仓位中 4 触发 → 非 mass
  assertEqual('mass: 4/10 @ 50% → false', evaluateMassTrigger(4, 10, 0.5), false);

  // 0 仓位 → false（防御）
  assertEqual('mass: 0 open → false', evaluateMassTrigger(0, 0, 0.5), false);
  // 触发数 0 → false
  assertEqual('mass: 0 triggered → false', evaluateMassTrigger(0, 5, 0.5), false);
  // open_count 负 → false
  assertEqual('mass: open=-1 → false', evaluateMassTrigger(1, -1, 0.5), false);

  // 自定义 threshold 0.3：1/3 → mass (ceil(3*0.3)=1, 1≥1)
  assertEqual('mass: 1/3 @ 30% → true', evaluateMassTrigger(1, 3, 0.3), true);
  // 自定义 threshold 0.8：4/5 → mass (ceil(5*0.8)=4)
  assertEqual('mass: 4/5 @ 80% → true', evaluateMassTrigger(4, 5, 0.8), true);
  // 自定义 threshold 1.0：4/5 → 非 mass (ceil(5*1)=5)
  assertEqual('mass: 4/5 @ 100% → false', evaluateMassTrigger(4, 5, 1.0), false);
  assertEqual('mass: 5/5 @ 100% → true', evaluateMassTrigger(5, 5, 1.0), true);

  // threshold 0 → 任一触发都 mass（ceil(N*0)=0, threshold=0）
  assertEqual('mass: 1/5 @ 0% → true', evaluateMassTrigger(1, 5, 0), true);
  // threshold > 1 → 永远不 mass
  assertEqual('mass: 5/5 @ 200% → false', evaluateMassTrigger(5, 5, 2), false);
}

async function testNormalize() {
  assertEqual('normalize: empty → defaults', normalizePerStockStopLossConfig({}), {
    ...DEFAULT_PER_STOCK_STOP_LOSS_CONFIG,
  });
  assertEqual('normalize: null → defaults', normalizePerStockStopLossConfig(null), {
    ...DEFAULT_PER_STOCK_STOP_LOSS_CONFIG,
  });
  assertEqual('normalize: undefined → defaults', normalizePerStockStopLossConfig(undefined), {
    ...DEFAULT_PER_STOCK_STOP_LOSS_CONFIG,
  });
  assertEqual(
    'normalize: enabled=false respected',
    normalizePerStockStopLossConfig({ enabled: false, pct: 0.05, mass_threshold_ratio: 0.3 }),
    { enabled: false, pct: 0.05, mass_threshold_ratio: 0.3 }
  );
  assertEqual(
    'normalize: enabled non-boolean → default true',
    normalizePerStockStopLossConfig({ enabled: 'yes' }).enabled,
    DEFAULT_PER_STOCK_STOP_LOSS_CONFIG.enabled
  );
  assertEqual(
    'normalize: pct -0.1 → default 0.07',
    normalizePerStockStopLossConfig({ pct: -0.1 }).pct,
    DEFAULT_PER_STOCK_STOP_LOSS_CONFIG.pct
  );
  assertEqual(
    'normalize: pct 1.5 → default 0.07',
    normalizePerStockStopLossConfig({ pct: 1.5 }).pct,
    DEFAULT_PER_STOCK_STOP_LOSS_CONFIG.pct
  );
  assertEqual(
    'normalize: pct NaN → default 0.07',
    normalizePerStockStopLossConfig({ pct: NaN }).pct,
    DEFAULT_PER_STOCK_STOP_LOSS_CONFIG.pct
  );
  assertEqual(
    'normalize: pct 0 honored',
    normalizePerStockStopLossConfig({ pct: 0 }).pct,
    0
  );
  assertEqual(
    'normalize: pct 1 honored',
    normalizePerStockStopLossConfig({ pct: 1 }).pct,
    1
  );
  assertEqual(
    'normalize: pct string "0.05" coerced',
    normalizePerStockStopLossConfig({ pct: '0.05' }).pct,
    0.05
  );
  // mass_threshold_ratio normalization
  assertEqual(
    'normalize: mass_threshold_ratio -0.1 → default 0.5',
    normalizePerStockStopLossConfig({ mass_threshold_ratio: -0.1 }).mass_threshold_ratio,
    DEFAULT_PER_STOCK_STOP_LOSS_CONFIG.mass_threshold_ratio
  );
  assertEqual(
    'normalize: mass_threshold_ratio 2.0 → default 0.5',
    normalizePerStockStopLossConfig({ mass_threshold_ratio: 2.0 }).mass_threshold_ratio,
    DEFAULT_PER_STOCK_STOP_LOSS_CONFIG.mass_threshold_ratio
  );
  assertEqual(
    'normalize: mass_threshold_ratio 0.3 honored',
    normalizePerStockStopLossConfig({ mass_threshold_ratio: 0.3 }).mass_threshold_ratio,
    0.3
  );
}

async function testBuildPerStockStopLossMessage() {
  const msg = buildPerStockStopLossMessage({
    symbol: '600519.SH',
    today_close: 92.0,
    avg_cost: 100.0,
    loss_ratio: -0.08,
    effective_pct: 0.07,
  });
  assert('per-stock msg includes symbol', msg.includes('600519.SH'));
  assert('per-stock msg includes close', msg.includes('92.000'));
  assert('per-stock msg includes cost', msg.includes('100.000'));
  assert('per-stock msg includes loss pct', msg.includes('-8.00%'));
  assert('per-stock msg includes threshold pct', msg.includes('-7.00%'));
}

async function testBuildMassTriggerMessage() {
  const msg = buildMassTriggerMessage({
    triggered_count: 3,
    open_count: 5,
    threshold_ratio: 0.5,
  });
  assert('mass msg includes triggered count', msg.includes('3'));
  assert('mass msg includes open count', msg.includes('5'));
  assert('mass msg includes ratio percentage', msg.includes('60.00%')); // 3/5=60%
  assert('mass msg includes threshold percentage', msg.includes('50.00%'));
  assert('mass msg mentions LEVEL_2', msg.includes('LEVEL_2'));
}

// ---------------------------------------------------------------------------
//  Tests — guard.evaluateAfterClose end-to-end
// ---------------------------------------------------------------------------

async function testHappyPathSingleTrigger() {
  // 1 持仓 -8% → triggered，未达 mass（1 仓位中 1 触发，ceil(1*0.5)=1 → mass！）
  // 但 mass 阈值要求 triggered ≥ ceil(open*0.5) ⇒ 1 ≥ 1 → mass
  // 写一组持仓更具说服力：2 持仓中 1 触发（-8%）/ 1 不触发（+5%）→ INDIVIDUAL
  const state = emptyState({
    userIds: [1],
    configs: { 1: { enabled: true, pct: 0.07, mass_threshold_ratio: 0.5 } },
    positionsByUser: {
      1: [
        makePosition({ id: 1, symbol: 'A.SH', avg_cost: 100 }),
        makePosition({ id: 2, symbol: 'B.SH', avg_cost: 50 }),
      ],
    },
    bars: {
      'A.SH': { close: 92, date: new Date('2026-06-07') }, // -8% triggers
      'B.SH': { close: 52.5, date: new Date('2026-06-07') }, // +5% no trigger
    },
  });
  const guard = new PerStockStopLossGuard(makeFakeSource(state));
  const result = await guard.evaluateAfterClose({ user_id: 1 });
  assertEqual('happy: scanned 1', result.scanned_users, 1);
  assertEqual('happy: triggered users 1', result.triggered_users, 1);
  assertEqual('happy: 1 trigger total', result.triggers.length, 1);
  assertEqual('happy: trigger symbol = A.SH', result.triggers[0].symbol, 'A.SH');
  assertClose('happy: loss_ratio = -0.08', result.triggers[0].loss_ratio, -0.08);

  // 2 持仓中 1 触发：ceil(2*0.5)=1 → mass
  assertEqual('happy: level MASS (1/2 @ 50%)', result.per_user[0].level, 'MASS');
  assertEqual('happy: open_positions_count 2', result.per_user[0].open_positions_count, 2);
  assertEqual('happy: triggered_count 1', result.per_user[0].triggered_count, 1);

  // Alerts written: 1 stock alert + 1 mass alert
  assertEqual('happy: 2 alerts written (1 stock + 1 mass)', state.alerts.length, 2);
  assertEqual('happy: alert[0] symbol = A.SH', state.alerts[0].symbol, 'A.SH');
  assertEqual(
    'happy: alert[1] symbol = MASS sentinel',
    state.alerts[1].symbol,
    PER_STOCK_STOP_LOSS_MASS_SYMBOL
  );
}

async function testIndividualButNotMass() {
  // 3 持仓中 1 触发 → INDIVIDUAL（ceil(3*0.5)=2, 1<2）
  const state = emptyState({
    userIds: [1],
    configs: { 1: { enabled: true, pct: 0.07, mass_threshold_ratio: 0.5 } },
    positionsByUser: {
      1: [
        makePosition({ id: 1, symbol: 'A.SH', avg_cost: 100 }),
        makePosition({ id: 2, symbol: 'B.SH', avg_cost: 50 }),
        makePosition({ id: 3, symbol: 'C.SH', avg_cost: 30 }),
      ],
    },
    bars: {
      'A.SH': { close: 91, date: new Date('2026-06-07') }, // -9% triggers
      'B.SH': { close: 52, date: new Date('2026-06-07') }, // +4% no trigger
      'C.SH': { close: 29, date: new Date('2026-06-07') }, // -3.3% no trigger
    },
  });
  const guard = new PerStockStopLossGuard(makeFakeSource(state));
  const result = await guard.evaluateAfterClose({ user_id: 1 });
  assertEqual('indiv: triggered_count 1', result.per_user[0].triggered_count, 1);
  assertEqual('indiv: level INDIVIDUAL (1/3 @ 50%)', result.per_user[0].level, 'INDIVIDUAL');
  // Only 1 stock alert; NO mass alert
  assertEqual('indiv: 1 alert (no mass)', state.alerts.length, 1);
  assertEqual('indiv: alert is per-stock A.SH', state.alerts[0].symbol, 'A.SH');
}

async function testMassTriggerThreeStocks() {
  // 3 持仓中 2 触发 → MASS（ceil(3*0.5)=2）
  const state = emptyState({
    userIds: [1],
    configs: { 1: { enabled: true, pct: 0.07, mass_threshold_ratio: 0.5 } },
    positionsByUser: {
      1: [
        makePosition({ id: 1, symbol: 'A.SH', avg_cost: 100 }),
        makePosition({ id: 2, symbol: 'B.SH', avg_cost: 50 }),
        makePosition({ id: 3, symbol: 'C.SH', avg_cost: 30 }),
      ],
    },
    bars: {
      'A.SH': { close: 91, date: new Date('2026-06-07') }, // -9% triggers
      'B.SH': { close: 46, date: new Date('2026-06-07') }, // -8% triggers
      'C.SH': { close: 29.5, date: new Date('2026-06-07') }, // -1.67% no trigger
    },
  });
  const guard = new PerStockStopLossGuard(makeFakeSource(state));
  const result = await guard.evaluateAfterClose({ user_id: 1 });
  assertEqual('mass3: triggered_count 2', result.per_user[0].triggered_count, 2);
  assertEqual('mass3: level MASS', result.per_user[0].level, 'MASS');
  // 2 stock + 1 mass = 3
  assertEqual('mass3: 3 alerts (2 stock + 1 mass)', state.alerts.length, 3);
  const massAlert = state.alerts.find(a => a.symbol === PER_STOCK_STOP_LOSS_MASS_SYMBOL);
  assert('mass3: mass alert exists', massAlert !== undefined);
  assert('mass3: mass alert message has LEVEL_2', massAlert?.message.includes('LEVEL_2') ?? false);
}

async function testBoundaryTrigger() {
  // loss_ratio == -0.07 (exact) → triggered (≤ inclusive)
  const state = emptyState({
    userIds: [1],
    configs: { 1: { enabled: true, pct: 0.07, mass_threshold_ratio: 0.5 } },
    positionsByUser: {
      1: [makePosition({ id: 1, symbol: 'A.SH', avg_cost: 100 })],
    },
    bars: { 'A.SH': { close: 93, date: new Date('2026-06-07') } }, // -7% boundary
  });
  const guard = new PerStockStopLossGuard(makeFakeSource(state));
  const result = await guard.evaluateAfterClose({ user_id: 1 });
  assertEqual('boundary: triggered (≤ inclusive)', result.per_user[0].triggered_count, 1);
}

async function testPerPositionPctOverrideTighter() {
  // user pct = 0.10, position.stop_loss_pct = 0.05 → 紧 5%
  // 持仓亏损 -6% → 触发（因 -0.06 ≤ -0.05）
  const state = emptyState({
    userIds: [1],
    configs: { 1: { enabled: true, pct: 0.1, mass_threshold_ratio: 0.5 } },
    positionsByUser: {
      1: [makePosition({ id: 1, symbol: 'A.SH', avg_cost: 100, stop_loss_pct: 0.05 })],
    },
    bars: { 'A.SH': { close: 94, date: new Date('2026-06-07') } }, // -6%
  });
  const guard = new PerStockStopLossGuard(makeFakeSource(state));
  const result = await guard.evaluateAfterClose({ user_id: 1 });
  assertEqual('pctTighter: triggered', result.per_user[0].triggered_count, 1);
  assertEqual('pctTighter: effective_pct = 0.05', result.triggers[0].effective_pct, 0.05);
}

async function testPerPositionPctOverrideLooser() {
  // user pct = 0.07, position.stop_loss_pct = 0.15 → 松 15%
  // 持仓亏损 -8% → 不触发（因 -0.08 > -0.15）
  const state = emptyState({
    userIds: [1],
    configs: { 1: { enabled: true, pct: 0.07, mass_threshold_ratio: 0.5 } },
    positionsByUser: {
      1: [makePosition({ id: 1, symbol: 'A.SH', avg_cost: 100, stop_loss_pct: 0.15 })],
    },
    bars: { 'A.SH': { close: 92, date: new Date('2026-06-07') } }, // -8%
  });
  const guard = new PerStockStopLossGuard(makeFakeSource(state));
  const result = await guard.evaluateAfterClose({ user_id: 1 });
  assertEqual('pctLooser: NOT triggered', result.per_user[0].triggered_count, 0);
  assertEqual('pctLooser: level NONE', result.per_user[0].level, 'NONE');
}

async function testNoBar() {
  // DailyBar 缺当日 → skipped_no_bar
  const state = emptyState({
    userIds: [1],
    configs: { 1: { enabled: true, pct: 0.07, mass_threshold_ratio: 0.5 } },
    positionsByUser: {
      1: [makePosition({ id: 1, symbol: 'MISSING.SH', avg_cost: 100 })],
    },
    bars: {}, // no bar for MISSING.SH
  });
  const guard = new PerStockStopLossGuard(makeFakeSource(state));
  const result = await guard.evaluateAfterClose({ user_id: 1 });
  assertEqual('noBar: 0 triggered', result.per_user[0].triggered_count, 0);
  assertEqual('noBar: level NONE', result.per_user[0].level, 'NONE');
  assertEqual(
    'noBar: status = skipped_no_bar',
    result.per_user[0].results[0].status,
    'skipped_no_bar'
  );
  assertEqual('noBar: 0 alerts', state.alerts.length, 0);
}

async function testBadCost() {
  // avg_cost ≤ 0 → skipped_bad_cost
  const state = emptyState({
    userIds: [1],
    configs: { 1: { enabled: true, pct: 0.07, mass_threshold_ratio: 0.5 } },
    positionsByUser: {
      1: [makePosition({ id: 1, symbol: 'A.SH', avg_cost: 0 })],
    },
    bars: { 'A.SH': { close: 92, date: new Date('2026-06-07') } },
  });
  const guard = new PerStockStopLossGuard(makeFakeSource(state));
  const result = await guard.evaluateAfterClose({ user_id: 1 });
  assertEqual('badCost: 0 triggered', result.per_user[0].triggered_count, 0);
  assertEqual(
    'badCost: status = skipped_bad_cost',
    result.per_user[0].results[0].status,
    'skipped_bad_cost'
  );
}

async function testZeroQuantitySkipped() {
  const state = emptyState({
    userIds: [1],
    configs: { 1: { enabled: true, pct: 0.07, mass_threshold_ratio: 0.5 } },
    positionsByUser: {
      1: [makePosition({ id: 1, symbol: 'A.SH', avg_cost: 100, quantity: 0 })],
    },
    bars: { 'A.SH': { close: 80, date: new Date('2026-06-07') } },
  });
  const guard = new PerStockStopLossGuard(makeFakeSource(state));
  const result = await guard.evaluateAfterClose({ user_id: 1 });
  assertEqual('noQty: open_positions_count 0', result.per_user[0].open_positions_count, 0);
  assertEqual('noQty: 0 triggered', result.per_user[0].triggered_count, 0);
  assertEqual(
    'noQty: status = skipped_no_quantity',
    result.per_user[0].results[0].status,
    'skipped_no_quantity'
  );
}

async function testDisabledUser() {
  const state = emptyState({
    userIds: [1],
    configs: { 1: { enabled: false, pct: 0.07, mass_threshold_ratio: 0.5 } },
    positionsByUser: {
      1: [
        makePosition({ id: 1, symbol: 'A.SH', avg_cost: 100 }),
        makePosition({ id: 2, symbol: 'B.SH', avg_cost: 50 }),
      ],
    },
    bars: {
      'A.SH': { close: 80, date: new Date('2026-06-07') }, // -20% would trigger
      'B.SH': { close: 30, date: new Date('2026-06-07') }, // -40% would trigger
    },
  });
  const guard = new PerStockStopLossGuard(makeFakeSource(state));
  const result = await guard.evaluateAfterClose({ user_id: 1 });
  assertEqual('disabled: 0 triggered', result.per_user[0].triggered_count, 0);
  assertEqual('disabled: level NONE', result.per_user[0].level, 'NONE');
  assertEqual('disabled: 0 alerts', state.alerts.length, 0);
}

async function testDryRun() {
  const state = emptyState({
    userIds: [1],
    configs: { 1: { enabled: true, pct: 0.07, mass_threshold_ratio: 0.5 } },
    positionsByUser: {
      1: [
        makePosition({ id: 1, symbol: 'A.SH', avg_cost: 100 }),
        makePosition({ id: 2, symbol: 'B.SH', avg_cost: 50 }),
      ],
    },
    bars: {
      'A.SH': { close: 80, date: new Date('2026-06-07') },
      'B.SH': { close: 40, date: new Date('2026-06-07') },
    },
  });
  const guard = new PerStockStopLossGuard(makeFakeSource(state));
  const result = await guard.evaluateAfterClose({ user_id: 1, dry_run: true });
  assertEqual('dryRun: 2 triggers returned', result.triggers.length, 2);
  assertEqual('dryRun: level MASS', result.per_user[0].level, 'MASS');
  assertEqual('dryRun: 0 alerts written', state.alerts.length, 0);
}

async function testAlertFailureDoesNotMaskTrigger() {
  const state = emptyState({
    userIds: [1],
    configs: { 1: { enabled: true, pct: 0.07, mass_threshold_ratio: 0.5 } },
    positionsByUser: {
      1: [makePosition({ id: 1, symbol: 'A.SH', avg_cost: 100 })],
    },
    bars: { 'A.SH': { close: 80, date: new Date('2026-06-07') } },
    writeAlertShouldThrow: true,
  });
  const guard = new PerStockStopLossGuard(makeFakeSource(state));
  const result = await guard.evaluateAfterClose({ user_id: 1 });
  // Trigger still surfaced even if writeAlert fails
  assertEqual('alertFail: trigger surfaced', result.triggers.length, 1);
  assertEqual('alertFail: trigger symbol matches', result.triggers[0].symbol, 'A.SH');
  // 0 alerts recorded (fake threw on both)
  assertEqual('alertFail: 0 alerts (fake threw)', state.alerts.length, 0);
}

async function testMultiUserIsolation() {
  // user 1 OK, user 2 loadPositions throws → user 1 still gets triggered
  const state = emptyState({
    userIds: [1, 2],
    configs: {
      1: { enabled: true, pct: 0.07, mass_threshold_ratio: 0.5 },
      2: { enabled: true, pct: 0.07, mass_threshold_ratio: 0.5 },
    },
    positionsByUser: {
      1: [makePosition({ id: 1, symbol: 'A.SH', avg_cost: 100 })],
      2: [makePosition({ id: 2, symbol: 'B.SH', avg_cost: 50 })],
    },
    bars: {
      'A.SH': { close: 80, date: new Date('2026-06-07') },
      'B.SH': { close: 40, date: new Date('2026-06-07') },
    },
    loadPositionsShouldThrowForUser: 2,
  });
  const guard = new PerStockStopLossGuard(makeFakeSource(state));
  const result = await guard.evaluateAfterClose();
  assertEqual('multi: scanned 2', result.scanned_users, 2);
  // User 1 should still produce 1 trigger
  assertEqual('multi: 1 trigger from user1', result.triggers.length, 1);
  assertEqual('multi: trigger user_id = 1', result.triggers[0].user_id, 1);
  // User 2 should have error captured
  const user2Result = result.per_user.find(u => u.user_id === 2);
  assert('multi: user2 error captured', user2Result?.error !== undefined);
}

async function testScansAllWhenNoUserId() {
  const state = emptyState({
    userIds: [1, 2, 3],
    configs: {
      1: { enabled: true, pct: 0.07, mass_threshold_ratio: 0.5 },
      2: { enabled: false, pct: 0.07, mass_threshold_ratio: 0.5 },
      3: { enabled: true, pct: 0.07, mass_threshold_ratio: 0.5 },
    },
    positionsByUser: {
      1: [makePosition({ id: 1, symbol: 'A.SH', avg_cost: 100 })],
      2: [makePosition({ id: 2, symbol: 'B.SH', avg_cost: 100 })],
      3: [makePosition({ id: 3, symbol: 'C.SH', avg_cost: 100 })],
    },
    bars: {
      'A.SH': { close: 80, date: new Date('2026-06-07') }, // -20% triggers
      'B.SH': { close: 80, date: new Date('2026-06-07') },
      'C.SH': { close: 85, date: new Date('2026-06-07') }, // -15% triggers
    },
  });
  const guard = new PerStockStopLossGuard(makeFakeSource(state));
  const result = await guard.evaluateAfterClose();
  assertEqual('scanAll: scanned 3', result.scanned_users, 3);
  // Both user1 and user3 trigger; user2 is disabled
  assertEqual('scanAll: 2 triggered users', result.triggered_users, 2);
}

async function testCustomMassThreshold() {
  // 3 仓位，custom threshold = 0.3 → 1 触发就达到 mass (ceil(3*0.3)=1)
  const state = emptyState({
    userIds: [1],
    configs: { 1: { enabled: true, pct: 0.07, mass_threshold_ratio: 0.3 } },
    positionsByUser: {
      1: [
        makePosition({ id: 1, symbol: 'A.SH', avg_cost: 100 }),
        makePosition({ id: 2, symbol: 'B.SH', avg_cost: 50 }),
        makePosition({ id: 3, symbol: 'C.SH', avg_cost: 30 }),
      ],
    },
    bars: {
      'A.SH': { close: 91, date: new Date('2026-06-07') }, // -9% triggers
      'B.SH': { close: 52, date: new Date('2026-06-07') }, // no trigger
      'C.SH': { close: 30, date: new Date('2026-06-07') }, // no trigger
    },
  });
  const guard = new PerStockStopLossGuard(makeFakeSource(state));
  const result = await guard.evaluateAfterClose({ user_id: 1 });
  assertEqual('customMass: 1 triggered', result.per_user[0].triggered_count, 1);
  // 1/3 ≥ ceil(3*0.3)=1 → MASS
  assertEqual('customMass: level MASS at 30%', result.per_user[0].level, 'MASS');
}

async function testNoPortfolio() {
  // portfolio_id null → NONE
  const state = emptyState({
    userIds: [1],
    configs: { 1: { enabled: true, pct: 0.07, mass_threshold_ratio: 0.5 } },
    portfolioIds: { 1: null },
    positionsByUser: { 1: [] },
    bars: {},
  });
  const guard = new PerStockStopLossGuard(makeFakeSource(state));
  const result = await guard.evaluateAfterClose({ user_id: 1 });
  assertEqual('noPortfolio: level NONE', result.per_user[0].level, 'NONE');
  assertEqual('noPortfolio: portfolio_id null', result.per_user[0].portfolio_id, null);
  assertEqual('noPortfolio: 0 alerts', state.alerts.length, 0);
}

// ---------------------------------------------------------------------------
//  Tests — getConfig / updateConfig
// ---------------------------------------------------------------------------

async function testGetConfigDefault() {
  const state = emptyState({ userIds: [1] });
  const guard = new PerStockStopLossGuard(makeFakeSource(state));
  const config = await guard.getConfig(1);
  assertEqual('getConfig: returns defaults', config, { ...DEFAULT_PER_STOCK_STOP_LOSS_CONFIG });
}

async function testUpdateConfigRoundTrip() {
  const state = emptyState({ userIds: [1] });
  const guard = new PerStockStopLossGuard(makeFakeSource(state));
  const updated = await guard.updateConfig(1, {
    enabled: true,
    pct: 0.05,
    mass_threshold_ratio: 0.3,
  });
  assertEqual('updateConfig: returns normalized', updated, {
    enabled: true,
    pct: 0.05,
    mass_threshold_ratio: 0.3,
  });
  const after = await guard.getConfig(1);
  assertEqual('updateConfig: persisted', after, {
    enabled: true,
    pct: 0.05,
    mass_threshold_ratio: 0.3,
  });
}

async function testUpdateConfigGarbageSanitized() {
  const state = emptyState({ userIds: [1] });
  const guard = new PerStockStopLossGuard(makeFakeSource(state));
  const updated = await guard.updateConfig(1, {
    enabled: 'maybe',
    pct: 5,
    mass_threshold_ratio: -1,
  });
  assertEqual('updateConfig garbage → defaults', updated, {
    ...DEFAULT_PER_STOCK_STOP_LOSS_CONFIG,
  });
}

// ---------------------------------------------------------------------------
//  Driver
// ---------------------------------------------------------------------------

async function main() {
  await testConstants();
  await testPickEffectivePct();
  await testComputeLossRatio();
  await testEvaluateTrigger();
  await testEvaluateMassTrigger();
  await testNormalize();
  await testBuildPerStockStopLossMessage();
  await testBuildMassTriggerMessage();

  await testHappyPathSingleTrigger();
  await testIndividualButNotMass();
  await testMassTriggerThreeStocks();
  await testBoundaryTrigger();
  await testPerPositionPctOverrideTighter();
  await testPerPositionPctOverrideLooser();
  await testNoBar();
  await testBadCost();
  await testZeroQuantitySkipped();
  await testDisabledUser();
  await testDryRun();
  await testAlertFailureDoesNotMaskTrigger();
  await testMultiUserIsolation();
  await testScansAllWhenNoUserId();
  await testCustomMassThreshold();
  await testNoPortfolio();

  await testGetConfigDefault();
  await testUpdateConfigRoundTrip();
  await testUpdateConfigGarbageSanitized();

  console.log(`\n${passed} ok, ${failed} failed`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch(err => {
  console.error('TEST RUNNER CRASHED:', err);
  process.exitCode = 1;
});
