/**
 * CleanupOldDataService 单元测试 (US-097)
 *
 * 完全脱 DB: 走 service 的 DataSource 接口注入 fake (in-memory store).
 * 不需要 stub Sequelize Model 静态方法 — 服务设计成只通过 DataSource 接口
 * 跟 DB 交互, 测试只需 mock 这一层.
 *
 * 跑法:
 *   cd backend && npx ts-node --transpile-only tests/services/cleanup-old-data-service.test.ts
 *
 * 覆盖维度:
 *   - 纯函数 helpers:
 *     - normalizeThresholdDays (default / numeric string / float / negative / NaN / Infinity / null / undefined)
 *     - computeCutoffDate (UTC 边界 / 跨月 / 闰年 1 天 / 0 day = today)
 *     - toIsoDate (UTC slice)
 *     - isWhitelistedTask (空 whitelist / 空 keys / 交集 / 无交集)
 *     - normalizeWhitelistStrategies (empty / trim / dedup / non-string entries 过滤)
 *     - partitionBacktestTasksByWhitelist (全过 / 全跳 / 混合)
 *   - service.cleanup() e2e:
 *     - dryRun=true (默认) → 只 count 不 delete
 *     - dryRun=false → 真正 delete
 *     - whitelist 豁免 backtest task
 *     - cascade delete (trades + results)
 *     - 单 target 失败不阻塞其他
 *     - 阈值各自生效 (backtest 90 / log 180 / alert 30)
 *     - alerts 只清 is_read=true
 *     - 空 stale → count=0 cascade=0
 */

import {
  CleanupOldDataService,
  CleanupDataSource,
  normalizeThresholdDays,
  computeCutoffDate,
  toIsoDate,
  isWhitelistedTask,
  normalizeWhitelistStrategies,
  partitionBacktestTasksByWhitelist,
  DEFAULT_BACKTEST_RETENTION_DAYS,
  DEFAULT_LOG_RETENTION_DAYS,
  DEFAULT_ALERT_RETENTION_DAYS,
} from '../../src/services/CleanupOldDataService';

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

// ===========================================================================
// Pure helpers
// ===========================================================================

function testNormalizeThresholdDays(): void {
  // defaults
  assertEqual('normalize default undef', normalizeThresholdDays(undefined, 90), 90);
  assertEqual('normalize default null', normalizeThresholdDays(null, 90), 90);
  // valid numbers
  assertEqual('normalize number', normalizeThresholdDays(60, 90), 60);
  assertEqual('normalize string number', normalizeThresholdDays('60', 90), 60);
  // floor floats
  assertEqual('normalize float floor', normalizeThresholdDays(90.7, 90), 90);
  assertEqual('normalize string float', normalizeThresholdDays('90.7', 90), 90);
  // 1 day min (Math.max(1, floor))
  assertEqual('normalize 0.5 → 1', normalizeThresholdDays(0.5, 90), 1);
  // invalid → fallback
  assertEqual('normalize 0 → fallback', normalizeThresholdDays(0, 90), 90);
  assertEqual('normalize negative → fallback', normalizeThresholdDays(-5, 90), 90);
  assertEqual('normalize NaN string → fallback', normalizeThresholdDays('abc', 90), 90);
  assertEqual('normalize Infinity → fallback', normalizeThresholdDays(Infinity, 90), 90);
  assertEqual('normalize NaN → fallback', normalizeThresholdDays(NaN, 90), 90);
}

function testComputeCutoffDate(): void {
  const asOf = new Date('2026-06-09T03:00:00.000Z');
  const c30 = computeCutoffDate(asOf, 30);
  assertEqual('cutoff 30 days', toIsoDate(c30), '2026-05-10');
  const c180 = computeCutoffDate(asOf, 180);
  assertEqual('cutoff 180 days', toIsoDate(c180), '2025-12-11');
  // cross-year
  const newYear = new Date('2026-01-05T00:00:00.000Z');
  const cBeforeYear = computeCutoffDate(newYear, 10);
  assertEqual('cutoff cross-year', toIsoDate(cBeforeYear), '2025-12-26');
  // leap year: 2024 had Feb 29
  const afterLeap = new Date('2024-03-05T00:00:00.000Z');
  const cLeap = computeCutoffDate(afterLeap, 5);
  assertEqual('cutoff leap year Feb', toIsoDate(cLeap), '2024-02-29');
}

function testToIsoDate(): void {
  assertEqual(
    'iso UTC midnight',
    toIsoDate(new Date('2026-06-09T00:00:00.000Z')),
    '2026-06-09'
  );
  assertEqual(
    'iso UTC late evening',
    toIsoDate(new Date('2026-06-09T23:59:59.999Z')),
    '2026-06-09'
  );
}

function testIsWhitelistedTask(): void {
  assert('empty whitelist never whitelists', !isWhitelistedTask(['a', 'b'], []));
  assert('empty keys never whitelists', !isWhitelistedTask([], ['a']));
  assert('single match', isWhitelistedTask(['multi_factor_alpha'], ['multi_factor_alpha']));
  assert(
    'partial match (one in whitelist)',
    isWhitelistedTask(['multi_factor_alpha', 'dragon_head'], ['multi_factor_alpha'])
  );
  assert(
    'no match',
    !isWhitelistedTask(['breakout', 'low_vol'], ['multi_factor_alpha', 'dragon_head'])
  );
  // case sensitive (与 strategy_key 约定一致)
  assert(
    'case sensitive: MULTI_FACTOR ≠ multi_factor',
    !isWhitelistedTask(['MULTI_FACTOR_ALPHA'], ['multi_factor_alpha'])
  );
}

function testNormalizeWhitelistStrategies(): void {
  assertEqual('whitelist undefined → []', normalizeWhitelistStrategies(undefined), []);
  assertEqual('whitelist empty → []', normalizeWhitelistStrategies([]), []);
  assertEqual(
    'whitelist trim',
    normalizeWhitelistStrategies([' a ', 'b\t', '\n c\n']),
    ['a', 'b', 'c']
  );
  assertEqual(
    'whitelist dedup',
    normalizeWhitelistStrategies(['a', 'a', 'b', 'a', 'b']),
    ['a', 'b']
  );
  assertEqual(
    'whitelist filter empty + non-string',
    normalizeWhitelistStrategies(['', '  ', 'a', null as any, undefined as any, 42 as any]),
    ['a']
  );
  assertEqual(
    'whitelist preserves case',
    normalizeWhitelistStrategies(['Multi_Factor', 'multi_factor']),
    ['Multi_Factor', 'multi_factor']
  );
}

function testPartitionBacktestTasksByWhitelist(): void {
  const tasks = [
    { id: 1, strategy_keys: ['multi_factor_alpha'] },
    { id: 2, strategy_keys: ['dragon_head', 'breakout'] },
    { id: 3, strategy_keys: ['low_vol'] },
    { id: 4, strategy_keys: [] }, // 空 keys 永不豁免
  ];
  // no whitelist → all to delete
  const { toDelete: all, skipped: none } = partitionBacktestTasksByWhitelist(tasks, []);
  assertEqual('empty whitelist → all to delete', all, [1, 2, 3, 4]);
  assertEqual('empty whitelist → none skipped', none, []);
  // whitelist 'dragon_head' → id=2 skipped
  const { toDelete, skipped } = partitionBacktestTasksByWhitelist(tasks, ['dragon_head']);
  assertEqual('whitelist dragon_head → toDelete', toDelete, [1, 3, 4]);
  assertEqual('whitelist dragon_head → skipped', skipped, [2]);
  // whitelist 'unknown' → none skipped
  const { toDelete: td2, skipped: sk2 } = partitionBacktestTasksByWhitelist(tasks, ['unknown']);
  assertEqual('whitelist unknown → all to delete', td2, [1, 2, 3, 4]);
  assertEqual('whitelist unknown → none skipped', sk2, []);
  // empty input
  const { toDelete: td3, skipped: sk3 } = partitionBacktestTasksByWhitelist([], ['x']);
  assertEqual('empty tasks → empty toDelete', td3, []);
  assertEqual('empty tasks → empty skipped', sk3, []);
}

// ===========================================================================
// Fake DataSource for e2e service tests
// ===========================================================================

interface FakeBacktestTask {
  id: number;
  created_at: Date;
  strategy_keys: string[];
}

interface FakeLog {
  id: number;
  created_at: Date;
}

interface FakeAlert {
  id: number;
  created_at: Date;
  is_read: boolean;
}

function makeFakeDataSource(seed: {
  backtests?: FakeBacktestTask[];
  dataUpdateLogs?: FakeLog[];
  taskExecLogs?: FakeLog[];
  alerts?: FakeAlert[];
  trades?: Record<number, number>; // task_id → trade count
  results?: Record<number, number>; // task_id → result count
  failBacktest?: boolean;
  failDataUpdateLogs?: boolean;
  failTaskExecLogs?: boolean;
  failAlerts?: boolean;
}): CleanupDataSource & {
  state: {
    backtests: FakeBacktestTask[];
    dataUpdateLogs: FakeLog[];
    taskExecLogs: FakeLog[];
    alerts: FakeAlert[];
    trades: Record<number, number>;
    results: Record<number, number>;
  };
} {
  const state = {
    backtests: [...(seed.backtests || [])],
    dataUpdateLogs: [...(seed.dataUpdateLogs || [])],
    taskExecLogs: [...(seed.taskExecLogs || [])],
    alerts: [...(seed.alerts || [])],
    trades: { ...(seed.trades || {}) },
    results: { ...(seed.results || {}) },
  };

  const ds: CleanupDataSource & { state: typeof state } = {
    state,
    async findStaleBacktestTasks(cutoff: Date) {
      if (seed.failBacktest) throw new Error('backtest db fail');
      return state.backtests
        .filter(b => b.created_at < cutoff)
        .map(b => ({ id: b.id, strategy_keys: b.strategy_keys }));
    },
    async deleteBacktestTasksCascade(taskIds: number[]) {
      let trades_deleted = 0;
      let results_deleted = 0;
      for (const id of taskIds) {
        trades_deleted += state.trades[id] || 0;
        results_deleted += state.results[id] || 0;
        delete state.trades[id];
        delete state.results[id];
      }
      const before = state.backtests.length;
      state.backtests = state.backtests.filter(b => !taskIds.includes(b.id));
      const tasks_deleted = before - state.backtests.length;
      return { trades_deleted, results_deleted, tasks_deleted };
    },
    async countStaleDataUpdateLogs(cutoff: Date) {
      if (seed.failDataUpdateLogs) throw new Error('dul count fail');
      return state.dataUpdateLogs.filter(l => l.created_at < cutoff).length;
    },
    async deleteStaleDataUpdateLogs(cutoff: Date) {
      if (seed.failDataUpdateLogs) throw new Error('dul delete fail');
      const before = state.dataUpdateLogs.length;
      state.dataUpdateLogs = state.dataUpdateLogs.filter(l => l.created_at >= cutoff);
      return before - state.dataUpdateLogs.length;
    },
    async countStaleTaskExecutionLogs(cutoff: Date) {
      if (seed.failTaskExecLogs) throw new Error('tel count fail');
      return state.taskExecLogs.filter(l => l.created_at < cutoff).length;
    },
    async deleteStaleTaskExecutionLogs(cutoff: Date) {
      if (seed.failTaskExecLogs) throw new Error('tel delete fail');
      const before = state.taskExecLogs.length;
      state.taskExecLogs = state.taskExecLogs.filter(l => l.created_at >= cutoff);
      return before - state.taskExecLogs.length;
    },
    async countStaleReadRiskAlerts(cutoff: Date) {
      if (seed.failAlerts) throw new Error('alerts count fail');
      return state.alerts.filter(a => a.is_read && a.created_at < cutoff).length;
    },
    async deleteStaleReadRiskAlerts(cutoff: Date) {
      if (seed.failAlerts) throw new Error('alerts delete fail');
      const before = state.alerts.length;
      state.alerts = state.alerts.filter(a => !(a.is_read && a.created_at < cutoff));
      return before - state.alerts.length;
    },
  };
  return ds;
}

const ASOF = new Date('2026-06-09T03:00:00.000Z'); // 测试基准时间

function makeDate(daysAgo: number): Date {
  const d = new Date(ASOF);
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d;
}

// ===========================================================================
// e2e: service.cleanup()
// ===========================================================================

async function testCleanupDefaultDryRun(): Promise<void> {
  const ds = makeFakeDataSource({
    backtests: [
      { id: 1, created_at: makeDate(100), strategy_keys: ['multi_factor_alpha'] }, // 100 > 90 → stale
      { id: 2, created_at: makeDate(50), strategy_keys: ['dragon_head'] }, // 50 < 90 → keep
    ],
    dataUpdateLogs: [
      { id: 1, created_at: makeDate(200) }, // 200 > 180 → stale
      { id: 2, created_at: makeDate(100) }, // 100 < 180 → keep
    ],
    taskExecLogs: [
      { id: 1, created_at: makeDate(200) },
      { id: 2, created_at: makeDate(100) },
    ],
    alerts: [
      { id: 1, created_at: makeDate(40), is_read: true }, // 40 > 30 + read → stale
      { id: 2, created_at: makeDate(40), is_read: false }, // unread → keep
      { id: 3, created_at: makeDate(20), is_read: true }, // 20 < 30 → keep
    ],
    trades: { 1: 50 },
    results: { 1: 5 },
  });
  const service = new CleanupOldDataService(ds);
  const result = await service.cleanup({ asOfDate: ASOF });

  assertEqual('default dryRun mode', result.mode, 'dry_run');
  assertEqual('default dryRun total_count', result.total_count, 1 + 1 + 1 + 1); // 1 backtest + 1 dul + 1 tel + 1 alert
  // dryRun cascade_count is 0 (designed to skip extra queries)
  assertEqual('dryRun cascade_count = 0', result.total_cascade_count, 0);
  // state unchanged
  assertEqual('dryRun: backtests untouched', ds.state.backtests.length, 2);
  assertEqual('dryRun: dul untouched', ds.state.dataUpdateLogs.length, 2);
  assertEqual('dryRun: tel untouched', ds.state.taskExecLogs.length, 2);
  assertEqual('dryRun: alerts untouched', ds.state.alerts.length, 3);
  // per-target executed=false
  for (const t of result.targets) {
    assertEqual(`dryRun: ${t.target} executed=false`, t.executed, false);
  }
  assertEqual('default no errors', result.errors, []);
  assertEqual('default no whitelist skipped', result.whitelist_skipped_total, 0);
}

async function testCleanupExecuted(): Promise<void> {
  const ds = makeFakeDataSource({
    backtests: [
      { id: 1, created_at: makeDate(100), strategy_keys: ['multi_factor_alpha'] },
      { id: 2, created_at: makeDate(50), strategy_keys: ['dragon_head'] },
    ],
    dataUpdateLogs: [
      { id: 1, created_at: makeDate(200) },
      { id: 2, created_at: makeDate(100) },
    ],
    taskExecLogs: [{ id: 1, created_at: makeDate(200) }],
    alerts: [
      { id: 1, created_at: makeDate(40), is_read: true },
      { id: 2, created_at: makeDate(40), is_read: false },
    ],
    trades: { 1: 50 },
    results: { 1: 5 },
  });
  const service = new CleanupOldDataService(ds);
  const result = await service.cleanup({ dryRun: false, asOfDate: ASOF });

  assertEqual('executed mode', result.mode, 'executed');
  // backtests: 1 task + 50 trades + 5 results
  // logs: 1 dul + 1 tel
  // alerts: 1 read+stale
  assertEqual('executed total_count', result.total_count, 1 + 1 + 1 + 1);
  assertEqual('executed cascade_count', result.total_cascade_count, 50 + 5);
  // state mutated
  assertEqual('executed: 1 backtest left (id=2)', ds.state.backtests.length, 1);
  assertEqual('executed: kept id=2', ds.state.backtests[0].id, 2);
  assertEqual('executed: dul 1 left', ds.state.dataUpdateLogs.length, 1);
  assertEqual('executed: tel 0 left', ds.state.taskExecLogs.length, 0);
  assertEqual('executed: alerts 1 left', ds.state.alerts.length, 1);
  // unread alert kept
  assertEqual('executed: unread alert kept', ds.state.alerts[0].id, 2);
  // per-target executed=true
  for (const t of result.targets) {
    assertEqual(`executed: ${t.target} executed=true`, t.executed, true);
  }
}

async function testCleanupWithWhitelist(): Promise<void> {
  const ds = makeFakeDataSource({
    backtests: [
      { id: 1, created_at: makeDate(100), strategy_keys: ['multi_factor_alpha'] }, // whitelisted
      { id: 2, created_at: makeDate(100), strategy_keys: ['dragon_head'] }, // not whitelisted
      { id: 3, created_at: makeDate(100), strategy_keys: ['multi_factor_alpha', 'breakout'] }, // partial match → whitelisted
      { id: 4, created_at: makeDate(100), strategy_keys: [] }, // empty → not whitelisted
    ],
    trades: { 1: 10, 2: 20, 3: 30, 4: 40 },
    results: { 1: 1, 2: 2, 3: 3, 4: 4 },
  });
  const service = new CleanupOldDataService(ds);
  const result = await service.cleanup({
    whitelistStrategies: ['multi_factor_alpha'],
    dryRun: false,
    asOfDate: ASOF,
  });

  const bt = result.targets.find(t => t.target === 'quant_backtest_tasks');
  assert('whitelist: backtest target found', bt !== undefined);
  assertEqual('whitelist: 2 tasks deleted', bt!.count, 2); // id=2, id=4
  assertEqual('whitelist: 2 tasks skipped', bt!.whitelist_skipped, 2); // id=1, id=3
  assertEqual('whitelist: cascade 20+2 + 40+4 = 66', bt!.cascade_count, 66);
  assertEqual('whitelist: total skip in summary', result.whitelist_skipped_total, 2);
  // state check: kept id=1 and id=3
  assertEqual('whitelist: 2 backtests kept', ds.state.backtests.length, 2);
  const keptIds = ds.state.backtests.map(b => b.id).sort();
  assertEqual('whitelist: kept ids', keptIds, [1, 3]);
}

async function testCleanupCustomThresholds(): Promise<void> {
  const ds = makeFakeDataSource({
    backtests: [
      { id: 1, created_at: makeDate(80), strategy_keys: ['x'] }, // 80 > 60 → stale at 60d
      { id: 2, created_at: makeDate(50), strategy_keys: ['x'] }, // 50 < 60 → keep at 60d
    ],
    dataUpdateLogs: [
      { id: 1, created_at: makeDate(50) }, // 50 > 30 → stale at 30d
      { id: 2, created_at: makeDate(20) }, // 20 < 30 → keep at 30d
    ],
    taskExecLogs: [{ id: 1, created_at: makeDate(50) }],
    alerts: [
      { id: 1, created_at: makeDate(10), is_read: true }, // 10 > 7 → stale at 7d
      { id: 2, created_at: makeDate(5), is_read: true }, // 5 < 7 → keep at 7d
    ],
  });
  const service = new CleanupOldDataService(ds);
  const result = await service.cleanup({
    backtestRetentionDays: 60,
    logRetentionDays: 30,
    alertRetentionDays: 7,
    dryRun: false,
    asOfDate: ASOF,
  });

  assertEqual('custom: backtest 60d → 1 stale', result.targets[0].count, 1);
  assertEqual('custom: dul 30d → 1 stale', result.targets[1].count, 1);
  assertEqual('custom: tel 30d → 1 stale', result.targets[2].count, 1);
  assertEqual('custom: alerts 7d → 1 stale', result.targets[3].count, 1);
}

async function testCleanupFailureIsolation(): Promise<void> {
  const ds = makeFakeDataSource({
    backtests: [{ id: 1, created_at: makeDate(100), strategy_keys: ['x'] }],
    dataUpdateLogs: [{ id: 1, created_at: makeDate(200) }],
    taskExecLogs: [{ id: 1, created_at: makeDate(200) }],
    alerts: [{ id: 1, created_at: makeDate(40), is_read: true }],
    trades: { 1: 5 },
    results: { 1: 1 },
    failBacktest: true,
  });
  const service = new CleanupOldDataService(ds);
  const result = await service.cleanup({ dryRun: false, asOfDate: ASOF });

  assertEqual('fail-isolation: backtest in errors', result.errors, ['quant_backtest_tasks']);
  // other 3 still succeeded
  assertEqual('fail-isolation: dul still cleaned', ds.state.dataUpdateLogs.length, 0);
  assertEqual('fail-isolation: tel still cleaned', ds.state.taskExecLogs.length, 0);
  assertEqual('fail-isolation: alerts still cleaned', ds.state.alerts.length, 0);
  // backtest target has error
  const bt = result.targets.find(t => t.target === 'quant_backtest_tasks');
  assert('fail-isolation: backtest has error msg', !!bt?.error);
  // backtest unchanged
  assertEqual('fail-isolation: backtest store unchanged', ds.state.backtests.length, 1);
}

async function testCleanupAllSucceedNothingStale(): Promise<void> {
  const ds = makeFakeDataSource({
    backtests: [{ id: 1, created_at: makeDate(5), strategy_keys: ['x'] }], // 5 < 90
    dataUpdateLogs: [{ id: 1, created_at: makeDate(5) }], // 5 < 180
    taskExecLogs: [{ id: 1, created_at: makeDate(5) }],
    alerts: [{ id: 1, created_at: makeDate(5), is_read: true }], // 5 < 30
  });
  const service = new CleanupOldDataService(ds);
  const result = await service.cleanup({ dryRun: false, asOfDate: ASOF });

  assertEqual('nothing stale: total=0', result.total_count, 0);
  assertEqual('nothing stale: cascade=0', result.total_cascade_count, 0);
  assertEqual('nothing stale: no errors', result.errors, []);
  // state unchanged
  assertEqual('nothing stale: backtests preserved', ds.state.backtests.length, 1);
  assertEqual('nothing stale: dul preserved', ds.state.dataUpdateLogs.length, 1);
  assertEqual('nothing stale: tel preserved', ds.state.taskExecLogs.length, 1);
  assertEqual('nothing stale: alerts preserved', ds.state.alerts.length, 1);
}

async function testCleanupOnlyUnreadAlerts(): Promise<void> {
  const ds = makeFakeDataSource({
    alerts: [
      { id: 1, created_at: makeDate(40), is_read: false },
      { id: 2, created_at: makeDate(100), is_read: false },
    ],
  });
  const service = new CleanupOldDataService(ds);
  const result = await service.cleanup({ dryRun: false, asOfDate: ASOF });
  const alertT = result.targets.find(t => t.target === 'risk_alerts');
  assertEqual('unread alerts not cleaned', alertT!.count, 0);
  assertEqual('unread alerts preserved', ds.state.alerts.length, 2);
}

async function testCleanupAllWhitelisted(): Promise<void> {
  const ds = makeFakeDataSource({
    backtests: [
      { id: 1, created_at: makeDate(100), strategy_keys: ['multi_factor_alpha'] },
      { id: 2, created_at: makeDate(100), strategy_keys: ['multi_factor_alpha'] },
    ],
    trades: { 1: 10, 2: 20 },
    results: { 1: 1, 2: 2 },
  });
  const service = new CleanupOldDataService(ds);
  const result = await service.cleanup({
    whitelistStrategies: ['multi_factor_alpha'],
    dryRun: false,
    asOfDate: ASOF,
  });
  const bt = result.targets.find(t => t.target === 'quant_backtest_tasks');
  assertEqual('all whitelisted: 0 deleted', bt!.count, 0);
  assertEqual('all whitelisted: 2 skipped', bt!.whitelist_skipped, 2);
  // executed=true even when nothing to do (deleteBacktestTasksCascade with [] still runs)
  // — actually for backtests, we still go to deleteBacktestTasksCascade with empty list,
  // which short-circuits, returns 0/0/0; executed=true
  assertEqual('all whitelisted: executed=true', bt!.executed, true);
  // state untouched
  assertEqual('all whitelisted: store untouched', ds.state.backtests.length, 2);
}

async function testCleanupInvalidThresholdsFallback(): Promise<void> {
  const ds = makeFakeDataSource({
    backtests: [{ id: 1, created_at: makeDate(100), strategy_keys: ['x'] }],
    dataUpdateLogs: [{ id: 1, created_at: makeDate(200) }],
    alerts: [{ id: 1, created_at: makeDate(40), is_read: true }],
  });
  const service = new CleanupOldDataService(ds);
  // Pass invalid thresholds → should fallback to defaults
  const result = await service.cleanup({
    backtestRetentionDays: -5 as any,
    logRetentionDays: 'abc' as any,
    alertRetentionDays: 0 as any,
    dryRun: false,
    asOfDate: ASOF,
  });

  // Should behave with defaults: 90/180/30
  // backtest 100d > 90 → 1 stale
  assertEqual('invalid threshold fallback: 1 backtest', result.targets[0].count, 1);
  // dul 200d > 180 → 1 stale
  assertEqual('invalid threshold fallback: 1 dul', result.targets[1].count, 1);
  // alert 40d > 30 → 1 stale
  assertEqual('invalid threshold fallback: 1 alert', result.targets[3].count, 1);
}

async function testCleanupExecutedCascadeWithNoStale(): Promise<void> {
  const ds = makeFakeDataSource({
    backtests: [{ id: 1, created_at: makeDate(5), strategy_keys: ['x'] }],
    trades: { 1: 100 }, // would-cascade but task is fresh
  });
  const service = new CleanupOldDataService(ds);
  const result = await service.cleanup({ dryRun: false, asOfDate: ASOF });
  const bt = result.targets.find(t => t.target === 'quant_backtest_tasks');
  assertEqual('no stale backtest: count=0', bt!.count, 0);
  assertEqual('no stale backtest: cascade=0', bt!.cascade_count, 0);
  // Fresh trade record preserved
  assertEqual('fresh trade record preserved', ds.state.trades[1], 100);
}

async function testCleanupExportedConstants(): Promise<void> {
  assertEqual('DEFAULT_BACKTEST_RETENTION_DAYS', DEFAULT_BACKTEST_RETENTION_DAYS, 90);
  assertEqual('DEFAULT_LOG_RETENTION_DAYS', DEFAULT_LOG_RETENTION_DAYS, 180);
  assertEqual('DEFAULT_ALERT_RETENTION_DAYS', DEFAULT_ALERT_RETENTION_DAYS, 30);
}

async function testCleanupBoundaryStrictLess(): Promise<void> {
  // 边界: cutoff strict < — created_at 恰等于 cutoff 时不删
  const ds = makeFakeDataSource({
    dataUpdateLogs: [
      { id: 1, created_at: makeDate(180) }, // 恰好 180 days, cutoff = asOf - 180 → created_at == cutoff → NOT delete (strict <)
      { id: 2, created_at: makeDate(181) }, // 181 > 180 → stale
    ],
  });
  const service = new CleanupOldDataService(ds);
  const result = await service.cleanup({ dryRun: false, asOfDate: ASOF });
  const dul = result.targets.find(t => t.target === 'data_update_logs');
  assertEqual('boundary strict <: only id=2 deleted', dul!.count, 1);
  assertEqual('boundary strict <: id=1 kept', ds.state.dataUpdateLogs.length, 1);
  assertEqual('boundary strict <: kept id', ds.state.dataUpdateLogs[0].id, 1);
}

async function main(): Promise<void> {
  console.log('CleanupOldDataService tests starting...');
  // pure helpers
  testNormalizeThresholdDays();
  testComputeCutoffDate();
  testToIsoDate();
  testIsWhitelistedTask();
  testNormalizeWhitelistStrategies();
  testPartitionBacktestTasksByWhitelist();
  // service e2e
  await testCleanupDefaultDryRun();
  await testCleanupExecuted();
  await testCleanupWithWhitelist();
  await testCleanupCustomThresholds();
  await testCleanupFailureIsolation();
  await testCleanupAllSucceedNothingStale();
  await testCleanupOnlyUnreadAlerts();
  await testCleanupAllWhitelisted();
  await testCleanupInvalidThresholdsFallback();
  await testCleanupExecutedCascadeWithNoStale();
  await testCleanupExportedConstants();
  await testCleanupBoundaryStrictLess();

  console.log('');
  console.log(`✓ passed: ${passed}`);
  console.log(`${failed > 0 ? '❌' : '✓'} failed: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error('fatal:', e);
  process.exit(1);
});
