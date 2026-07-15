/**
 * US-070 [FE-031] AlertsBell 顶 nav bar — 纯函数 helper 单元测试.
 *
 * 跑法:
 *   cd backend && npx ts-node --transpile-only tests/services/alerts-bell-helpers.test.ts
 * 或:
 *   cd backend && npm test -- --filter=alerts-bell
 *
 * 跨 monorepo import (../../../frontend) — 与 [[前端 pure helper 模板]]
 * (strategyKillSwitchHelpers / shadowRunHelpers / overfit-metrics) 同款.
 *
 * 覆盖维度:
 *   [1] 常量 sanity (CRITICAL < MAX_BADGE / MIN < DEFAULT < MAX poll)
 *   [2] normalizeUnreadCount: 兜底 null/undef/NaN/负/小数/Infinity
 *   [3] classifyAlertsBellSeverity: 0/1/9/10/100 边界
 *   [4] formatBadgeText: 0 → '' / 数字 / 100+ 截断
 *   [5] buildBellTooltip: 3 档文案
 *   [6] clampPollInterval: 兜底 + clamp 上下界
 *   [7] buildAlertsBellHref: 落到当前有效的 CatDesk 主入口
 *   [8] META-GUARD fs+regex 守:
 *       - alertsBellHelpers.ts 所有 export
 *       - AlertsBell.tsx: import helper + listRiskAlerts + setInterval + navigate
 *       - App.tsx: import AlertsBell + 在 Header 里渲染
 *       - App.tsx: 确实挂载 CatDesk route
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  ALERTS_BELL_TARGET_PATH,
  buildAlertsBellHref,
  buildBellTooltip,
  classifyAlertsBellSeverity,
  clampPollInterval,
  CRITICAL_UNREAD_THRESHOLD,
  DEFAULT_POLL_INTERVAL_MS,
  formatBadgeText,
  MAX_BADGE_COUNT,
  MAX_POLL_INTERVAL_MS,
  MIN_POLL_INTERVAL_MS,
  normalizeUnreadCount,
} from '../../../frontend/src/pages/workspace/alertsBellHelpers';

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
assert('[1.1] CRITICAL < MAX_BADGE_COUNT', CRITICAL_UNREAD_THRESHOLD < MAX_BADGE_COUNT);
assert('[1.2] CRITICAL > 0', CRITICAL_UNREAD_THRESHOLD > 0);
assert('[1.3] MIN_POLL < DEFAULT_POLL', MIN_POLL_INTERVAL_MS < DEFAULT_POLL_INTERVAL_MS);
assert('[1.4] DEFAULT_POLL < MAX_POLL', DEFAULT_POLL_INTERVAL_MS < MAX_POLL_INTERVAL_MS);
assert('[1.5] DEFAULT_POLL >= 30s (防 DDoS)', DEFAULT_POLL_INTERVAL_MS >= 30_000);
assert('[1.6] DEFAULT_POLL <= 5min (用户感知)', DEFAULT_POLL_INTERVAL_MS <= 300_000);
assert('[1.7] MAX_BADGE_COUNT == 99 (antd 默认)', MAX_BADGE_COUNT === 99);
assert(
  '[1.8] ALERTS_BELL_TARGET_PATH 落当前 /catdesk 主入口',
  ALERTS_BELL_TARGET_PATH === '/catdesk'
);

// ============================================================
// [2] normalizeUnreadCount
// ============================================================
assert('[2.1] null → 0', normalizeUnreadCount(null) === 0);
assert('[2.2] undefined → 0', normalizeUnreadCount(undefined) === 0);
assert('[2.3] NaN → 0', normalizeUnreadCount(NaN) === 0);
assert('[2.4] "5" 非 number → 0 (不接受字符串)', normalizeUnreadCount('5' as any) === 0);
assert('[2.5] -3 → 0 (负数兜底)', normalizeUnreadCount(-3) === 0);
assert('[2.6] 0 → 0', normalizeUnreadCount(0) === 0);
assert('[2.7] 5 → 5', normalizeUnreadCount(5) === 5);
assert('[2.8] 5.7 → 5 (floor)', normalizeUnreadCount(5.7) === 5);
assert(
  '[2.9] Infinity → MAX_BADGE_COUNT',
  normalizeUnreadCount(Infinity) === MAX_BADGE_COUNT
);
assert(
  '[2.10] -Infinity → 0',
  normalizeUnreadCount(-Infinity) === 0
);
assert('[2.11] 99 → 99', normalizeUnreadCount(99) === 99);
assert('[2.12] 200 → 200 (保留, format 才截断)', normalizeUnreadCount(200) === 200);

// ============================================================
// [3] classifyAlertsBellSeverity
// ============================================================
assert('[3.1] 0 → none', classifyAlertsBellSeverity(0) === 'none');
assert('[3.2] 1 → normal', classifyAlertsBellSeverity(1) === 'normal');
assert(
  '[3.3] CRITICAL-1 → normal',
  classifyAlertsBellSeverity(CRITICAL_UNREAD_THRESHOLD - 1) === 'normal'
);
assert(
  '[3.4] CRITICAL → critical (>=)',
  classifyAlertsBellSeverity(CRITICAL_UNREAD_THRESHOLD) === 'critical'
);
assert('[3.5] 50 → critical', classifyAlertsBellSeverity(50) === 'critical');
assert('[3.6] -5 → none (兜底)', classifyAlertsBellSeverity(-5) === 'none');
assert('[3.7] NaN → none', classifyAlertsBellSeverity(NaN) === 'none');
assert(
  '[3.8] Infinity → critical',
  classifyAlertsBellSeverity(Infinity) === 'critical'
);

// ============================================================
// [4] formatBadgeText
// ============================================================
assert('[4.1] 0 → ""', formatBadgeText(0) === '');
assert('[4.2] -3 → ""', formatBadgeText(-3) === '');
assert('[4.3] 1 → "1"', formatBadgeText(1) === '1');
assert('[4.4] 50 → "50"', formatBadgeText(50) === '50');
assert('[4.5] 99 → "99"', formatBadgeText(99) === '99');
assert('[4.6] 100 → "99+"', formatBadgeText(100) === '99+');
assert('[4.7] 9999 → "99+"', formatBadgeText(9999) === '99+');
assert(
  '[4.8] Infinity → "99" (normalize 已截到 MAX, format 不再看到溢出)',
  formatBadgeText(Infinity) === '99'
);

// ============================================================
// [5] buildBellTooltip
// ============================================================
{
  const t0 = buildBellTooltip(0);
  assert('[5.1] 0 → 含 "无未读"', t0.includes('无未读'));

  const t1 = buildBellTooltip(3);
  assert('[5.2] 3 → 含数字 3', t1.includes('3'));
  assert('[5.3] 3 → 含 "点击查看"', t1.includes('点击查看'));
  assert('[5.4] 3 不应触发 critical 文案', !t1.includes('高频'));

  const t10 = buildBellTooltip(CRITICAL_UNREAD_THRESHOLD);
  assert('[5.5] CRITICAL → 含 "高频告警"', t10.includes('高频'));
  assert(
    '[5.6] CRITICAL → 含数字',
    t10.includes(String(CRITICAL_UNREAD_THRESHOLD))
  );

  const tNeg = buildBellTooltip(-5);
  assert('[5.7] 负数 → 安全 fallback 到无未读', tNeg.includes('无未读'));
}

// ============================================================
// [6] clampPollInterval
// ============================================================
assert(
  '[6.1] undefined → DEFAULT',
  clampPollInterval(undefined) === DEFAULT_POLL_INTERVAL_MS
);
assert('[6.2] null → DEFAULT', clampPollInterval(null) === DEFAULT_POLL_INTERVAL_MS);
assert('[6.3] NaN → DEFAULT', clampPollInterval(NaN) === DEFAULT_POLL_INTERVAL_MS);
assert(
  '[6.4] Infinity → DEFAULT',
  clampPollInterval(Infinity) === DEFAULT_POLL_INTERVAL_MS
);
assert(
  '[6.5] 1000 (< MIN) → MIN',
  clampPollInterval(1000) === MIN_POLL_INTERVAL_MS
);
assert(
  '[6.6] 999999 (> MAX) → MAX',
  clampPollInterval(999999) === MAX_POLL_INTERVAL_MS
);
assert(
  '[6.7] 合法 60000 → 60000',
  clampPollInterval(60000) === 60000
);
assert(
  '[6.8] 60000.7 → 60000 (floor)',
  clampPollInterval(60000.7) === 60000
);
assert('[6.9] -1000 → MIN', clampPollInterval(-1000) === MIN_POLL_INTERVAL_MS);

// ============================================================
// [7] buildAlertsBellHref
// ============================================================
{
  const href = buildAlertsBellHref();
  assert('[7.1] href 等于当前 CatDesk path', href === ALERTS_BELL_TARGET_PATH);
  assert('[7.2] href 不再携带已删除的 risk_center tab', !href.includes('risk_center'));
  assert('[7.3] href 不依赖 query 重定向', !href.includes('?'));
}

// ============================================================
// [7b] PR-C 普通用户 href + 角色路由
// ============================================================
{
  // 跨 monorepo 动态 require, 避开顶层 import 改动 (与已有 import 同款相对 path).
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const helpers = require('../../../frontend/src/pages/workspace/alertsBellHelpers');
  const userHref: string = helpers.buildAlertsBellHrefForUser();
  assert('[7b.1] user href 落当前 CatDesk', userHref === '/catdesk');
  assert(
    '[7b.2] admin → 当前主入口',
    helpers.buildAlertsBellHrefForRole(true) === buildAlertsBellHref()
  );
  assert(
    '[7b.3] 非 admin → 同一当前主入口',
    helpers.buildAlertsBellHrefForRole(false) === userHref
  );
  assert(
    '[7b.4] undefined → 当前主入口',
    helpers.buildAlertsBellHrefForRole(undefined) === userHref
  );
  assert(
    '[7b.5] null → 当前主入口',
    helpers.buildAlertsBellHrefForRole(null) === userHref
  );
  assert(
    '[7b.6] USER_TARGET_PATH 与当前主入口一致',
    helpers.ALERTS_BELL_USER_TARGET_PATH === '/catdesk'
  );
}

// ============================================================
// [8] META-GUARD fs+regex — 守 helper / UI / wiring 全同步
// ============================================================
const FRONTEND_ROOT = join(__dirname, '..', '..', '..', 'frontend', 'src');

function readFile(rel: string): string {
  return readFileSync(join(FRONTEND_ROOT, rel), 'utf8');
}

// 8.1 — helper export 完整
{
  const helperSrc = readFile('pages/workspace/alertsBellHelpers.ts');
  for (const name of [
    'export const MAX_BADGE_COUNT',
    'export const CRITICAL_UNREAD_THRESHOLD',
    'export const DEFAULT_POLL_INTERVAL_MS',
    'export const MIN_POLL_INTERVAL_MS',
    'export const MAX_POLL_INTERVAL_MS',
    'export const ALERTS_BELL_TARGET_PATH',
    'export const ALERTS_BELL_USER_TARGET_PATH',
    'export type AlertsBellSeverity',
    'export function normalizeUnreadCount',
    'export function classifyAlertsBellSeverity',
    'export function formatBadgeText',
    'export function buildBellTooltip',
    'export function clampPollInterval',
    'export function buildAlertsBellHref',
    'export function buildAlertsBellHrefForUser',
    'export function buildAlertsBellHrefForRole',
  ]) {
    assert(`[8.1] helper exports ${name}`, helperSrc.includes(name));
  }
}

// 8.2 — AlertsBell.tsx 接入 helper + 调 useAlertsRealtime + navigate
// US-073 [FE-034] 已把 listRiskAlerts/setInterval 移到 useAlertsRealtime hook 内部,
// 这里只守 "Bell 仍走 hook + helper 渲染 Badge/Tooltip" 形态, 不再直接守 listRiskAlerts.
{
  const bellSrc = readFile('components/layout/AlertsBell.tsx');
  assert(
    '[8.2a] AlertsBell import alertsBellHelpers',
    bellSrc.includes('alertsBellHelpers')
  );
  assert(
    '[8.2b] AlertsBell 用 useAlertsRealtime hook (US-073)',
    bellSrc.includes('useAlertsRealtime')
  );
  assert(
    '[8.2c] AlertsBell import alertsRealtimeClient',
    /from\s+['"]\.\.\/\.\.\/services\/alertsRealtimeClient['"]/.test(bellSrc)
  );
  assert(
    '[8.2d] AlertsBell 暴露 enableWebSocket prop (故障演练)',
    bellSrc.includes('enableWebSocket')
  );
  assert(
    '[8.2e] AlertsBell 暴露 data-mode 让 E2E 断 ws/polling 状态',
    bellSrc.includes('data-mode')
  );
  assert(
    '[8.2f] AlertsBell 用 useNavigate + buildAlertsBellHref',
    bellSrc.includes('useNavigate') && bellSrc.includes('buildAlertsBellHref')
  );
  assert(
    '[8.2g] AlertsBell 含 data-testid="alerts-bell"',
    bellSrc.includes('data-testid="alerts-bell"')
  );
  assert(
    '[8.2h] AlertsBell 用 BellOutlined icon',
    bellSrc.includes('BellOutlined')
  );
  assert('[8.2i] AlertsBell 用 antd Badge', bellSrc.includes('Badge'));
  assert(
    '[8.2j] AlertsBell 用 Tooltip 显示 buildBellTooltip',
    bellSrc.includes('Tooltip') && bellSrc.includes('buildBellTooltip')
  );
  // fail-OPEN: mode='error' 时仍保留 unreadCount 不清零 (现在由 hook 兜底)
  assert(
    "[8.2k] AlertsBell 仍处理 mode==='error' 提示 (fail-OPEN)",
    /mode\s*===\s*['"]error['"]/.test(bellSrc)
  );
  // 提及 US-070 让未来 grep / 跨 sprint 追溯能找到
  assert('[8.2l] AlertsBell 提到 US-070', bellSrc.includes('US-070'));
  assert('[8.2m] AlertsBell 提到 US-073 (实时升级标识)', bellSrc.includes('US-073'));
}

// 8.3 — App.tsx 已 import + 在 Header 渲染 AlertsBell
{
  const appSrc = readFile('App.tsx');
  assert(
    '[8.3a] App import AlertsBell',
    /import\s+AlertsBell\s+from\s+['"][^'"]*AlertsBell['"]/.test(appSrc)
  );
  assert(
    '[8.3b] App 在 JSX 里渲染 <AlertsBell',
    appSrc.includes('<AlertsBell')
  );
  // Bell 应该在 Header 的 token-guarded 块里, 与 GlobalPortfolioSelector 同 div
  assert(
    '[8.3c] AlertsBell 跟 GlobalPortfolioSelector 一起在 Header 块',
    /<GlobalPortfolioSelector\s*\/>[\s\S]{0,800}<AlertsBell/.test(appSrc) ||
      /<AlertsBell[\s\S]{0,800}<GlobalPortfolioSelector\s*\/>/.test(appSrc)
  );
}

// 8.4 — App.tsx 挂载 helper 输出的 CatDesk route
{
  const appSrc = readFile('App.tsx');
  assert(
    '[8.4a] App import catDeskRoute',
    /import\s*\{\s*catDeskRoute\s*\}\s*from\s*['"][^'"]*catdesk\/router['"]/.test(appSrc)
  );
  assert(
    '[8.4b] App 对 /catdesk 使用 catDeskRoute',
    appSrc.includes("location.pathname === '/catdesk'") && appSrc.includes('{catDeskRoute}')
  );
}

// ============================================================
// 汇总
// ============================================================
console.log(`\nalerts-bell helpers tests: ${passed} passed, ${failed} failed.`);
if (failed > 0) {
  process.exit(1);
}
process.exit(0);
