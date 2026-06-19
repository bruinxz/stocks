/**
 * US-060 [FE-021] DataWorkspace 加厚 6 tab — 单元测试.
 *
 * 不依赖 jest / DB / 网络 / React; 直接跑:
 *   cd backend && npx ts-node --transpile-only tests/services/data-workspace-tab-helpers.test.ts
 *
 * 全部 import 自 frontend/src/pages/workspace/dataWorkspaceTabHelpers.ts
 * (pure helpers, 无 antd/react, ts-node 直接吃). 跨 monorepo import 用
 * 相对路径 `../../../frontend/...`, 与 [[industry-concentration-kpi-helpers]]
 * (US-057) / error-patterns-helpers (US-059) 同款模式.
 *
 * 覆盖维度:
 *   [1] 常量 / 配色 sanity
 *   [2] bucketCardsByCategory 分桶 (daily/periodic/event/未知类别忽略)
 *   [3] countSyncErrors / countFreshToday / sumRecordCount 数值边界
 *   [4] classifyOverallTag / classifySyncTag / classifyLogsTag 优先级
 *   [5] buildDataWorkspaceTabViewModel 6 个 tab AC 主验收 (每个 tab 都有真内容)
 *   [6] view model 边界 (null/undefined healthResponse / 未知 tabKey)
 *   [7] META-GUARD fs+regex 守 DataWorkspace.tsx 接通 helper, 不再用旧固定 KPI
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  DATA_HEALTH_COLOR,
  DATA_WORKSPACE_TAB_KEYS,
  STOCKS_UNIVERSE_HINT,
  SYNC_FRESH_MAX_LAG,
  SYNC_STALE_MAX_LAG,
  TAB_HEADLINE,
  TAB_SUBTITLE,
  bucketCardsByCategory,
  buildDataWorkspaceTabViewModel,
  classifyLogsTag,
  classifyOverallTag,
  classifySyncTag,
  countFreshToday,
  countSyncErrors,
  emptyBucket,
  sumRecordCount,
} from '../../../frontend/src/pages/workspace/dataWorkspaceTabHelpers';
import type {
  DataHealthStatusResponse,
  DataSourceHealthCard,
} from '../../../frontend/src/services/dataHealthService';

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

function makeCard(overrides: Partial<DataSourceHealthCard> = {}): DataSourceHealthCard {
  return {
    key: 'k1',
    display_name: '北向资金',
    category: 'daily',
    latest_data_date: '2026-06-19',
    last_sync_at: '2026-06-19T08:00:00Z',
    record_count: 1000,
    lag_trading_days: 0,
    level: 'green',
    sync_source: 'northbound',
    description: '北向资金日级数据',
    ...overrides,
  };
}

function makeResponse(cards: DataSourceHealthCard[]): DataHealthStatusResponse {
  const summary = { green: 0, yellow: 0, red: 0, unknown: 0 };
  for (const c of cards) {
    summary[c.level] = (summary[c.level] || 0) + 1;
  }
  return {
    reference_trade_date: '2026-06-19',
    cards,
    summary,
    generated_at: '2026-06-19T09:00:00Z',
  };
}

// ---- [1] 常量 / 配色 sanity ------------------------------------------------
assert('[1.1] DATA_WORKSPACE_TAB_KEYS 长度 = 6', DATA_WORKSPACE_TAB_KEYS.length === 6);
assert(
  '[1.2] 6 个 key 是固定枚举 health/stocks/sync/tasks/logs/monitoring',
  JSON.stringify([...DATA_WORKSPACE_TAB_KEYS]) ===
    JSON.stringify(['health', 'stocks', 'sync', 'tasks', 'logs', 'monitoring'])
);
assert('[1.3] DATA_HEALTH_COLOR.red 是 hex', /^#[0-9a-fA-F]{6}$/.test(DATA_HEALTH_COLOR.red));
assert('[1.4] DATA_HEALTH_COLOR.yellow 是 hex', /^#[0-9a-fA-F]{6}$/.test(DATA_HEALTH_COLOR.yellow));
assert('[1.5] DATA_HEALTH_COLOR.green 是 hex', /^#[0-9a-fA-F]{6}$/.test(DATA_HEALTH_COLOR.green));
assert(
  '[1.6] DATA_HEALTH_COLOR.unknown 是 hex',
  /^#[0-9a-fA-F]{6}$/.test(DATA_HEALTH_COLOR.unknown)
);
assert(
  '[1.7] DATA_HEALTH_COLOR 4 色互不相同',
  new Set([
    DATA_HEALTH_COLOR.red,
    DATA_HEALTH_COLOR.yellow,
    DATA_HEALTH_COLOR.green,
    DATA_HEALTH_COLOR.unknown,
  ]).size === 4
);
assert('[1.8] SYNC_FRESH_MAX_LAG = 0', SYNC_FRESH_MAX_LAG === 0);
assert('[1.9] SYNC_STALE_MAX_LAG = 3', SYNC_STALE_MAX_LAG === 3);
assert(
  '[1.10] SYNC_FRESH_MAX_LAG < SYNC_STALE_MAX_LAG (阈值 sanity)',
  SYNC_FRESH_MAX_LAG < SYNC_STALE_MAX_LAG
);
assert('[1.11] STOCKS_UNIVERSE_HINT > 0', STOCKS_UNIVERSE_HINT > 0);
assert(
  '[1.12] DATA_HEALTH_COLOR frozen',
  Object.isFrozen(DATA_HEALTH_COLOR) === true
);
assert('[1.13] TAB_HEADLINE 6 项', Object.keys(TAB_HEADLINE).length === 6);
assert('[1.14] TAB_SUBTITLE 6 项', Object.keys(TAB_SUBTITLE).length === 6);
for (const key of DATA_WORKSPACE_TAB_KEYS) {
  assert(`[1.15.${key}] TAB_HEADLINE.${key} 非空`, TAB_HEADLINE[key].length > 0);
  assert(`[1.16.${key}] TAB_SUBTITLE.${key} 非空`, TAB_SUBTITLE[key].length > 0);
}
assert('[1.17] TAB_HEADLINE frozen', Object.isFrozen(TAB_HEADLINE) === true);
assert('[1.18] TAB_SUBTITLE frozen', Object.isFrozen(TAB_SUBTITLE) === true);

// ---- [2] bucketCardsByCategory --------------------------------------------
{
  const cards: DataSourceHealthCard[] = [
    makeCard({ category: 'daily', level: 'green' }),
    makeCard({ category: 'daily', level: 'red' }),
    makeCard({ category: 'daily', level: 'yellow' }),
    makeCard({ category: 'periodic', level: 'green' }),
    makeCard({ category: 'event', level: 'unknown' }),
  ];
  const b = bucketCardsByCategory(cards);
  assert('[2.1] daily.total=3', b.daily.total === 3);
  assert('[2.2] daily.green=1', b.daily.green === 1);
  assert('[2.3] daily.red=1', b.daily.red === 1);
  assert('[2.4] daily.yellow=1', b.daily.yellow === 1);
  assert('[2.5] periodic.total=1', b.periodic.total === 1);
  assert('[2.6] periodic.green=1', b.periodic.green === 1);
  assert('[2.7] event.total=1', b.event.total === 1);
  assert('[2.8] event.unknown=1', b.event.unknown === 1);
}
{
  const empty = bucketCardsByCategory([]);
  assert('[2.9] 空数组 → 三类全 0', empty.daily.total === 0 && empty.periodic.total === 0 && empty.event.total === 0);
}
{
  // 异常输入: 非数组 / null / undefined
  // @ts-expect-error 测试非法输入
  const b1 = bucketCardsByCategory(null);
  assert('[2.10] null 输入 → 三类全 0 不抛', b1.daily.total === 0);
  // @ts-expect-error 测试非法输入
  const b2 = bucketCardsByCategory(undefined);
  assert('[2.11] undefined 输入 → 三类全 0', b2.daily.total === 0);
  // @ts-expect-error 测试未知 category 被忽略
  const b3 = bucketCardsByCategory([makeCard({ category: 'bogus' as any })]);
  assert('[2.12] 未知 category 被忽略 (不计入 daily)', b3.daily.total === 0);
}
{
  // null card / 字段缺失
  // @ts-expect-error 测试 null card
  const b = bucketCardsByCategory([null, undefined, makeCard()]);
  assert('[2.13] null/undefined card 被跳过, 只剩 daily.total=1', b.daily.total === 1);
}
{
  const eb = emptyBucket();
  assert(
    '[2.14] emptyBucket 字段全 0',
    eb.total === 0 && eb.red === 0 && eb.yellow === 0 && eb.green === 0 && eb.unknown === 0
  );
}

// ---- [3] countSyncErrors / countFreshToday / sumRecordCount ---------------
{
  const cards = [
    makeCard({ error: 'DB timeout' }),
    makeCard({ error: '' }),
    makeCard(),
    makeCard({ error: 'unknown' }),
  ];
  assert('[3.1] countSyncErrors 仅算非空 error', countSyncErrors(cards) === 2);
}
assert('[3.2] countSyncErrors([])=0', countSyncErrors([]) === 0);
// @ts-expect-error 测试非法输入
assert('[3.3] countSyncErrors(null)=0', countSyncErrors(null) === 0);
{
  const cards = [
    makeCard({ category: 'daily', lag_trading_days: 0 }), // fresh
    makeCard({ category: 'daily', lag_trading_days: 1 }),
    makeCard({ category: 'daily', lag_trading_days: -1 }), // < 0 也算 fresh
    makeCard({ category: 'daily', lag_trading_days: null }), // null 不算
    makeCard({ category: 'periodic', lag_trading_days: 0 }), // periodic 不算
    makeCard({ category: 'daily', lag_trading_days: Number.NaN }),
  ];
  assert('[3.4] countFreshToday 仅 daily + lag<=0 + finite', countFreshToday(cards) === 2);
}
assert('[3.5] countFreshToday([])=0', countFreshToday([]) === 0);
// @ts-expect-error 测试非法输入
assert('[3.6] countFreshToday(undefined)=0', countFreshToday(undefined) === 0);
{
  const cards = [
    makeCard({ record_count: 100 }),
    makeCard({ record_count: 200 }),
    makeCard({ record_count: 0 }),
    makeCard({ record_count: -5 }), // 负值丢
    makeCard({ record_count: Number.NaN as unknown as number }),
  ];
  assert('[3.7] sumRecordCount=300', sumRecordCount(cards) === 300);
}
assert('[3.8] sumRecordCount([])=0', sumRecordCount([]) === 0);

// ---- [4] classifyOverallTag / classifySyncTag / classifyLogsTag -----------
{
  // overall: red > yellow > unknown > green priority
  const tag1 = classifyOverallTag({ green: 0, yellow: 0, red: 2, unknown: 0 }, 5);
  assert('[4.1] red > 0 → red color', tag1.color === 'red');
  assert('[4.2] red 文案含 严重滞后', tag1.text.includes('严重滞后'));
  const tag2 = classifyOverallTag({ green: 0, yellow: 3, red: 0, unknown: 0 }, 5);
  assert('[4.3] 仅 yellow → orange', tag2.color === 'orange');
  const tag3 = classifyOverallTag({ green: 0, yellow: 0, red: 0, unknown: 2 }, 5);
  assert('[4.4] 仅 unknown → default', tag3.color === 'default');
  const tag4 = classifyOverallTag({ green: 5, yellow: 0, red: 0, unknown: 0 }, 5);
  assert('[4.5] 全 green → green', tag4.color === 'green');
  const tag5 = classifyOverallTag(null, 0);
  assert('[4.6] summary null + 0 cards → default 未注册', tag5.color === 'default' && tag5.text.includes('尚未注册'));
}
{
  const daily = { total: 5, red: 0, yellow: 2, green: 3, unknown: 0 };
  const tag = classifySyncTag(daily, 1);
  assert('[4.7] sync syncErrors > 0 优先级最高 → red', tag.color === 'red' && tag.text.includes('同步链路异常'));
  const tag2 = classifySyncTag(daily, 0);
  assert('[4.8] sync yellow 但无 syncError → orange', tag2.color === 'orange');
  const tag3 = classifySyncTag({ total: 5, red: 1, yellow: 0, green: 4, unknown: 0 }, 0);
  assert('[4.9] sync red > 0 → red', tag3.color === 'red');
  const tag4 = classifySyncTag({ total: 0, red: 0, yellow: 0, green: 0, unknown: 0 }, 0);
  assert('[4.10] sync daily total=0 → default 尚无日级源', tag4.color === 'default');
  const tag5 = classifySyncTag({ total: 3, red: 0, yellow: 0, green: 3, unknown: 0 }, 0);
  assert('[4.11] sync 全绿 → green', tag5.color === 'green');
}
{
  assert('[4.12] logs syncErrors>0 → red', classifyLogsTag(2, 0).color === 'red');
  assert('[4.13] logs unknown>0 → orange', classifyLogsTag(0, 1).color === 'orange');
  assert('[4.14] logs 全无 → green', classifyLogsTag(0, 0).color === 'green');
}

// ---- [5] buildDataWorkspaceTabViewModel 6 个 tab AC 主验收 -----------------
{
  const resp = makeResponse([
    makeCard({ key: 'a', category: 'daily', level: 'green', lag_trading_days: 0, record_count: 100 }),
    makeCard({ key: 'b', category: 'daily', level: 'red', lag_trading_days: 5, record_count: 500 }),
    makeCard({ key: 'c', category: 'periodic', level: 'green', record_count: 200 }),
    makeCard({ key: 'd', category: 'event', level: 'unknown', record_count: 50, error: 'fetch failed' }),
  ]);

  // [5.health] -----------------------------------------------------------
  const vm1 = buildDataWorkspaceTabViewModel('health', resp);
  assert('[5.h.1] health tabKey 对', vm1.tabKey === 'health');
  assert('[5.h.2] health headline 是 数据源健康度', vm1.headline === TAB_HEADLINE.health);
  assert('[5.h.3] health loading=false', vm1.loading === false);
  assert('[5.h.4] health KPI 5 个 (参考日 + 4 级 level)', vm1.kpis.length === 5);
  assert('[5.h.5] health KPI 含 参考交易日', vm1.kpis[0].title === '参考交易日' && vm1.kpis[0].value === '2026-06-19');
  assert('[5.h.6] health 红 KPI valueColor 红', vm1.kpis[3].title === '严重滞后' && vm1.kpis[3].color === DATA_HEALTH_COLOR.red);
  assert('[5.h.7] health tag.color 是 red (有 1 个红)', vm1.tag !== null && vm1.tag.color === 'red');

  // [5.stocks] ----------------------------------------------------------
  const vm2 = buildDataWorkspaceTabViewModel('stocks', resp);
  assert('[5.s.1] stocks tabKey 对', vm2.tabKey === 'stocks');
  assert('[5.s.2] stocks headline 是 个股趋势浏览器', vm2.headline === TAB_HEADLINE.stocks);
  assert('[5.s.3] stocks KPI 含 本地数据源 = 4 个', vm2.kpis[0].title === '本地数据源' && vm2.kpis[0].value === 4);
  assert('[5.s.4] stocks KPI 含 日级源 = 2', vm2.kpis[1].title === '日级源' && vm2.kpis[1].value === 2);
  assert('[5.s.5] stocks 累计记录 = 850', vm2.kpis[2].title === '累计记录' && vm2.kpis[2].value === 850);
  assert(
    '[5.s.6] stocks 宇宙规模 KPI 显式',
    vm2.kpis[3].title === '宇宙规模 (估)' && vm2.kpis[3].value === STOCKS_UNIVERSE_HINT
  );
  assert('[5.s.7] stocks 日级红 → tag.color red', vm2.tag !== null && vm2.tag.color === 'red');

  // [5.sync] -----------------------------------------------------------
  const vm3 = buildDataWorkspaceTabViewModel('sync', resp);
  assert('[5.sy.1] sync tabKey 对', vm3.tabKey === 'sync');
  assert('[5.sy.2] sync KPI 含 今日新鲜=1', vm3.kpis[2].title === '今日新鲜' && vm3.kpis[2].value === 1);
  assert('[5.sy.3] sync KPI 含 同步异常=1', vm3.kpis[3].title === '同步异常' && vm3.kpis[3].value === 1);
  assert('[5.sy.4] sync 同步异常 → tag.red (优先级最高)', vm3.tag !== null && vm3.tag.color === 'red');

  // [5.tasks] ----------------------------------------------------------
  const vm4 = buildDataWorkspaceTabViewModel('tasks', resp);
  assert('[5.t.1] tasks tabKey 对', vm4.tabKey === 'tasks');
  assert('[5.t.2] tasks KPI 4 项 (注册+日级+周期+事件)', vm4.kpis.length === 4);
  assert('[5.t.3] tasks 已注册 = 4', vm4.kpis[0].value === 4);
  assert('[5.t.4] tasks 日级=2 / 周期=1 / 事件=1', vm4.kpis[1].value === 2 && vm4.kpis[2].value === 1 && vm4.kpis[3].value === 1);
  assert('[5.t.5] tasks 同步异常 → tag.red', vm4.tag !== null && vm4.tag.color === 'red');

  // [5.logs] -----------------------------------------------------------
  const vm5 = buildDataWorkspaceTabViewModel('logs', resp);
  assert('[5.l.1] logs tabKey 对', vm5.tabKey === 'logs');
  assert('[5.l.2] logs KPI 3 项 (同步异常+滞后告警+状态未知)', vm5.kpis.length === 3);
  assert('[5.l.3] logs 同步异常=1', vm5.kpis[0].value === 1);
  assert('[5.l.4] logs 滞后告警=1 (1 red)', vm5.kpis[1].value === 1);
  assert('[5.l.5] logs 状态未知=1', vm5.kpis[2].value === 1);
  assert('[5.l.6] logs syncErrors > 0 → tag.red', vm5.tag !== null && vm5.tag.color === 'red');

  // [5.monitoring] -----------------------------------------------------
  const vm6 = buildDataWorkspaceTabViewModel('monitoring', resp);
  assert('[5.m.1] monitoring tabKey 对', vm6.tabKey === 'monitoring');
  assert('[5.m.2] monitoring KPI 4 项 (参考+总源+不健康+健康率)', vm6.kpis.length === 4);
  assert('[5.m.3] monitoring 总数据源=4', vm6.kpis[1].value === 4);
  // 健康率 = green(2) / total(4) = 50%
  assert('[5.m.4] monitoring 健康率 = 50', vm6.kpis[3].value === 50);
  assert('[5.m.5] monitoring 不健康 = 2 (red+yellow+unknown = 1+0+1)', vm6.kpis[2].value === 2);
}

// ---- [6] view model 边界 --------------------------------------------------
{
  const vm = buildDataWorkspaceTabViewModel('health', null);
  assert('[6.1] null healthResponse → loading=true', vm.loading === true);
  assert('[6.2] loading 时 KPI 占位', vm.kpis.length === 1 && vm.kpis[0].value === '—');
  assert('[6.3] loading 时 headline 仍渲染', vm.headline === TAB_HEADLINE.health);
  assert('[6.4] loading 时 tag = null', vm.tag === null);
}
{
  const vm = buildDataWorkspaceTabViewModel('health', undefined);
  assert('[6.5] undefined healthResponse → loading=true', vm.loading === true);
}
{
  // 未知 tabKey fallback 到 health
  // @ts-expect-error 测试非法 key
  const vm = buildDataWorkspaceTabViewModel('bogus', null);
  assert('[6.6] 未知 key fallback 到 health', vm.tabKey === 'health');
}
{
  // 空 cards 数组但非 null response
  const resp = makeResponse([]);
  const vm = buildDataWorkspaceTabViewModel('monitoring', resp);
  assert('[6.7] 空 cards 时 monitoring 健康率 = "—" (避免 0/0=NaN)', vm.kpis[3].value === '—');
  assert('[6.8] 空 cards 时 monitoring 健康率 suffix 缺省', vm.kpis[3].suffix === undefined);
  const vm2 = buildDataWorkspaceTabViewModel('health', resp);
  assert('[6.9] 空 cards 时 health tag = 未注册', vm2.tag !== null && vm2.tag.text.includes('尚未注册'));
}
{
  // cards 含 NaN/null 字段不抛
  const resp = makeResponse([
    makeCard({ record_count: Number.NaN as unknown as number, lag_trading_days: null }),
  ]);
  const vm = buildDataWorkspaceTabViewModel('stocks', resp);
  assert('[6.10] 异常字段 cards stocks 不抛', vm.tabKey === 'stocks');
  assert('[6.11] 异常字段 sumRecord=0', vm.kpis[2].value === 0);
}
{
  // 同输入同输出 (useMemo 友好)
  const resp = makeResponse([makeCard()]);
  const vm1 = buildDataWorkspaceTabViewModel('sync', resp);
  const vm2 = buildDataWorkspaceTabViewModel('sync', resp);
  assert('[6.12] 同输入同输出 (KPI 长度)', vm1.kpis.length === vm2.kpis.length);
  assert('[6.13] 同输入同输出 (KPI[0].value)', vm1.kpis[0].value === vm2.kpis[0].value);
}

// ---- [7] META-GUARD fs+regex ----------------------------------------------
{
  const workspacePath = join(__dirname, '../../../frontend/src/pages/workspace/DataWorkspace.tsx');
  const src = readFileSync(workspacePath, 'utf8');
  assert(
    '[7.1] DataWorkspace.tsx import buildDataWorkspaceTabViewModel',
    /import\s*\{[\s\S]*?buildDataWorkspaceTabViewModel[\s\S]*?\}\s*from\s*['"]\.\/dataWorkspaceTabHelpers['"]/.test(
      src
    )
  );
  assert(
    '[7.2] DataWorkspace.tsx 调用 buildDataWorkspaceTabViewModel',
    /buildDataWorkspaceTabViewModel\(activeKey,\s*healthData\)/.test(src)
  );
  assert(
    '[7.3] DataWorkspace.tsx 用 vm.kpis.map (KPI strip 走 view model)',
    /vm\.kpis\.map/.test(src)
  );
  assert(
    '[7.4] DataWorkspace.tsx 用 vm.tag 决定 headerActions',
    /vm\.tag/.test(src)
  );
  assert(
    '[7.5] DataWorkspace.tsx 不再 inline 写 kpi.red === undefined 旧式 setKpi 三态',
    !/setKpi\(\s*\{\s*total:/.test(src)
  );
  assert(
    '[7.6] DataWorkspace.tsx 不再 hardcode 旧 "数据源 / 严重滞后 / 轻微滞后" 三件套',
    !/title="数据源"\s+value=\{kpi\.total\}/.test(src)
  );
  assert(
    '[7.7] DataWorkspace.tsx 仍渲染 6 个 tab key (覆盖 6 tab 真内容)',
    /key:\s*'health'/.test(src) &&
      /key:\s*'stocks'/.test(src) &&
      /key:\s*'sync'/.test(src) &&
      /key:\s*'tasks'/.test(src) &&
      /key:\s*'logs'/.test(src) &&
      /key:\s*'monitoring'/.test(src)
  );
  assert(
    '[7.8] DataWorkspace.tsx 渲染 overviewBar (data-testid=data-workspace-overview-)',
    /data-testid=\{?`?data-workspace-overview-/.test(src)
  );
  assert(
    '[7.9] DataWorkspace.tsx import DataHealthStatusResponse (state 类型)',
    /import\s+(?:type\s+)?\{[^}]*DataHealthStatusResponse[^}]*\}/.test(src)
  );
}
{
  const helperPath = join(
    __dirname,
    '../../../frontend/src/pages/workspace/dataWorkspaceTabHelpers.ts'
  );
  const src = readFileSync(helperPath, 'utf8');
  assert(
    '[7.10] helper export DATA_WORKSPACE_TAB_KEYS',
    /export\s+const\s+DATA_WORKSPACE_TAB_KEYS\s*=/.test(src)
  );
  assert('[7.11] helper export DATA_HEALTH_COLOR', /export\s+const\s+DATA_HEALTH_COLOR\b/.test(src));
  assert('[7.12] helper export SYNC_FRESH_MAX_LAG', /export\s+const\s+SYNC_FRESH_MAX_LAG\b/.test(src));
  assert('[7.13] helper export TAB_HEADLINE', /export\s+const\s+TAB_HEADLINE\b/.test(src));
  assert('[7.14] helper export TAB_SUBTITLE', /export\s+const\s+TAB_SUBTITLE\b/.test(src));
  assert(
    '[7.15] helper export buildDataWorkspaceTabViewModel',
    /export\s+function\s+buildDataWorkspaceTabViewModel/.test(src)
  );
  assert(
    '[7.16] helper export bucketCardsByCategory',
    /export\s+function\s+bucketCardsByCategory/.test(src)
  );
  assert('[7.17] helper export classifyOverallTag', /export\s+function\s+classifyOverallTag/.test(src));
  assert('[7.18] helper export classifySyncTag', /export\s+function\s+classifySyncTag/.test(src));
  assert('[7.19] helper export classifyLogsTag', /export\s+function\s+classifyLogsTag/.test(src));
}

// ---- summary ---------------------------------------------------------------
console.log(`\ndata-workspace-tab-helpers: ${passed} ok / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
