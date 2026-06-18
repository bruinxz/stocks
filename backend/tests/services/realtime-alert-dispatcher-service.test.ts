/**
 * RealtimeAlertDispatcher 单元测试 (US-067 实时风控 webhook)
 *
 * 不依赖 jest；node 直接跑:
 *   cd backend && npx ts-node --transpile-only tests/services/realtime-alert-dispatcher-service.test.ts
 *
 * 完全脱离 DB / 网络：注入 fake RealtimeAlertDispatcherDataSource。
 *
 * 覆盖维度:
 *   - 常量冻结 (REALTIME_ALERT_STATUS / REALTIME_ALERT_CHANNELS / window / lru)
 *   - 纯函数:
 *     - buildAlertSignature (各字段缺失 / 正常 / 大小写)
 *     - isWithinDedupWindow (在窗 / 出窗 / 缺记录 / 非法 ts / 负 window)
 *     - mergeSeenAlertSignatures (新增 / 重复 bump / FIFO LRU drop / 非法记录过滤 / limit edge)
 *     - shouldDispatchForChannel (feishu / email / sms 各自 4 路径)
 *     - buildAlertId (YYYY-MM-DD slice / rand4 padding)
 *     - buildAlertDeeplink (baseUrl trim / SearchParams 顺序)
 *     - buildRiskAlertFeishuCard (HIGH 红 / MEDIUM 橙 / LOW 灰 / 字段 truncate / sections 顺序)
 *     - buildRiskAlertEmail (subject 含 level + symbol / html 含 deeplink / text fallback)
 *     - buildRiskAlertSmsParams (env 缺失 fallback signName / templateCode 透传 / 字段截断)
 *   - service.dispatch() e2e:
 *     - level !== HIGH → skipped + skip_reason
 *     - 用户不存在 → skipped
 *     - 30 min dedup hit → skipped + deduped=true
 *     - 出 30 min 窗 → 重新发
 *     - dry_run=true → 所有 channel status=skipped message=dry_run，不写 dedup
 *     - 3 channel 全 enabled + 全成功 → status=sent / sent_any=true / 写 dedup
 *     - 1 channel fail + 2 sent → status=partial
 *     - 3 channel 全 fail → status=failed
 *     - feishu enabled=false → channel skipped
 *     - email risk_alert=false → channel skipped
 *     - sms phone 缺 → channel skipped
 *     - sendFeishu throw → channel failed 不传染其他 channel
 *     - loadSeenRecords throw → fail-OPEN 继续推送
 *     - saveSeenRecords throw → fail-OPEN 返回 sent
 *     - 同 signature 2 次连发 → 第 2 次 deduped
 *     - 不同 signature → 各自独立 dedup
 *     - rule_id 缺失 → signature 用 'unknown'
 *     - level 大小写差异 → signature normalize 一致
 *     - fireAndForget (no-await) 不 throw
 *     - LRU trim 超 200 条 → 旧的 drop
 *
 * 测试运行：每条断言 console.log 一次，最后汇总 ok/failed 计数。
 */

import {
  RealtimeAlertDispatcher,
  RealtimeAlertDispatcherDataSource,
  RealtimeAlertInput,
  RealtimeAlertSeenRecord,
  RealtimeAlertChannelResult,
  RealtimeAlertCardPayload,
  REALTIME_ALERT_STATUS,
  REALTIME_ALERT_CHANNELS,
  REALTIME_ALERT_DEDUP_WINDOW_MS,
  REALTIME_ALERT_SEEN_LRU_LIMIT,
  REALTIME_ALERT_TRIGGER_LEVEL,
  buildAlertSignature,
  isWithinDedupWindow,
  mergeSeenAlertSignatures,
  shouldDispatchForChannel,
  buildAlertId,
  buildAlertDeeplink,
  buildRiskAlertFeishuCard,
  buildRiskAlertEmail,
  buildRiskAlertSmsParams,
  SMS_TEMPLATE_RISK_ALERT_ENV,
  SMS_SIGN_NAME_ENV,
} from '../../src/services/RealtimeAlertDispatcher';

import {
  NotificationChannelsConfig,
  DEFAULT_NOTIFICATION_CONFIG,
} from '../../src/services/DailyTradingDigestService';

import { FeishuBotWebhookSendResult } from '../../src/services/FeishuBotWebhookService';
import { EmailNotificationSendResult } from '../../src/services/EmailNotificationService';
import { AliyunSmsSendResult } from '../../src/services/AliyunSmsService';

let passed = 0;
let failed = 0;

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

function assertThrows(name: string, fn: () => any): void {
  try {
    fn();
    failed += 1;
    console.error(`❌ ${name} - did not throw`);
  } catch {
    passed += 1;
  }
}

async function assertRejects(name: string, fn: () => Promise<any>): Promise<void> {
  try {
    await fn();
    failed += 1;
    console.error(`❌ ${name} - did not reject`);
  } catch {
    passed += 1;
  }
}

// ---------------------------------------------------------------------------
// Fake DataSource
// ---------------------------------------------------------------------------

interface FakeUserState {
  username: string;
  config: NotificationChannelsConfig;
}

interface FakeDataSourceOptions {
  /** Map<user_id, FakeUserState | null>; null 代表用户不存在 */
  users: Map<number, FakeUserState | null>;
  /** seen records by user */
  seenByUser?: Map<number, RealtimeAlertSeenRecord[]>;
  /** Override channel adapters */
  sendFeishu?: (
    payload: RealtimeAlertCardPayload,
    url: string
  ) => Promise<FeishuBotWebhookSendResult>;
  sendEmail?: (
    payload: RealtimeAlertCardPayload,
    addr: string
  ) => Promise<EmailNotificationSendResult>;
  sendSms?: (payload: RealtimeAlertCardPayload, phone: string) => Promise<AliyunSmsSendResult>;
  /** Inject errors */
  loadSeenThrows?: boolean;
  saveSeenThrows?: boolean;
  loadUserThrows?: boolean;
}

class FakeDataSource implements RealtimeAlertDispatcherDataSource {
  public sendFeishuCalls: Array<{ payload: RealtimeAlertCardPayload; url: string }> = [];
  public sendEmailCalls: Array<{ payload: RealtimeAlertCardPayload; addr: string }> = [];
  public sendSmsCalls: Array<{ payload: RealtimeAlertCardPayload; phone: string }> = [];
  public saveSeenCalls: Array<{ user_id: number; records: RealtimeAlertSeenRecord[] }> = [];

  constructor(private opts: FakeDataSourceOptions) {
    if (!opts.seenByUser) opts.seenByUser = new Map();
  }

  async loadUserConfig(user_id: number) {
    if (this.opts.loadUserThrows) throw new Error('fake loadUserConfig throw');
    const state = this.opts.users.get(user_id);
    if (!state) return null;
    return { username: state.username, config: state.config };
  }

  async loadSeenRecords(user_id: number): Promise<RealtimeAlertSeenRecord[]> {
    if (this.opts.loadSeenThrows) throw new Error('fake loadSeenRecords throw');
    return this.opts.seenByUser!.get(user_id) || [];
  }

  async saveSeenRecords(user_id: number, records: RealtimeAlertSeenRecord[]): Promise<void> {
    this.saveSeenCalls.push({ user_id, records });
    if (this.opts.saveSeenThrows) throw new Error('fake saveSeenRecords throw');
    this.opts.seenByUser!.set(user_id, records);
  }

  async sendFeishuCard(payload: RealtimeAlertCardPayload, url: string) {
    this.sendFeishuCalls.push({ payload, url });
    if (this.opts.sendFeishu) return this.opts.sendFeishu(payload, url);
    return { success: true, data: { code: 0 } };
  }

  async sendEmail(payload: RealtimeAlertCardPayload, addr: string) {
    this.sendEmailCalls.push({ payload, addr });
    if (this.opts.sendEmail) return this.opts.sendEmail(payload, addr);
    return { success: true, data: { messageId: 'fake-msg' } };
  }

  async sendSms(payload: RealtimeAlertCardPayload, phone: string) {
    this.sendSmsCalls.push({ payload, phone });
    if (this.opts.sendSms) return this.opts.sendSms(payload, phone);
    return { success: true, data: { code: 'OK', bizId: 'fake-biz' } };
  }
}

// Helpers to build configs
function configFull(
  overrides: {
    feishu?: Partial<NotificationChannelsConfig['feishu']>;
    email?: Partial<NotificationChannelsConfig['email']>;
    sms?: Partial<NotificationChannelsConfig['sms']>;
  } = {}
): NotificationChannelsConfig {
  return {
    feishu: {
      enabled: true,
      webhook_url: 'https://feishu.test/webhook/abc',
      daily_digest: true,
      earnings_alert: true,
      risk_alert: true,
      ...(overrides.feishu || {}),
    },
    email: {
      enabled: true,
      address: 'user@example.com',
      weekly_review: true,
      risk_alert: true,
      ...(overrides.email || {}),
    },
    wechat: { ...DEFAULT_NOTIFICATION_CONFIG.wechat },
    sms: {
      enabled: true,
      phone: '13800138000',
      risk_alert: true,
      ...(overrides.sms || {}),
    },
  };
}

function makeInput(overrides: Partial<RealtimeAlertInput> = {}): RealtimeAlertInput {
  return {
    user_id: 1,
    symbol: '600519',
    name: '贵州茅台',
    level: 'HIGH',
    message: '触发持仓上限告警',
    rule_id: 'position_limit',
    triggered_at: '2026-06-08 10:00:00',
    ...overrides,
  };
}

(async () => {
  console.log('\n[1] 常量冻结...');

  assertEqual('REALTIME_ALERT_STATUS.SENT', REALTIME_ALERT_STATUS.SENT, 'sent');
  assertEqual('REALTIME_ALERT_STATUS.SKIPPED', REALTIME_ALERT_STATUS.SKIPPED, 'skipped');
  assertEqual('REALTIME_ALERT_STATUS.FAILED', REALTIME_ALERT_STATUS.FAILED, 'failed');
  assertEqual('REALTIME_ALERT_STATUS.PARTIAL', REALTIME_ALERT_STATUS.PARTIAL, 'partial');
  assertEqual('REALTIME_ALERT_CHANNELS.FEISHU', REALTIME_ALERT_CHANNELS.FEISHU, 'feishu');
  assertEqual('REALTIME_ALERT_CHANNELS.EMAIL', REALTIME_ALERT_CHANNELS.EMAIL, 'email');
  assertEqual('REALTIME_ALERT_CHANNELS.SMS', REALTIME_ALERT_CHANNELS.SMS, 'sms');
  assertEqual('dedup window 30 min', REALTIME_ALERT_DEDUP_WINDOW_MS, 30 * 60 * 1000);
  assertEqual('lru limit 200', REALTIME_ALERT_SEEN_LRU_LIMIT, 200);
  assertEqual('trigger level HIGH', REALTIME_ALERT_TRIGGER_LEVEL, 'HIGH');

  // status / channels objects are frozen
  assertThrows('STATUS 不可变', () => {
    (REALTIME_ALERT_STATUS as any).NEW = 'new';
  });
  assertThrows('CHANNELS 不可变', () => {
    (REALTIME_ALERT_CHANNELS as any).WEBHOOK = 'webhook';
  });

  // =========================================================================
  console.log('\n[2] buildAlertSignature 边界...');
  // Batch X (2026-06-17, notif-3): signature 加 message hash 后缀，让"升级告警"突破 dedup
  //   schema: `<rule_id>::<symbol>::<level>::<msgHash>` (msgHash='0' 当 message 缺失)
  assertEqual(
    'normal',
    buildAlertSignature({ rule_id: 'position_limit', symbol: '600519', level: 'HIGH' }),
    'position_limit::600519::HIGH::0'
  );
  assertEqual(
    'level 小写 normalize',
    buildAlertSignature({ rule_id: 'r', symbol: 's', level: 'high' }),
    'r::s::HIGH::0'
  );
  assertEqual(
    'rule_id 缺失 → unknown',
    buildAlertSignature({ symbol: '600519', level: 'HIGH' } as any),
    'unknown::600519::HIGH::0'
  );
  assertEqual(
    'rule_id 空字符串 → unknown',
    buildAlertSignature({ rule_id: '   ', symbol: '600519', level: 'HIGH' }),
    'unknown::600519::HIGH::0'
  );
  assertEqual(
    'symbol 缺失 → UNKNOWN_SYMBOL',
    buildAlertSignature({ rule_id: 'r', level: 'HIGH' } as any),
    'r::UNKNOWN_SYMBOL::HIGH::0'
  );
  assertEqual(
    'level 缺失 → UNKNOWN_LEVEL',
    buildAlertSignature({ rule_id: 'r', symbol: 's' } as any),
    'r::s::UNKNOWN_LEVEL::0'
  );

  // =========================================================================
  console.log('\n[3] isWithinDedupWindow...');
  const nowMs = 1_000_000_000_000;
  assertEqual('在窗', isWithinDedupWindow({ signature: 's', pushed_at_ms: nowMs - 10_000 }, nowMs), true);
  assertEqual(
    '出窗（恰好 30min）',
    isWithinDedupWindow({ signature: 's', pushed_at_ms: nowMs - 30 * 60 * 1000 }, nowMs),
    false
  );
  assertEqual(
    '出窗（30min + 1s）',
    isWithinDedupWindow(
      { signature: 's', pushed_at_ms: nowMs - 30 * 60 * 1000 - 1000 },
      nowMs
    ),
    false
  );
  assertEqual('缺记录 → false', isWithinDedupWindow(undefined, nowMs), false);
  assertEqual(
    'pushed_at_ms NaN → false',
    isWithinDedupWindow({ signature: 's', pushed_at_ms: NaN as any }, nowMs),
    false
  );
  assertEqual(
    'window 负值 → false',
    isWithinDedupWindow({ signature: 's', pushed_at_ms: nowMs - 10 }, nowMs, -1),
    false
  );

  // =========================================================================
  console.log('\n[4] mergeSeenAlertSignatures...');
  const m1 = mergeSeenAlertSignatures([], [{ signature: 'a', pushed_at_ms: 100 }]);
  assertEqual('append new', m1.length, 1);
  assertEqual('append signature', m1[0].signature, 'a');

  const m2 = mergeSeenAlertSignatures(
    [
      { signature: 'a', pushed_at_ms: 100 },
      { signature: 'b', pushed_at_ms: 200 },
    ],
    [{ signature: 'a', pushed_at_ms: 999 }]
  );
  assertEqual('bump 重复 signature 到末尾', m2.length, 2);
  assertEqual('bump 后顺序 b a', m2.map(r => r.signature).join(','), 'b,a');
  assertEqual('bump 后 ts 更新', m2[1].pushed_at_ms, 999);

  const m3 = mergeSeenAlertSignatures(
    Array.from({ length: 5 }, (_, i) => ({ signature: `old-${i}`, pushed_at_ms: i })),
    [
      { signature: 'new-1', pushed_at_ms: 100 },
      { signature: 'new-2', pushed_at_ms: 101 },
      { signature: 'new-3', pushed_at_ms: 102 },
    ],
    5
  );
  assertEqual('LRU trim limit=5 → 5', m3.length, 5);
  // FIFO 应保留最新的：old-3, old-4, new-1, new-2, new-3
  assertEqual(
    'LRU drop 最老',
    m3.map(r => r.signature).join(','),
    'old-2,old-3,old-4,new-1,new-2,new-3'.split(',').slice(-5).join(',')
  );

  // existing 含非法行（缺 signature / 非数字 ts）→ 过滤
  const m4 = mergeSeenAlertSignatures(
    [
      { signature: 'a', pushed_at_ms: 1 },
      { signature: '', pushed_at_ms: 2 } as any,
      { signature: 'b', pushed_at_ms: NaN as any },
      null as any,
      { signature: 'c', pushed_at_ms: 3 },
    ],
    []
  );
  assertEqual('过滤非法行', m4.length, 2);
  assertEqual('保留 a + c', m4.map(r => r.signature).join(','), 'a,c');

  // 非法新行 skip
  const m5 = mergeSeenAlertSignatures(
    [],
    [
      null as any,
      { signature: '', pushed_at_ms: 100 } as any,
      { signature: 'x', pushed_at_ms: NaN as any },
      { signature: 'x', pushed_at_ms: 100 },
    ]
  );
  assertEqual('过滤非法新行 → 仅 x', m5.length, 1);

  // limit edge: limit=0 / 非整 → 退回 200
  const m6 = mergeSeenAlertSignatures(
    Array.from({ length: 250 }, (_, i) => ({ signature: `s-${i}`, pushed_at_ms: i })),
    [],
    0
  );
  assertEqual('limit=0 退回 200', m6.length, 200);
  const m7 = mergeSeenAlertSignatures(
    Array.from({ length: 250 }, (_, i) => ({ signature: `s-${i}`, pushed_at_ms: i })),
    [],
    3.5
  );
  assertEqual('limit 小数退回 200', m7.length, 200);

  // =========================================================================
  console.log('\n[5] shouldDispatchForChannel...');
  const fullConfig = configFull();

  // feishu 路径
  assertEqual(
    'feishu 全通',
    shouldDispatchForChannel(fullConfig, REALTIME_ALERT_CHANNELS.FEISHU, false).shouldSend,
    true
  );
  assertEqual(
    'feishu enabled=false',
    shouldDispatchForChannel(
      configFull({ feishu: { enabled: false } }),
      REALTIME_ALERT_CHANNELS.FEISHU,
      false
    ).shouldSend,
    false
  );
  assertEqual(
    'feishu risk_alert=false',
    shouldDispatchForChannel(
      configFull({ feishu: { risk_alert: false } }),
      REALTIME_ALERT_CHANNELS.FEISHU,
      false
    ).shouldSend,
    false
  );
  assertEqual(
    'feishu URL 缺 + 无 env fallback',
    shouldDispatchForChannel(
      configFull({ feishu: { webhook_url: '' } }),
      REALTIME_ALERT_CHANNELS.FEISHU,
      false
    ).shouldSend,
    false
  );
  assertEqual(
    'feishu URL 缺 + 有 env fallback',
    shouldDispatchForChannel(
      configFull({ feishu: { webhook_url: '' } }),
      REALTIME_ALERT_CHANNELS.FEISHU,
      true
    ).shouldSend,
    true
  );

  // email 路径
  assertEqual(
    'email 全通',
    shouldDispatchForChannel(fullConfig, REALTIME_ALERT_CHANNELS.EMAIL, false).shouldSend,
    true
  );
  assertEqual(
    'email enabled=false',
    shouldDispatchForChannel(
      configFull({ email: { enabled: false } }),
      REALTIME_ALERT_CHANNELS.EMAIL,
      false
    ).shouldSend,
    false
  );
  assertEqual(
    'email risk_alert=false',
    shouldDispatchForChannel(
      configFull({ email: { risk_alert: false } }),
      REALTIME_ALERT_CHANNELS.EMAIL,
      false
    ).shouldSend,
    false
  );
  assertEqual(
    'email address 缺',
    shouldDispatchForChannel(
      configFull({ email: { address: '' } }),
      REALTIME_ALERT_CHANNELS.EMAIL,
      false
    ).shouldSend,
    false
  );

  // sms 路径
  assertEqual(
    'sms 全通',
    shouldDispatchForChannel(fullConfig, REALTIME_ALERT_CHANNELS.SMS, false).shouldSend,
    true
  );
  assertEqual(
    'sms enabled=false',
    shouldDispatchForChannel(
      configFull({ sms: { enabled: false } }),
      REALTIME_ALERT_CHANNELS.SMS,
      false
    ).shouldSend,
    false
  );
  assertEqual(
    'sms risk_alert=false',
    shouldDispatchForChannel(
      configFull({ sms: { risk_alert: false } }),
      REALTIME_ALERT_CHANNELS.SMS,
      false
    ).shouldSend,
    false
  );
  assertEqual(
    'sms phone 缺',
    shouldDispatchForChannel(
      configFull({ sms: { phone: '' } }),
      REALTIME_ALERT_CHANNELS.SMS,
      false
    ).shouldSend,
    false
  );

  // 未知 channel
  assertEqual(
    '未知 channel → false',
    shouldDispatchForChannel(fullConfig, 'unknown' as any, false).shouldSend,
    false
  );

  // =========================================================================
  console.log('\n[6] buildAlertId / buildAlertDeeplink...');
  assertEqual(
    'buildAlertId 标准',
    buildAlertId(42, '2026-06-08 10:00:00', 'abcd'),
    'ALERT-42-20260608-abcd'
  );
  assertEqual(
    'buildAlertId rand4 padding',
    buildAlertId(1, '2026-01-01 00:00:00', '7'),
    'ALERT-1-20260101-0007'
  );
  assertEqual(
    'buildAlertId rand4 截断',
    buildAlertId(1, '2026-01-01 00:00:00', '0123456'),
    'ALERT-1-20260101-0123'
  );

  const link1 = buildAlertDeeplink('600519', 'ALERT-1-20260608-abcd', 'https://app.com');
  assert('deeplink 含 base', link1.startsWith('https://app.com/workspace/portfolio?'));
  assert('deeplink 含 ai=symbol', link1.includes('ai=600519'));
  assert('deeplink 含 alert', link1.includes('alert=ALERT-1-20260608-abcd'));
  assert(
    'deeplink 含 type=realtime_risk_alert',
    link1.includes('type=realtime_risk_alert')
  );

  const link2 = buildAlertDeeplink('AAPL', 'ALERT-2-20260608-xxxx', 'https://x.com///');
  assert('deeplink trim 尾 slash', link2.startsWith('https://x.com/workspace/portfolio?'));

  // =========================================================================
  console.log('\n[7] buildRiskAlertFeishuCard...');
  const cardHigh = buildRiskAlertFeishuCard({
    alert_id_dispatch: 'ALERT-1-20260608-abcd',
    user_id: 1,
    symbol: '600519',
    name: '贵州茅台',
    level: 'HIGH',
    message: '触发追踪止损 -7.2%',
    rule_id: 'trailing_stop',
    triggered_at: '2026-06-08 10:00:00',
    deeplink_url: 'https://app.com/workspace/portfolio?ai=600519',
  });
  assertEqual('msg_type interactive', cardHigh.msg_type, 'interactive');
  assertEqual('HIGH header template red', cardHigh.card.header.template, 'red');
  assert('HIGH header title 含告警', cardHigh.card.header.title.content.includes('风控告警'));
  assert('HIGH header title 含 HIGH', cardHigh.card.header.title.content.includes('HIGH'));
  assert('elements 有 5+ section', cardHigh.card.elements.length >= 5);

  const cardMed = buildRiskAlertFeishuCard({
    alert_id_dispatch: 'a',
    user_id: 1,
    symbol: 's',
    name: 'n',
    level: 'MEDIUM',
    message: 'm',
    rule_id: 'r',
    triggered_at: 't',
    deeplink_url: 'u',
  });
  assertEqual('MEDIUM header template orange', cardMed.card.header.template, 'orange');

  const cardLow = buildRiskAlertFeishuCard({
    alert_id_dispatch: 'a',
    user_id: 1,
    symbol: 's',
    name: 'n',
    level: 'LOW',
    message: 'm',
    rule_id: 'r',
    triggered_at: 't',
    deeplink_url: 'u',
  });
  assertEqual('LOW header template grey', cardLow.card.header.template, 'grey');

  // 字段被 safeText 截断（message > 400）
  const longMsg = 'X'.repeat(500);
  const cardLong = buildRiskAlertFeishuCard({
    alert_id_dispatch: 'a',
    user_id: 1,
    symbol: 's',
    name: 'n',
    level: 'HIGH',
    message: longMsg,
    rule_id: 'r',
    triggered_at: 't',
    deeplink_url: 'u',
  });
  // 寻找 message div: elements[2] = hr; elements[3] = message div
  const msgEl = cardLong.card.elements[3] as any;
  assert('message 被截断含 …', msgEl.text.content.endsWith('…'));
  assert('message 截断 ≤ 400', msgEl.text.content.length <= 400);

  // =========================================================================
  console.log('\n[8] buildRiskAlertEmail...');
  const emailHigh = buildRiskAlertEmail({
    alert_id_dispatch: 'ALERT-1-20260608-abcd',
    user_id: 1,
    symbol: '600519',
    name: '贵州茅台',
    level: 'HIGH',
    message: '触发追踪止损 -7.2%',
    rule_id: 'trailing_stop',
    triggered_at: '2026-06-08 10:00:00',
    deeplink_url: 'https://app.com/workspace/portfolio?ai=600519',
  });
  assert('email subject 含 level', emailHigh.subject.includes('HIGH'));
  assert('email subject 含 symbol', emailHigh.subject.includes('600519'));
  assert('email subject 含 name', emailHigh.subject.includes('贵州茅台'));
  assert('email html 含 deeplink', emailHigh.html.includes('https://app.com/workspace/portfolio'));
  assert('email html 含 rule_id', emailHigh.html.includes('trailing_stop'));
  assert('email html 含 alert_id', emailHigh.html.includes('ALERT-1-20260608-abcd'));
  assert(
    'email text 含 deeplink',
    (emailHigh.text || '').includes('https://app.com/workspace/portfolio')
  );
  // HTML escape — '&' not <
  const emailWithAmp = buildRiskAlertEmail({
    alert_id_dispatch: 'a',
    user_id: 1,
    symbol: '<script>',
    name: '"AT&T"',
    level: 'HIGH',
    message: 'm < n & q',
    rule_id: 'r',
    triggered_at: 't',
    deeplink_url: 'https://x.com?a=1&b=2',
  });
  assert('html escape <', !emailWithAmp.html.includes('<script>'));
  assert('html escape &', emailWithAmp.html.includes('&amp;'));

  // =========================================================================
  console.log('\n[9] buildRiskAlertSmsParams...');
  const smsParams1 = buildRiskAlertSmsParams(
    {
      alert_id_dispatch: 'a',
      user_id: 1,
      symbol: '600519',
      name: '贵州茅台',
      level: 'HIGH',
      message: 'm',
      rule_id: 'trailing_stop',
      triggered_at: 't',
      deeplink_url: 'u',
    },
    { [SMS_TEMPLATE_RISK_ALERT_ENV]: 'SMS_12345678', [SMS_SIGN_NAME_ENV]: 'TestSign' }
  );
  assertEqual('sms signName from env', smsParams1.signName, 'TestSign');
  assertEqual('sms templateCode from env', smsParams1.templateCode, 'SMS_12345678');
  assertEqual('sms templateParam symbol', smsParams1.templateParam.symbol, '600519');
  assertEqual('sms templateParam level', smsParams1.templateParam.level, 'HIGH');
  assertEqual('sms templateParam rule', smsParams1.templateParam.rule, 'trailing_stop');

  // env 缺失 → signName fallback 'QuantX量化', templateCode 空字符串
  const smsParams2 = buildRiskAlertSmsParams(
    {
      alert_id_dispatch: 'a',
      user_id: 1,
      symbol: '600519',
      name: 'n',
      level: 'HIGH',
      message: 'm',
      rule_id: 'r',
      triggered_at: 't',
      deeplink_url: 'u',
    },
    {}
  );
  assertEqual('sms signName fallback', smsParams2.signName, 'QuantX量化');
  assertEqual('sms templateCode 空', smsParams2.templateCode, '');

  // =========================================================================
  console.log('\n[10] dispatch e2e: level !== HIGH → skipped...');
  const ds10 = new FakeDataSource({
    users: new Map([[1, { username: 'u1', config: configFull() }]]),
  });
  const svc10 = new RealtimeAlertDispatcher(ds10);
  const r10 = await svc10.dispatch(makeInput({ level: 'MEDIUM' }));
  assertEqual('MEDIUM skipped', r10.status, REALTIME_ALERT_STATUS.SKIPPED);
  assertEqual('MEDIUM not sent', r10.sent_any, false);
  assert('MEDIUM skip_reason', (r10.skip_reason || '').includes('HIGH'));
  assertEqual('MEDIUM 不调 channel', ds10.sendFeishuCalls.length, 0);

  const r10b = await svc10.dispatch(makeInput({ level: 'low' }));
  assertEqual('LOW (case) skipped', r10b.status, REALTIME_ALERT_STATUS.SKIPPED);

  // =========================================================================
  console.log('\n[11] dispatch e2e: 用户不存在 → skipped...');
  const ds11 = new FakeDataSource({
    users: new Map([[1, null]]),
  });
  const svc11 = new RealtimeAlertDispatcher(ds11);
  const r11 = await svc11.dispatch(makeInput());
  assertEqual('用户不存在 skipped', r11.status, REALTIME_ALERT_STATUS.SKIPPED);
  assertEqual('用户不存在 skip_reason', r11.skip_reason, '用户不存在');

  // =========================================================================
  console.log('\n[12] dispatch e2e: 3 channel 全成功 → sent...');
  const ds12 = new FakeDataSource({
    users: new Map([[1, { username: 'u1', config: configFull() }]]),
  });
  const svc12 = new RealtimeAlertDispatcher(ds12);
  const r12 = await svc12.dispatch(makeInput(), {
    now_ms_override: 1_000_000_000_000,
  });
  assertEqual('3 channel sent', r12.status, REALTIME_ALERT_STATUS.SENT);
  assertEqual('sent_any', r12.sent_any, true);
  assertEqual('deduped=false', r12.deduped, false);
  assertEqual('dry_run=false', r12.dry_run, false);
  assertEqual('调 feishu 1 次', ds12.sendFeishuCalls.length, 1);
  assertEqual('调 email 1 次', ds12.sendEmailCalls.length, 1);
  assertEqual('调 sms 1 次', ds12.sendSmsCalls.length, 1);
  assertEqual('写 dedup 1 次', ds12.saveSeenCalls.length, 1);
  assertEqual('dedup record 1 条', ds12.saveSeenCalls[0].records.length, 1);
  assertEqual(
    'dedup signature',
    ds12.saveSeenCalls[0].records[0].signature,
    'position_limit::600519::HIGH::d5e0cb68'
  );
  const channels12 = r12.channels.map(c => `${c.channel}:${c.status}`);
  assert(
    'feishu sent',
    channels12.includes('feishu:sent'),
    JSON.stringify(channels12)
  );
  assert(
    'email sent',
    channels12.includes('email:sent'),
    JSON.stringify(channels12)
  );
  assert(
    'sms sent',
    channels12.includes('sms:sent'),
    JSON.stringify(channels12)
  );
  // alert_id format
  assert(
    'alert_id_dispatch 命名规范',
    /^ALERT-1-20260608-[0-9a-f]{4}$/.test(r12.alert_id_dispatch)
  );
  // deeplink format on feishu payload
  assert(
    'feishu payload deeplink_url 含 workspace',
    ds12.sendFeishuCalls[0].payload.deeplink_url.includes('workspace/portfolio')
  );

  // =========================================================================
  console.log('\n[13] dispatch e2e: 30 min dedup hit → deduped...');
  // Pre-seed dedup
  const seeded13 = new Map<number, RealtimeAlertSeenRecord[]>();
  const dedupNow = 1_000_000_000_000;
  seeded13.set(1, [
    { signature: 'position_limit::600519::HIGH::d5e0cb68', pushed_at_ms: dedupNow - 5 * 60 * 1000 },
  ]);
  const ds13 = new FakeDataSource({
    users: new Map([[1, { username: 'u1', config: configFull() }]]),
    seenByUser: seeded13,
  });
  const svc13 = new RealtimeAlertDispatcher(ds13);
  const r13 = await svc13.dispatch(makeInput(), { now_ms_override: dedupNow });
  assertEqual('5 min ago → deduped status skipped', r13.status, REALTIME_ALERT_STATUS.SKIPPED);
  assertEqual('deduped=true', r13.deduped, true);
  assert('deduped skip_reason', (r13.skip_reason || '').includes('dedup'));
  assertEqual('deduped 不调 feishu', ds13.sendFeishuCalls.length, 0);
  assertEqual('deduped 不调 email', ds13.sendEmailCalls.length, 0);
  assertEqual('deduped 不调 sms', ds13.sendSmsCalls.length, 0);
  assertEqual('deduped 不写 dedup', ds13.saveSeenCalls.length, 0);

  // =========================================================================
  console.log('\n[14] dispatch e2e: 出 30 min 窗口 → 重新发...');
  const seeded14 = new Map<number, RealtimeAlertSeenRecord[]>();
  seeded14.set(1, [
    { signature: 'position_limit::600519::HIGH::d5e0cb68', pushed_at_ms: dedupNow - 31 * 60 * 1000 },
  ]);
  const ds14 = new FakeDataSource({
    users: new Map([[1, { username: 'u1', config: configFull() }]]),
    seenByUser: seeded14,
  });
  const svc14 = new RealtimeAlertDispatcher(ds14);
  const r14 = await svc14.dispatch(makeInput(), { now_ms_override: dedupNow });
  assertEqual('出窗 sent', r14.status, REALTIME_ALERT_STATUS.SENT);
  assertEqual('出窗 deduped=false', r14.deduped, false);
  assertEqual('出窗 调 feishu', ds14.sendFeishuCalls.length, 1);
  // 写 dedup 后 pushed_at_ms 应是 dedupNow
  assertEqual('出窗后写 dedup ts', ds14.saveSeenCalls[0].records[0].pushed_at_ms, dedupNow);

  // =========================================================================
  console.log('\n[15] dispatch e2e: dry_run=true → 所有 channel skip 不写 dedup...');
  const ds15 = new FakeDataSource({
    users: new Map([[1, { username: 'u1', config: configFull() }]]),
  });
  const svc15 = new RealtimeAlertDispatcher(ds15);
  const r15 = await svc15.dispatch(makeInput(), { dry_run: true });
  assertEqual('dry_run dry_run=true', r15.dry_run, true);
  // status: all 3 channels skipped (since dry_run) → SKIPPED
  assertEqual('dry_run status skipped', r15.status, REALTIME_ALERT_STATUS.SKIPPED);
  assertEqual('dry_run 不调 feishu', ds15.sendFeishuCalls.length, 0);
  assertEqual('dry_run 不调 email', ds15.sendEmailCalls.length, 0);
  assertEqual('dry_run 不调 sms', ds15.sendSmsCalls.length, 0);
  assertEqual('dry_run 不写 dedup', ds15.saveSeenCalls.length, 0);
  // every channel result has dry_run message
  for (const ch of r15.channels) {
    assertEqual(`dry_run ${ch.channel} status`, ch.status, REALTIME_ALERT_STATUS.SKIPPED);
    assertEqual(`dry_run ${ch.channel} message`, ch.message, 'dry_run');
  }

  // =========================================================================
  console.log('\n[16] dispatch e2e: 1 channel fail + 2 sent → partial...');
  const ds16 = new FakeDataSource({
    users: new Map([[1, { username: 'u1', config: configFull() }]]),
    sendFeishu: async () => ({ success: false, message: '飞书 webhook down' }),
  });
  const svc16 = new RealtimeAlertDispatcher(ds16);
  const r16 = await svc16.dispatch(makeInput());
  assertEqual('1 fail 2 sent → partial', r16.status, REALTIME_ALERT_STATUS.PARTIAL);
  assertEqual('partial sent_any=true', r16.sent_any, true);
  // feishu channel status=failed
  const feishuCh16 = r16.channels.find(c => c.channel === REALTIME_ALERT_CHANNELS.FEISHU);
  assertEqual('feishu status failed', feishuCh16?.status, REALTIME_ALERT_STATUS.FAILED);
  assertEqual('feishu message', feishuCh16?.message, '飞书 webhook down');
  // partial 写 dedup（至少 1 sent）
  assertEqual('partial 写 dedup', ds16.saveSeenCalls.length, 1);

  // =========================================================================
  console.log('\n[17] dispatch e2e: 3 channel 全 fail → failed...');
  const ds17 = new FakeDataSource({
    users: new Map([[1, { username: 'u1', config: configFull() }]]),
    sendFeishu: async () => ({ success: false, message: 'x' }),
    sendEmail: async () => ({ success: false, message: 'y' }),
    sendSms: async () => ({ success: false, message: 'z' }),
  });
  const svc17 = new RealtimeAlertDispatcher(ds17);
  const r17 = await svc17.dispatch(makeInput());
  assertEqual('3 fail → failed', r17.status, REALTIME_ALERT_STATUS.FAILED);
  assertEqual('全 fail sent_any=false', r17.sent_any, false);
  assertEqual('全 fail 不写 dedup', ds17.saveSeenCalls.length, 0);

  // =========================================================================
  console.log('\n[18] dispatch e2e: feishu enabled=false → channel skip...');
  const ds18 = new FakeDataSource({
    users: new Map([
      [1, { username: 'u1', config: configFull({ feishu: { enabled: false } }) }],
    ]),
  });
  const svc18 = new RealtimeAlertDispatcher(ds18);
  const r18 = await svc18.dispatch(makeInput());
  assertEqual('feishu disabled status partial', r18.status, REALTIME_ALERT_STATUS.SENT);
  // Wait: feishu skipped + email sent + sms sent = 2 sent / 2 eligible / status=SENT
  // (skipped channels don't count as eligible — eligibleCount=2)
  assertEqual('feishu disabled sent_any', r18.sent_any, true);
  assertEqual('feishu not called', ds18.sendFeishuCalls.length, 0);
  assertEqual('email called', ds18.sendEmailCalls.length, 1);
  assertEqual('sms called', ds18.sendSmsCalls.length, 1);
  const feishuCh18 = r18.channels.find(c => c.channel === REALTIME_ALERT_CHANNELS.FEISHU);
  assertEqual('feishu skipped', feishuCh18?.status, REALTIME_ALERT_STATUS.SKIPPED);
  assert(
    'feishu skip reason 含 enabled',
    (feishuCh18?.message || '').includes('未启用')
  );

  // =========================================================================
  console.log('\n[19] dispatch e2e: email risk_alert=false → channel skip...');
  const ds19 = new FakeDataSource({
    users: new Map([
      [1, { username: 'u1', config: configFull({ email: { risk_alert: false } }) }],
    ]),
  });
  const svc19 = new RealtimeAlertDispatcher(ds19);
  const r19 = await svc19.dispatch(makeInput());
  // feishu + sms sent; email skipped
  assertEqual('email skip status sent', r19.status, REALTIME_ALERT_STATUS.SENT);
  assertEqual('email not called', ds19.sendEmailCalls.length, 0);
  const emailCh19 = r19.channels.find(c => c.channel === REALTIME_ALERT_CHANNELS.EMAIL);
  assertEqual('email skipped', emailCh19?.status, REALTIME_ALERT_STATUS.SKIPPED);
  assert(
    'email skip reason 含 risk_alert 关闭',
    (emailCh19?.message || '').includes('关闭')
  );

  // =========================================================================
  console.log('\n[20] dispatch e2e: sms phone 缺 → channel skip...');
  const ds20 = new FakeDataSource({
    users: new Map([
      [1, { username: 'u1', config: configFull({ sms: { phone: '' } }) }],
    ]),
  });
  const svc20 = new RealtimeAlertDispatcher(ds20);
  const r20 = await svc20.dispatch(makeInput());
  assertEqual('sms phone 缺 not called', ds20.sendSmsCalls.length, 0);
  const smsCh20 = r20.channels.find(c => c.channel === REALTIME_ALERT_CHANNELS.SMS);
  assertEqual('sms skipped', smsCh20?.status, REALTIME_ALERT_STATUS.SKIPPED);
  assert('sms skip reason 含 手机号', (smsCh20?.message || '').includes('手机号'));

  // =========================================================================
  console.log('\n[21] dispatch e2e: sendFeishu throw → channel failed 不传染...');
  const ds21 = new FakeDataSource({
    users: new Map([[1, { username: 'u1', config: configFull() }]]),
    sendFeishu: async () => {
      throw new Error('boom feishu');
    },
  });
  const svc21 = new RealtimeAlertDispatcher(ds21);
  const r21 = await svc21.dispatch(makeInput());
  // feishu failed; email/sms sent → partial
  assertEqual('throw partial', r21.status, REALTIME_ALERT_STATUS.PARTIAL);
  const feishuCh21 = r21.channels.find(c => c.channel === REALTIME_ALERT_CHANNELS.FEISHU);
  assertEqual('throw feishu status failed', feishuCh21?.status, REALTIME_ALERT_STATUS.FAILED);
  assert(
    'throw feishu message 含 boom',
    (feishuCh21?.message || '').includes('boom')
  );
  // 其他 channel 不受影响
  const emailCh21 = r21.channels.find(c => c.channel === REALTIME_ALERT_CHANNELS.EMAIL);
  assertEqual('throw 其他 channel email sent', emailCh21?.status, REALTIME_ALERT_STATUS.SENT);

  // =========================================================================
  console.log('\n[22] dispatch e2e: loadSeenRecords throw → fail-OPEN 继续...');
  const ds22 = new FakeDataSource({
    users: new Map([[1, { username: 'u1', config: configFull() }]]),
    loadSeenThrows: true,
  });
  const svc22 = new RealtimeAlertDispatcher(ds22);
  const r22 = await svc22.dispatch(makeInput());
  // 应继续推送（fail-OPEN）
  assertEqual('loadSeen throw → continue sent', r22.status, REALTIME_ALERT_STATUS.SENT);

  // =========================================================================
  console.log('\n[23] dispatch e2e: saveSeenRecords throw → fail-OPEN 仍 sent...');
  const ds23 = new FakeDataSource({
    users: new Map([[1, { username: 'u1', config: configFull() }]]),
    saveSeenThrows: true,
  });
  const svc23 = new RealtimeAlertDispatcher(ds23);
  const r23 = await svc23.dispatch(makeInput());
  assertEqual('saveSeen throw → status sent', r23.status, REALTIME_ALERT_STATUS.SENT);
  assertEqual('saveSeen throw → 仍调 channel', ds23.sendFeishuCalls.length, 1);

  // =========================================================================
  console.log('\n[24] dispatch e2e: loadUserConfig throw → failed...');
  const ds24 = new FakeDataSource({
    users: new Map(),
    loadUserThrows: true,
  });
  const svc24 = new RealtimeAlertDispatcher(ds24);
  const r24 = await svc24.dispatch(makeInput());
  assertEqual('loadUser throw → failed', r24.status, REALTIME_ALERT_STATUS.FAILED);
  assert('failed skip_reason 含 加载', (r24.skip_reason || '').includes('加载'));

  // =========================================================================
  console.log('\n[25] dispatch e2e: 同 signature 连发 → 第 2 次 deduped...');
  const ds25 = new FakeDataSource({
    users: new Map([[1, { username: 'u1', config: configFull() }]]),
  });
  const svc25 = new RealtimeAlertDispatcher(ds25);
  const r25a = await svc25.dispatch(makeInput(), { now_ms_override: dedupNow });
  assertEqual('first sent', r25a.status, REALTIME_ALERT_STATUS.SENT);
  // 第 2 次 dedup hit
  const r25b = await svc25.dispatch(makeInput(), { now_ms_override: dedupNow + 1000 });
  assertEqual('second deduped', r25b.deduped, true);
  assertEqual('second skipped', r25b.status, REALTIME_ALERT_STATUS.SKIPPED);
  // 调用次数仍是 1
  assertEqual('only 1 feishu call', ds25.sendFeishuCalls.length, 1);

  // =========================================================================
  console.log('\n[26] dispatch e2e: 不同 signature 各自独立 dedup...');
  const ds26 = new FakeDataSource({
    users: new Map([[1, { username: 'u1', config: configFull() }]]),
  });
  const svc26 = new RealtimeAlertDispatcher(ds26);
  await svc26.dispatch(makeInput({ rule_id: 'position_limit' }), {
    now_ms_override: dedupNow,
  });
  await svc26.dispatch(makeInput({ rule_id: 'trailing_stop' }), {
    now_ms_override: dedupNow + 1000,
  });
  await svc26.dispatch(makeInput({ symbol: '000001' }), {
    now_ms_override: dedupNow + 2000,
  });
  await svc26.dispatch(makeInput({ level: 'HIGH', rule_id: 'position_limit' }), {
    now_ms_override: dedupNow + 3000,
  });
  // 4 次发送, 但第 4 次同 signature 命中 dedup → 3 次实际推
  assertEqual('3 distinct signatures sent', ds26.sendFeishuCalls.length, 3);

  // =========================================================================
  console.log('\n[27] dispatch e2e: rule_id 缺失 → signature 用 unknown...');
  const ds27 = new FakeDataSource({
    users: new Map([[1, { username: 'u1', config: configFull() }]]),
  });
  const svc27 = new RealtimeAlertDispatcher(ds27);
  const r27 = await svc27.dispatch(makeInput({ rule_id: undefined }));
  assertEqual(
    'rule_id 缺失 signature unknown',
    r27.signature,
    'unknown::600519::HIGH::d5e0cb68'
  );
  assertEqual('rule_id field unknown', r27.rule_id, 'unknown');

  // =========================================================================
  console.log('\n[28] dispatch e2e: level 大小写 normalize 一致 signature...');
  const ds28 = new FakeDataSource({
    users: new Map([[1, { username: 'u1', config: configFull() }]]),
  });
  const svc28 = new RealtimeAlertDispatcher(ds28);
  const r28 = await svc28.dispatch(makeInput({ level: 'high' }));
  // 仍然被识别为 HIGH（trigger gate uses toUpperCase）
  assertEqual('lowercase high → sent', r28.status, REALTIME_ALERT_STATUS.SENT);
  assertEqual('lowercase level normalize', r28.level, 'HIGH');
  assertEqual('lowercase signature HIGH', r28.signature, 'position_limit::600519::HIGH::d5e0cb68');

  // =========================================================================
  console.log('\n[29] fireAndForget 不 throw...');
  const ds29 = new FakeDataSource({
    users: new Map([[1, { username: 'u1', config: configFull() }]]),
    sendFeishu: async () => {
      throw new Error('boom feishu');
    },
    sendEmail: async () => {
      throw new Error('boom email');
    },
    sendSms: async () => {
      throw new Error('boom sms');
    },
  });
  const svc29 = new RealtimeAlertDispatcher(ds29);
  let threw29 = false;
  try {
    svc29.fireAndForget(makeInput());
  } catch {
    threw29 = true;
  }
  assertEqual('fireAndForget 不 throw', threw29, false);
  // give async tasks a tick to run
  await new Promise(r => setTimeout(r, 100));

  // =========================================================================
  console.log('\n[30] dispatch e2e: 所有 channel disabled → status SKIPPED + 不写 dedup...');
  const ds30 = new FakeDataSource({
    users: new Map([
      [
        1,
        {
          username: 'u1',
          config: configFull({
            feishu: { enabled: false },
            email: { enabled: false },
            sms: { enabled: false },
          }),
        },
      ],
    ]),
  });
  const svc30 = new RealtimeAlertDispatcher(ds30);
  const r30 = await svc30.dispatch(makeInput());
  assertEqual('all disabled skipped', r30.status, REALTIME_ALERT_STATUS.SKIPPED);
  assertEqual('all disabled sent_any=false', r30.sent_any, false);
  assertEqual('all disabled not call feishu', ds30.sendFeishuCalls.length, 0);
  assertEqual('all disabled not call email', ds30.sendEmailCalls.length, 0);
  assertEqual('all disabled not call sms', ds30.sendSmsCalls.length, 0);
  assertEqual('all disabled 不写 dedup', ds30.saveSeenCalls.length, 0);

  // =========================================================================
  console.log('\n[31] dispatch e2e: LRU trim 边界...');
  // pre-seed 200 entries; new sent should drop oldest (FIFO)
  const seeded31 = new Map<number, RealtimeAlertSeenRecord[]>();
  seeded31.set(
    1,
    Array.from({ length: 200 }, (_, i) => ({
      signature: `signature-${i}`,
      pushed_at_ms: 100 + i,
    }))
  );
  const ds31 = new FakeDataSource({
    users: new Map([[1, { username: 'u1', config: configFull() }]]),
    seenByUser: seeded31,
  });
  const svc31 = new RealtimeAlertDispatcher(ds31);
  const r31 = await svc31.dispatch(makeInput(), { now_ms_override: 999_999 });
  assertEqual('LRU sent', r31.status, REALTIME_ALERT_STATUS.SENT);
  // saveSeen 应被 trim 到 200 条
  const saved31 = ds31.saveSeenCalls[0].records;
  assertEqual('saved LRU length = 200', saved31.length, 200);
  // 首条 signature 应该是 signature-1 (signature-0 被 drop)
  assertEqual('LRU first dropped', saved31[0].signature, 'signature-1');
  // 末条应该是新加的
  assertEqual('LRU tail 新加', saved31[saved31.length - 1].signature, 'position_limit::600519::HIGH::d5e0cb68');

  // =========================================================================
  console.log('\n[32] dispatch e2e: sendFeishu 返回 skipped=true → 当作 SKIPPED...');
  const ds32 = new FakeDataSource({
    users: new Map([[1, { username: 'u1', config: configFull() }]]),
    sendFeishu: async () => ({ success: false, skipped: true, message: '飞书 env disabled' }),
  });
  const svc32 = new RealtimeAlertDispatcher(ds32);
  const r32 = await svc32.dispatch(makeInput());
  const feishuCh32 = r32.channels.find(c => c.channel === REALTIME_ALERT_CHANNELS.FEISHU);
  assertEqual('返回 skipped → 当 SKIPPED', feishuCh32?.status, REALTIME_ALERT_STATUS.SKIPPED);
  // email + sms 仍 sent → 整体 SENT (2 eligible / 2 sent)
  assertEqual('email+sms 全 sent → SENT', r32.status, REALTIME_ALERT_STATUS.SENT);

  // =========================================================================
  console.log('\n[33] dispatch e2e: input rule_id 含空格 trim...');
  const ds33 = new FakeDataSource({
    users: new Map([[1, { username: 'u1', config: configFull() }]]),
  });
  const svc33 = new RealtimeAlertDispatcher(ds33);
  const r33 = await svc33.dispatch(makeInput({ rule_id: '  position_limit  ' }));
  assertEqual('rule_id trim', r33.rule_id, 'position_limit');
  assertEqual('signature trim', r33.signature, 'position_limit::600519::HIGH::d5e0cb68');

  // =========================================================================
  console.log('\n[34] dispatch e2e: triggered_at 缺失 → 默认 ISO 当前时间...');
  const ds34 = new FakeDataSource({
    users: new Map([[1, { username: 'u1', config: configFull() }]]),
  });
  const svc34 = new RealtimeAlertDispatcher(ds34);
  const r34 = await svc34.dispatch(makeInput({ triggered_at: undefined }));
  assertEqual('triggered_at 缺失 sent', r34.status, REALTIME_ALERT_STATUS.SENT);
  // alert_id_dispatch 应含 YYYYMMDD (current date)
  assert('alert_id_dispatch 含日期', /^ALERT-1-\d{8}-[0-9a-f]{4}$/.test(r34.alert_id_dispatch));

  // =========================================================================
  console.log('\n[35] dispatch e2e: 默认 (无 override) constructor 使用 production DS...');
  // 仅校验默认 ctor 不 throw — production DS 会访问 DB 但 dispatch 在缺 user 时
  // 内部 fail-OPEN，单测仅断言 svc 实例创建成功。
  const svc35 = new RealtimeAlertDispatcher();
  assert('默认 ctor', svc35 instanceof RealtimeAlertDispatcher);

  // =========================================================================
  console.log('\n--------------------------------------------------------------');
  console.log(`Total: ${passed} ok, ${failed} failed`);
  console.log('--------------------------------------------------------------');
  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
})().catch(err => {
  console.error('test crashed', err);
  process.exit(1);
});
