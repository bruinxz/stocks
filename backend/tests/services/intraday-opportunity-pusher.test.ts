/**
 * IntradayOpportunityPusher 单元测试 (CE-C)
 *
 * 不依赖 jest;  node 直接跑:
 *   cd backend && npx ts-node --transpile-only tests/services/intraday-opportunity-pusher.test.ts
 *
 * 完全脱 DB / 网络 / 飞书 webhook —— PusherDataSource 注入 fake.
 *
 * 覆盖维度:
 *   - 常量冻结 (target_groups / actions / risk levels / TTL table / caps)
 *   - 纯函数:
 *     - asciiSparklineFromBars (空 / 单点 / 全相等 / 升序 / 含 NaN / >8 桶分箱)
 *     - inferSparklineDirection (升 / 降 / 平 / 单点)
 *     - ttlForTriggerRule (已知 rule / 未知 fallback / 空字符串)
 *     - buildOpportunitySignature (同桶相同 / 跨桶不同 / unknown 退化)
 *     - safeClamp / formatChangePct / formatPrice / formatEntryZone
 *     - actionLabel / riskLabel / safeText
 *     - buildIntradayDeeplink (含 signal_id / 缺 signal_id / base trim)
 *     - buildOpportunityCard (绿 header / 6 字段 / 触发理由 / sparkline / footer 含 UTC+8)
 *     - validateOpportunityInput (合法 / 缺 symbol / trigger_time 字符串 fallback)
 *     - appendDedupRecord (新增 / 重复替换 / LRU trim)
 *   - service.push() e2e:
 *     - dry_run=true → ok=true / skipped_reason='dry_run' / 不调 fake send + 不写 audit
 *     - 单 group business → sent + 写 audit
 *     - 同 ttl 桶内 2 次 → 第 2 次 deduped
 *     - 跨桶 (now 调过 ttl) → 第 2 次重新发
 *     - per-symbol cap (6 次同 symbol) → 第 6 次 circuit_breaker
 *     - global cap (21 次任意 symbol) → 第 21 次 circuit_breaker
 *     - business + ops 并行 fan-out → 双 group 都 sent
 *     - user group 但缺 user_ids → 返 no_webhook (不 throw)
 *     - user group + 多 user_ids → per-user webhook fan-out
 *     - user webhook 缺失 → 该用户 no_webhook, 其他成功
 *     - 单 group send_error 不传染其他 group (allSettled)
 *     - 缺业务 webhook env → no_webhook
 *     - include_chart=false → 不调 fetchSparkline + 卡片无 sparkline 段
 *     - invalid_input (缺 symbol) → ok=false / skipped_reason='invalid_input'
 *     - persist=false → 不调 persistAuditRow
 *     - trigger_time 字符串 ISO → 自动转 Date
 *     - getRecentPushes filter symbol/rule
 *     - resetBuffers 清空
 *     - 时区: footer 含 'UTC+8' + 北京时间转换
 */

import {
  IntradayOpportunityPusher,
  OpportunityInput,
  OpportunityDecision,
  PushOptions,
  PusherDataSource,
  AuditRowInput,
  OPPORTUNITY_TARGET_GROUPS,
  OPPORTUNITY_ACTIONS,
  OPPORTUNITY_RISK_LEVELS,
  TRIGGER_RULE_DEDUP_TTL_MS,
  DEFAULT_TTL_MS,
  PER_SYMBOL_HOURLY_CAP,
  GLOBAL_MINUTE_CAP,
  ttlForTriggerRule,
  buildOpportunitySignature,
  safeClamp,
  formatChangePct,
  formatPrice,
  formatEntryZone,
  actionLabel,
  riskLabel,
  safeText,
  buildIntradayDeeplink,
  buildOpportunityCard,
  validateOpportunityInput,
  appendDedupRecord,
} from '../../src/services/IntradayOpportunityPusher';
import {
  asciiSparklineFromBars,
  inferSparklineDirection,
  SparklineResult,
} from '../../src/services/SparklinePngService';
import { FeishuBotWebhookSendResult } from '../../src/services/FeishuBotWebhookService';

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

interface FakeDataSourceOpts {
  /** Map<user_id, webhook_url or null> */
  userWebhooks?: Map<number, string | null>;
  /** Override sendFeishuCard */
  sendFeishu?: (card: any, url: string) => Promise<FeishuBotWebhookSendResult>;
  /** Inject sparkline (single static) */
  sparkline?: SparklineResult | null;
  /** Throw on persistAuditRow */
  persistThrows?: boolean;
}

class FakeDS implements PusherDataSource {
  public sendCalls: Array<{ card: any; url: string }> = [];
  public auditCalls: AuditRowInput[] = [];
  public loadUserWebhookCalls: number[] = [];
  public sparkCalls = 0;

  constructor(private opts: FakeDataSourceOpts = {}) {}

  async loadUserWebhook(user_id: number): Promise<string | null> {
    this.loadUserWebhookCalls.push(user_id);
    return this.opts.userWebhooks?.get(user_id) ?? null;
  }

  async sendFeishuCard(card: any, url: string): Promise<FeishuBotWebhookSendResult> {
    this.sendCalls.push({ card, url });
    if (this.opts.sendFeishu) return this.opts.sendFeishu(card, url);
    return { success: true, data: { code: 0 } };
  }

  async persistAuditRow(row: AuditRowInput): Promise<void> {
    this.auditCalls.push(row);
    if (this.opts.persistThrows) throw new Error('fake persist throw');
  }

  async fetchSparkline(_symbol: string): Promise<SparklineResult | null> {
    this.sparkCalls += 1;
    return this.opts.sparkline ?? null;
  }
}

function makeInput(overrides: Partial<OpportunityInput> = {}): OpportunityInput {
  const decision: OpportunityDecision = {
    action: 'buy',
    // PR-L (2026-06-29): 默认 conf 改为 65 (< 70 threshold), 不触发 emergency gate.
    // EMERGENCY_CONF_GATE 单测见 [push_e2e: PR-L conf gate >= 70 拦截] case.
    confidence_score: 65,
    risk_level: 'medium',
    suggested_position_pct: 8.5,
    entry_zone: [123.45, 125.67],
    stop_loss: 118.0,
    take_profit: 135.0,
  };
  return {
    symbol: 'sh.600519',
    name: '贵州茅台',
    trigger_rule: 'breakout_60d_high',
    trigger_rule_label: '突破 60 日新高',
    trigger_time: new Date('2026-06-25T08:09:00.000Z'),
    current_price: 124.50,
    change_pct: 5.32,
    volume_ratio: 2.13,
    decision,
    reasons: ['突破 60 日新高 124.50', '量比 2.13 倍 明显放量', '北上资金净流入 1.2 亿'],
    industry: '白酒',
    market_segment: '消费',
    source_signal_id: 99001,
    ...overrides,
  };
}

(async () => {
  // ==========================================================================
  console.log('\n[1] 常量冻结...');
  assertEqual('TARGET_GROUPS.BUSINESS', OPPORTUNITY_TARGET_GROUPS.BUSINESS, 'business');
  assertEqual('TARGET_GROUPS.OPS', OPPORTUNITY_TARGET_GROUPS.OPS, 'ops');
  assertEqual('TARGET_GROUPS.USER', OPPORTUNITY_TARGET_GROUPS.USER, 'user');
  assertEqual('ACTIONS.STRONG_BUY', OPPORTUNITY_ACTIONS.STRONG_BUY, 'strong_buy');
  assertEqual('RISK.LOW', OPPORTUNITY_RISK_LEVELS.LOW, 'low');
  assertEqual('TTL breakout_60d_high = 30min', TRIGGER_RULE_DEDUP_TTL_MS.breakout_60d_high, 30 * 60_000);
  assertEqual('TTL volume_spike = 5min', TRIGGER_RULE_DEDUP_TTL_MS.volume_spike, 5 * 60_000);
  assertEqual('TTL northbound = 60min', TRIGGER_RULE_DEDUP_TTL_MS.northbound_inflow_surge, 60 * 60_000);
  assertEqual('DEFAULT_TTL_MS = 15min', DEFAULT_TTL_MS, 15 * 60_000);
  assertEqual('PER_SYMBOL cap = 5', PER_SYMBOL_HOURLY_CAP, 5);
  assertEqual('GLOBAL cap = 20', GLOBAL_MINUTE_CAP, 20);
  assertThrows('TARGET_GROUPS 不可变', () => {
    (OPPORTUNITY_TARGET_GROUPS as any).NEW = 'new';
  });

  // ==========================================================================
  console.log('\n[2] asciiSparklineFromBars...');
  assertEqual('null bars → null', asciiSparklineFromBars(null), null);
  assertEqual('empty bars → null', asciiSparklineFromBars([]), null);
  assertEqual('single bar → null', asciiSparklineFromBars([{ close: 10 }]), null);
  // 全相等
  assertEqual(
    '全相等 → 中间档 × length',
    asciiSparklineFromBars([{ close: 10 }, { close: 10 }, { close: 10 }]),
    '▄▄▄'
  );
  // 升序
  const ascSpark = asciiSparklineFromBars([
    { close: 10 },
    { close: 12 },
    { close: 14 },
    { close: 16 },
    { close: 18 },
  ]);
  assert('升序 sparkline 非空', !!ascSpark && ascSpark.length === 5);
  assert('升序首字符是最矮 ▁', ascSpark!.startsWith('▁'));
  assert('升序末字符是最高 █', ascSpark!.endsWith('█'));
  // 含 NaN
  const nanSpark = asciiSparklineFromBars([
    { close: 10 },
    { close: NaN as any },
    { close: 20 },
  ]);
  assert('NaN 跳过, 仍能渲染 2 字符', !!nanSpark && nanSpark.length === 2);

  // ==========================================================================
  console.log('\n[3] inferSparklineDirection...');
  assertEqual('升序 → up', inferSparklineDirection([{ close: 10 }, { close: 20 }]), 'up');
  assertEqual('降序 → down', inferSparklineDirection([{ close: 20 }, { close: 10 }]), 'down');
  assertEqual('微变 → flat', inferSparklineDirection([{ close: 100 }, { close: 100.3 }]), 'flat');
  assertEqual('单点 → flat', inferSparklineDirection([{ close: 10 }]), 'flat');

  // ==========================================================================
  console.log('\n[4] ttlForTriggerRule...');
  assertEqual('breakout_60d_high', ttlForTriggerRule('breakout_60d_high'), 30 * 60_000);
  assertEqual('volume_spike', ttlForTriggerRule('volume_spike'), 5 * 60_000);
  assertEqual('unknown → default', ttlForTriggerRule('some_unknown_rule'), DEFAULT_TTL_MS);
  assertEqual('empty → default', ttlForTriggerRule(''), DEFAULT_TTL_MS);

  // ==========================================================================
  console.log('\n[5] buildOpportunitySignature...');
  const ts1 = Date.parse('2026-06-25T09:31:00.000Z');
  const ts2 = ts1 + 5 * 60_000; // 同 5min 桶 vs 不同桶
  // 5min ttl → ts1, ts1+5min 分别属于 bucket = floor(ts1/300000), floor((ts1+300000)/300000) = bucket+1
  const sigA = buildOpportunitySignature('sh.600519', 'volume_spike', ts1, 5 * 60_000);
  const sigB = buildOpportunitySignature('sh.600519', 'volume_spike', ts1 + 60_000, 5 * 60_000);
  const sigC = buildOpportunitySignature('sh.600519', 'volume_spike', ts2, 5 * 60_000);
  assertEqual('同 5min 桶相同签名', sigA, sigB);
  assert('跨 5min 桶不同签名', sigA !== sigC);
  // unknown 退化
  const sigUnknown = buildOpportunitySignature('', '', 0, 0);
  assert('空 symbol/rule/ttl 不 throw', sigUnknown.startsWith('intraday_opp::UNKNOWN_SYMBOL::unknown::'));

  // ==========================================================================
  console.log('\n[6] safeClamp / formatChangePct / formatPrice / formatEntryZone...');
  assertEqual('clamp 中间', safeClamp(50, 0, 100, 0), 50);
  assertEqual('clamp 超上限', safeClamp(150, 0, 100, 0), 100);
  assertEqual('clamp 超下限', safeClamp(-10, 0, 100, 0), 0);
  assertEqual('clamp NaN → fallback', safeClamp(NaN, 0, 100, 42), 42);
  assertEqual('formatChangePct 正数', formatChangePct(5.327), '+5.33%');
  assertEqual('formatChangePct 负数', formatChangePct(-1.2), '-1.20%');
  assertEqual('formatChangePct 0', formatChangePct(0), '0.00%');
  assertEqual('formatChangePct null', formatChangePct(null), '—');
  assertEqual('formatPrice', formatPrice(123.456), '123.46');
  assertEqual('formatPrice null', formatPrice(null), '—');
  assertEqual('formatEntryZone 正常', formatEntryZone([12.34, 13.45]), '12.34 - 13.45');
  assertEqual('formatEntryZone null', formatEntryZone(null), '—');
  assertEqual('formatEntryZone undefined', formatEntryZone(undefined), '—');
  assertEqual('formatEntryZone 含 NaN', formatEntryZone([NaN as any, 13]), '—');

  // ==========================================================================
  console.log('\n[7] actionLabel / riskLabel / safeText...');
  assertEqual('action buy', actionLabel('buy'), '买入');
  assertEqual('action strong_buy', actionLabel('strong_buy'), '强烈买入');
  assertEqual('action unknown', actionLabel('xxx' as any), 'xxx');
  assertEqual('risk medium', riskLabel('medium'), '中');
  assertEqual('safeText trim & truncate', safeText('  hello  world  ', 10), 'hello wor…');
  assertEqual('safeText null', safeText(null, 10), '');

  // ==========================================================================
  console.log('\n[8] buildIntradayDeeplink...');
  const link1 = buildIntradayDeeplink('sh.600519', 99001, 'http://x.test/');
  assertEqual(
    'deeplink 含 intraday + signal_id + type',
    link1,
    'http://x.test/workspace/today?intraday=sh.600519&signal_id=99001&type=intraday_opportunity'
  );
  const link2 = buildIntradayDeeplink('sh.600519', null, 'http://x.test');
  assert('signal_id null → 不带 signal_id 参数', !link2.includes('signal_id'));
  // baseUrl 尾部 / trim
  const link3 = buildIntradayDeeplink('sh.600519', 1, 'http://x.test////');
  assert('base trim 多余 /', link3.startsWith('http://x.test/workspace/today'));

  // ==========================================================================
  console.log('\n[9] buildOpportunityCard...');
  const card = buildOpportunityCard(makeInput(), {
    deeplink_url: 'http://x.test/workspace/today?intraday=sh.600519',
    sparkline: {
      format: 'sparkline_unicode',
      rendered: '▂▃▅▆█',
      direction: 'up',
      low: 100.5,
      high: 125.6,
    },
    include_chart: true,
  });
  assertEqual('msg_type', card.msg_type, 'interactive');
  assertEqual('header.template = green', card.card.header.template, 'green');
  assert('header title 含 🎯', card.card.header.title.content.includes('🎯'));
  assert(
    'header title 含 实时买入机会',
    card.card.header.title.content.includes('实时买入机会')
  );
  const cardJson = JSON.stringify(card);
  assert('卡片含 symbol', cardJson.includes('sh.600519'));
  assert('卡片含 name', cardJson.includes('贵州茅台'));
  assert('卡片含 trigger_rule_label', cardJson.includes('突破 60 日新高'));
  assert('卡片含 sparkline', cardJson.includes('▂▃▅▆█'));
  assert('卡片含触发理由 1', cardJson.includes('量比 2.13'));
  assert('卡片含入场区间', cardJson.includes('123.45 - 125.67'));
  assert('卡片含止损', cardJson.includes('118.00'));
  assert('卡片含止盈', cardJson.includes('135.00'));
  assert('卡片含 现价', cardJson.includes('124.50'));
  assert('卡片含 涨幅', cardJson.includes('+5.32%'));
  assert('卡片含 deeplink 按钮', cardJson.includes('http://x.test/workspace/today'));
  assert('卡片 footer 含 UTC+8', cardJson.includes('UTC+8'));
  // CC fix 验证: 输入 ISO Z = '2026-06-25T08:09:00.000Z' → 北京 16:09:00
  assert('footer 北京时间 16:09:00', cardJson.includes('2026-06-25 16:09:00 (UTC+8)'));
  assert('卡片含 加入自选 按钮', cardJson.includes('加入自选'));

  // include_chart=false → 不含 sparkline 段
  const cardNoChart = buildOpportunityCard(makeInput(), {
    deeplink_url: 'http://x',
    sparkline: null,
    include_chart: false,
  });
  assert('include_chart=false 卡片不含 sparkline', !JSON.stringify(cardNoChart).includes('近 20 日趋势'));

  // ==========================================================================
  console.log('\n[10] validateOpportunityInput...');
  assert('合法 input', !!validateOpportunityInput(makeInput()));
  assertEqual('缺 symbol → null', validateOpportunityInput({ ...makeInput(), symbol: '' }), null);
  assertEqual(
    '缺 trigger_rule → null',
    validateOpportunityInput({ ...makeInput(), trigger_rule: '' }),
    null
  );
  // trigger_time ISO string → 自动转 Date
  const withStringTime = validateOpportunityInput({
    ...makeInput(),
    trigger_time: '2026-06-25T08:09:00Z' as any,
  });
  assert('trigger_time ISO 字符串 → 转 Date', withStringTime?.trigger_time instanceof Date);
  // 非法 trigger_time
  assertEqual(
    'trigger_time 非法 → null',
    validateOpportunityInput({ ...makeInput(), trigger_time: 'garbage' as any }),
    null
  );

  // ==========================================================================
  console.log('\n[11] appendDedupRecord...');
  const buf0 = appendDedupRecord([], { signature: 'a', pushed_at_ms: 1 });
  assertEqual('新增 1 条', buf0.length, 1);
  const buf1 = appendDedupRecord(buf0, { signature: 'a', pushed_at_ms: 2 });
  assertEqual('同 signature 替换 → 仍 1 条', buf1.length, 1);
  assertEqual('替换为新 ts', buf1[0].pushed_at_ms, 2);
  // LRU trim
  const limit = 3;
  let trimBuf: any[] = [];
  for (let i = 0; i < 10; i++) {
    trimBuf = appendDedupRecord(
      trimBuf as any,
      { signature: `s${i}`, pushed_at_ms: i },
      limit
    );
  }
  assertEqual('LRU trim 到 limit', trimBuf.length, 3);
  assertEqual('保留最新 3 条', trimBuf.map((r: any) => r.signature), ['s7', 's8', 's9']);

  // ==========================================================================
  console.log('\n[12] push e2e: dry_run=true...');
  // 干净环境: 清 env 避免误读
  delete process.env.FEISHU_RECOMMENDATION_BOT_WEBHOOK;
  const ds12 = new FakeDS({
    sparkline: { format: 'sparkline_unicode', rendered: '▂▃▅', direction: 'up', low: 1, high: 2 },
  });
  const svc12 = new IntradayOpportunityPusher(ds12);
  const r12 = await svc12.push(makeInput(), { dry_run: true });
  assertEqual('ok=true', r12.ok, true);
  assertEqual('skipped_reason=dry_run', r12.skipped_reason, 'dry_run');
  assertEqual('pushed_groups 全 dry_run', r12.pushed_groups.length, 1);
  assertEqual('group=business + status=dry_run', r12.pushed_groups[0].status, 'dry_run');
  assertEqual('不调 webhook', ds12.sendCalls.length, 0);
  assertEqual('不写 audit (dry_run 跳过 persist 路径)', ds12.auditCalls.length, 0);
  assert('card_payload 不空', !!r12.card_payload);

  // ==========================================================================
  console.log('\n[13] push e2e: 单 group business sent + audit...');
  process.env.FEISHU_RECOMMENDATION_BOT_WEBHOOK = 'https://feishu.test/biz';
  const ds13 = new FakeDS({});
  const svc13 = new IntradayOpportunityPusher(ds13);
  const r13 = await svc13.push(makeInput());
  assertEqual('ok=true', r13.ok, true);
  assertEqual('skipped_reason=undefined', r13.skipped_reason, undefined);
  assertEqual('1 group sent', r13.pushed_groups.length, 1);
  assertEqual('group=business', r13.pushed_groups[0].group, 'business');
  assertEqual('status=sent', r13.pushed_groups[0].status, 'sent');
  assertEqual('调 webhook 1 次', ds13.sendCalls.length, 1);
  assertEqual('webhook URL', ds13.sendCalls[0].url, 'https://feishu.test/biz');
  assertEqual('写 audit 1 行', ds13.auditCalls.length, 1);
  assertEqual('audit target_groups', ds13.auditCalls[0].target_groups, 'business');
  assertEqual(
    'audit push_result.dedup_signature 一致',
    (ds13.auditCalls[0].push_result as any).dedup_signature,
    r13.dedup_signature
  );

  // ==========================================================================
  console.log('\n[14] push e2e: 同 ttl 桶内 2 次 → 第 2 次 deduped...');
  // breakout_60d_high TTL = 30min
  const fixedTime = Date.parse('2026-06-25T09:30:00.000Z');
  const inputT = makeInput({ trigger_time: new Date(fixedTime) });
  const ds14 = new FakeDS({});
  const svc14 = new IntradayOpportunityPusher(ds14);
  const r14a = await svc14.push(inputT);
  const r14b = await svc14.push({ ...inputT, trigger_time: new Date(fixedTime + 5 * 60_000) });
  assertEqual('第 1 次 sent', r14a.ok, true);
  assertEqual('第 2 次 deduped (5min 后仍同 30min 桶)', r14b.skipped_reason, 'deduped');
  assertEqual('第 2 次 ok=false', r14b.ok, false);
  assertEqual('调 webhook 仅 1 次', ds14.sendCalls.length, 1);
  // dedup 仍写 audit 留痕
  assertEqual('写 audit 2 行 (含 deduped 留痕)', ds14.auditCalls.length, 2);
  assertEqual(
    'audit 第 2 行 skipped_reason=deduped',
    (ds14.auditCalls[1].push_result as any).skipped_reason,
    'deduped'
  );

  // ==========================================================================
  console.log('\n[15] push e2e: 跨桶 (now 调过 ttl) → 第 2 次重发...');
  const ds15 = new FakeDS({});
  const svc15 = new IntradayOpportunityPusher(ds15);
  const t0 = Date.parse('2026-06-25T09:00:00.000Z');
  const t1 = Date.parse('2026-06-25T09:35:00.000Z'); // > 30min later (TTL=30min)
  await svc15.push(makeInput({ trigger_time: new Date(t0) }), { now_ms_override: t0 });
  const r15b = await svc15.push(makeInput({ trigger_time: new Date(t1) }), { now_ms_override: t1 });
  assertEqual('跨桶 第 2 次 sent', r15b.ok, true);
  assertEqual('调 webhook 共 2 次', ds15.sendCalls.length, 2);

  // ==========================================================================
  console.log('\n[16] push e2e: per-symbol cap (6 次同 symbol)...');
  const ds16 = new FakeDS({});
  const svc16 = new IntradayOpportunityPusher(ds16);
  const base = Date.parse('2026-06-25T09:00:00.000Z');
  // 用 5 个不同 rule 避免 dedup 阻挡 (per-rule TTL bucket 各异)
  const rules = ['volume_spike', 'rapid_rise', 'rapid_fall_stabilize', 'breakout_60d_high', 'breakout_20d_high'];
  for (let i = 0; i < 5; i++) {
    const r = await svc16.push(
      makeInput({
        trigger_rule: rules[i],
        trigger_time: new Date(base + i * 60_000),
      }),
      { now_ms_override: base + i * 60_000 }
    );
    assert(`第 ${i + 1} 次 ok`, r.ok, JSON.stringify(r));
  }
  // 第 6 次应触发 per-symbol cap
  const r16 = await svc16.push(
    makeInput({
      trigger_rule: 'northbound_inflow_surge',
      trigger_time: new Date(base + 5 * 60_000),
    }),
    { now_ms_override: base + 5 * 60_000 }
  );
  assertEqual('第 6 次 circuit_breaker', r16.skipped_reason, 'circuit_breaker');
  assertEqual('第 6 次 ok=false', r16.ok, false);

  // ==========================================================================
  console.log('\n[17] push e2e: global cap (21 次任意 symbol)...');
  const ds17 = new FakeDS({});
  const svc17 = new IntradayOpportunityPusher(ds17);
  const baseT = Date.parse('2026-06-25T10:00:00.000Z');
  // 用 25 个不同 symbol (每个 symbol < 5) 避开 per-symbol cap;
  // 但全部在 1min 内 (now_ms_override 都 = baseT) 触发 global cap
  for (let i = 0; i < 20; i++) {
    const r = await svc17.push(
      makeInput({
        symbol: `s${i}`,
        trigger_time: new Date(baseT),
        trigger_rule: 'volume_spike',
      }),
      { now_ms_override: baseT }
    );
    assert(`global 第 ${i + 1} 次 ok`, r.ok);
  }
  // 第 21 次 global cap
  const r17 = await svc17.push(
    makeInput({ symbol: 's999', trigger_time: new Date(baseT), trigger_rule: 'volume_spike' }),
    { now_ms_override: baseT }
  );
  assertEqual('第 21 次 circuit_breaker', r17.skipped_reason, 'circuit_breaker');

  // ==========================================================================
  console.log('\n[18] push e2e: business + ops 并行 fan-out...');
  process.env.FEISHU_RECOMMENDATION_BOT_WEBHOOK = 'https://feishu.test/biz';
  process.env.OPS_ALERT_FEISHU_WEBHOOK = 'https://feishu.test/ops';
  const ds18 = new FakeDS({});
  const svc18 = new IntradayOpportunityPusher(ds18);
  const r18 = await svc18.push(makeInput(), { target_groups: ['business', 'ops'] });
  assertEqual('2 groups returned', r18.pushed_groups.length, 2);
  assert('business sent', r18.pushed_groups.some(g => g.group === 'business' && g.ok));
  assert('ops sent', r18.pushed_groups.some(g => g.group === 'ops' && g.ok));
  assertEqual('调 webhook 2 次 (business + ops)', ds18.sendCalls.length, 2);

  // ==========================================================================
  console.log('\n[19] push e2e: user group 缺 user_ids → no_webhook...');
  const ds19 = new FakeDS({});
  const svc19 = new IntradayOpportunityPusher(ds19);
  const r19 = await svc19.push(makeInput(), { target_groups: ['user'] });
  assertEqual('返 no_webhook + ok=false', r19.ok, false);
  assertEqual('skipped_reason=no_webhook', r19.skipped_reason, 'no_webhook');
  assertEqual('group status=no_webhook', r19.pushed_groups[0].status, 'no_webhook');
  assertEqual('不调 webhook', ds19.sendCalls.length, 0);

  // ==========================================================================
  console.log('\n[20] push e2e: user group + 多 user_ids per-user webhook...');
  const ds20 = new FakeDS({
    userWebhooks: new Map([
      [1, 'https://feishu.test/u1'],
      [2, 'https://feishu.test/u2'],
      [3, null], // 缺 webhook
    ]),
  });
  const svc20 = new IntradayOpportunityPusher(ds20);
  const r20 = await svc20.push(makeInput(), { target_groups: ['user'], user_ids: [1, 2, 3] });
  assertEqual('3 user group results', r20.pushed_groups.length, 3);
  assertEqual('调 webhook 仅 2 次 (u3 缺 webhook 跳过)', ds20.sendCalls.length, 2);
  const u3 = r20.pushed_groups.find(g => g.user_id === 3);
  assertEqual('u3 no_webhook', u3?.status, 'no_webhook');
  const u1 = r20.pushed_groups.find(g => g.user_id === 1);
  assertEqual('u1 sent', u1?.status, 'sent');
  assertEqual('整体 ok=true (至少 1 user sent)', r20.ok, true);

  // ==========================================================================
  console.log('\n[21] push e2e: 单 group send_error 不传染其他 (allSettled)...');
  process.env.FEISHU_RECOMMENDATION_BOT_WEBHOOK = 'https://feishu.test/biz';
  process.env.OPS_ALERT_FEISHU_WEBHOOK = 'https://feishu.test/ops';
  let callIdx = 0;
  const ds21 = new FakeDS({
    sendFeishu: async (_card, url) => {
      callIdx += 1;
      if (url.includes('/ops')) {
        return { success: false, message: 'ops 推送失败' };
      }
      return { success: true, data: { code: 0 } };
    },
  });
  const svc21 = new IntradayOpportunityPusher(ds21);
  const r21 = await svc21.push(makeInput(), { target_groups: ['business', 'ops'] });
  const biz21 = r21.pushed_groups.find(g => g.group === 'business');
  const ops21 = r21.pushed_groups.find(g => g.group === 'ops');
  assertEqual('business sent', biz21?.status, 'sent');
  assertEqual('ops send_error', ops21?.status, 'send_error');
  assertEqual('整体 ok=true (业务群成功)', r21.ok, true);
  assertEqual('调 webhook 2 次', callIdx, 2);

  // ==========================================================================
  console.log('\n[22] push e2e: 缺业务 webhook env → no_webhook...');
  delete process.env.FEISHU_RECOMMENDATION_BOT_WEBHOOK;
  const ds22 = new FakeDS({});
  const svc22 = new IntradayOpportunityPusher(ds22);
  const r22 = await svc22.push(makeInput(), { target_groups: ['business'] });
  assertEqual('no_webhook', r22.pushed_groups[0].status, 'no_webhook');
  assertEqual('ok=false', r22.ok, false);
  assertEqual('skipped_reason=no_webhook', r22.skipped_reason, 'no_webhook');

  // ==========================================================================
  console.log('\n[23] push e2e: include_chart=false 不调 fetchSparkline...');
  process.env.FEISHU_RECOMMENDATION_BOT_WEBHOOK = 'https://feishu.test/biz';
  const ds23 = new FakeDS({
    sparkline: { format: 'sparkline_unicode', rendered: '▂▃', direction: 'up', low: 1, high: 2 },
  });
  const svc23 = new IntradayOpportunityPusher(ds23);
  const r23 = await svc23.push(makeInput(), { include_chart: false });
  assertEqual('fetchSparkline 未调用', ds23.sparkCalls, 0);
  assertEqual('sparkline = null', r23.sparkline, null as any);
  // card 不含 sparkline 段
  assert(
    'card 不含 sparkline 内容',
    !JSON.stringify(r23.card_payload).includes('近 20 日趋势')
  );

  // ==========================================================================
  console.log('\n[24] push e2e: invalid_input (缺 symbol)...');
  const ds24 = new FakeDS({});
  const svc24 = new IntradayOpportunityPusher(ds24);
  const r24 = await svc24.push({ ...makeInput(), symbol: '' });
  assertEqual('ok=false', r24.ok, false);
  assertEqual('skipped_reason=invalid_input', r24.skipped_reason, 'invalid_input');
  assertEqual('不调 webhook', ds24.sendCalls.length, 0);
  assertEqual('不写 audit', ds24.auditCalls.length, 0);

  // ==========================================================================
  console.log('\n[25] push e2e: persist=false 不调 persistAuditRow...');
  const ds25 = new FakeDS({});
  const svc25 = new IntradayOpportunityPusher(ds25);
  await svc25.push(makeInput(), { persist: false });
  assertEqual('audit 未调用', ds25.auditCalls.length, 0);

  // ==========================================================================
  console.log('\n[26] push e2e: persistAuditRow throw 不阻塞主流程...');
  const ds26 = new FakeDS({ persistThrows: true });
  const svc26 = new IntradayOpportunityPusher(ds26);
  const r26 = await svc26.push(makeInput());
  assertEqual('主推送仍 ok=true', r26.ok, true);
  assertEqual('webhook 调用 1 次', ds26.sendCalls.length, 1);

  // ==========================================================================
  console.log('\n[27] push e2e: trigger_time ISO 字符串 → 自动转 Date...');
  const ds27 = new FakeDS({});
  const svc27 = new IntradayOpportunityPusher(ds27);
  const r27 = await svc27.push({
    ...makeInput(),
    trigger_time: '2026-06-25T08:09:00Z' as any,
  });
  assertEqual('ok=true', r27.ok, true);
  // audit row trigger_time 应是 Date
  assert(
    'audit row trigger_time 是 Date',
    ds27.auditCalls[0].trigger_time instanceof Date
  );

  // ==========================================================================
  console.log('\n[28] getRecentPushes filter...');
  const ds28 = new FakeDS({});
  const svc28 = new IntradayOpportunityPusher(ds28);
  await svc28.push(
    makeInput({ symbol: 's1', trigger_rule: 'volume_spike' }),
    { now_ms_override: 1_000_000 }
  );
  await svc28.push(
    makeInput({ symbol: 's2', trigger_rule: 'rapid_rise' }),
    { now_ms_override: 1_000_001 }
  );
  await svc28.push(
    makeInput({ symbol: 's1', trigger_rule: 'rapid_rise' }),
    { now_ms_override: 1_000_002 }
  );
  const all = svc28.getRecentPushes();
  assertEqual('全部 3 条', all.length, 3);
  const filterSymbol = svc28.getRecentPushes(50, { symbol: 's1' });
  assertEqual('filter symbol=s1 → 2 条', filterSymbol.length, 2);
  const filterRule = svc28.getRecentPushes(50, { trigger_rule: 'rapid_rise' });
  assertEqual('filter rule=rapid_rise → 2 条', filterRule.length, 2);

  // ==========================================================================
  console.log('\n[29] resetBuffers 清空...');
  svc28.resetBuffers();
  assertEqual('reset 后 recent = 0', svc28.getRecentPushes().length, 0);

  // ==========================================================================
  console.log('\n[30] dispatchGroup 未知 group → no_webhook (不 throw)...');
  const ds30 = new FakeDS({});
  const svc30 = new IntradayOpportunityPusher(ds30);
  // TS 不允许 'xxx' 作为 OpportunityTargetGroup, 用 cast 模拟运行时坏 input
  const r30 = await svc30.push(makeInput(), { target_groups: ['xxx' as any] });
  assertEqual('未知 group → no_webhook', r30.pushed_groups[0].status, 'no_webhook');

  // ==========================================================================
  console.log('\n[31] PR-L emergency stop-loss gate — conf >= 70 拦截 (audit 仍写)...');
  // 见 IntradayOpportunityPusher 顶部 EMERGENCY_CONF_GATE 注释:
  // PR-K 30 天回测证实 conf>=70 反向 (win 30% < low<50 win 40%).
  // gate 在 push entry 处直接 return skipped, **audit 仍写一行** 留痕便于回查.
  // dry_run 仍跳过该 gate (UI 预览不受影响).
  process.env.FEISHU_RECOMMENDATION_BOT_WEBHOOK = 'https://feishu.test/biz';
  const ds31 = new FakeDS({});
  const svc31 = new IntradayOpportunityPusher(ds31);
  const r31a = await svc31.push(
    makeInput({
      symbol: 'sh.600000',
      decision: {
        action: 'buy',
        confidence_score: 80,
        risk_level: 'medium',
        suggested_position_pct: 5,
        entry_zone: [10, 11],
        stop_loss: 9,
        take_profit: 12,
      },
    })
  );
  assertEqual('conf=80 拦截 ok=false', r31a.ok, false);
  assertEqual('skipped_reason=emergency_stop_loss_conf_gate', r31a.skipped_reason, 'emergency_stop_loss_conf_gate');
  assertEqual('无 group sent (gate 直接 return)', r31a.pushed_groups.length, 0);
  assertEqual('webhook 不调', ds31.sendCalls.length, 0);
  assertEqual('audit 仍写 1 行 (留痕)', ds31.auditCalls.length, 1);
  assertEqual(
    'audit push_result.skipped_reason=emergency_stop_loss_conf_gate',
    (ds31.auditCalls[0].push_result as any).skipped_reason,
    'emergency_stop_loss_conf_gate'
  );

  // 边界: conf=70 也拦截 (>= 严格)
  const r31b = await svc31.push(
    makeInput({
      symbol: 'sh.600001',
      decision: {
        action: 'buy',
        confidence_score: 70,
        risk_level: 'medium',
        suggested_position_pct: 5,
        entry_zone: [10, 11],
        stop_loss: 9,
        take_profit: 12,
      },
    })
  );
  assertEqual('conf=70 边界拦截', r31b.skipped_reason, 'emergency_stop_loss_conf_gate');

  // 反例: conf=69 不拦截 (< threshold) → 正常 push
  const r31c = await svc31.push(
    makeInput({
      symbol: 'sh.600002',
      decision: {
        action: 'buy',
        confidence_score: 69,
        risk_level: 'medium',
        suggested_position_pct: 5,
        entry_zone: [10, 11],
        stop_loss: 9,
        take_profit: 12,
      },
    })
  );
  assertEqual('conf=69 不拦截 ok=true', r31c.ok, true);
  assertEqual('conf=69 status=sent', r31c.pushed_groups[0]?.status, 'sent');

  // dry_run 即使 conf>=70 也不拦截
  const r31d = await svc31.push(
    makeInput({
      symbol: 'sh.600003',
      decision: {
        action: 'buy',
        confidence_score: 90,
        risk_level: 'medium',
        suggested_position_pct: 5,
        entry_zone: [10, 11],
        stop_loss: 9,
        take_profit: 12,
      },
    }),
    { dry_run: true }
  );
  assertEqual('dry_run 跳过 gate ok=true', r31d.ok, true);
  assertEqual('dry_run skipped_reason=dry_run (非 emergency)', r31d.skipped_reason, 'dry_run');

  // ==========================================================================
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
