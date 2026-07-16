/**
 * US-072 [FE-033] AlertItem snooze + 一键执行 — pure helper 单元测试.
 *
 * 跑法:
 *   cd backend && npx ts-node --transpile-only tests/services/alert-item-action-helpers.test.ts
 * 或:
 *   cd backend && npm test -- --filter=alert-item-action
 *
 * 跨 monorepo import (../../../frontend) — 与 [[alerts-bell-helpers.test.ts]]
 * (US-070) / [[alerts-panel-helpers.test.ts]] (US-071) / strategyKillSwitchHelpers /
 * shadowRunHelpers / overfit-metrics 同款"前端 pure helper 跨 monorepo 单测"
 * 范式. 阈值 / 决策表 / 兜底 sanity 全在 helper 文件里 export, 单测 import 直接守.
 *
 * 覆盖维度:
 *   [1] 常量 sanity (SNOOZE_DURATION_MS 与 LABEL/ORDER 三表对齐 + ms 数值正确)
 *   [2] computeSnoozeUntil: now + ms / 兜底非法 duration / 非法 now
 *   [3] isAlertSnoozed: until > now / until <= now / 缺 entry / null map / null id
 *   [4] addSnooze / removeSnooze: 不可变 / 覆盖 / 不存在 id remove
 *   [5] pruneExpiredSnoozes: 全过期 / 部分过期 / 全有效 / 空
 *   [6] filterOutSnoozedAlerts: 空 map 短路 / 部分 snooze / 全 snooze / null items
 *   [7] readSnoozeMap / writeSnoozeMap: 读写回环 / 脏数据 fail-OPEN / quota 失败返 false
 *   [8] buildAlertActionDescriptor: 4 category × symbol 合法/非法 决策表
 *   [9] looksLikeAShareSymbol: 6 位 / .SH/.SZ/.BJ / 非法前缀 / 空
 *  [10] formatSnoozeRemaining: 4 档时间格式化
 *  [11] META-GUARD fs+regex 守 helper exports + descriptor 目标均为当前 App 有效路由
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  ALERT_ACTION_LABEL,
  SNOOZE_DURATION_LABEL,
  SNOOZE_DURATION_MS,
  SNOOZE_DURATION_ORDER,
  SNOOZE_STORAGE_KEY,
  type SnoozeMap,
  type SnoozeStorage,
  addSnooze,
  buildAlertActionDescriptor,
  computeSnoozeUntil,
  filterOutSnoozedAlerts,
  formatSnoozeRemaining,
  isAlertSnoozed,
  looksLikeAShareSymbol,
  pruneExpiredSnoozes,
  readSnoozeMap,
  removeSnooze,
  writeSnoozeMap,
} from '../../../frontend/src/pages/workspace/alertItemActionHelpers';
import type { EnrichedAlert } from '../../../frontend/src/pages/workspace/alertsPanelHelpers';

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

// ============================================================
// [1] 常量 sanity
// ============================================================
assert('[1.1] SNOOZE_DURATION_ORDER 含 3 档', SNOOZE_DURATION_ORDER.length === 3);
assert(
  '[1.2] SNOOZE_DURATION_ORDER 顺序 1h→1d→1w',
  SNOOZE_DURATION_ORDER[0] === '1h' &&
    SNOOZE_DURATION_ORDER[1] === '1d' &&
    SNOOZE_DURATION_ORDER[2] === '1w'
);
assert('[1.3] SNOOZE_DURATION_MS 1h = 3,600,000', SNOOZE_DURATION_MS['1h'] === 3_600_000);
assert('[1.4] SNOOZE_DURATION_MS 1d = 86,400,000', SNOOZE_DURATION_MS['1d'] === 86_400_000);
assert('[1.5] SNOOZE_DURATION_MS 1w = 604,800,000', SNOOZE_DURATION_MS['1w'] === 604_800_000);
assert(
  '[1.6] SNOOZE_DURATION_LABEL 含 1h/1d/1w 三档',
  Object.keys(SNOOZE_DURATION_LABEL).length === 3 &&
    SNOOZE_DURATION_LABEL['1h'].includes('1') &&
    SNOOZE_DURATION_LABEL['1d'].includes('1') &&
    SNOOZE_DURATION_LABEL['1w'].includes('1')
);
assert(
  '[1.7] ALERT_ACTION_LABEL 4 category 齐全',
  Object.keys(ALERT_ACTION_LABEL).length === 4 &&
    typeof ALERT_ACTION_LABEL.position === 'string' &&
    typeof ALERT_ACTION_LABEL.market === 'string' &&
    typeof ALERT_ACTION_LABEL.individual === 'string' &&
    typeof ALERT_ACTION_LABEL.data === 'string'
);
assert(
  '[1.8] SNOOZE_STORAGE_KEY 含 alertItem 前缀',
  typeof SNOOZE_STORAGE_KEY === 'string' && SNOOZE_STORAGE_KEY.startsWith('alertItem')
);

// ============================================================
// [2] computeSnoozeUntil
// ============================================================
assert(
  '[2.1] computeSnoozeUntil 1h = now + 1h ms',
  computeSnoozeUntil(1_000_000, '1h') === 1_000_000 + 3_600_000
);
assert(
  '[2.2] computeSnoozeUntil 1d = now + 1d ms',
  computeSnoozeUntil(0, '1d') === 86_400_000
);
assert(
  '[2.3] computeSnoozeUntil 1w = now + 1w ms',
  computeSnoozeUntil(0, '1w') === 604_800_000
);
assert(
  '[2.4] computeSnoozeUntil 非法 duration 兜底 1h',
  computeSnoozeUntil(1000, 'wat' as never) === 1000 + 3_600_000
);
assert(
  '[2.5] computeSnoozeUntil 非法 now 兜底 0',
  computeSnoozeUntil(NaN as number, '1h') === 3_600_000
);

// ============================================================
// [3] isAlertSnoozed
// ============================================================
{
  const map: SnoozeMap = {
    '10': { duration: '1h', until: 5000 },
    '11': { duration: '1d', until: 100 },
  };
  assert('[3.1] until > now → true', isAlertSnoozed(10, map, 1000));
  assert('[3.2] until <= now → false', !isAlertSnoozed(11, map, 1000));
  assert('[3.3] 缺 entry → false', !isAlertSnoozed(999, map, 1000));
  assert('[3.4] map=null → false', !isAlertSnoozed(10, null, 1000));
  assert('[3.5] id=null → false', !isAlertSnoozed(null, map, 1000));
  assert('[3.6] string id 同 number id 同效果', isAlertSnoozed('10', map, 1000));
  assert(
    '[3.7] now=NaN 兜底 0, until>0 仍 true',
    isAlertSnoozed(10, map, NaN as number)
  );
}

// ============================================================
// [4] addSnooze / removeSnooze
// ============================================================
{
  const prev: SnoozeMap = { '1': { duration: '1h', until: 100 } };
  const next = addSnooze(prev, 2, '1d', 1000);
  assert('[4.1] addSnooze 新 id 含 entry', next['2']?.duration === '1d');
  assert('[4.2] addSnooze immutable — prev 未动', prev['2'] === undefined);
  assert(
    '[4.3] addSnooze 同 id 覆盖',
    addSnooze(prev, 1, '1w', 1000)['1'].duration === '1w'
  );
  assert(
    '[4.4] addSnooze prev=null 返新 map',
    addSnooze(null, 5, '1h', 1000)['5'].duration === '1h'
  );

  const removed = removeSnooze(prev, 1);
  assert('[4.5] removeSnooze 删除 id', !('1' in removed));
  assert('[4.6] removeSnooze immutable', '1' in prev);
  assert(
    '[4.7] removeSnooze 不存在 id 仍返 copy',
    removeSnooze(prev, 999)['1']?.duration === '1h'
  );
  assert('[4.8] removeSnooze prev=null → {}', Object.keys(removeSnooze(null, 1)).length === 0);
}

// ============================================================
// [5] pruneExpiredSnoozes
// ============================================================
{
  const map: SnoozeMap = {
    '1': { duration: '1h', until: 100 },
    '2': { duration: '1d', until: 5000 },
    '3': { duration: '1w', until: 50 },
  };
  const pruned = pruneExpiredSnoozes(map, 1000);
  assert('[5.1] 过期 entry 被剔', !('1' in pruned) && !('3' in pruned));
  assert('[5.2] 未过期保留', '2' in pruned);
  assert(
    '[5.3] 全过期 → {}',
    Object.keys(pruneExpiredSnoozes(map, 999_999_999)).length === 0
  );
  assert(
    '[5.4] 全有效保留',
    Object.keys(pruneExpiredSnoozes(map, 0)).length === 3
  );
  assert('[5.5] map=null → {}', Object.keys(pruneExpiredSnoozes(null, 1000)).length === 0);
}

// ============================================================
// [6] filterOutSnoozedAlerts
// ============================================================
{
  const items: EnrichedAlert[] = [
    {
      id: 1,
      user_id: 1,
      symbol: 'SH600000',
      name: 'A',
      level: 'HIGH',
      message: 'm',
      is_read: false,
      created_at: '2026-06-20',
      updated_at: '2026-06-20',
      derived_level: 'HIGH',
      derived_category: 'individual',
    },
    {
      id: 2,
      user_id: 1,
      symbol: 'SH600001',
      name: 'B',
      level: 'LOW',
      message: 'm',
      is_read: false,
      created_at: '2026-06-20',
      updated_at: '2026-06-20',
      derived_level: 'LOW',
      derived_category: 'position',
    },
  ];
  const map: SnoozeMap = { '1': { duration: '1h', until: 5000 } };
  const out = filterOutSnoozedAlerts(items, map, 1000);
  assert('[6.1] snooze 的 id=1 被剔', out.length === 1 && out[0].id === 2);
  assert(
    '[6.2] 空 map 短路返全集',
    filterOutSnoozedAlerts(items, {}, 1000).length === 2
  );
  assert(
    '[6.3] map=null 短路返全集',
    filterOutSnoozedAlerts(items, null, 1000).length === 2
  );
  assert('[6.4] items=null → []', filterOutSnoozedAlerts(null, map, 1000).length === 0);
  assert(
    '[6.5] 全 snooze',
    filterOutSnoozedAlerts(items, { '1': { duration: '1h', until: 5000 }, '2': { duration: '1h', until: 5000 } }, 1000).length === 0
  );
}

// ============================================================
// [7] readSnoozeMap / writeSnoozeMap with fake storage
// ============================================================
function makeFakeStorage(initial: Record<string, string> = {}): {
  storage: SnoozeStorage;
  data: Record<string, string>;
  removed: string[];
  failWrite?: boolean;
} {
  const data: Record<string, string> = { ...initial };
  const removed: string[] = [];
  const obj = {
    data,
    removed,
    failWrite: false as boolean,
    storage: {
      getItem: (k: string) => (k in data ? data[k] : null),
      setItem(k: string, v: string) {
        if (obj.failWrite) throw new Error('quota');
        data[k] = v;
      },
      removeItem(k: string) {
        removed.push(k);
        delete data[k];
      },
    } as SnoozeStorage,
  };
  return obj;
}

{
  const fake = makeFakeStorage();
  const ok = writeSnoozeMap({ '1': { duration: '1h', until: 999 } }, fake.storage);
  assert('[7.1] writeSnoozeMap 成功返 true', ok === true);
  const back = readSnoozeMap(fake.storage);
  assert('[7.2] readSnoozeMap 回环', back['1']?.until === 999 && back['1']?.duration === '1h');
}
{
  const fake = makeFakeStorage({ [SNOOZE_STORAGE_KEY]: '{ this is not json' });
  const out = readSnoozeMap(fake.storage);
  assert('[7.3] 脏 JSON fail-OPEN 返 {}', Object.keys(out).length === 0);
  assert('[7.4] 脏 JSON 顺手清', fake.removed.includes(SNOOZE_STORAGE_KEY));
}
{
  const fake = makeFakeStorage({ [SNOOZE_STORAGE_KEY]: '"not_an_object"' });
  assert('[7.5] 非 object JSON 返 {}', Object.keys(readSnoozeMap(fake.storage)).length === 0);
}
{
  const fake = makeFakeStorage({
    [SNOOZE_STORAGE_KEY]: JSON.stringify({
      '1': { duration: '1h', until: 'wat' },
      '2': { duration: 'bad', until: 100 },
      '3': { duration: '1w', until: 100 },
    }),
  });
  const out = readSnoozeMap(fake.storage);
  assert('[7.6] 脏 entry 被跳, 合法保留', !('1' in out) && !('2' in out) && '3' in out);
}
{
  const fake = makeFakeStorage();
  fake.failWrite = true;
  const ok = writeSnoozeMap({ '1': { duration: '1h', until: 1 } }, fake.storage);
  assert('[7.7] quota throw → fail-OPEN 返 false', ok === false);
}
{
  // null storage (window 不存在的 SSR / 测试 jsdom 关掉) 返 {}
  const nullStorage: SnoozeStorage = {
    getItem: () => null,
    setItem: () => {
      /* */
    },
    removeItem: () => {
      /* */
    },
  };
  assert('[7.8] null storage 返 {}', Object.keys(readSnoozeMap(nullStorage)).length === 0);
  assert('[7.9] null storage write ok 返 true', writeSnoozeMap({}, nullStorage) === true);
}

// ============================================================
// [8] buildAlertActionDescriptor 决策表
// ============================================================
function mkAlert(
  cat: EnrichedAlert['derived_category'],
  symbol: string
): EnrichedAlert {
  return {
    id: 1,
    user_id: 1,
    symbol,
    name: 'x',
    level: 'HIGH',
    message: 'm',
    is_read: false,
    created_at: '2026-06-20',
    updated_at: '2026-06-20',
    derived_level: 'HIGH',
    derived_category: cat,
  };
}
{
  const d = buildAlertActionDescriptor(mkAlert('individual', '600000'));
  assert('[8.1] individual+合法 → /stock/600000', d.href === '/stock/600000');
  assert('[8.1b] actionType=open_stock_detail', d.actionType === 'open_stock_detail');
  assert('[8.1c] markReadOnAction=false (保留未读以便细看)', d.markReadOnAction === false);
}
{
  const d = buildAlertActionDescriptor(mkAlert('individual', '600000.SH'));
  assert('[8.2] individual+ .SH 后缀 → /stock/600000.SH', d.href === '/stock/600000.SH');
}
{
  const d = buildAlertActionDescriptor(mkAlert('individual', 'SYSTEM:disk_full'));
  assert(
    '[8.3] individual+SYSTEM: → 降级 CatDesk',
    d.href === '/catdesk' && d.actionType === 'open_risk_center'
  );
  assert('[8.3b] 降级 markRead=true', d.markReadOnAction === true);
}
{
  const d = buildAlertActionDescriptor(mkAlert('position', '600000'));
  assert('[8.4] position → /catdesk（PortfolioWorkspace 已删）', d.href === '/catdesk');
  assert('[8.4b] actionType=open_position_review', d.actionType === 'open_position_review');
}
{
  const d = buildAlertActionDescriptor(mkAlert('market', '600000'));
  assert('[8.5] market → /catdesk', d.href === '/catdesk');
  assert('[8.5b] actionType=open_risk_center', d.actionType === 'open_risk_center');
}
{
  const d = buildAlertActionDescriptor(mkAlert('data', '600000'));
  assert('[8.6] data → /workspace/data', d.href === '/workspace/data');
  assert('[8.6b] actionType=open_data_center', d.actionType === 'open_data_center');
}

// ============================================================
// [9] looksLikeAShareSymbol
// ============================================================
assert('[9.1] 6 位数字 valid', looksLikeAShareSymbol('600000'));
assert('[9.2] .SH 后缀 valid', looksLikeAShareSymbol('600000.SH'));
assert('[9.3] .SZ 后缀 valid', looksLikeAShareSymbol('000001.SZ'));
assert('[9.4] .BJ 后缀 valid', looksLikeAShareSymbol('830000.BJ'));
assert('[9.5] 小写 .sh valid', looksLikeAShareSymbol('600000.sh'));
assert('[9.6] SYSTEM: 前缀 invalid', !looksLikeAShareSymbol('SYSTEM:foo'));
assert('[9.7] DATA: 前缀 invalid', !looksLikeAShareSymbol('DATA:foo'));
assert('[9.8] 空串 invalid', !looksLikeAShareSymbol(''));
assert('[9.9] null invalid', !looksLikeAShareSymbol(null));
assert('[9.10] 5 位数字 invalid (A 股 6 位)', !looksLikeAShareSymbol('60000'));
assert('[9.11] 7 位数字 invalid', !looksLikeAShareSymbol('6000000'));
assert('[9.12] 字母 invalid', !looksLikeAShareSymbol('AAPL'));

// ============================================================
// [10] formatSnoozeRemaining
// ============================================================
assert(
  '[10.1] < 60s → 即将解除',
  formatSnoozeRemaining(1000, 1000 + 30 * 1000) === '即将解除'
);
assert(
  '[10.2] < 60min → N 分钟后解除',
  formatSnoozeRemaining(0, 30 * 60 * 1000).includes('分钟后')
);
assert(
  '[10.3] < 24h → N 小时后解除',
  formatSnoozeRemaining(0, 3 * 60 * 60 * 1000).includes('小时后')
);
assert(
  '[10.4] >= 24h → N 天后解除',
  formatSnoozeRemaining(0, 3 * 24 * 60 * 60 * 1000).includes('天后')
);
assert(
  '[10.5] until < now → 即将解除 (兜底 0)',
  formatSnoozeRemaining(1000, 500) === '即将解除'
);
assert(
  '[10.6] NaN 兜底',
  formatSnoozeRemaining(NaN as number, NaN as number) === '即将解除'
);
{
  // 1d snooze 立刻看应是 "24 小时后" 或 "1 天后" — 24h 边界精确
  const out = formatSnoozeRemaining(0, 24 * 60 * 60 * 1000);
  assert(
    '[10.7] 24h 边界 → 1 天后解除 (>= 24h 走 day 分支)',
    out === '1 天后解除',
    `actual=${out}`
  );
}

// ============================================================
// [11] META-GUARD — fs + regex 守 helper 全 export + UI 接入
// ============================================================
const FRONTEND_ROOT = join(__dirname, '..', '..', '..', 'frontend', 'src');

function readFile(rel: string): string {
  return readFileSync(join(FRONTEND_ROOT, rel), 'utf8');
}

// 11.1 — helper 所有 export 齐全
{
  const helperSrc = readFile('pages/workspace/alertItemActionHelpers.ts');
  for (const name of [
    'export const SNOOZE_DURATION_LABEL',
    'export const SNOOZE_DURATION_MS',
    'export const SNOOZE_DURATION_ORDER',
    'export const SNOOZE_STORAGE_KEY',
    'export const ALERT_ACTION_LABEL',
    'export type SnoozeDuration',
    'export type SnoozeMap',
    'export type AlertActionType',
    'export interface SnoozeEntry',
    'export interface SnoozeStorage',
    'export interface AlertActionDescriptor',
    'export function defaultSnoozeStorage',
    'export function readSnoozeMap',
    'export function writeSnoozeMap',
    'export function computeSnoozeUntil',
    'export function isAlertSnoozed',
    'export function addSnooze',
    'export function removeSnooze',
    'export function pruneExpiredSnoozes',
    'export function filterOutSnoozedAlerts',
    'export function looksLikeAShareSymbol',
    'export function buildAlertActionDescriptor',
    'export function formatSnoozeRemaining',
  ]) {
    assert(`[11.1] helper exports ${name}`, helperSrc.includes(name));
  }
}

// 11.2 — descriptor 目标均有当前 App 路由（不依赖 wildcard / legacy redirect）
{
  const appSrc = readFile('App.tsx');
  assert(
    '[11.2a] App 挂载 CatDesk route',
    appSrc.includes("from './pages/catdesk/router'") && appSrc.includes('{catDeskRoute}')
  );
  assert(
    '[11.2b] App 挂载 /workspace/data',
    /path=["']\/workspace\/data["']/.test(appSrc)
  );
  assert(
    '[11.2c] App 挂载 /stock/:symbol',
    /path=["']\/stock\/:symbol["']/.test(appSrc)
  );
}

// ============================================================
// 汇总
// ============================================================
console.log(`\nalert-item-action helpers tests: ${passed} passed, ${failed} failed.`);
if (failed > 0) {
  process.exit(1);
}
process.exit(0);
