/**
 * US-074 [FE-035] CriticalAlertModal — 前端 pure helper + meta-guard 单元测试.
 *
 * 跑法 (跨 monorepo, 同 [[alerts-realtime-client.test.ts]] / [[alerts-bell-helpers.test.ts]] 范式):
 *   cd backend && npx ts-node --transpile-only tests/services/critical-alert-modal-helpers.test.ts
 * 或:
 *   cd backend && npm test -- --filter=critical-alert-modal-helpers
 *
 * 覆盖维度:
 *   [1] 常量 sanity (CRITICAL_RULE_IDS 含全部 7 类 / Object.freeze / cap 合理)
 *   [2] isCriticalAlert — 决策表全分支
 *   [3] ruleIdToLabel — 已知/未知/null
 *   [4] buildCriticalAlertHeadline — SYSTEM:/普通股/缺 symbol
 *   [5] buildCriticalAlertViewModel — happy + 缺 alert_id → null + 字段归一化
 *   [6] enqueueCriticalAlert — dedup / ack skip / cap 砍头
 *   [7] popCriticalAlert — head/rest 拆 + 空集
 *   [8] loadAckedAlertIds / recordAckedAlertId — fake storage + 损坏 JSON + cap FIFO
 *   [9] META-GUARD — App.tsx mount + CriticalAlertModal.tsx 调 useAlertsRealtime
 *                  + alertsRealtimeClient.ts onAlert 钩子 + sessionCleanup 含 session key
 */

import { readFileSync } from 'fs';
import { join } from 'path';

import {
  ACK_CACHE_MAX,
  ACK_CACHE_SESSION_KEY,
  CRITICAL_MODAL_MAX_QUEUE,
  CRITICAL_MODAL_OK_TEXT,
  CRITICAL_MODAL_TITLE,
  CRITICAL_RULE_IDS,
  CRITICAL_SYMBOL_PREFIXES,
  buildCriticalAlertHeadline,
  buildCriticalAlertViewModel,
  enqueueCriticalAlert,
  isCriticalAlert,
  loadAckedAlertIds,
  popCriticalAlert,
  recordAckedAlertId,
  ruleIdToLabel,
} from '../../../frontend/src/pages/workspace/criticalAlertModalHelpers';

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
assert('[1.1] CRITICAL_RULE_IDS 含 drawdown_breaker', CRITICAL_RULE_IDS.includes('drawdown_breaker'));
assert('[1.2] CRITICAL_RULE_IDS 含 position_limit', CRITICAL_RULE_IDS.includes('position_limit'));
assert('[1.3] CRITICAL_RULE_IDS 含 black_swan', CRITICAL_RULE_IDS.includes('black_swan'));
assert('[1.4] CRITICAL_RULE_IDS 含 per_stock_stop_loss', CRITICAL_RULE_IDS.includes('per_stock_stop_loss'));
assert('[1.5] CRITICAL_RULE_IDS 含 kill_switch', CRITICAL_RULE_IDS.includes('kill_switch'));
assert('[1.6] CRITICAL_RULE_IDS 含 reconciliation', CRITICAL_RULE_IDS.includes('reconciliation'));
assert('[1.7] CRITICAL_RULE_IDS 含 restricted_share_unlock', CRITICAL_RULE_IDS.includes('restricted_share_unlock'));
assert('[1.8] CRITICAL_RULE_IDS 不含 trailing_stop (反例)', !CRITICAL_RULE_IDS.includes('trailing_stop'));
assert('[1.9] CRITICAL_RULE_IDS 不含 industry_concentration (反例)', !CRITICAL_RULE_IDS.includes('industry_concentration'));
assert('[1.10] CRITICAL_RULE_IDS Object.freeze 防误改', Object.isFrozen(CRITICAL_RULE_IDS));

assert('[1.11] CRITICAL_SYMBOL_PREFIXES 含 SYSTEM:', CRITICAL_SYMBOL_PREFIXES.includes('SYSTEM:'));
assert('[1.12] CRITICAL_SYMBOL_PREFIXES frozen', Object.isFrozen(CRITICAL_SYMBOL_PREFIXES));

assert('[1.13] CRITICAL_MODAL_MAX_QUEUE > 0 & 合理上限', CRITICAL_MODAL_MAX_QUEUE > 0 && CRITICAL_MODAL_MAX_QUEUE <= 20);
assert('[1.14] ACK_CACHE_MAX >= 100 (单 session 累积 ack 容量)', ACK_CACHE_MAX >= 100);
assert('[1.15] ACK_CACHE_SESSION_KEY 含 criticalAlertModal 命名空间', ACK_CACHE_SESSION_KEY.includes('criticalAlertModal'));
assert('[1.16] CRITICAL_MODAL_TITLE 中文 + 含 ⚠ 标识', /严重/.test(CRITICAL_MODAL_TITLE) && CRITICAL_MODAL_TITLE.includes('⚠'));
assert('[1.17] CRITICAL_MODAL_OK_TEXT = 我已知悉 (强语气)', CRITICAL_MODAL_OK_TEXT === '我已知悉');

// ============================================================
// [2] isCriticalAlert — 决策表
// ============================================================
function mkMsg(overrides: Record<string, any>): any {
  return { type: 'alert.new', alert_id: 1, ...overrides };
}

assert('[2.1] null → false', !isCriticalAlert(null));
assert('[2.2] undefined → false', !isCriticalAlert(undefined));
assert('[2.3] type 非 alert.new → false', !isCriticalAlert(mkMsg({ type: 'connected' })));
assert('[2.4] 无 alert_id → false', !isCriticalAlert(mkMsg({ alert_id: undefined })));
assert('[2.5] alert_id=0 → false (无 id 没法 markRead)', !isCriticalAlert(mkMsg({ alert_id: 0 })));
assert('[2.6] alert_id 负数 → false', !isCriticalAlert(mkMsg({ alert_id: -1 })));
assert('[2.7] alert_id NaN → false', !isCriticalAlert(mkMsg({ alert_id: NaN })));

assert(
  '[2.8] level=CRITICAL → true (后端未来兼容)',
  isCriticalAlert(mkMsg({ level: 'CRITICAL', rule_id: null, symbol: '000001.SZ' }))
);
assert(
  '[2.9] level=critical (小写) → true (toUpperCase 归一)',
  isCriticalAlert(mkMsg({ level: 'critical', symbol: '000001.SZ' }))
);

assert(
  '[2.10] HIGH + drawdown_breaker → true',
  isCriticalAlert(mkMsg({ level: 'HIGH', rule_id: 'drawdown_breaker', symbol: '600519' }))
);
assert(
  '[2.11] HIGH + position_limit → true',
  isCriticalAlert(mkMsg({ level: 'HIGH', rule_id: 'position_limit', symbol: '000858' }))
);
assert(
  '[2.12] HIGH + black_swan → true',
  isCriticalAlert(mkMsg({ level: 'HIGH', rule_id: 'black_swan', symbol: '300750' }))
);
assert(
  '[2.13] HIGH + per_stock_stop_loss → true',
  isCriticalAlert(mkMsg({ level: 'HIGH', rule_id: 'per_stock_stop_loss', symbol: '600519' }))
);
assert(
  '[2.14] HIGH + kill_switch → true',
  isCriticalAlert(mkMsg({ level: 'HIGH', rule_id: 'kill_switch', symbol: '' }))
);
assert(
  '[2.15] HIGH + reconciliation → true',
  isCriticalAlert(mkMsg({ level: 'HIGH', rule_id: 'reconciliation', symbol: 'SYSTEM:RECON' }))
);
assert(
  '[2.16] HIGH + restricted_share_unlock → true',
  isCriticalAlert(mkMsg({ level: 'HIGH', rule_id: 'restricted_share_unlock', symbol: '688123' }))
);

assert(
  '[2.17] HIGH + trailing_stop → false (常规 ts 不强制弹)',
  !isCriticalAlert(mkMsg({ level: 'HIGH', rule_id: 'trailing_stop', symbol: '600519' }))
);
assert(
  '[2.18] HIGH + industry_concentration → false (再平衡时处理)',
  !isCriticalAlert(mkMsg({ level: 'HIGH', rule_id: 'industry_concentration', symbol: '600519' }))
);
assert(
  '[2.19] MEDIUM + drawdown_breaker → false (level 没到 HIGH)',
  !isCriticalAlert(mkMsg({ level: 'MEDIUM', rule_id: 'drawdown_breaker', symbol: '600519' }))
);
assert(
  '[2.20] LOW + black_swan → false',
  !isCriticalAlert(mkMsg({ level: 'LOW', rule_id: 'black_swan', symbol: '600519' }))
);

assert(
  '[2.21] SYSTEM:RISK_GUARD_UNAVAILABLE 任意 level → true (前缀命中, 兜底防漏标)',
  isCriticalAlert(mkMsg({ level: 'MEDIUM', rule_id: 'unknown', symbol: 'SYSTEM:RISK_GUARD_UNAVAILABLE' }))
);
assert(
  '[2.22] SYSTEM:BRIDGE_DOWN HIGH → true',
  isCriticalAlert(mkMsg({ level: 'HIGH', rule_id: 'bridge', symbol: 'SYSTEM:BRIDGE_DOWN' }))
);

assert(
  '[2.23] HIGH + 无 rule_id + 非 SYSTEM: → false (避免泛 HIGH 全弹)',
  !isCriticalAlert(mkMsg({ level: 'HIGH', rule_id: null, symbol: '600519' }))
);

// ============================================================
// [3] ruleIdToLabel
// ============================================================
assert('[3.1] drawdown_breaker → 账户回撤熔断', ruleIdToLabel('drawdown_breaker') === '账户回撤熔断');
assert('[3.2] position_limit → 仓位上限', ruleIdToLabel('position_limit') === '仓位上限');
assert('[3.3] black_swan → 黑天鹅事件', ruleIdToLabel('black_swan') === '黑天鹅事件');
assert('[3.4] kill_switch → 策略 kill-switch', ruleIdToLabel('kill_switch') === '策略 kill-switch');
assert('[3.5] reconciliation → 对账异常', ruleIdToLabel('reconciliation') === '对账异常');
assert('[3.6] per_stock_stop_loss → 个股止损', ruleIdToLabel('per_stock_stop_loss') === '个股止损');
assert('[3.7] restricted_share_unlock → 限售解禁', ruleIdToLabel('restricted_share_unlock') === '限售解禁');
assert('[3.8] trailing_stop → 移动止盈止损 (非 critical 但已知 label)', ruleIdToLabel('trailing_stop') === '移动止盈止损');
assert('[3.9] industry_concentration → 行业集中度', ruleIdToLabel('industry_concentration') === '行业集中度');
assert('[3.10] unknown rule → 返原始 key (便于报修)', ruleIdToLabel('my_custom_rule') === 'my_custom_rule');
assert('[3.11] null → 风控告警 (兜底)', ruleIdToLabel(null) === '风控告警');
assert('[3.12] empty → 风控告警', ruleIdToLabel('') === '风控告警');
assert('[3.13] 大小写不敏感 (DRAWDOWN_BREAKER → 账户回撤熔断)', ruleIdToLabel('DRAWDOWN_BREAKER') === '账户回撤熔断');

// ============================================================
// [4] buildCriticalAlertHeadline
// ============================================================
assert(
  '[4.1] 普通股: 600519 + drawdown → 600519 · 账户回撤熔断',
  buildCriticalAlertHeadline({ symbol: '600519', rule_id: 'drawdown_breaker' }) === '600519 · 账户回撤熔断'
);
assert(
  '[4.2] SYSTEM: 前缀剥离 → BRIDGE_DOWN · 风控告警',
  buildCriticalAlertHeadline({ symbol: 'SYSTEM:BRIDGE_DOWN', rule_id: null }) === 'BRIDGE_DOWN · 风控告警'
);
assert(
  '[4.3] 缺 symbol → 仅 ruleLabel',
  buildCriticalAlertHeadline({ symbol: null, rule_id: 'kill_switch' }) === '策略 kill-switch'
);
assert(
  '[4.4] 空 symbol → 仅 ruleLabel',
  buildCriticalAlertHeadline({ symbol: '   ', rule_id: 'black_swan' }) === '黑天鹅事件'
);

// ============================================================
// [5] buildCriticalAlertViewModel
// ============================================================
const vm1 = buildCriticalAlertViewModel(
  mkMsg({
    alert_id: 42,
    user_id: 7,
    level: 'high',
    rule_id: 'drawdown_breaker',
    symbol: '600519',
    message: '账户回撤 15% 触发熔断',
    created_at: '2026-06-20T10:00:00Z',
  })
);
assert('[5.1] vm.alert_id', vm1?.alert_id === 42);
assert('[5.2] vm.user_id', vm1?.user_id === 7);
assert('[5.3] vm.level toUpperCase → HIGH', vm1?.level === 'HIGH');
assert('[5.4] vm.rule_id 保留原值', vm1?.rule_id === 'drawdown_breaker');
assert('[5.5] vm.ruleLabel', vm1?.ruleLabel === '账户回撤熔断');
assert('[5.6] vm.headline', vm1?.headline === '600519 · 账户回撤熔断');
assert('[5.7] vm.message', vm1?.message === '账户回撤 15% 触发熔断');
assert('[5.8] vm.createdAtIso', vm1?.createdAtIso === '2026-06-20T10:00:00Z');

assert('[5.9] 缺 alert_id → null', buildCriticalAlertViewModel(mkMsg({ alert_id: 0 })) === null);
assert('[5.10] null → null', buildCriticalAlertViewModel(null) === null);
assert('[5.11] 小数 alert_id → Math.floor', buildCriticalAlertViewModel(mkMsg({ alert_id: 3.7 }))?.alert_id === 3);

const vm2 = buildCriticalAlertViewModel(
  mkMsg({ alert_id: 5, user_id: undefined, level: undefined, rule_id: undefined, symbol: undefined, message: undefined })
);
assert('[5.12] 缺 user_id fallback 0', vm2?.user_id === 0);
assert('[5.13] 缺 level fallback 空 string', vm2?.level === '');
assert('[5.14] 缺 rule_id fallback null', vm2?.rule_id === null);
assert('[5.15] 缺 symbol fallback 空 string', vm2?.symbol === '');
assert('[5.16] 缺 message fallback 空 string', vm2?.message === '');
assert('[5.17] 缺 createdAt fallback null', vm2?.createdAtIso === null);

// ============================================================
// [6] enqueueCriticalAlert
// ============================================================
function mkVm(alert_id: number): any {
  return {
    alert_id,
    user_id: 1,
    symbol: 'S',
    level: 'HIGH',
    message: 'm',
    rule_id: 'r',
    ruleLabel: 'L',
    createdAtIso: null,
    headline: 'H',
  };
}

const empty: any[] = [];
const r1 = enqueueCriticalAlert(empty, mkVm(1), new Set<number>());
assert('[6.1] 空队列入队 1 条', r1.length === 1 && r1[0].alert_id === 1);

const r2 = enqueueCriticalAlert(r1, mkVm(1), new Set<number>());
assert('[6.2] 重复 alert_id dedup, 长度仍 1', r2.length === 1);

const r3 = enqueueCriticalAlert(r1, mkVm(2), new Set<number>([2]));
assert('[6.3] 已 ack 的 alert_id 跳过, 长度仍 1', r3.length === 1);

// 队列已 5 条 (CRITICAL_MODAL_MAX_QUEUE), 再入 1 条 → 砍头, 保新尾
let queue: any[] = [];
for (let i = 1; i <= CRITICAL_MODAL_MAX_QUEUE; i++) {
  queue = enqueueCriticalAlert(queue, mkVm(i), new Set<number>());
}
assert('[6.4] 队列已满 = CRITICAL_MODAL_MAX_QUEUE', queue.length === CRITICAL_MODAL_MAX_QUEUE);
const overflowed = enqueueCriticalAlert(queue, mkVm(99), new Set<number>());
assert('[6.5] 满后入队仍是 CRITICAL_MODAL_MAX_QUEUE 长', overflowed.length === CRITICAL_MODAL_MAX_QUEUE);
assert('[6.6] 砍头 — 最老的 alert_id=1 被踢出', !overflowed.some(v => v.alert_id === 1));
assert('[6.7] 保新 — 最新 alert_id=99 在尾部', overflowed[overflowed.length - 1].alert_id === 99);

// ============================================================
// [7] popCriticalAlert
// ============================================================
const [h1, rest1] = popCriticalAlert([mkVm(1), mkVm(2), mkVm(3)]);
assert('[7.1] head = first', h1?.alert_id === 1);
assert('[7.2] rest 长度 2', rest1.length === 2 && rest1[0].alert_id === 2);

const [h2, rest2] = popCriticalAlert([]);
assert('[7.3] 空集 head=null', h2 === null);
assert('[7.4] 空集 rest=[]', rest2.length === 0);

// ============================================================
// [8] loadAckedAlertIds / recordAckedAlertId — fake storage
// ============================================================
function makeFakeStorage(initial: Record<string, string> = {}): {
  store: Record<string, string>;
  getItem: (k: string) => string | null;
  setItem: (k: string, v: string) => void;
} {
  const store: Record<string, string> = { ...initial };
  return {
    store,
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => {
      store[k] = v;
    },
  };
}

const s1 = makeFakeStorage();
const loaded1 = loadAckedAlertIds(s1);
assert('[8.1] 空 storage → 空 Set', loaded1.size === 0);

const s2 = makeFakeStorage({ [ACK_CACHE_SESSION_KEY]: '[1, 2, 3]' });
const loaded2 = loadAckedAlertIds(s2);
assert('[8.2] 含 [1,2,3] → Set size 3', loaded2.size === 3 && loaded2.has(2));

const s3 = makeFakeStorage({ [ACK_CACHE_SESSION_KEY]: 'not-json' });
const loaded3 = loadAckedAlertIds(s3);
assert('[8.3] 损坏 JSON → 空 Set (fail-OPEN)', loaded3.size === 0);

const s4 = makeFakeStorage({ [ACK_CACHE_SESSION_KEY]: '{"a":1}' });
const loaded4 = loadAckedAlertIds(s4);
assert('[8.4] 非数组 → 空 Set', loaded4.size === 0);

const s5 = makeFakeStorage({ [ACK_CACHE_SESSION_KEY]: '[1, "bad", -2, 3.7, 0, 5]' });
const loaded5 = loadAckedAlertIds(s5);
assert('[8.5] 过滤非法元素, 保留 [1, 3, 5]', loaded5.has(1) && loaded5.has(5) && loaded5.has(3) && loaded5.size === 3);

assert('[8.6] null storage → 空 Set', loadAckedAlertIds(null).size === 0);

const s6 = makeFakeStorage();
const after = recordAckedAlertId(7, s6);
assert('[8.7] record 后 Set 含 7', after.has(7));
assert('[8.8] 持久化到 storage', s6.store[ACK_CACHE_SESSION_KEY] !== undefined);
const reread = loadAckedAlertIds(s6);
assert('[8.9] 重读 storage 仍含 7', reread.has(7));

const s7 = makeFakeStorage();
recordAckedAlertId(1, s7);
const dupAfter = recordAckedAlertId(1, s7);
assert('[8.10] 重复 record 同 id 不抛错且 size 仍为 1', dupAfter.size === 1);

const s8 = makeFakeStorage();
recordAckedAlertId(NaN, s8);
recordAckedAlertId(0, s8);
recordAckedAlertId(-5, s8);
const invalidLoaded = loadAckedAlertIds(s8);
assert('[8.11] 非法 alert_id (NaN/0/负) 不写入', invalidLoaded.size === 0);

// FIFO cap — 灌 ACK_CACHE_MAX + 10 条, 期望最早的 10 条被踢出
const sCap = makeFakeStorage();
for (let i = 1; i <= ACK_CACHE_MAX + 10; i++) {
  recordAckedAlertId(i, sCap);
}
const capLoaded = loadAckedAlertIds(sCap);
assert(`[8.12] FIFO cap — size == ACK_CACHE_MAX (${ACK_CACHE_MAX})`, capLoaded.size === ACK_CACHE_MAX);
assert('[8.13] FIFO cap — 最早的 1 被踢出', !capLoaded.has(1));
assert('[8.14] FIFO cap — 最新的 ACK_CACHE_MAX+10 仍在', capLoaded.has(ACK_CACHE_MAX + 10));

// ============================================================
// [9] META-GUARD — 守 App / Modal / hook / sessionCleanup 接入不退化
// ============================================================
const helpersPath = join(__dirname, '../../../frontend/src/pages/workspace/criticalAlertModalHelpers.ts');
const helpersSrc = readFileSync(helpersPath, 'utf8');
assert(
  '[9.1] helpers 含 CRITICAL_RULE_IDS export 常量',
  /export const CRITICAL_RULE_IDS/.test(helpersSrc)
);
assert(
  '[9.2] helpers 含 isCriticalAlert export 函数',
  /export function isCriticalAlert/.test(helpersSrc)
);
assert(
  '[9.3] helpers 用 Object.freeze 锁常量',
  /Object\.freeze\(/.test(helpersSrc)
);

const appSrc = readFileSync(join(__dirname, '../../../frontend/src/App.tsx'), 'utf8');
assert(
  '[9.4] App.tsx import CriticalAlertModal',
  /import\s+CriticalAlertModal\s+from\s+['"]\.\/components\/layout\/CriticalAlertModal['"]/.test(appSrc)
);
assert(
  '[9.5] App.tsx 在 token && (...) 块内 mount <CriticalAlertModal />',
  /<CriticalAlertModal\s*\/>/.test(appSrc)
);

const modalSrc = readFileSync(join(__dirname, '../../../frontend/src/components/layout/CriticalAlertModal.tsx'), 'utf8');
assert(
  '[9.6] Modal 调 useAlertsRealtime 注入 onAlert 钩子',
  /useAlertsRealtime\(\s*\{[\s\S]*onAlert/.test(modalSrc)
);
assert(
  '[9.7] Modal 调 isCriticalAlert 守门',
  /isCriticalAlert\(/.test(modalSrc)
);
assert(
  '[9.8] Modal 调 markSingleRiskAlertRead 同步 backend',
  /markSingleRiskAlertRead\(/.test(modalSrc)
);
assert(
  '[9.9] Modal 含强制 ack 三件套: closable={false} maskClosable={false} keyboard={false}',
  /closable=\{false\}/.test(modalSrc) &&
    /maskClosable=\{false\}/.test(modalSrc) &&
    /keyboard=\{false\}/.test(modalSrc)
);
assert(
  '[9.10] Modal cancel button 隐藏 (强制 ack)',
  /cancelButtonProps=\{\{\s*style:\s*\{\s*display:\s*['"]none['"]/.test(modalSrc)
);
assert(
  '[9.11] Modal 用 recordAckedAlertId 持久化 ack 状态',
  /recordAckedAlertId\(/.test(modalSrc)
);
assert(
  '[9.12] Modal 用 enqueueCriticalAlert/popCriticalAlert 管理队列',
  /enqueueCriticalAlert\(/.test(modalSrc) && /popCriticalAlert\(/.test(modalSrc)
);
assert(
  '[9.13] Modal 含 data-testid 便于 E2E',
  /data-testid="critical-alert-modal"/.test(modalSrc)
);

const clientSrc = readFileSync(join(__dirname, '../../../frontend/src/services/alertsRealtimeClient.ts'), 'utf8');
assert(
  '[9.14] alertsRealtimeClient 含 onAlert option (US-074 钩子)',
  /onAlert\?:\s*\(msg:\s*AlertsRealtimeMessage\)\s*=>\s*void/.test(clientSrc)
);
assert(
  '[9.15] alertsRealtimeClient onAlert 回调用 try/catch 保护不让 ws 断',
  /onAlertRef/.test(clientSrc) && /try\s*\{[\s\S]*onAlertRef\.current\(/.test(clientSrc)
);

const cleanupSrc = readFileSync(join(__dirname, '../../../frontend/src/utils/sessionCleanup.ts'), 'utf8');
assert(
  '[9.16] sessionCleanup 含 USER_SCOPED_SESSION_STORAGE_KEYS 白名单',
  /USER_SCOPED_SESSION_STORAGE_KEYS/.test(cleanupSrc)
);
assert(
  '[9.17] sessionCleanup 白名单含 ACK_CACHE_SESSION_KEY 值 (logout 时清)',
  cleanupSrc.includes('criticalAlertModal_acked_v1')
);
assert(
  '[9.18] clearUserScopedStorage 真扫 sessionStorage',
  /sessionStorage\.removeItem/.test(cleanupSrc)
);

// 反向 guard: Bell 不能擅自处理 critical 弹窗 (职责分离)
const bellSrc = readFileSync(join(__dirname, '../../../frontend/src/components/layout/AlertsBell.tsx'), 'utf8');
assert(
  '[9.19] Bell 不调 isCriticalAlert (职责分离)',
  !/isCriticalAlert/.test(bellSrc)
);
assert(
  '[9.20] Bell 不 render Modal 组件 (职责分离)',
  !/<Modal/.test(bellSrc)
);

// ============================================================
// summary
// ============================================================
console.log(`\ncritical-alert-modal-helpers: ${passed} ok / ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
