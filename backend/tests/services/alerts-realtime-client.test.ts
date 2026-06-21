/**
 * US-073 [FE-034] alertsRealtimeClient — 前端 pure helper + meta-guard 单元测试.
 *
 * 跑法 (跨 monorepo, 同 [[alerts-bell-helpers.test.ts]] 范式):
 *   cd backend && npx ts-node --transpile-only tests/services/alerts-realtime-client.test.ts
 * 或:
 *   cd backend && npm test -- --filter=alerts-realtime-client
 *
 * 覆盖维度:
 *   [1] 常量 sanity
 *   [2] wsUrlFromHttpBase — http/https/缺/带 path 末尾
 *   [3] buildAlertsWsUrl — token 缺 / base 缺 / encodeURIComponent
 *   [4] computeReconnectBackoff — 指数 + clamp + 非法 attempt
 *   [5] shouldGiveUpReconnect — 边界
 *   [6] parseRealtimeMessage — 非 JSON / null / 非 object / 缺 type / 正常
 *   [7] shouldFetchOnMessage — alert.new vs connected
 *   [8] META-GUARD — AlertsBell.tsx 调 useAlertsRealtime
 */

import { readFileSync } from 'fs';
import { join } from 'path';

import {
  ALERTS_POLLING_INTERVAL_MS,
  ALERTS_RECONNECT_GIVE_UP_AFTER,
  ALERTS_RECONNECT_INITIAL_MS,
  ALERTS_RECONNECT_MAX_MS,
  buildAlertsWsUrl,
  computeReconnectBackoff,
  parseRealtimeMessage,
  shouldFetchOnMessage,
  shouldGiveUpReconnect,
  wsUrlFromHttpBase,
} from '../../../frontend/src/services/alertsRealtimeClient';

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
assert('[1.1] POLLING_INTERVAL > 0', ALERTS_POLLING_INTERVAL_MS > 0);
assert(
  '[1.2] POLLING_INTERVAL <= 60s (用户感知)',
  ALERTS_POLLING_INTERVAL_MS <= 60_000
);
assert(
  '[1.3] POLLING_INTERVAL >= 10s (防 DDoS)',
  ALERTS_POLLING_INTERVAL_MS >= 10_000
);
assert(
  '[1.4] RECONNECT_INITIAL < RECONNECT_MAX',
  ALERTS_RECONNECT_INITIAL_MS < ALERTS_RECONNECT_MAX_MS
);
assert(
  '[1.5] RECONNECT_INITIAL >= 500ms (防快速雪崩)',
  ALERTS_RECONNECT_INITIAL_MS >= 500
);
assert('[1.6] GIVE_UP_AFTER > 0', ALERTS_RECONNECT_GIVE_UP_AFTER > 0);
assert(
  '[1.7] GIVE_UP_AFTER >= 3 (允许临时网络抖动)',
  ALERTS_RECONNECT_GIVE_UP_AFTER >= 3
);

// ============================================================
// [2] wsUrlFromHttpBase
// ============================================================
assert(
  '[2.1] http:// → ws://',
  wsUrlFromHttpBase('http://localhost:3000') === 'ws://localhost:3000'
);
assert(
  '[2.2] https:// → wss://',
  wsUrlFromHttpBase('https://api.example.com') === 'wss://api.example.com'
);
assert(
  '[2.3] 末尾 / 自动剥',
  wsUrlFromHttpBase('http://h:3000/') === 'ws://h:3000'
);
assert(
  '[2.4] 末尾多 / 自动剥',
  wsUrlFromHttpBase('http://h:3000///') === 'ws://h:3000'
);
assert('[2.5] null → null', wsUrlFromHttpBase(null) === null);
assert('[2.6] undefined → null', wsUrlFromHttpBase(undefined) === null);
assert('[2.7] 空 string → null', wsUrlFromHttpBase('') === null);
assert(
  '[2.8] 无 protocol → null (拒绝 bare host 防错配)',
  wsUrlFromHttpBase('localhost:3000') === null
);

// ============================================================
// [3] buildAlertsWsUrl
// ============================================================
assert(
  '[3.1] 正常: ws://h + token=abc',
  buildAlertsWsUrl('ws://h', 'abc') === 'ws://h/ws/alerts?token=abc'
);
assert(
  '[3.2] token 缺 → null',
  buildAlertsWsUrl('ws://h', null) === null
);
assert(
  '[3.3] base 缺 → null',
  buildAlertsWsUrl(null, 'abc') === null
);
assert(
  '[3.4] token 特殊字符 encode',
  buildAlertsWsUrl('ws://h', 'a+b/c=') === 'ws://h/ws/alerts?token=a%2Bb%2Fc%3D'
);

// ============================================================
// [4] computeReconnectBackoff — 指数翻倍 + clamp
// ============================================================
assert(
  '[4.1] attempt=0 → INITIAL',
  computeReconnectBackoff(0) === ALERTS_RECONNECT_INITIAL_MS
);
assert(
  '[4.2] attempt=1 → 2*INITIAL',
  computeReconnectBackoff(1) === ALERTS_RECONNECT_INITIAL_MS * 2
);
assert(
  '[4.3] attempt=4 → 16*INITIAL (16s)',
  computeReconnectBackoff(4) === ALERTS_RECONNECT_INITIAL_MS * 16
);
assert(
  '[4.4] attempt=10 → clamp 到 MAX',
  computeReconnectBackoff(10) === ALERTS_RECONNECT_MAX_MS
);
assert(
  '[4.5] attempt=-1 (非法) → INITIAL',
  computeReconnectBackoff(-1) === ALERTS_RECONNECT_INITIAL_MS
);
assert(
  '[4.6] attempt=NaN → INITIAL',
  computeReconnectBackoff(NaN) === ALERTS_RECONNECT_INITIAL_MS
);
assert(
  '[4.7] 自定义 initial=500 max=4000, attempt=3 → min(4000, 4000)=4000',
  computeReconnectBackoff(3, 500, 4000) === 4000
);

// ============================================================
// [5] shouldGiveUpReconnect
// ============================================================
assert('[5.1] attempt < GIVE_UP → false', !shouldGiveUpReconnect(0));
assert(
  '[5.2] attempt === GIVE_UP → true',
  shouldGiveUpReconnect(ALERTS_RECONNECT_GIVE_UP_AFTER)
);
assert(
  '[5.3] attempt > GIVE_UP → true',
  shouldGiveUpReconnect(ALERTS_RECONNECT_GIVE_UP_AFTER + 5)
);
assert(
  '[5.4] NaN → false (不当成超限)',
  !shouldGiveUpReconnect(NaN)
);

// ============================================================
// [6] parseRealtimeMessage
// ============================================================
assert('[6.1] null → null', parseRealtimeMessage(null) === null);
assert('[6.2] undefined → null', parseRealtimeMessage(undefined) === null);
assert('[6.3] 非 string → null', parseRealtimeMessage(123 as any) === null);
assert('[6.4] 损坏 JSON → null', parseRealtimeMessage('not-json') === null);
assert(
  '[6.5] JSON null → null',
  parseRealtimeMessage('null') === null
);
assert(
  '[6.6] JSON 但非 object → null',
  parseRealtimeMessage('"plain-string"') === null
);
assert(
  '[6.7] JSON object 缺 type → null',
  parseRealtimeMessage(JSON.stringify({ alert_id: 1 })) === null
);

const goodMsg = JSON.stringify({ type: 'alert.new', alert_id: 7, level: 'HIGH' });
const parsed = parseRealtimeMessage(goodMsg);
assert(
  '[6.8] 正常 alert.new → 解出对象',
  !!parsed && parsed.type === 'alert.new' && parsed.alert_id === 7
);

const connMsg = JSON.stringify({ type: 'connected', user_id: 1 });
const cp = parseRealtimeMessage(connMsg);
assert('[6.9] connected 消息也能解析', !!cp && cp.type === 'connected');

// ============================================================
// [7] shouldFetchOnMessage
// ============================================================
assert(
  '[7.1] alert.new → true (要 fetch 一次 unread_count)',
  shouldFetchOnMessage({ type: 'alert.new' })
);
assert(
  '[7.2] connected → false (不重复 fetch)',
  !shouldFetchOnMessage({ type: 'connected' })
);
assert(
  '[7.3] 未知 type → false',
  !shouldFetchOnMessage({ type: 'something-else' })
);
assert('[7.4] null → false', !shouldFetchOnMessage(null));

// ============================================================
// [8] META-GUARD — AlertsBell.tsx 调 useAlertsRealtime
// ============================================================
const bellSrc = readFileSync(
  join(__dirname, '../../../frontend/src/components/layout/AlertsBell.tsx'),
  'utf8'
);
assert(
  '[8.1] AlertsBell.tsx 含 useAlertsRealtime import',
  /useAlertsRealtime/.test(bellSrc) &&
    /from\s+['"]\.\.\/\.\.\/services\/alertsRealtimeClient['"]/.test(bellSrc)
);
assert(
  '[8.2] AlertsBell.tsx 调 useAlertsRealtime(',
  /useAlertsRealtime\(/.test(bellSrc)
);
assert(
  '[8.3] AlertsBell.tsx 不再直接 setInterval poll (改走 hook)',
  !/window\.setInterval\(\s*\(\)\s*=>\s*\{[\s\S]*?fetchUnread/.test(bellSrc)
);
assert(
  '[8.4] AlertsBell.tsx 不再直接 import listRiskAlerts (hook 内部消费)',
  !/from\s+['"]\.\.\/\.\.\/services\/riskAlertService['"]/.test(bellSrc)
);
assert(
  '[8.5] data-mode 暴露给 E2E / dev-browser skill',
  /data-mode=/.test(bellSrc)
);
assert(
  '[8.6] enableWebSocket prop 暴露 — 故障演练用',
  /enableWebSocket/.test(bellSrc)
);

// alertsRealtimeClient.ts 自身: useAlertsRealtime 必须含 polling fallback
const clientSrc = readFileSync(
  join(__dirname, '../../../frontend/src/services/alertsRealtimeClient.ts'),
  'utf8'
);
assert(
  '[8.7] alertsRealtimeClient.ts 含 polling fallback (startPolling)',
  /startPolling/.test(clientSrc)
);
assert(
  '[8.8] alertsRealtimeClient.ts 含 reconnect backoff (scheduleReconnect)',
  /scheduleReconnect/.test(clientSrc)
);
assert(
  "[8.9] alertsRealtimeClient.ts WS message 'connected' 时停 polling (stopPolling)",
  /stopPolling/.test(clientSrc)
);
assert(
  '[8.10] alertsRealtimeClient.ts 用 WebSocket constructor (走 browser API)',
  /new WebSocket\(/.test(clientSrc)
);

// ============================================================
// summary
// ============================================================
console.log(`\nalerts-realtime-client: ${passed} ok / ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
