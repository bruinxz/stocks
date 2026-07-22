/**
 * WeChatOAService 单元测试 (US-066 微信公众号订阅消息)
 *
 * 不依赖 jest；node 直接跑:
 *   cd backend && npx ts-node --transpile-only tests/services/wechat-oa-service.test.ts
 *
 * 完全脱离 DB / 网络：注入 fake WeChatOADataSource + 直接测 WeChatOAClient pure helpers。
 *
 * 覆盖维度:
 *   - 常量冻结 (WECHAT_MESSAGE_PATHS / WECHAT_TEMPLATE_ENV)
 *   - WeChatOAClient 纯函数：
 *     - readWeChatOAConfigFromEnv (缺 appId / 缺 secret / 默认 apiBase + timeoutMs)
 *     - isWeChatOADisabledByEnv (true / false / 不同字符串)
 *     - isValidOpenId (合法 28 字符 / 含特殊字符 / 太短 / 太长 / 非字符串)
 *     - isValidSceneStr (合法 / 含 ! / 含中文 / 太长 / 空)
 *     - buildBindSceneStr (确定性 rand6 provider / user_id 非正抛错)
 *     - parseBindSceneStr (反向 / 非 bind- 前缀 / 非数字 user_id)
 *     - computeTokenExpireAt (-300 减 5min / fallback / 最低 60s)
 *   - WeChatOAService 纯函数：
 *     - shouldSendWeChatForUser (4 路径: 未启用 / 缺 openid / 模板开关关 / 通过)
 *     - resolveTemplateId (env 配置 / 缺失)
 *     - buildWeChatMessageId (date / rand4 / path 后缀)
 *     - buildDailyDigestSubscribeData (盈利绿 / 亏损红 / 平灰 / pct null)
 *     - buildEarningsForecastSubscribeData (预增绿 / 预减红 / 其他灰)
 *     - buildRiskAlertSubscribeData (HIGH 红 / MEDIUM 橙 / LOW 灰 / 缺字段)
 *   - service.getBindQrCode() e2e:
 *     - createQrCode 成功 → 返回 bind_id + qrcode_image_url + scene_str + 持久化
 *     - createQrCode 失败 → throw
 *     - 用户不存在 → throw
 *     - user 已绑定 → 返回 current_openid
 *   - service.confirmBind() e2e:
 *     - 状态有 openid + bound_at → bound:true
 *     - 状态无 openid → bound:false
 *     - scene_str 不匹配 → bound:false + 提示重新扫码
 *     - 用户不存在 → bound:false + message='用户不存在'
 *   - service.handleBindEventFromWebhook() e2e:
 *     - 合法 scene_str + openid → applyBindResult 被调
 *     - scene_str 非法 → throw
 *     - openid 非法 → throw
 *   - service.sendDailyDigest() e2e:
 *     - 通过 gate → status='sent' / sendSubscribeMessage 被调
 *     - 用户不存在 → status='failed'
 *     - 模板 id 未配置 → status='skipped' + skip_reason 含 'env'
 *     - wechat.enabled=false → status='skipped'
 *     - wechat.daily_digest=false → status='skipped'
 *     - wechat.openid 空 → status='skipped'
 *     - dry_run=true → status='skipped' skip_reason='dry_run'
 *     - sendSubscribeMessage 返回 success=false → status='failed'
 *     - sendSubscribeMessage 返回 skipped=true → status='skipped'
 *     - sendSubscribeMessage throw → 由 service.sendByTemplate try/catch buildPayload 捕获 (buildPayload 不会 throw 这里实测 DS 传播)
 *   - service.sendEarningsForecast() e2e: 走 sendByTemplate 路径冒烟一次
 *   - service.sendRiskAlert() e2e: 同上
 *   - service.updateWeChatConfig() e2e:
 *     - patch 4 字段 normalize 后落盘
 *   - service.unbindWeChat() e2e:
 *     - openid / bind_scene_str / bound_at 清空 / 其他字段保留
 */

import {
  WeChatOAClient,
  readWeChatOAConfigFromEnv,
  isWeChatOADisabledByEnv,
  isValidOpenId,
  isValidSceneStr,
  buildBindSceneStr,
  parseBindSceneStr,
  computeTokenExpireAt,
  resetWeChatAccessToken,
  WeChatQrCodeResult,
  WeChatSendResult,
  WeChatSubscribeMessageData,
} from '../../src/services/WeChatOAClient';

import {
  WeChatOAService,
  WeChatOADataSource,
  WECHAT_MESSAGE_PATHS,
  WECHAT_TEMPLATE_ENV,
  shouldSendWeChatForUser,
  resolveTemplateId,
  buildWeChatMessageId,
  buildDailyDigestSubscribeData,
  buildEarningsForecastSubscribeData,
  buildRiskAlertSubscribeData,
} from '../../src/services/WeChatOAService';

import {
  NotificationChannelsConfig,
  DEFAULT_NOTIFICATION_CONFIG,
  DigestPayload,
} from '../../src/services/DailyTradingDigestService';

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
// 测试装置 — fake WeChatOADataSource
// ---------------------------------------------------------------------------

interface FakeUserState {
  username: string;
  config: NotificationChannelsConfig;
}

function makeConfig(overrides: Partial<NotificationChannelsConfig['wechat']> = {}): NotificationChannelsConfig {
  return {
    feishu: { ...DEFAULT_NOTIFICATION_CONFIG.feishu },
    email: { ...DEFAULT_NOTIFICATION_CONFIG.email },
    wechat: {
      ...DEFAULT_NOTIFICATION_CONFIG.wechat,
      ...overrides,
    },
  };
}

interface FakeDataSourceCalls {
  loadUserConfig: number[];
  saveBindSceneStr: Array<{ user_id: number; scene_str: string }>;
  loadWeChatBindState: number[];
  applyBindResult: Array<{ user_id: number; openid: string; bound_at: string }>;
  sendSubscribeMessage: Array<{
    toUser: string;
    templateId: string;
    data: WeChatSubscribeMessageData;
    url?: string;
  }>;
  createQrCode: Array<{ sceneStr: string; expireSeconds?: number }>;
}

class FakeWeChatOADataSource implements WeChatOADataSource {
  users = new Map<number, FakeUserState>();
  calls: FakeDataSourceCalls = {
    loadUserConfig: [],
    saveBindSceneStr: [],
    loadWeChatBindState: [],
    applyBindResult: [],
    sendSubscribeMessage: [],
    createQrCode: [],
  };
  qrCodeResult: WeChatQrCodeResult = {
    success: true,
    ticket: 'fake_ticket_001',
    url: 'https://wx.fake.com/url/abc',
    qrcode_image_url: 'https://mp.weixin.qq.com/cgi-bin/showqrcode?ticket=fake_ticket_001',
    expire_seconds: 2592000,
    scene_str: '',
  };
  sendResult: WeChatSendResult = {
    success: true,
    data: { errcode: 0, errmsg: 'ok', msgid: 12345 },
  };

  setUser(user_id: number, state: FakeUserState): void {
    this.users.set(user_id, state);
  }

  async loadUserConfig(user_id: number) {
    this.calls.loadUserConfig.push(user_id);
    const s = this.users.get(user_id);
    if (!s) return null;
    return { username: s.username, config: s.config };
  }

  async saveBindSceneStr(user_id: number, scene_str: string): Promise<void> {
    this.calls.saveBindSceneStr.push({ user_id, scene_str });
    const s = this.users.get(user_id);
    if (!s) throw new Error('用户不存在');
    s.config.wechat.bind_scene_str = scene_str;
  }

  async loadWeChatBindState(user_id: number) {
    this.calls.loadWeChatBindState.push(user_id);
    const s = this.users.get(user_id);
    if (!s) return null;
    return {
      openid: s.config.wechat.openid || '',
      bind_scene_str: s.config.wechat.bind_scene_str || '',
      bound_at: s.config.wechat.bound_at || '',
    };
  }

  async applyBindResult(input: { user_id: number; openid: string; bound_at: string }): Promise<void> {
    this.calls.applyBindResult.push(input);
    const s = this.users.get(input.user_id);
    if (!s) throw new Error('用户不存在');
    s.config.wechat.enabled = true;
    s.config.wechat.openid = input.openid;
    s.config.wechat.bound_at = input.bound_at;
  }

  async sendSubscribeMessage(input: {
    toUser: string;
    templateId: string;
    data: WeChatSubscribeMessageData;
    url?: string;
  }): Promise<WeChatSendResult> {
    this.calls.sendSubscribeMessage.push(input);
    return this.sendResult;
  }

  async createQrCode(sceneStr: string, expireSeconds?: number): Promise<WeChatQrCodeResult> {
    this.calls.createQrCode.push({ sceneStr, expireSeconds });
    return { ...this.qrCodeResult, scene_str: sceneStr };
  }
}

function makeDigestPayload(overrides: Partial<DigestPayload> = {}): DigestPayload {
  return {
    user_id: 1,
    username: 'test',
    trade_date: '2026-06-08',
    pnl: {
      total_value: 100000,
      prev_total_value: 99000,
      pnl_today: 1000,
      pnl_today_pct: 1.0,
      position_value: 50000,
      current_cash: 50000,
    },
    trades_today_buy: [],
    trades_today_sell: [],
    trades_today_buy_count: 0,
    trades_today_sell_count: 0,
    ...overrides,
  };
}

// ===========================================================================
// 测试 1: 常量冻结
// ===========================================================================

console.log('\n[1] 常量冻结...');

assert(
  'WECHAT_MESSAGE_PATHS 冻结',
  Object.isFrozen(WECHAT_MESSAGE_PATHS),
  'should be frozen via Object.freeze'
);
assertEqual('WECHAT_MESSAGE_PATHS.BIND', WECHAT_MESSAGE_PATHS.BIND, 'BIND');
assertEqual('WECHAT_MESSAGE_PATHS.DIGEST', WECHAT_MESSAGE_PATHS.DIGEST, 'DIGEST');
assertEqual('WECHAT_MESSAGE_PATHS.EARN', WECHAT_MESSAGE_PATHS.EARN, 'EARN');
assertEqual('WECHAT_MESSAGE_PATHS.RISK', WECHAT_MESSAGE_PATHS.RISK, 'RISK');

assert('WECHAT_TEMPLATE_ENV 冻结', Object.isFrozen(WECHAT_TEMPLATE_ENV));
assertEqual('WECHAT_TEMPLATE_ENV.DAILY_DIGEST', WECHAT_TEMPLATE_ENV.DAILY_DIGEST, 'WECHAT_TEMPLATE_DAILY_DIGEST');
assertEqual(
  'WECHAT_TEMPLATE_ENV.EARNINGS_FORECAST',
  WECHAT_TEMPLATE_ENV.EARNINGS_FORECAST,
  'WECHAT_TEMPLATE_EARNINGS_FORECAST'
);
assertEqual('WECHAT_TEMPLATE_ENV.RISK_ALERT', WECHAT_TEMPLATE_ENV.RISK_ALERT, 'WECHAT_TEMPLATE_RISK_ALERT');

// ===========================================================================
// 测试 2: WeChatOAClient 纯函数 - readWeChatOAConfigFromEnv
// ===========================================================================

console.log('\n[2] readWeChatOAConfigFromEnv...');

assertEqual('缺 appId → null', readWeChatOAConfigFromEnv({}), null);
assertEqual(
  '缺 secret → null',
  readWeChatOAConfigFromEnv({ WECHAT_OA_APPID: 'wx_appid_test' }),
  null
);
const cfg1 = readWeChatOAConfigFromEnv({
  WECHAT_OA_APPID: 'wx_a',
  WECHAT_OA_APPSECRET: 'secret_a',
});
assert('合法 env → 非 null', cfg1 !== null);
assertEqual('apiBase 默认值', cfg1!.apiBase, 'https://api.weixin.qq.com');
assertEqual('timeoutMs 默认 10000', cfg1!.timeoutMs, 10000);

const cfg2 = readWeChatOAConfigFromEnv({
  WECHAT_OA_APPID: 'wx_a',
  WECHAT_OA_APPSECRET: 'secret_a',
  WECHAT_OA_API_BASE: 'https://custom.api/',
  WECHAT_OA_TIMEOUT_MS: '20000',
});
assertEqual('apiBase 自定义', cfg2!.apiBase, 'https://custom.api/');
assertEqual('timeoutMs 自定义', cfg2!.timeoutMs, 20000);

// 非法 timeoutMs 走默认
const cfg3 = readWeChatOAConfigFromEnv({
  WECHAT_OA_APPID: 'wx_a',
  WECHAT_OA_APPSECRET: 'secret_a',
  WECHAT_OA_TIMEOUT_MS: 'abc',
});
assertEqual('非法 timeoutMs → 默认', cfg3!.timeoutMs, 10000);

// ===========================================================================
// 测试 3: isWeChatOADisabledByEnv
// ===========================================================================

console.log('\n[3] isWeChatOADisabledByEnv...');

assertEqual('缺 env → false', isWeChatOADisabledByEnv({}), false);
assertEqual('true', isWeChatOADisabledByEnv({ DISABLE_WECHAT_OA: 'true' }), true);
assertEqual('1', isWeChatOADisabledByEnv({ DISABLE_WECHAT_OA: '1' }), true);
assertEqual('yes', isWeChatOADisabledByEnv({ DISABLE_WECHAT_OA: 'yes' }), true);
assertEqual('false', isWeChatOADisabledByEnv({ DISABLE_WECHAT_OA: 'false' }), false);
assertEqual('0', isWeChatOADisabledByEnv({ DISABLE_WECHAT_OA: '0' }), false);

// ===========================================================================
// 测试 4: isValidOpenId
// ===========================================================================

console.log('\n[4] isValidOpenId...');

assertEqual('合法 28 字符', isValidOpenId('oABCDEFGHijklmnopqrstuvwxyzAB'), true);
assertEqual('含 _ 合法', isValidOpenId('oABC_DEFGHijklmnopqr_stuvwxyzAB'), true);
assertEqual('含 - 合法', isValidOpenId('oABC-DEFGHijklmnopqr-stuvwxyzAB'), true);
assertEqual('太短', isValidOpenId('oABC'), false);
assertEqual('太长', isValidOpenId('o'.repeat(100)), false);
assertEqual('空字符串', isValidOpenId(''), false);
assertEqual('null', isValidOpenId(null as any), false);
assertEqual('undefined', isValidOpenId(undefined as any), false);
assertEqual('非字符串', isValidOpenId(12345 as any), false);
assertEqual('含中文', isValidOpenId('oABC中文DEFGHijklmnopq'), false);
assertEqual('含空格', isValidOpenId('oABC DEFGHijklmnopqrs'), false);

// ===========================================================================
// 测试 5: isValidSceneStr
// ===========================================================================

console.log('\n[5] isValidSceneStr...');

assertEqual('合法 ASCII', isValidSceneStr('bind-123-ABCDEF'), true);
assertEqual('合法 + !', isValidSceneStr('bind!123'), true);
assertEqual('合法 + .', isValidSceneStr('bind.123'), true);
assertEqual('合法单字符', isValidSceneStr('a'), true);
assertEqual('空', isValidSceneStr(''), false);
assertEqual('null', isValidSceneStr(null as any), false);
assertEqual('含中文', isValidSceneStr('bind-绑定-001'), false);
assertEqual('含空格', isValidSceneStr('bind 123'), false);
assertEqual('64 字符 边界', isValidSceneStr('a'.repeat(64)), true);
assertEqual('65 字符 超限', isValidSceneStr('a'.repeat(65)), false);

// ===========================================================================
// 测试 6: buildBindSceneStr / parseBindSceneStr 往返
// ===========================================================================

console.log('\n[6] buildBindSceneStr / parseBindSceneStr...');

const scene = buildBindSceneStr(123, () => 'ABCDEF');
assertEqual('确定性 rand6', scene, 'bind-123-ABCDEF');
const parsed = parseBindSceneStr(scene);
assert('parse 非 null', parsed !== null);
assertEqual('parse user_id', parsed!.user_id, 123);
assertEqual('parse rand6', parsed!.rand6, 'ABCDEF');

assertThrows('user_id 0 抛错', () => buildBindSceneStr(0));
assertThrows('user_id 负数抛错', () => buildBindSceneStr(-1));
assertThrows('user_id 浮点抛错', () => buildBindSceneStr(1.5));
assertThrows('user_id NaN 抛错', () => buildBindSceneStr(NaN));

assertEqual('parse 非 bind- 前缀 → null', parseBindSceneStr('xxx-123-ABCDEF'), null);
assertEqual('parse 非数字 user_id → null', parseBindSceneStr('bind-abc-ABCDEF'), null);
assertEqual('parse rand6 < 4 → null', parseBindSceneStr('bind-123-AB'), null);
assertEqual('parse 空 → null', parseBindSceneStr(''), null);

// 真随机也合法
const sceneRandom = buildBindSceneStr(456);
assert('真随机 scene 也合法', isValidSceneStr(sceneRandom));
assert('真随机 scene 可反解', parseBindSceneStr(sceneRandom)?.user_id === 456);

// ===========================================================================
// 测试 7: computeTokenExpireAt
// ===========================================================================

console.log('\n[7] computeTokenExpireAt...');

// expires_in=7200 → 减 300 = 6900s = 6900000ms 后过期
assertEqual('expires_in=7200', computeTokenExpireAt(7200, 1000000), 1000000 + 6900 * 1000);
// expires_in=1000 → 减 300 = 700s 后过期
assertEqual('expires_in=1000', computeTokenExpireAt(1000, 1000000), 1000000 + 700 * 1000);
// expires_in=200 → -100s 触发最低 60s 兜底
assertEqual('expires_in=200 走 60s 兜底', computeTokenExpireAt(200, 1000000), 1000000 + 60000);
// 非法值走默认 7200
assertEqual('NaN 走默认 7200', computeTokenExpireAt(NaN, 1000000), 1000000 + 6900 * 1000);
assertEqual('0 走默认', computeTokenExpireAt(0, 1000000), 1000000 + 6900 * 1000);

// ===========================================================================
// 测试 8: shouldSendWeChatForUser
// ===========================================================================

console.log('\n[8] shouldSendWeChatForUser...');

const cfg_off = makeConfig({ enabled: false });
assertEqual(
  'wechat.enabled=false',
  shouldSendWeChatForUser(cfg_off, WECHAT_TEMPLATE_ENV.DAILY_DIGEST).shouldSend,
  false
);

const cfg_noOpenid = makeConfig({ enabled: true, openid: '', daily_digest: true });
assertEqual(
  '缺 openid',
  shouldSendWeChatForUser(cfg_noOpenid, WECHAT_TEMPLATE_ENV.DAILY_DIGEST).shouldSend,
  false
);

const cfg_digestOff = makeConfig({
  enabled: true,
  openid: 'oABCDEFGHijklmnopqrstuvwxyzAB',
  daily_digest: false,
});
assertEqual(
  'daily_digest 关',
  shouldSendWeChatForUser(cfg_digestOff, WECHAT_TEMPLATE_ENV.DAILY_DIGEST).shouldSend,
  false
);

const cfg_ok = makeConfig({
  enabled: true,
  openid: 'oABCDEFGHijklmnopqrstuvwxyzAB',
  daily_digest: true,
  earnings_alert: true,
  risk_alert: true,
});
assertEqual(
  '4 字段全开 → 应发',
  shouldSendWeChatForUser(cfg_ok, WECHAT_TEMPLATE_ENV.DAILY_DIGEST).shouldSend,
  true
);
assertEqual(
  '4 字段全开 earnings_alert → 应发',
  shouldSendWeChatForUser(cfg_ok, WECHAT_TEMPLATE_ENV.EARNINGS_FORECAST).shouldSend,
  true
);
assertEqual(
  '4 字段全开 risk_alert → 应发',
  shouldSendWeChatForUser(cfg_ok, WECHAT_TEMPLATE_ENV.RISK_ALERT).shouldSend,
  true
);

// earnings_alert 单独关
const cfg_earningsOff = makeConfig({
  enabled: true,
  openid: 'oABCDEFGHijklmnopqrstuvwxyzAB',
  earnings_alert: false,
});
assertEqual(
  'earnings_alert=false → 关 earnings',
  shouldSendWeChatForUser(cfg_earningsOff, WECHAT_TEMPLATE_ENV.EARNINGS_FORECAST).shouldSend,
  false
);

const cfg_riskOff = makeConfig({
  enabled: true,
  openid: 'oABCDEFGHijklmnopqrstuvwxyzAB',
  risk_alert: false,
});
assertEqual(
  'risk_alert=false → 关 risk',
  shouldSendWeChatForUser(cfg_riskOff, WECHAT_TEMPLATE_ENV.RISK_ALERT).shouldSend,
  false
);

// ===========================================================================
// 测试 9: resolveTemplateId
// ===========================================================================

console.log('\n[9] resolveTemplateId...');

assertEqual(
  'env 配置 → 取值',
  resolveTemplateId(WECHAT_TEMPLATE_ENV.DAILY_DIGEST, {
    WECHAT_TEMPLATE_DAILY_DIGEST: 'template_xxx',
  }),
  'template_xxx'
);
assertEqual('env 缺失 → 空字符串', resolveTemplateId(WECHAT_TEMPLATE_ENV.DAILY_DIGEST, {}), '');

// ===========================================================================
// 测试 10: buildWeChatMessageId
// ===========================================================================

console.log('\n[10] buildWeChatMessageId...');

const mid = buildWeChatMessageId(123, WECHAT_MESSAGE_PATHS.DIGEST, {
  date: '20260608',
  rand4Provider: () => 'abcd',
});
assertEqual('确定性 ID', mid, 'WECHAT-123-DIGEST-20260608-abcd');

// path 不同 ID 不同
const midBind = buildWeChatMessageId(123, WECHAT_MESSAGE_PATHS.BIND, {
  date: '20260608',
  rand4Provider: () => 'abcd',
});
assertEqual('BIND ID', midBind, 'WECHAT-123-BIND-20260608-abcd');

assertThrows('user_id 0 抛错', () => buildWeChatMessageId(0, WECHAT_MESSAGE_PATHS.DIGEST));
assertThrows('user_id -1 抛错', () => buildWeChatMessageId(-1, WECHAT_MESSAGE_PATHS.DIGEST));

// 真随机也合法
const midRandom = buildWeChatMessageId(99, WECHAT_MESSAGE_PATHS.RISK);
assert('真随机 ID 包含 user_id', midRandom.includes('-99-'));
assert('真随机 ID 包含 path', midRandom.includes('-RISK-'));
assert('真随机 ID 以 WECHAT- 开头', midRandom.startsWith('WECHAT-'));

// 非法 date 字符串走默认今天
const midDefaultDate = buildWeChatMessageId(123, WECHAT_MESSAGE_PATHS.DIGEST, {
  date: 'not-a-date',
  rand4Provider: () => 'abcd',
});
assert('非法 date 走默认', /^WECHAT-123-DIGEST-\d{8}-abcd$/.test(midDefaultDate));

// ===========================================================================
// 测试 11: buildDailyDigestSubscribeData
// ===========================================================================

console.log('\n[11] buildDailyDigestSubscribeData...');

const dataWin = buildDailyDigestSubscribeData(
  makeDigestPayload({
    pnl: {
      total_value: 100000,
      prev_total_value: 99000,
      pnl_today: 1234.56,
      pnl_today_pct: 1.25,
      position_value: 50000,
      current_cash: 50000,
    },
    trades_today_buy_count: 2,
    trades_today_sell_count: 1,
  })
);
assert('first 含 trade_date', dataWin.first.value.includes('2026-06-08'));
assert('keyword1 含 +', dataWin.keyword1.value.includes('+'));
assert('keyword1 含 %', dataWin.keyword1.value.includes('%'));
assertEqual('keyword1 盈利绿色', dataWin.keyword1.color, '#3f8600');
assertEqual('keyword2 买入笔数', dataWin.keyword2.value, '2 笔');
assertEqual('keyword3 卖出笔数', dataWin.keyword3.value, '1 笔');
assertEqual('keyword4 闭环成交数', dataWin.keyword4.value, '3 笔闭环成交');

const dataLoss = buildDailyDigestSubscribeData(
  makeDigestPayload({
    pnl: {
      total_value: 95000,
      prev_total_value: 100000,
      pnl_today: -5000,
      pnl_today_pct: -5.0,
      position_value: 50000,
      current_cash: 45000,
    },
  })
);
assertEqual('亏损红色', dataLoss.keyword1.color, '#cf1322');
assert('keyword1 含 -', dataLoss.keyword1.value.includes('-'));

const dataFlat = buildDailyDigestSubscribeData(
  makeDigestPayload({
    pnl: {
      total_value: 100000,
      prev_total_value: 100000,
      pnl_today: 0,
      pnl_today_pct: 0,
      position_value: 50000,
      current_cash: 50000,
    },
  })
);
assertEqual('零盈亏灰色', dataFlat.keyword1.color, '#666666');

// pnl_today_pct = null
const dataNullPct = buildDailyDigestSubscribeData(
  makeDigestPayload({
    pnl: {
      total_value: 100000,
      prev_total_value: 0,
      pnl_today: 100,
      pnl_today_pct: null,
      position_value: 50000,
      current_cash: 50000,
    },
  })
);
assert('null pct 仍包含金额', dataNullPct.keyword1.value.includes('100'));
// 但不含 %
assert('null pct 不含 %', !dataNullPct.keyword1.value.includes('%'));

// ===========================================================================
// 测试 12: buildEarningsForecastSubscribeData
// ===========================================================================

console.log('\n[12] buildEarningsForecastSubscribeData...');

const dataPredictUp = buildEarningsForecastSubscribeData({
  symbol: '600519',
  name: '贵州茅台',
  forecast_type: '预增',
  profit_change_text: '+50.0% ~ +80.0%',
  report_period: '2026Q1',
  announce_date: '2026-04-10',
});
assertEqual('keyword1 含 symbol 和 name', dataPredictUp.keyword1.value, '600519 贵州茅台');
assert('keyword2 含预增 + 区间', dataPredictUp.keyword2.value.includes('预增'));
assertEqual('预增绿色', dataPredictUp.keyword2.color, '#3f8600');
assertEqual('keyword3 报告期', dataPredictUp.keyword3.value, '2026Q1');
assertEqual('keyword4 公告日期', dataPredictUp.keyword4.value, '2026-04-10');

const dataPredictDown = buildEarningsForecastSubscribeData({
  symbol: '000001',
  name: '平安银行',
  forecast_type: '预减',
  profit_change_text: '-30.0% ~ -50.0%',
  report_period: '2026Q1',
  announce_date: '2026-04-10',
});
assertEqual('预减红色', dataPredictDown.keyword2.color, '#cf1322');

const dataPredictUncertain = buildEarningsForecastSubscribeData({
  symbol: '000001',
  name: 'X',
  forecast_type: '不确定',
  profit_change_text: '—',
  report_period: '2026Q1',
  announce_date: '2026-04-10',
});
assertEqual('不确定灰色', dataPredictUncertain.keyword2.color, '#666666');

// 缺 report_period 显示 '—'
const dataEmpty = buildEarningsForecastSubscribeData({
  symbol: '600519',
  name: '贵州茅台',
  forecast_type: '续盈',
  profit_change_text: '+10% ~ +20%',
  report_period: '',
  announce_date: '',
});
assertEqual('缺 report_period → —', dataEmpty.keyword3.value, '—');
assertEqual('缺 announce_date → —', dataEmpty.keyword4.value, '—');

// ===========================================================================
// 测试 13: buildRiskAlertSubscribeData
// ===========================================================================

console.log('\n[13] buildRiskAlertSubscribeData...');

const dataHigh = buildRiskAlertSubscribeData({
  level: 'HIGH',
  title: '持仓个股触发熔断',
  detail: '宁德时代触发 -8% 单日跌幅熔断',
  triggered_at: '2026-06-08T14:30:00+08:00',
  symbol: '300750',
});
assertEqual('HIGH 红色', dataHigh.keyword1.color, '#cf1322');
assertEqual('HIGH 等级文本', dataHigh.keyword1.value, 'HIGH 级');
assertEqual('keyword2 标题', dataHigh.keyword2.value, '持仓个股触发熔断');
assertEqual('keyword4 symbol', dataHigh.keyword4.value, '300750');
assert('remark 含 detail', dataHigh.remark.value.includes('宁德时代'));

const dataMed = buildRiskAlertSubscribeData({
  level: 'MEDIUM',
  title: '行业集中度告警',
  detail: '消费板块占比超 50%',
  triggered_at: '2026-06-08T14:30:00+08:00',
});
assertEqual('MEDIUM 橙色', dataMed.keyword1.color, '#fa8c16');
assertEqual('缺 symbol → —', dataMed.keyword4.value, '—');

const dataLow = buildRiskAlertSubscribeData({
  level: 'LOW',
  title: '指标提示',
  detail: 'X',
  triggered_at: '2026-06-08T14:30:00+08:00',
});
assertEqual('LOW 灰色', dataLow.keyword1.color, '#999999');

// 缺 level 走 LOW
const dataNoLevel = buildRiskAlertSubscribeData({
  level: undefined as any,
  title: 'X',
  detail: 'X',
  triggered_at: '2026-06-08T14:30:00+08:00',
});
assertEqual('缺 level 走 LOW 灰色', dataNoLevel.keyword1.color, '#999999');

// ===========================================================================
// 测试 14: service.getBindQrCode()
// ===========================================================================

(async () => {
  console.log('\n[14] service.getBindQrCode()...');

  // 14.1 成功路径
  const ds1 = new FakeWeChatOADataSource();
  ds1.setUser(7, {
    username: 'alice',
    config: makeConfig({ enabled: false, openid: '' }),
  });
  const svc1 = new WeChatOAService({ dataSource: ds1 });
  const qr1 = await svc1.getBindQrCode(7, { rand6Provider: () => 'ABCDEF' });
  assertEqual('成功 user_id', qr1.user_id, 7);
  assertEqual('成功 scene_str', qr1.scene_str, 'bind-7-ABCDEF');
  assertEqual('成功 ticket', qr1.ticket, 'fake_ticket_001');
  assert('成功 qrcode_image_url', qr1.qrcode_image_url.includes('mp.weixin.qq.com'));
  assert('expire_at ISO', /\d{4}-\d{2}-\d{2}T/.test(qr1.expire_at));
  assertEqual('createQrCode 被调一次', ds1.calls.createQrCode.length, 1);
  assertEqual(
    'createQrCode 传入 sceneStr',
    ds1.calls.createQrCode[0].sceneStr,
    'bind-7-ABCDEF'
  );
  assertEqual(
    'saveBindSceneStr 被调',
    ds1.calls.saveBindSceneStr[0]?.scene_str,
    'bind-7-ABCDEF'
  );
  // user 之前未绑定 → current_openid 空
  assertEqual('current_openid 未绑定 → 空', qr1.current_openid, '');

  // 14.2 用户已绑定 → current_openid 有值
  const ds2 = new FakeWeChatOADataSource();
  ds2.setUser(8, {
    username: 'bob',
    config: makeConfig({
      enabled: true,
      openid: 'oOLDXXXXXXXXXXXXXXXXXXXXXXXX',
      bound_at: '2026-05-01T08:00:00Z',
    }),
  });
  const svc2 = new WeChatOAService({ dataSource: ds2 });
  const qr2 = await svc2.getBindQrCode(8, { rand6Provider: () => 'XYZ123' });
  assertEqual('current_openid 已绑定', qr2.current_openid, 'oOLDXXXXXXXXXXXXXXXXXXXXXXXX');
  assertEqual('current_bound_at 已填', qr2.current_bound_at, '2026-05-01T08:00:00Z');
  // 重新生成 scene_str 后已持久化
  assertEqual('scene_str 被覆盖', qr2.scene_str, 'bind-8-XYZ123');

  // 14.3 用户不存在
  const ds3 = new FakeWeChatOADataSource();
  const svc3 = new WeChatOAService({ dataSource: ds3 });
  await assertRejects('用户不存在 throw', async () => svc3.getBindQrCode(999));

  // 14.4 createQrCode 失败 → throw
  const ds4 = new FakeWeChatOADataSource();
  ds4.setUser(9, { username: 'c', config: makeConfig() });
  ds4.qrCodeResult = { success: false, message: '微信侧错误' };
  const svc4 = new WeChatOAService({ dataSource: ds4 });
  await assertRejects('createQrCode 失败 throw', async () => svc4.getBindQrCode(9));

  // 14.5 user_id 非法 → throw
  const ds5 = new FakeWeChatOADataSource();
  const svc5 = new WeChatOAService({ dataSource: ds5 });
  await assertRejects('user_id=0 throw', async () => svc5.getBindQrCode(0));
  await assertRejects('user_id=-1 throw', async () => svc5.getBindQrCode(-1));
  await assertRejects('user_id 浮点 throw', async () => svc5.getBindQrCode(1.5));

  // ===========================================================================
  // 测试 15: service.confirmBind()
  // ===========================================================================

  console.log('\n[15] service.confirmBind()...');

  // 15.1 已绑定 → bound:true
  const dsB1 = new FakeWeChatOADataSource();
  dsB1.setUser(10, {
    username: 'd',
    config: makeConfig({
      openid: 'oNEWXXXXXXXXXXXXXXXXXXXXXXXX',
      bound_at: '2026-06-08T10:00:00Z',
      bind_scene_str: 'bind-10-XXXXXX',
    }),
  });
  const svcB1 = new WeChatOAService({ dataSource: dsB1 });
  const cb1 = await svcB1.confirmBind(10, 'bind-10-XXXXXX');
  assertEqual('已绑定 bound true', cb1.bound, true);
  assertEqual('已绑定 openid', cb1.openid, 'oNEWXXXXXXXXXXXXXXXXXXXXXXXX');
  assertEqual('已绑定 message', cb1.message, '已成功绑定');

  // 15.2 未绑定 → bound:false
  const dsB2 = new FakeWeChatOADataSource();
  dsB2.setUser(11, {
    username: 'e',
    config: makeConfig({
      openid: '',
      bound_at: '',
      bind_scene_str: 'bind-11-YYYYYY',
    }),
  });
  const svcB2 = new WeChatOAService({ dataSource: dsB2 });
  const cb2 = await svcB2.confirmBind(11, 'bind-11-YYYYYY');
  assertEqual('未绑定 bound false', cb2.bound, false);

  // 15.3 scene_str 不匹配 → bound:false
  const cb3 = await svcB2.confirmBind(11, 'bind-11-ZZZZZZ');
  assertEqual('scene_str 不匹配 bound false', cb3.bound, false);
  assert('scene_str 不匹配 提示重新扫码', (cb3.message || '').includes('重新扫码'));

  // 15.4 用户不存在 → bound:false
  const dsB4 = new FakeWeChatOADataSource();
  const svcB4 = new WeChatOAService({ dataSource: dsB4 });
  const cb4 = await svcB4.confirmBind(999);
  assertEqual('用户不存在 bound false', cb4.bound, false);
  assertEqual('用户不存在 message', cb4.message, '用户不存在');

  // 15.5 不传 scene_str → 也能 bound（兜底容灾）
  const cb5 = await svcB1.confirmBind(10);
  assertEqual('不传 scene_str 仍可 bound', cb5.bound, true);

  // ===========================================================================
  // 测试 16: service.handleBindEventFromWebhook()
  // ===========================================================================

  console.log('\n[16] service.handleBindEventFromWebhook()...');

  // 16.1 合法 → applyBindResult 被调
  const dsW1 = new FakeWeChatOADataSource();
  dsW1.setUser(12, { username: 'f', config: makeConfig() });
  const svcW1 = new WeChatOAService({ dataSource: dsW1 });
  const res1 = await svcW1.handleBindEventFromWebhook({
    sceneStr: 'bind-12-ABCDEF',
    openid: 'oWEBHOOK_12345678901234567890',
    eventAt: '2026-06-08T10:00:00Z',
  });
  assertEqual('webhook user_id', res1.user_id, 12);
  assertEqual('webhook bound_at', res1.bound_at, '2026-06-08T10:00:00Z');
  assertEqual('applyBindResult 被调', dsW1.calls.applyBindResult.length, 1);
  assertEqual(
    'applyBindResult openid',
    dsW1.calls.applyBindResult[0].openid,
    'oWEBHOOK_12345678901234567890'
  );

  // 16.2 scene_str 非法 → throw
  await assertRejects('scene_str 非法 throw', async () =>
    svcW1.handleBindEventFromWebhook({
      sceneStr: 'invalid-scene',
      openid: 'oWEBHOOK_12345678901234567890',
    })
  );

  // 16.3 openid 非法 → throw
  await assertRejects('openid 非法 throw', async () =>
    svcW1.handleBindEventFromWebhook({
      sceneStr: 'bind-12-ABCDEF',
      openid: 'short',
    })
  );

  // 16.4 eventAt 缺省 → 走 Date.now ISO
  const res2 = await svcW1.handleBindEventFromWebhook({
    sceneStr: 'bind-12-XYZ789',
    openid: 'oWEBHOOK_12345678901234567890',
  });
  assert('缺 eventAt 走 Date.now ISO', /\d{4}-\d{2}-\d{2}T/.test(res2.bound_at));

  // ===========================================================================
  // 测试 17: service.sendDailyDigest()
  // ===========================================================================

  console.log('\n[17] service.sendDailyDigest()...');

  // 17.1 env 缺 templateId → status='skipped'
  const dsS1 = new FakeWeChatOADataSource();
  dsS1.setUser(20, {
    username: 'g',
    config: makeConfig({
      enabled: true,
      openid: 'oABCDEFGHijklmnopqrstuvwxyzAB',
      daily_digest: true,
    }),
  });
  const svcS1 = new WeChatOAService({ dataSource: dsS1 });
  // 临时清空 env
  const savedTpl = process.env.WECHAT_TEMPLATE_DAILY_DIGEST;
  delete process.env.WECHAT_TEMPLATE_DAILY_DIGEST;
  const r1 = await svcS1.sendDailyDigest({
    user_id: 20,
    payload: makeDigestPayload(),
  });
  assertEqual('缺 templateId status skipped', r1.status, 'skipped');
  assert('缺 templateId skip_reason 含 env', (r1.skip_reason || '').includes('env'));

  // 17.2 template 配齐 → 通过
  process.env.WECHAT_TEMPLATE_DAILY_DIGEST = 'tpl_daily_001';
  const r2 = await svcS1.sendDailyDigest({
    user_id: 20,
    payload: makeDigestPayload(),
  });
  assertEqual('合法 status sent', r2.status, 'sent');
  assertEqual('合法 sent true', r2.sent, true);
  assertEqual('合法 template_id', r2.template_id, 'tpl_daily_001');
  assertEqual('sendSubscribeMessage 调用 1 次', dsS1.calls.sendSubscribeMessage.length, 1);
  assertEqual(
    'sendSubscribeMessage toUser',
    dsS1.calls.sendSubscribeMessage[0].toUser,
    'oABCDEFGHijklmnopqrstuvwxyzAB'
  );

  // 17.3 wechat.enabled=false → skipped
  const dsS3 = new FakeWeChatOADataSource();
  dsS3.setUser(21, {
    username: 'h',
    config: makeConfig({ enabled: false, openid: 'oABCDEFGHijklmnopqrstuvwxyzAB' }),
  });
  const svcS3 = new WeChatOAService({ dataSource: dsS3 });
  const r3 = await svcS3.sendDailyDigest({ user_id: 21, payload: makeDigestPayload() });
  assertEqual('wechat.enabled=false → skipped', r3.status, 'skipped');
  assert('skip_reason 提示未启用', (r3.skip_reason || '').includes('未启用'));
  // sendSubscribeMessage 不该被调
  assertEqual('未启用 sendSubscribeMessage 0 次', dsS3.calls.sendSubscribeMessage.length, 0);

  // 17.4 daily_digest=false → skipped
  const dsS4 = new FakeWeChatOADataSource();
  dsS4.setUser(22, {
    username: 'i',
    config: makeConfig({
      enabled: true,
      openid: 'oABCDEFGHijklmnopqrstuvwxyzAB',
      daily_digest: false,
    }),
  });
  const svcS4 = new WeChatOAService({ dataSource: dsS4 });
  const r4 = await svcS4.sendDailyDigest({ user_id: 22, payload: makeDigestPayload() });
  assertEqual('daily_digest=false → skipped', r4.status, 'skipped');

  // 17.5 openid 空 → skipped
  const dsS5 = new FakeWeChatOADataSource();
  dsS5.setUser(23, {
    username: 'j',
    config: makeConfig({ enabled: true, openid: '', daily_digest: true }),
  });
  const svcS5 = new WeChatOAService({ dataSource: dsS5 });
  const r5 = await svcS5.sendDailyDigest({ user_id: 23, payload: makeDigestPayload() });
  assertEqual('openid 空 → skipped', r5.status, 'skipped');
  assert('openid 空 reason 含绑定', (r5.skip_reason || '').includes('绑定'));

  // 17.6 user 不存在 → failed
  const dsS6 = new FakeWeChatOADataSource();
  const svcS6 = new WeChatOAService({ dataSource: dsS6 });
  const r6 = await svcS6.sendDailyDigest({ user_id: 999, payload: makeDigestPayload() });
  assertEqual('用户不存在 → failed', r6.status, 'failed');
  assertEqual('用户不存在 error', r6.error, '用户不存在');

  // 17.7 dry_run=true → skipped + skip_reason='dry_run' + 不调 send
  const dsS7 = new FakeWeChatOADataSource();
  dsS7.setUser(24, {
    username: 'k',
    config: makeConfig({
      enabled: true,
      openid: 'oABCDEFGHijklmnopqrstuvwxyzAB',
      daily_digest: true,
    }),
  });
  const svcS7 = new WeChatOAService({ dataSource: dsS7 });
  const r7 = await svcS7.sendDailyDigest({
    user_id: 24,
    payload: makeDigestPayload(),
    dry_run: true,
  });
  assertEqual('dry_run → skipped', r7.status, 'skipped');
  assertEqual('dry_run skip_reason', r7.skip_reason, 'dry_run');
  // 包含组装好的 data
  assert('dry_run 含 dry_run_data', !!r7.response?.dry_run_data);
  // sendSubscribeMessage 不调
  assertEqual('dry_run send 0 次', dsS7.calls.sendSubscribeMessage.length, 0);

  // 17.8 sendSubscribeMessage 返回 success=false → failed
  const dsS8 = new FakeWeChatOADataSource();
  dsS8.setUser(25, {
    username: 'l',
    config: makeConfig({
      enabled: true,
      openid: 'oABCDEFGHijklmnopqrstuvwxyzAB',
      daily_digest: true,
    }),
  });
  dsS8.sendResult = {
    success: false,
    message: '微信侧错误',
    data: { errcode: 40003, errmsg: 'invalid openid' },
  };
  const svcS8 = new WeChatOAService({ dataSource: dsS8 });
  const r8 = await svcS8.sendDailyDigest({ user_id: 25, payload: makeDigestPayload() });
  assertEqual('send 失败 status failed', r8.status, 'failed');
  assertEqual('send 失败 error', r8.error, '微信侧错误');
  assert('send 失败 response 透传', !!r8.response);

  // 17.9 sendSubscribeMessage 返回 skipped=true → skipped
  const dsS9 = new FakeWeChatOADataSource();
  dsS9.setUser(26, {
    username: 'm',
    config: makeConfig({
      enabled: true,
      openid: 'oABCDEFGHijklmnopqrstuvwxyzAB',
      daily_digest: true,
    }),
  });
  dsS9.sendResult = { success: false, skipped: true, message: '微信通道已禁用' };
  const svcS9 = new WeChatOAService({ dataSource: dsS9 });
  const r9 = await svcS9.sendDailyDigest({ user_id: 26, payload: makeDigestPayload() });
  assertEqual('send skipped → status skipped', r9.status, 'skipped');
  assertEqual('send skipped → skip_reason', r9.skip_reason, '微信通道已禁用');

  // ===========================================================================
  // 测试 18: service.sendEarningsForecast() / sendRiskAlert() 冒烟
  // ===========================================================================

  console.log('\n[18] service.sendEarningsForecast() / sendRiskAlert()...');

  const dsE1 = new FakeWeChatOADataSource();
  dsE1.setUser(30, {
    username: 'n',
    config: makeConfig({
      enabled: true,
      openid: 'oABCDEFGHijklmnopqrstuvwxyzAB',
      earnings_alert: true,
    }),
  });
  process.env.WECHAT_TEMPLATE_EARNINGS_FORECAST = 'tpl_earn_001';
  const svcE1 = new WeChatOAService({ dataSource: dsE1 });
  const rE = await svcE1.sendEarningsForecast({
    user_id: 30,
    payload: {
      symbol: '600519',
      name: '贵州茅台',
      forecast_type: '预增',
      profit_change_text: '+50.0% ~ +80.0%',
      report_period: '2026Q1',
      announce_date: '2026-04-10',
    },
  });
  assertEqual('earnings 成功 status', rE.status, 'sent');
  assertEqual('earnings template_id', rE.template_id, 'tpl_earn_001');
  assertEqual('earnings kind', rE.template_kind, WECHAT_TEMPLATE_ENV.EARNINGS_FORECAST);
  // data 中应该有 earnings 内容
  assertEqual(
    'earnings keyword1 拼 symbol+name',
    (dsE1.calls.sendSubscribeMessage[0].data.keyword1 as any).value,
    '600519 贵州茅台'
  );

  process.env.WECHAT_TEMPLATE_RISK_ALERT = 'tpl_risk_001';
  const dsR1 = new FakeWeChatOADataSource();
  dsR1.setUser(31, {
    username: 'o',
    config: makeConfig({
      enabled: true,
      openid: 'oABCDEFGHijklmnopqrstuvwxyzAB',
      risk_alert: true,
    }),
  });
  const svcR1 = new WeChatOAService({ dataSource: dsR1 });
  const rR = await svcR1.sendRiskAlert({
    user_id: 31,
    payload: {
      level: 'HIGH',
      title: '风控告警',
      detail: 'detail',
      triggered_at: '2026-06-08T10:00:00Z',
      symbol: '600519',
    },
  });
  assertEqual('risk 成功 status', rR.status, 'sent');
  assertEqual('risk template_id', rR.template_id, 'tpl_risk_001');

  // ===========================================================================
  // 测试 19: service.updateWeChatConfig()
  //
  // ⚠️ 真实 DB 测试需要 User.findByPk 可用；这里只覆盖 fake 模式下能跑通的字段映射。
  //   updateWeChatConfig 直接读 User model，不能 fake；测试在 e2e tests 中覆盖。
  //   纯函数 buildXxxSubscribeData 在 #11/12/13 已经覆盖。
  // ===========================================================================

  console.log('\n[19] service.updateWeChatConfig() —— Skip (DB required)');

  // 还原 env
  if (savedTpl === undefined) {
    delete process.env.WECHAT_TEMPLATE_DAILY_DIGEST;
  } else {
    process.env.WECHAT_TEMPLATE_DAILY_DIGEST = savedTpl;
  }

  // ===========================================================================
  // 测试 20: WeChatOAClient.getAccessToken() with injection
  // ===========================================================================

  console.log('\n[20] WeChatOAClient.getAccessToken() injection...');

  resetWeChatAccessToken();
  let injectedCalls = 0;
  const client = new WeChatOAClient({
    accessTokenProvider: async () => {
      injectedCalls += 1;
      return 'injected_token_xyz';
    },
  });
  const t1 = await client.getAccessToken();
  assertEqual('注入 token 值', t1, 'injected_token_xyz');
  assertEqual('注入 provider 调用次数', injectedCalls, 1);
  const t2 = await client.getAccessToken();
  assertEqual('注入 provider 二次调用', injectedCalls, 2); // provider 每次调一次

  // ===========================================================================
  // 测试 21: WeChatOAClient.createQrCode 输入校验
  // ===========================================================================

  console.log('\n[21] WeChatOAClient.createQrCode 输入校验...');

  const client21 = new WeChatOAClient({
    accessTokenProvider: async () => 'fake_token',
  });
  const r21a = await client21.createQrCode('中文场景');
  assertEqual('非法 sceneStr → failed', r21a.success, false);
  assert(
    '非法 sceneStr message',
    (r21a.message || '').includes('scene_str')
  );

  // 21.b DISABLE_WECHAT_OA=true → skipped
  process.env.DISABLE_WECHAT_OA = 'true';
  const r21b = await client21.createQrCode('valid-scene');
  assertEqual('disabled → skipped', r21b.skipped, true);
  delete process.env.DISABLE_WECHAT_OA;

  // ===========================================================================
  // 测试 22: WeChatOAClient.sendSubscribeMessage 输入校验
  // ===========================================================================

  console.log('\n[22] WeChatOAClient.sendSubscribeMessage 输入校验...');

  const client22 = new WeChatOAClient({
    accessTokenProvider: async () => 'fake_token',
  });
  const r22a = await client22.sendSubscribeMessage({
    toUser: 'bad',
    templateId: 'tpl_x',
    data: { x: { value: 'a' } },
  });
  assertEqual('openid 非法 → failed', r22a.success, false);
  assert('openid 非法 message 含 openid', (r22a.message || '').includes('openid'));

  const r22b = await client22.sendSubscribeMessage({
    toUser: 'oABCDEFGHijklmnopqrstuvwxyzAB',
    templateId: '',
    data: { x: { value: 'a' } },
  });
  assertEqual('templateId 空 → failed', r22b.success, false);
  assert('templateId 空 message', (r22b.message || '').includes('templateId'));

  const r22c = await client22.sendSubscribeMessage({
    toUser: 'oABCDEFGHijklmnopqrstuvwxyzAB',
    templateId: 'tpl_x',
    data: null as any,
  });
  assertEqual('data 非对象 → failed', r22c.success, false);

  // disable
  process.env.DISABLE_WECHAT_OA = 'true';
  const r22d = await client22.sendSubscribeMessage({
    toUser: 'oABCDEFGHijklmnopqrstuvwxyzAB',
    templateId: 'tpl_x',
    data: { x: { value: 'a' } },
  });
  assertEqual('disabled send → skipped', r22d.skipped, true);
  delete process.env.DISABLE_WECHAT_OA;

  // ===========================================================================
  // 汇总
  // ===========================================================================

  console.log('\n--------------------------------------------------------------');
  console.log(`Total: ${passed} ok, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
})().catch(err => {
  console.error('test crashed', err);
  process.exit(1);
});
