/**
 * RiskAlertService — [OPS-005] 标准 dispatcher 单元测试
 *
 * 跑法：
 *   cd backend && npm test -- --filter=risk-alert-service
 *   cd backend && npx ts-node --transpile-only tests/services/risk-alert-service.test.ts
 *
 * 覆盖维度（AC: 测试构造 3 级 alert 推送到正确 channel）：
 *   [1] 常量冻结 / 枚举映射 — SEVERITY / CHANNELS / SEVERITY_TO_LEVEL / SEVERITY_TO_CHANNELS
 *   [2] normalizeSeverity 边界 — 大小写 / 兼容 LOW→medium / 非法返回 null
 *   [3] buildChannelPlan — dry_run / override / severity 默认 plan / inbox 守门
 *   [4] buildOpsAlertText / buildImSubject — 标准格式 + 缺字段兜底
 *   [5] write() 3 级 severity 路由 — AC 主要验收点
 *   [6] write() error paths — 非法 severity / inbox 写失败 / feishu webhook 未配置 / im 地址未配置
 *   [7] write() options.override_channels / dry_run / feishu_webhook_url / im_address
 *   [8] write() realtime dispatcher hook — critical/high 触发, medium 不触发, inbox 失败时不触发
 *   [9] write() metadata.toast / severity 标记自动注入
 */

import {
  RiskAlertService,
  RiskAlertServiceDataSource,
  RiskAlertCreatePayload,
  RiskAlertWriteInput,
  RISK_ALERT_SEVERITY,
  RISK_ALERT_CHANNELS,
  SEVERITY_TO_LEVEL,
  SEVERITY_TO_CHANNELS,
  normalizeSeverity,
  buildChannelPlan,
  buildOpsAlertText,
  buildImSubject,
} from '../../src/services/RiskAlertService';

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

// ---------------------------------------------------------------------------
// Fake DataSource
// ---------------------------------------------------------------------------

interface FakeOptions {
  createThrows?: boolean;
  feishuFails?: boolean;
  feishuThrows?: boolean;
  imFails?: boolean;
  imThrows?: boolean;
  userImAddress?: string | null;
  loadImThrows?: boolean;
  /** 让某次 createRiskAlert 不返回有效 id (e.g. id=NaN) — 仿真 DB partial write */
  createReturnsBadId?: boolean;
}

class FakeDataSource implements RiskAlertServiceDataSource {
  createCalls: RiskAlertCreatePayload[] = [];
  feishuCalls: Array<{ url: string; body: any }> = [];
  imCalls: Array<{ address: string; subject: string; body: string }> = [];
  realtimeCalls: any[] = [];
  loadImCalls: number[] = [];
  /** 给 createRiskAlert 用的递增 id seed */
  private nextId = 1000;

  constructor(private opts: FakeOptions = {}) {}

  async createRiskAlert(payload: RiskAlertCreatePayload) {
    this.createCalls.push(payload);
    if (this.opts.createThrows) throw new Error('fake create throw');
    if (this.opts.createReturnsBadId) return { id: NaN } as any;
    return { id: this.nextId++ };
  }

  async loadUserImAddress(user_id: number) {
    this.loadImCalls.push(user_id);
    if (this.opts.loadImThrows) throw new Error('fake loadIm throw');
    return this.opts.userImAddress === undefined ? 'user@example.com' : this.opts.userImAddress;
  }

  async postFeishuOps(url: string, body: any) {
    this.feishuCalls.push({ url, body });
    if (this.opts.feishuThrows) throw new Error('fake feishu throw');
    if (this.opts.feishuFails) return { success: false, message: 'fake feishu fail' };
    return { success: true };
  }

  async sendIm(address: string, subject: string, body: string) {
    this.imCalls.push({ address, subject, body });
    if (this.opts.imThrows) throw new Error('fake im throw');
    if (this.opts.imFails) return { success: false, message: 'fake im fail' };
    return { success: true, ref_id: 'msg-id-123' };
  }

  fireRealtimeDispatcher(input: any) {
    this.realtimeCalls.push(input);
  }
}

function makeInput(overrides: Partial<RiskAlertWriteInput> = {}): RiskAlertWriteInput {
  return {
    user_id: 1,
    symbol: '600519',
    name: '贵州茅台',
    severity: RISK_ALERT_SEVERITY.HIGH,
    message: '触发持仓上限告警',
    rule_id: 'position_limit',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Main runner (async IIFE)
// ---------------------------------------------------------------------------

// silence logger.warn
// eslint-disable-next-line @typescript-eslint/no-var-requires
const loggerModule = require('../../src/utils/logger');
loggerModule.logger.warn = () => undefined;
loggerModule.logger.info = () => undefined;
loggerModule.logger.error = () => undefined;

(async () => {
  console.log('\n[1] 常量冻结 / 枚举映射...');

  assertEqual('RISK_ALERT_SEVERITY.CRITICAL', RISK_ALERT_SEVERITY.CRITICAL, 'critical');
  assertEqual('RISK_ALERT_SEVERITY.HIGH', RISK_ALERT_SEVERITY.HIGH, 'high');
  assertEqual('RISK_ALERT_SEVERITY.MEDIUM', RISK_ALERT_SEVERITY.MEDIUM, 'medium');
  assertThrows('SEVERITY 不可变', () => {
    (RISK_ALERT_SEVERITY as any).LOW = 'low';
  });
  assert(
    'CHANNELS 包含 inbox/feishu/im/toast',
    (RISK_ALERT_CHANNELS as ReadonlyArray<string>).includes('inbox') &&
      (RISK_ALERT_CHANNELS as ReadonlyArray<string>).includes('feishu') &&
      (RISK_ALERT_CHANNELS as ReadonlyArray<string>).includes('im') &&
      (RISK_ALERT_CHANNELS as ReadonlyArray<string>).includes('toast')
  );
  assertEqual('SEVERITY_TO_LEVEL.critical', SEVERITY_TO_LEVEL.critical, 'HIGH');
  assertEqual('SEVERITY_TO_LEVEL.high', SEVERITY_TO_LEVEL.high, 'HIGH');
  assertEqual('SEVERITY_TO_LEVEL.medium', SEVERITY_TO_LEVEL.medium, 'MEDIUM');

  // AC: severity → 默认 channel plan
  assertEqual('SEVERITY_TO_CHANNELS.critical', Array.from(SEVERITY_TO_CHANNELS.critical), [
    'inbox',
    'feishu',
    'im',
    'toast',
  ]);
  assertEqual('SEVERITY_TO_CHANNELS.high', Array.from(SEVERITY_TO_CHANNELS.high), [
    'inbox',
    'feishu',
  ]);
  assertEqual('SEVERITY_TO_CHANNELS.medium', Array.from(SEVERITY_TO_CHANNELS.medium), ['inbox']);

  // =========================================================================
  console.log('\n[2] normalizeSeverity 边界...');
  assertEqual('小写 critical', normalizeSeverity('critical'), 'critical');
  assertEqual('大写 CRITICAL', normalizeSeverity('CRITICAL'), 'critical');
  assertEqual('混合大小写 High', normalizeSeverity('High'), 'high');
  assertEqual('medium', normalizeSeverity('MEDIUM'), 'medium');
  assertEqual('兼容 LOW → medium', normalizeSeverity('LOW'), 'medium');
  assertEqual('兼容 low → medium', normalizeSeverity('low'), 'medium');
  assertEqual('未知 → null', normalizeSeverity('foo'), null);
  assertEqual('空字符串 → null', normalizeSeverity(''), null);
  assertEqual('non-string → null', normalizeSeverity(123 as any), null);
  assertEqual('null → null', normalizeSeverity(null), null);
  assertEqual('undefined → null', normalizeSeverity(undefined), null);

  // =========================================================================
  console.log('\n[3] buildChannelPlan...');
  assertEqual('critical 默认 plan', buildChannelPlan(RISK_ALERT_SEVERITY.CRITICAL), [
    'inbox',
    'feishu',
    'im',
    'toast',
  ]);
  assertEqual('high 默认 plan', buildChannelPlan(RISK_ALERT_SEVERITY.HIGH), ['inbox', 'feishu']);
  assertEqual('medium 默认 plan', buildChannelPlan(RISK_ALERT_SEVERITY.MEDIUM), ['inbox']);
  assertEqual(
    'dry_run=true → 空 plan',
    buildChannelPlan(RISK_ALERT_SEVERITY.CRITICAL, { dry_run: true }),
    []
  );
  // override
  assertEqual(
    'override_channels=[feishu] → inbox 自动 prepend',
    buildChannelPlan(RISK_ALERT_SEVERITY.MEDIUM, { override_channels: ['feishu'] }),
    ['inbox', 'feishu']
  );
  assertEqual(
    'override_channels 含未知 channel → 静默过滤',
    buildChannelPlan(RISK_ALERT_SEVERITY.HIGH, {
      override_channels: ['feishu', 'unknown' as any, 'inbox'],
    }),
    // inbox 已在列表里，不重复 prepend
    ['feishu', 'inbox']
  );
  assertEqual(
    'override_channels=[] → 空 plan（明确禁用所有）',
    buildChannelPlan(RISK_ALERT_SEVERITY.CRITICAL, { override_channels: [] }),
    []
  );

  // =========================================================================
  console.log('\n[4] buildOpsAlertText / buildImSubject...');
  const text = buildOpsAlertText(
    makeInput({
      severity: RISK_ALERT_SEVERITY.CRITICAL,
      message: 'drawdown 15%',
      rule_id: 'drawdown_breaker',
    })
  );
  assert('text 含 severity 大写', text.includes('CRITICAL'));
  assert('text 含 symbol', text.includes('600519'));
  assert('text 含 name', text.includes('贵州茅台'));
  assert('text 含 message', text.includes('drawdown 15%'));
  assert('text 含 rule_id', text.includes('drawdown_breaker'));

  const text2 = buildOpsAlertText({
    user_id: 1,
    symbol: '',
    name: '',
    severity: RISK_ALERT_SEVERITY.HIGH,
    message: '',
  });
  assert('symbol/name/message 全缺时不抛 + 含 unknown rule', text2.includes('unknown'));

  const subj = buildImSubject(
    makeInput({ severity: RISK_ALERT_SEVERITY.CRITICAL, symbol: '000858', name: '五粮液' })
  );
  assertEqual('subject 标准格式', subj, '【CRITICAL 风控告警】000858 五粮液');
  const subj2 = buildImSubject({
    user_id: 1,
    symbol: '',
    name: '',
    severity: RISK_ALERT_SEVERITY.MEDIUM,
    message: '',
  });
  assertEqual('subject 缺 symbol 兜底 —', subj2, '【MEDIUM 风控告警】—');

  // =========================================================================
  console.log('\n[5] write() 3 级 severity 路由 (AC 主验收)...');

  // CRITICAL：inbox + feishu + im + toast，且触发 realtime
  // Phase 10 (2026-06-28): inbox 写入成功后 feishu 默认 skip (由 afterCreate hook 推 card 兜底),
  // 此 case 显式 force_feishu_text=true 验证 runFeishu 路径仍可强发 text.
  {
    process.env.OPS_ALERT_FEISHU_WEBHOOK = 'https://feishu.test/webhook/abc';
    const ds = new FakeDataSource();
    const svc = new RiskAlertService(ds);
    const r = await svc.write(makeInput({ severity: RISK_ALERT_SEVERITY.CRITICAL }), {
      force_feishu_text: true,
    });
    assertEqual('critical: planned_channels', r.planned_channels, [
      'inbox',
      'feishu',
      'im',
      'toast',
    ]);
    assertEqual('critical: channels.length=4', r.channels.length, 4);
    assert('critical: alert_id 写入', typeof r.alert_id === 'number');
    // inbox 成功
    const inbox = r.channels.find(c => c.channel === 'inbox')!;
    assert('critical: inbox success', inbox.success === true);
    // inbox payload 写 level=HIGH
    assertEqual('critical: inbox level=HIGH', ds.createCalls[0].level, 'HIGH');
    // metadata.toast=true 注入
    assertEqual(
      'critical: metadata.toast 自动注入',
      (ds.createCalls[0] as any).metadata?.toast,
      true
    );
    // feishu 调到
    assertEqual('critical: feishu 被调用 1 次', ds.feishuCalls.length, 1);
    const feishu = r.channels.find(c => c.channel === 'feishu')!;
    assert('critical: feishu success', feishu.success === true);
    assert(
      'critical: feishu url 走 env',
      ds.feishuCalls[0].url === 'https://feishu.test/webhook/abc'
    );
    // im 调到
    assertEqual('critical: im 被调用 1 次', ds.imCalls.length, 1);
    const im = r.channels.find(c => c.channel === 'im')!;
    assert('critical: im success', im.success === true);
    assertEqual(
      'critical: im subject',
      ds.imCalls[0].subject,
      '【CRITICAL 风控告警】600519 贵州茅台'
    );
    // toast 标记
    const toast = r.channels.find(c => c.channel === 'toast')!;
    assert('critical: toast success', toast.success === true);
    assertEqual('critical: toast ref_id = alert_id', toast.ref_id, r.alert_id);
    // 用户分发由 RiskAlert.afterCreate 唯一负责，service 不再重复触发。
    assertEqual('critical: service 不重复 realtime dispatch', ds.realtimeCalls.length, 0);
    delete process.env.OPS_ALERT_FEISHU_WEBHOOK;
  }

  // HIGH：inbox + feishu（不发 im / toast），且触发 realtime
  // Phase 10: 同样需 force_feishu_text=true 才会真发 text
  {
    process.env.OPS_ALERT_FEISHU_WEBHOOK = 'https://feishu.test/webhook/high';
    const ds = new FakeDataSource();
    const svc = new RiskAlertService(ds);
    const r = await svc.write(makeInput({ severity: RISK_ALERT_SEVERITY.HIGH }), {
      force_feishu_text: true,
    });
    assertEqual('high: planned_channels', r.planned_channels, ['inbox', 'feishu']);
    assertEqual('high: channels.length=2', r.channels.length, 2);
    assertEqual('high: feishu 调 1 次', ds.feishuCalls.length, 1);
    assertEqual('high: im 不调', ds.imCalls.length, 0);
    assertEqual('high: service 不重复 realtime dispatch', ds.realtimeCalls.length, 0);
    assertEqual('high: inbox level=HIGH', ds.createCalls[0].level, 'HIGH');
    // toast 不在 plan → metadata.toast 不会注入
    assert('high: metadata.toast 不注入', (ds.createCalls[0] as any).metadata?.toast !== true);
    delete process.env.OPS_ALERT_FEISHU_WEBHOOK;
  }

  // MEDIUM：仅 inbox，不发 feishu/im/toast，不触发 realtime
  {
    const ds = new FakeDataSource();
    const svc = new RiskAlertService(ds);
    const r = await svc.write(makeInput({ severity: RISK_ALERT_SEVERITY.MEDIUM }));
    assertEqual('medium: planned_channels', r.planned_channels, ['inbox']);
    assertEqual('medium: channels.length=1', r.channels.length, 1);
    assertEqual('medium: feishu 不调', ds.feishuCalls.length, 0);
    assertEqual('medium: im 不调', ds.imCalls.length, 0);
    assertEqual('medium: realtime 不触发', ds.realtimeCalls.length, 0);
    assertEqual('medium: inbox level=MEDIUM', ds.createCalls[0].level, 'MEDIUM');
    assert('medium: alert_id 写入', typeof r.alert_id === 'number');
  }

  // =========================================================================
  console.log('\n[6] write() error paths...');

  // 非法 severity → 整体 noop + result.error
  {
    const ds = new FakeDataSource();
    const svc = new RiskAlertService(ds);
    const r = await svc.write({ ...makeInput(), severity: 'bogus' as any });
    assert('非法 severity: planned_channels=[]', r.planned_channels.length === 0);
    assert('非法 severity: channels=[]', r.channels.length === 0);
    assert('非法 severity: error 有值', typeof r.error === 'string' && r.error.includes('bogus'));
    assertEqual('非法 severity: 不调 DB', ds.createCalls.length, 0);
    assertEqual('非法 severity: 不触发 realtime', ds.realtimeCalls.length, 0);
  }

  // inbox 写失败 → channels[inbox].success=false; alert_id undefined; realtime 不触发；feishu 仍尝试
  {
    process.env.OPS_ALERT_FEISHU_WEBHOOK = 'https://feishu.test/webhook/x';
    const ds = new FakeDataSource({ createThrows: true });
    const svc = new RiskAlertService(ds);
    const r = await svc.write(makeInput({ severity: RISK_ALERT_SEVERITY.CRITICAL }));
    const inbox = r.channels.find(c => c.channel === 'inbox')!;
    assert('inbox 失败: success=false', inbox.success === false);
    assert('inbox 失败: error 含 fake', String(inbox.error || '').includes('fake create throw'));
    assertEqual('inbox 失败: alert_id undefined', r.alert_id, undefined);
    assertEqual('inbox 失败: realtime 不触发', ds.realtimeCalls.length, 0);
    // feishu 仍调到
    assertEqual('inbox 失败: feishu 仍调', ds.feishuCalls.length, 1);
    // toast.success=false (因 alert_id 缺)
    const toast = r.channels.find(c => c.channel === 'toast')!;
    assert('inbox 失败: toast 失败', toast.success === false);
    delete process.env.OPS_ALERT_FEISHU_WEBHOOK;
  }

  // feishu webhook 未配置 → channel skipped
  // Phase 10: force_feishu_text=true 让 runFeishu 真跑, 才能验 env-缺失分支
  {
    delete process.env.OPS_ALERT_FEISHU_WEBHOOK;
    const ds = new FakeDataSource();
    const svc = new RiskAlertService(ds);
    const r = await svc.write(makeInput({ severity: RISK_ALERT_SEVERITY.HIGH }), {
      force_feishu_text: true,
    });
    const feishu = r.channels.find(c => c.channel === 'feishu')!;
    assert('feishu 缺 url: success=false', feishu.success === false);
    assert('feishu 缺 url: skipped=true', feishu.skipped === true);
    assertEqual('feishu 缺 url: DataSource 不调', ds.feishuCalls.length, 0);
    // inbox 仍成功
    const inbox = r.channels.find(c => c.channel === 'inbox')!;
    assert('feishu 缺 url: inbox 仍成功', inbox.success === true);
  }

  // feishu 调用失败（webhook 504） → channel failed 不传染 inbox / im
  // Phase 10: force_feishu_text=true 让 runFeishu 真跑
  {
    process.env.OPS_ALERT_FEISHU_WEBHOOK = 'https://feishu.test/webhook/y';
    const ds = new FakeDataSource({ feishuFails: true });
    const svc = new RiskAlertService(ds);
    const r = await svc.write(makeInput({ severity: RISK_ALERT_SEVERITY.CRITICAL }), {
      force_feishu_text: true,
    });
    const feishu = r.channels.find(c => c.channel === 'feishu')!;
    assert('feishu fail: success=false', feishu.success === false);
    assert('feishu fail: error 含 fake', String(feishu.error || '').includes('fake feishu fail'));
    // inbox / im 不受污染
    assert(
      'feishu fail: inbox 仍 success',
      r.channels.find(c => c.channel === 'inbox')!.success === true
    );
    assert(
      'feishu fail: im 仍 success',
      r.channels.find(c => c.channel === 'im')!.success === true
    );
    delete process.env.OPS_ALERT_FEISHU_WEBHOOK;
  }

  // feishu adapter throw（DataSource 抛 sync error）→ 仍兜底成 channel failed
  // Phase 10: force_feishu_text=true 让 runFeishu 真跑
  {
    process.env.OPS_ALERT_FEISHU_WEBHOOK = 'https://feishu.test/webhook/z';
    const ds = new FakeDataSource({ feishuThrows: true });
    const svc = new RiskAlertService(ds);
    const r = await svc.write(makeInput({ severity: RISK_ALERT_SEVERITY.HIGH }), {
      force_feishu_text: true,
    });
    const feishu = r.channels.find(c => c.channel === 'feishu')!;
    assert('feishu throw: success=false', feishu.success === false);
    assert(
      'feishu throw: error 含 throw',
      String(feishu.error || '').includes('fake feishu throw')
    );
    delete process.env.OPS_ALERT_FEISHU_WEBHOOK;
  }

  // IM 用户地址缺失 → skipped
  {
    const ds = new FakeDataSource({ userImAddress: null });
    const svc = new RiskAlertService(ds);
    const r = await svc.write(makeInput({ severity: RISK_ALERT_SEVERITY.CRITICAL }));
    const im = r.channels.find(c => c.channel === 'im')!;
    assert('im 缺地址: success=false', im.success === false);
    assert('im 缺地址: skipped=true', im.skipped === true);
    assertEqual('im 缺地址: sendIm 不调', ds.imCalls.length, 0);
  }

  // IM 用户地址 DB 查询抛错 → channel failed（不阻塞其他通道）
  {
    const ds = new FakeDataSource({ loadImThrows: true });
    const svc = new RiskAlertService(ds);
    const r = await svc.write(makeInput({ severity: RISK_ALERT_SEVERITY.CRITICAL }));
    const im = r.channels.find(c => c.channel === 'im')!;
    assert('im loadIm throw: success=false', im.success === false);
    assert(
      'im loadIm throw: error 含 loadUserImAddress',
      String(im.error || '').includes('loadUserImAddress')
    );
    // inbox 仍成功
    assert(
      'im loadIm throw: inbox 仍 success',
      r.channels.find(c => c.channel === 'inbox')!.success === true
    );
  }

  // IM sendIm fail → channel failed
  {
    const ds = new FakeDataSource({ imFails: true });
    const svc = new RiskAlertService(ds);
    const r = await svc.write(makeInput({ severity: RISK_ALERT_SEVERITY.CRITICAL }));
    const im = r.channels.find(c => c.channel === 'im')!;
    assert('im fail: success=false', im.success === false);
    assert('im fail: error 含 fake', String(im.error || '').includes('fake im fail'));
  }

  // =========================================================================
  console.log('\n[7] write() options...');

  // override_channels — 显式只走 im
  {
    const ds = new FakeDataSource();
    const svc = new RiskAlertService(ds);
    const r = await svc.write(makeInput({ severity: RISK_ALERT_SEVERITY.MEDIUM }), {
      override_channels: ['im'],
    });
    // override 后 inbox 自动 prepend
    assertEqual('override=[im]: planned_channels', r.planned_channels, ['inbox', 'im']);
    assertEqual('override=[im]: im 调 1 次', ds.imCalls.length, 1);
    assertEqual('override=[im]: feishu 不调', ds.feishuCalls.length, 0);
  }

  // dry_run=true → 空 plan，所有通道都不调
  {
    process.env.OPS_ALERT_FEISHU_WEBHOOK = 'https://feishu.test/webhook/dr';
    const ds = new FakeDataSource();
    const svc = new RiskAlertService(ds);
    const r = await svc.write(makeInput({ severity: RISK_ALERT_SEVERITY.CRITICAL }), {
      dry_run: true,
    });
    assertEqual('dry_run: planned_channels=[]', r.planned_channels.length, 0);
    assertEqual('dry_run: channels=[]', r.channels.length, 0);
    assertEqual('dry_run: DB 不调', ds.createCalls.length, 0);
    assertEqual('dry_run: feishu 不调', ds.feishuCalls.length, 0);
    assertEqual('dry_run: realtime 不触发', ds.realtimeCalls.length, 0);
    delete process.env.OPS_ALERT_FEISHU_WEBHOOK;
  }

  // feishu_webhook_url 覆盖 env (Phase 10: 需 force_feishu_text=true 让 runFeishu 真跑)
  {
    process.env.OPS_ALERT_FEISHU_WEBHOOK = 'https://env.example.com/wh';
    const ds = new FakeDataSource();
    const svc = new RiskAlertService(ds);
    const r = await svc.write(makeInput({ severity: RISK_ALERT_SEVERITY.HIGH }), {
      feishu_webhook_url: 'https://opt.example.com/wh',
      force_feishu_text: true,
    });
    assertEqual('feishu_webhook_url 覆盖 env', ds.feishuCalls[0].url, 'https://opt.example.com/wh');
    assert('write 成功', r.channels.find(c => c.channel === 'feishu')!.success === true);
    delete process.env.OPS_ALERT_FEISHU_WEBHOOK;
  }

  // im_address 覆盖 user.email
  {
    const ds = new FakeDataSource();
    const svc = new RiskAlertService(ds);
    const r = await svc.write(makeInput({ severity: RISK_ALERT_SEVERITY.CRITICAL }), {
      im_address: 'override@example.com',
    });
    assertEqual('im_address 覆盖 user.email', ds.imCalls[0].address, 'override@example.com');
    // loadUserImAddress 不被调（已有 override）
    assertEqual('im_address 提供时不查 DB', ds.loadImCalls.length, 0);
    assert('write 成功', r.channels.find(c => c.channel === 'im')!.success === true);
  }

  // =========================================================================
  console.log('\n[8] realtime dispatcher 去重...');
  // RiskAlert model hook 是唯一用户 dispatcher；service 不再补发第二次。
  {
    const ds = new FakeDataSource();
    const svc = new RiskAlertService(ds);
    await svc.write(makeInput({ severity: RISK_ALERT_SEVERITY.CRITICAL }));
    assertEqual('critical: service realtime not called', ds.realtimeCalls.length, 0);
  }
  // high 触发
  {
    const ds = new FakeDataSource();
    const svc = new RiskAlertService(ds);
    await svc.write(makeInput({ severity: RISK_ALERT_SEVERITY.HIGH }));
    assertEqual('high: service realtime not called', ds.realtimeCalls.length, 0);
  }
  // medium 不触发
  {
    const ds = new FakeDataSource();
    const svc = new RiskAlertService(ds);
    await svc.write(makeInput({ severity: RISK_ALERT_SEVERITY.MEDIUM }));
    assertEqual('medium: realtime not called', ds.realtimeCalls.length, 0);
  }
  // critical + inbox 失败 → 不触发（缺 alert_id）
  {
    const ds = new FakeDataSource({ createThrows: true });
    const svc = new RiskAlertService(ds);
    await svc.write(makeInput({ severity: RISK_ALERT_SEVERITY.CRITICAL }));
    assertEqual('inbox 失败时 realtime 不触发', ds.realtimeCalls.length, 0);
  }
  // createReturnsBadId (id=NaN) → 视作 inbox 失败 → 不触发
  {
    const ds = new FakeDataSource({ createReturnsBadId: true });
    const svc = new RiskAlertService(ds);
    const r = await svc.write(makeInput({ severity: RISK_ALERT_SEVERITY.HIGH }));
    assertEqual('badId: alert_id undefined', r.alert_id, undefined);
    assertEqual('badId: realtime 不触发', ds.realtimeCalls.length, 0);
  }

  // =========================================================================
  console.log('\n[9] metadata 注入 & rule_id 缺省...');
  // metadata.toast 自动注入 critical
  {
    const ds = new FakeDataSource();
    const svc = new RiskAlertService(ds);
    await svc.write(
      makeInput({
        severity: RISK_ALERT_SEVERITY.CRITICAL,
        metadata: { custom_key: 'val', toast: false }, // user 试图覆盖
      })
    );
    const md = (ds.createCalls[0] as any).metadata;
    assertEqual('metadata.custom_key 透传', md?.custom_key, 'val');
    assertEqual('metadata.toast 强制 true（覆盖 user false）', md?.toast, true);
    assertEqual('metadata.severity 注入', md?.severity, 'critical');
    assertEqual(
      'metadata 标记 RiskAlertService 为唯一外部通知生产者',
      md?.external_dispatch_owner,
      'risk_alert_service'
    );
  }
  // rule_id 缺省 → DB payload 传 undefined（model 自己处理 null）
  {
    const ds = new FakeDataSource();
    const svc = new RiskAlertService(ds);
    await svc.write({
      user_id: 1,
      symbol: '300750',
      name: '宁德时代',
      severity: RISK_ALERT_SEVERITY.MEDIUM,
      message: 'test',
    });
    assertEqual(
      'rule_id 缺省时 DB payload rule_id=undefined',
      ds.createCalls[0].rule_id,
      undefined
    );
  }

  // =========================================================================
  console.log('\n[10] options.override_channels 与 toast 行为...');
  // override 不含 toast → metadata.toast 不注入
  {
    const ds = new FakeDataSource();
    const svc = new RiskAlertService(ds);
    await svc.write(makeInput({ severity: RISK_ALERT_SEVERITY.CRITICAL }), {
      override_channels: ['inbox', 'feishu'],
    });
    const md = (ds.createCalls[0] as any).metadata;
    assert('override 不含 toast → metadata.toast 不注入', md?.toast !== true);
  }
  // override 含 toast + 自带 inbox prepend
  {
    const ds = new FakeDataSource();
    const svc = new RiskAlertService(ds);
    await svc.write(makeInput({ severity: RISK_ALERT_SEVERITY.MEDIUM }), {
      override_channels: ['toast'],
    });
    const md = (ds.createCalls[0] as any).metadata;
    assertEqual('override=[toast]: planned_channels 自动 prepend inbox', md?.toast, true);
  }

  // =========================================================================
  console.log('\n[11] OPS 通知由 RiskAlertService 单一路径发送...');
  {
    process.env.OPS_ALERT_FEISHU_WEBHOOK = 'https://feishu.test/webhook/p10';
    const ds = new FakeDataSource();
    const svc = new RiskAlertService(ds);
    const r = await svc.write(makeInput({ severity: RISK_ALERT_SEVERITY.HIGH }));
    const feishu = r.channels.find(c => c.channel === 'feishu')!;
    assert('default: feishu success=true', feishu.success === true);
    assert('default: feishu attempted=true', feishu.attempted === true);
    assertEqual('default: DataSource.postFeishuOps 1 次', ds.feishuCalls.length, 1);
    // inbox 仍写入
    assert(
      'phase 10 default: inbox success',
      r.channels.find(c => c.channel === 'inbox')!.success === true
    );
    assertEqual('default: service 不重复 realtime dispatch', ds.realtimeCalls.length, 0);
    delete process.env.OPS_ALERT_FEISHU_WEBHOOK;
  }
  // force_feishu_text=true: runFeishu 真发 text (兼容 audit-task-parameters-dry-run.ts 等老 caller)
  {
    process.env.OPS_ALERT_FEISHU_WEBHOOK = 'https://feishu.test/webhook/force';
    const ds = new FakeDataSource();
    const svc = new RiskAlertService(ds);
    const r = await svc.write(makeInput({ severity: RISK_ALERT_SEVERITY.HIGH }), {
      force_feishu_text: true,
    });
    const feishu = r.channels.find(c => c.channel === 'feishu')!;
    assert('phase 10 force: feishu success=true', feishu.success === true);
    assertEqual('phase 10 force: DataSource.postFeishuOps 1 次', ds.feishuCalls.length, 1);
    delete process.env.OPS_ALERT_FEISHU_WEBHOOK;
  }
  // override_channels=['feishu'] 不含 inbox: alertId 自然 undefined, feishu 仍发 (兼容路径)
  {
    process.env.OPS_ALERT_FEISHU_WEBHOOK = 'https://feishu.test/webhook/no-inbox';
    const ds = new FakeDataSource();
    const svc = new RiskAlertService(ds);
    const r = await svc.write(makeInput({ severity: RISK_ALERT_SEVERITY.HIGH }), {
      override_channels: ['feishu'], // 内部会 prepend inbox, 但 caller 显式不要 inbox 的语义需走 override
    });
    const feishu = r.channels.find(c => c.channel === 'feishu')!;
    assert('override: feishu 仍通过单一路径发送', feishu.success === true);
    assertEqual('override: postFeishuOps 1 次', ds.feishuCalls.length, 1);
    delete process.env.OPS_ALERT_FEISHU_WEBHOOK;
  }
  // override_channels=['feishu'] + createReturnsBadId: alertId undefined -> feishu 仍发
  {
    process.env.OPS_ALERT_FEISHU_WEBHOOK = 'https://feishu.test/webhook/badid';
    const ds = new FakeDataSource({ createReturnsBadId: true });
    const svc = new RiskAlertService(ds);
    const r = await svc.write(makeInput({ severity: RISK_ALERT_SEVERITY.HIGH }));
    const feishu = r.channels.find(c => c.channel === 'feishu')!;
    // inbox 写入但 id=NaN -> alertId undefined -> 默认条件 fallback 走 runFeishu
    assert('phase 10 badId: alertId undefined -> feishu 真发', feishu.attempted === true);
    assertEqual('phase 10 badId: DataSource.postFeishuOps 1 次', ds.feishuCalls.length, 1);
    delete process.env.OPS_ALERT_FEISHU_WEBHOOK;
  }

  // =========================================================================
  console.log('\n[12] critical 路径 OPS 群只有一个生产者...');
  {
    process.env.OPS_ALERT_FEISHU_WEBHOOK = 'https://feishu.test/webhook/p10-verify';
    const ds = new FakeDataSource();
    const svc = new RiskAlertService(ds);
    const r = await svc.write(makeInput({ severity: RISK_ALERT_SEVERITY.CRITICAL }));
    // critical → planned channels = [inbox, feishu, im, toast]
    assertEqual('p10 verify: planned 4 通道', r.planned_channels.length, 4);
    const feishu = r.channels.find(c => c.channel === 'feishu')!;
    assert('verify: feishu success=true', feishu.success === true);
    assertEqual('verify: postFeishuOps 仅 1 次', ds.feishuCalls.length, 1);
    // inbox 仍写入
    const inbox = r.channels.find(c => c.channel === 'inbox')!;
    assert('p10 verify: inbox success', inbox.success === true);
    assert('p10 verify: alert_id 存在', typeof r.alert_id === 'number');
    assertEqual('verify: service realtime dispatcher 0 次', ds.realtimeCalls.length, 0);
    // im 仍发 (与 feishu 不同的通道, 不触发去重)
    assertEqual('p10 verify: im 调 1 次 (邮件路径不去重)', ds.imCalls.length, 1);
    delete process.env.OPS_ALERT_FEISHU_WEBHOOK;
  }

  // =========================================================================
  // Summary
  // =========================================================================
  setTimeout(() => {
    console.log(`\n========================================`);
    console.log(`RiskAlertService test summary: ${passed} ok / ${failed} failed`);
    console.log(`========================================`);
    process.exit(failed > 0 ? 1 : 0);
  }, 200);
})().catch(err => {
  console.error('unexpected test runner crash:', err);
  process.exit(2);
});
