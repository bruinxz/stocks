/**
 * US-073 [FE-034] AlertsBroadcaster — 进程内 WebSocket fan-out 单元测试.
 *
 * 跑法:
 *   cd backend && npx ts-node --transpile-only tests/realtime/alerts-broadcaster.test.ts
 * 或:
 *   cd backend && npm test -- --filter=alerts-broadcaster
 *
 * 覆盖维度:
 *   [1] 常量 sanity
 *   [2] buildBroadcastPayload — 字段归一化 + 缺失兜底 + Date/string created_at
 *   [3] isValidUserId — 边界
 *   [4] register / unregister / countClients — 正常路径 + MAX_CLIENTS_PER_USER
 *   [5] broadcast — 0 client / 1 client / 多 client / 跨 user 隔离 / 非法 user
 *   [6] broadcast 错误兜底 — client.send throw 自动 unregister; isOpen=false 自动 drop
 *   [7] broadcast fanout cap (MAX_BROADCAST_FANOUT)
 *   [8] meta-test — RiskAlert.afterCreate 含 broadcaster import + call
 */

import { readFileSync } from 'fs';
import { join } from 'path';

import {
  AlertsBroadcaster,
  AlertsBroadcastClient,
  AlertsBroadcastPayload,
  buildBroadcastPayload,
  isValidUserId,
  MAX_BROADCAST_FANOUT,
  MAX_CLIENTS_PER_USER,
} from '../../src/realtime/alertsBroadcaster';

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

// Helper: 制造一个 fake client. send 计数, 可控 isOpen / throw.
function makeFakeClient(opts: {
  id?: string;
  isOpenValue?: boolean;
  isOpenThrows?: boolean;
  sendThrows?: boolean;
} = {}): AlertsBroadcastClient & { calls: AlertsBroadcastPayload[] } {
  const calls: AlertsBroadcastPayload[] = [];
  const c: AlertsBroadcastClient & { calls: AlertsBroadcastPayload[] } = {
    client_id: opts.id || 'fake-' + Math.random().toString(36).slice(2, 8),
    isOpen: () => {
      if (opts.isOpenThrows) throw new Error('isOpen-bad');
      return opts.isOpenValue !== false;
    },
    send: (p: AlertsBroadcastPayload) => {
      if (opts.sendThrows) throw new Error('send-bad');
      calls.push(p);
    },
    calls,
  };
  return c;
}

// ============================================================
// [1] 常量 sanity
// ============================================================
assert('[1.1] MAX_CLIENTS_PER_USER > 0', MAX_CLIENTS_PER_USER > 0);
assert('[1.2] MAX_CLIENTS_PER_USER <= 64 (防泄漏)', MAX_CLIENTS_PER_USER <= 64);
assert(
  '[1.3] MAX_BROADCAST_FANOUT >= MAX_CLIENTS_PER_USER (单 user 内 fan-out 不被 cap 折)',
  MAX_BROADCAST_FANOUT >= MAX_CLIENTS_PER_USER
);

// ============================================================
// [2] buildBroadcastPayload
// ============================================================
const p1 = buildBroadcastPayload({
  alert_id: 12,
  user_id: 7,
  symbol: '600519',
  name: '贵州茅台',
  level: 'high',
  message: '止损触发',
  rule_id: 'trailing_stop',
  created_at: new Date('2026-06-20T08:30:00.000Z'),
});
assert('[2.1] type=alert.new', p1.type === 'alert.new');
assert('[2.2] alert_id 数字透传', p1.alert_id === 12);
assert('[2.3] level upcase', p1.level === 'HIGH');
assert(
  '[2.4] created_at Date → ISO',
  p1.created_at === '2026-06-20T08:30:00.000Z',
  `actual=${p1.created_at}`
);
assert('[2.5] rule_id 透传', p1.rule_id === 'trailing_stop');

const p2 = buildBroadcastPayload({
  alert_id: 99,
  user_id: 1,
  symbol: '300750',
  level: 'medium',
  message: 'x',
  // 缺 name / rule_id / created_at
});
assert('[2.6] name 缺失兜底 ""', p2.name === '');
assert('[2.7] rule_id 缺失兜底 null', p2.rule_id === null);
assert('[2.8] created_at 缺失兜底当前 ISO', /\d{4}-\d{2}-\d{2}T/.test(p2.created_at));

const p3 = buildBroadcastPayload({
  alert_id: 5,
  user_id: 2,
  symbol: 's',
  level: 'low',
  message: 'm',
  created_at: '2026-01-01T00:00:00Z',
  unread_delta: 3,
});
assert('[2.9] created_at string 透传', p3.created_at === '2026-01-01T00:00:00Z');
assert('[2.10] unread_delta 透传', p3.unread_delta === 3);

const p4 = buildBroadcastPayload({
  alert_id: 0,
  user_id: 0,
  symbol: '',
  level: '',
  message: '',
});
assert('[2.11] alert_id=0 / user_id=0 (Number 0) — 仍生成 payload 不抛', p4.alert_id === 0);

// ============================================================
// [3] isValidUserId
// ============================================================
assert('[3.1] 正常 7 → true', isValidUserId(7));
assert('[3.2] 0 → false', !isValidUserId(0));
assert('[3.3] -1 → false', !isValidUserId(-1));
assert('[3.4] NaN → false', !isValidUserId(NaN));
assert('[3.5] string "1" → false (类型严格)', !isValidUserId('1'));
assert('[3.6] null → false', !isValidUserId(null));
assert('[3.7] Infinity → false', !isValidUserId(Infinity));

// ============================================================
// [4] register / unregister / countClients
// ============================================================
{
  const bc = new AlertsBroadcaster();
  const c1 = makeFakeClient({ id: 'c1' });
  assert('[4.1] register 正常 user=7 → true', bc.register(7, c1));
  assert('[4.2] countClients(7)=1', bc.countClients(7) === 1);
  assert('[4.3] countTotalClients=1', bc.countTotalClients() === 1);
  assert('[4.4] register 非法 user_id=0 → false', !bc.register(0, c1));
  // 上限测试
  for (let i = 0; i < MAX_CLIENTS_PER_USER - 1; i++) {
    bc.register(7, makeFakeClient({ id: `c-${i}` }));
  }
  assert(
    '[4.5] 已达 MAX_CLIENTS_PER_USER → countClients==MAX',
    bc.countClients(7) === MAX_CLIENTS_PER_USER
  );
  const overflow = makeFakeClient({ id: 'overflow' });
  assert('[4.6] 再 register 超上限 → false', !bc.register(7, overflow));
  assert('[4.7] 超上限后 countClients 不变', bc.countClients(7) === MAX_CLIENTS_PER_USER);
  // unregister
  bc.unregister(7, c1);
  assert(
    '[4.8] unregister 后 countClients-1',
    bc.countClients(7) === MAX_CLIENTS_PER_USER - 1
  );
  // 跨 user 隔离
  bc.register(99, makeFakeClient({ id: 'u99' }));
  assert('[4.9] 跨 user 隔离 user=99 count=1', bc.countClients(99) === 1);
  assert('[4.10] user=7 不受影响', bc.countClients(7) === MAX_CLIENTS_PER_USER - 1);
  // 不存在 user 静默
  bc.unregister(12345, c1);
  assert('[4.11] 不存在 user.unregister 静默不抛', true);
  // 清空后 countClients=0
  bc.resetForTests();
  assert('[4.12] resetForTests → 全 0', bc.countTotalClients() === 0);

  const closedReasons: string[] = [];
  const revokedClient = makeFakeClient({ id: 'revoked' });
  revokedClient.close = reason => closedReasons.push(reason);
  bc.register(7, revokedClient);
  assert('[4.13] disconnectUser closes one client', bc.disconnectUser(7, 'logout') === 1);
  assert('[4.14] disconnectUser passes reason', closedReasons[0] === 'logout');
  assert('[4.15] disconnectUser clears registry', bc.countClients(7) === 0);
}

// ============================================================
// [5] broadcast 主路径
// ============================================================
{
  const bc = new AlertsBroadcaster();
  const c1 = makeFakeClient({ id: 'b1' });
  const c2 = makeFakeClient({ id: 'b2' });
  const c3 = makeFakeClient({ id: 'b3' });
  bc.register(7, c1);
  bc.register(7, c2);
  bc.register(99, c3); // 不同 user

  const payload = buildBroadcastPayload({
    alert_id: 1,
    user_id: 7,
    symbol: 's',
    level: 'high',
    message: 'm',
  });
  const r = bc.broadcast(payload);
  assert('[5.1] 2 client 都收到', c1.calls.length === 1 && c2.calls.length === 1);
  assert('[5.2] 跨 user c3 不收', c3.calls.length === 0);
  assert('[5.3] result {sent:2, dropped:0}', r.sent === 2 && r.dropped === 0);

  // 0 client user
  const r2 = bc.broadcast(buildBroadcastPayload({ alert_id: 2, user_id: 12345, symbol: 's', level: 'h', message: 'x' }));
  assert('[5.4] 0 client user broadcast 返 {0,0}', r2.sent === 0 && r2.dropped === 0);

  // 非法 user_id
  const r3 = bc.broadcast({ ...payload, user_id: 0 });
  assert('[5.5] 非法 user_id=0 → {0,0} 不广播', r3.sent === 0 && r3.dropped === 0);

  // 检查 c1/c2 payload 内容
  assert(
    '[5.6] payload 内容透传给 client',
    c1.calls[0].alert_id === 1 && c1.calls[0].symbol === 's' && c1.calls[0].level === 'HIGH'
  );
}

// ============================================================
// [6] broadcast 错误兜底
// ============================================================
{
  const bc = new AlertsBroadcaster();
  const good = makeFakeClient({ id: 'good' });
  const bad = makeFakeClient({ id: 'bad', sendThrows: true });
  bc.register(7, good);
  bc.register(7, bad);
  const r = bc.broadcast(
    buildBroadcastPayload({ alert_id: 1, user_id: 7, symbol: 's', level: 'h', message: 'm' })
  );
  assert('[6.1] good 收到', good.calls.length === 1);
  assert('[6.2] bad send throw → result {sent:1, dropped:1}', r.sent === 1 && r.dropped === 1);
  assert('[6.3] bad 自动 unregister', bc.countClients(7) === 1);

  // isOpen=false → drop
  const closed = makeFakeClient({ id: 'closed', isOpenValue: false });
  bc.register(7, closed);
  const r2 = bc.broadcast(
    buildBroadcastPayload({ alert_id: 2, user_id: 7, symbol: 's', level: 'h', message: 'm' })
  );
  assert(
    '[6.4] isOpen=false → drop 不 send',
    r2.dropped >= 1 && closed.calls.length === 0
  );
  assert('[6.5] isOpen=false 后自动 unregister', bc.countClients(7) === 1);

  // isOpen 自身 throw → 视为 dead
  const throwOpen = makeFakeClient({ id: 'throw-open', isOpenThrows: true });
  bc.register(7, throwOpen);
  const r3 = bc.broadcast(
    buildBroadcastPayload({ alert_id: 3, user_id: 7, symbol: 's', level: 'h', message: 'm' })
  );
  assert(
    '[6.6] isOpen throw → drop 视为 dead',
    throwOpen.calls.length === 0 && r3.dropped >= 1
  );
}

// ============================================================
// [7] fanout cap — 验证不超 MAX_BROADCAST_FANOUT
// ============================================================
{
  // 改用一个不同的 user 避免 MAX_CLIENTS_PER_USER 限制 — 这里只测 fanout 行为
  // (实际中 MAX_BROADCAST_FANOUT >= MAX_CLIENTS_PER_USER 已 sanity, 测试只为
  //  双重防御; 用 register 后手动塞 client 进去 — 但 broadcaster 没 backdoor,
  //  所以我们就测 "MAX_CLIENTS_PER_USER 数量下全部收到" 等价命题).
  const bc = new AlertsBroadcaster();
  const clients: ReturnType<typeof makeFakeClient>[] = [];
  for (let i = 0; i < MAX_CLIENTS_PER_USER; i++) {
    const c = makeFakeClient({ id: `f-${i}` });
    clients.push(c);
    bc.register(7, c);
  }
  bc.broadcast(
    buildBroadcastPayload({ alert_id: 1, user_id: 7, symbol: 's', level: 'h', message: 'm' })
  );
  const allGot = clients.every(c => c.calls.length === 1);
  assert(
    `[7.1] fanout to all ${MAX_CLIENTS_PER_USER} clients (≤ MAX_BROADCAST_FANOUT)`,
    allGot
  );
}

// ============================================================
// [8] META-GUARD — RiskAlert.afterCreate 调到了 broadcaster
// ============================================================
const riskAlertSrc = readFileSync(
  join(__dirname, '../../src/models/RiskAlert.ts'),
  'utf8'
);
assert(
  '[8.1] RiskAlert.ts 含 alertsBroadcaster import',
  /require\(['"]\.\.\/realtime\/alertsBroadcaster['"]\)/.test(riskAlertSrc)
);
assert(
  '[8.2] RiskAlert.ts 调 buildBroadcastPayload',
  /buildBroadcastPayload\(/.test(riskAlertSrc)
);
assert(
  '[8.3] RiskAlert.ts 调 alertsBroadcaster.broadcast',
  /alertsBroadcaster\.broadcast\(/.test(riskAlertSrc)
);
assert(
  '[8.4] RiskAlert.ts 仍保留既有 RealtimeAlertDispatcher fire-and-forget',
  /realtimeAlertDispatcher\.fireAndForget\(/.test(riskAlertSrc)
);
assert(
  '[8.5] RiskAlert.afterCreate 仍 fail-OPEN 顶层 try/catch',
  /\[RiskAlert\.afterCreate\]/.test(riskAlertSrc) && /catch\s*\(/.test(riskAlertSrc)
);
// broadcaster.broadcast 必须在 'HIGH' gate 之前 (所有 level 都广播), 不能放 dispatcher 后
const broadcastIdx = riskAlertSrc.indexOf('alertsBroadcaster.broadcast(');
const highGateIdx = riskAlertSrc.indexOf("'HIGH'");
assert(
  '[8.6] broadcast 调在 HIGH gate 之前 (所有 level 都广播)',
  broadcastIdx > 0 && highGateIdx > 0 && broadcastIdx < highGateIdx,
  `broadcastIdx=${broadcastIdx} highGateIdx=${highGateIdx}`
);

// ============================================================
// summary
// ============================================================
console.log(`\nalerts-broadcaster: ${passed} ok / ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
