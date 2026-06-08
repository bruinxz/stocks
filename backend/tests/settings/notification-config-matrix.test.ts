/**
 * US-080 — 推送渠道矩阵视图纯函数单测。
 *
 * 不依赖 jest / DB；node 直接跑：
 *   cd backend && npx ts-node --transpile-only tests/settings/notification-config-matrix.test.ts
 *
 * 覆盖：
 *   - applicable 矩阵的业务约束（weekly_review 只 email / risk_alert 4 通道全开 / sms 仅 risk_alert）
 *   - buildMatrixView 把 NotificationChannelsConfig 投影到 4×4 矩阵
 *   - cell.enabled = channel.enabled && channel.<event_field>（任一关掉则 cell 关）
 *   - matrixUpdatesToConfigPatch 把矩阵格反向 patch 翻译回 channel.<field>
 *   - 非 applicable 矩阵格静默忽略（不污染 patch）
 *   - 非 boolean 值静默忽略（前端误传 string 不破坏 patch）
 *   - 顶部 channels 字段（webhook_url / address / openid）正确投影
 */

import {
  NOTIFICATION_APPLICABLE_MATRIX,
  buildMatrixView,
  matrixUpdatesToConfigPatch,
} from '../../src/api/controllers/SettingsController';
import {
  DEFAULT_NOTIFICATION_CONFIG,
  NotificationChannelsConfig,
} from '../../src/services/DailyTradingDigestService';

let failed = 0;

function assert(name: string, cond: boolean, detail = '') {
  if (cond) {
    console.log(`  ok  ${name}${detail ? ` (${detail})` : ''}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}${detail ? ` (${detail})` : ''}`);
  }
}

function expectEqual<T>(name: string, actual: T, expected: T, detail = '') {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  assert(name, same, detail || `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ----- T1: applicable 矩阵的业务约束 ---------------------------------------
console.log('T1 — APPLICABLE_MATRIX 业务约束');
{
  // weekly_review 只 email，其他 3 个通道不支持
  assert(
    'weekly_review.feishu=false',
    NOTIFICATION_APPLICABLE_MATRIX.weekly_review.feishu === false
  );
  assert('weekly_review.email=true', NOTIFICATION_APPLICABLE_MATRIX.weekly_review.email === true);
  assert(
    'weekly_review.wechat=false',
    NOTIFICATION_APPLICABLE_MATRIX.weekly_review.wechat === false
  );
  assert('weekly_review.sms=false', NOTIFICATION_APPLICABLE_MATRIX.weekly_review.sms === false);

  // risk_alert 4 通道全开（实时分发是 multi-pipe）
  assert('risk_alert.feishu=true', NOTIFICATION_APPLICABLE_MATRIX.risk_alert.feishu === true);
  assert('risk_alert.email=true', NOTIFICATION_APPLICABLE_MATRIX.risk_alert.email === true);
  assert('risk_alert.wechat=true', NOTIFICATION_APPLICABLE_MATRIX.risk_alert.wechat === true);
  assert('risk_alert.sms=true', NOTIFICATION_APPLICABLE_MATRIX.risk_alert.sms === true);

  // daily_digest / earnings_alert 在 email/sms 关闭（成本+轰炸控制）
  assert(
    'daily_digest.email=false',
    NOTIFICATION_APPLICABLE_MATRIX.daily_digest.email === false
  );
  assert('daily_digest.sms=false', NOTIFICATION_APPLICABLE_MATRIX.daily_digest.sms === false);
  assert(
    'earnings_alert.email=false',
    NOTIFICATION_APPLICABLE_MATRIX.earnings_alert.email === false
  );
  assert('earnings_alert.sms=false', NOTIFICATION_APPLICABLE_MATRIX.earnings_alert.sms === false);
}

// ----- T2: buildMatrixView 基本投影 (default config) -----------------------
console.log('T2 — buildMatrixView default config');
{
  const view = buildMatrixView(DEFAULT_NOTIFICATION_CONFIG);
  // 顶部 channels 字段
  expectEqual('channels.feishu.enabled', view.channels.feishu.enabled, true);
  expectEqual('channels.feishu.webhook_url', view.channels.feishu.webhook_url, '');
  expectEqual('channels.feishu.configured', view.channels.feishu.configured, false);
  expectEqual('channels.email.enabled', view.channels.email.enabled, false);
  expectEqual('channels.wechat.bound', view.channels.wechat.bound, false);
  expectEqual('channels.sms.enabled', view.channels.sms.enabled, false);

  // applicable 矩阵格状态：default feishu.enabled=true + daily_digest=true → cell.enabled=true
  expectEqual('matrix.daily_digest.feishu.applicable', view.matrix.daily_digest.feishu.applicable, true);
  expectEqual('matrix.daily_digest.feishu.enabled', view.matrix.daily_digest.feishu.enabled, true);
  // 非 applicable 格：daily_digest.email
  expectEqual(
    'matrix.daily_digest.email.applicable',
    view.matrix.daily_digest.email.applicable,
    false
  );
  expectEqual('matrix.daily_digest.email.enabled', view.matrix.daily_digest.email.enabled, false);

  // wechat 通道默认 enabled=false，cell.enabled 必须为 false 即便 daily_digest 子开关勾过
  expectEqual('matrix.daily_digest.wechat.enabled', view.matrix.daily_digest.wechat.enabled, false);

  // weekly_review 行：只 email applicable，其他 3 通道为 not applicable
  expectEqual(
    'matrix.weekly_review.email.applicable',
    view.matrix.weekly_review.email.applicable,
    true
  );
  expectEqual(
    'matrix.weekly_review.feishu.applicable',
    view.matrix.weekly_review.feishu.applicable,
    false
  );
}

// ----- T3: cell.enabled = channel.enabled && channel.<event_field> --------
console.log('T3 — cell.enabled 联合开关');
{
  // channel.enabled=true + field=true → cell.enabled=true
  const cfg1: NotificationChannelsConfig = {
    feishu: {
      enabled: true,
      webhook_url: 'https://example.com',
      daily_digest: true,
      earnings_alert: false,
      risk_alert: false,
    },
    email: { enabled: false, address: '', weekly_review: true, risk_alert: false },
    wechat: {
      enabled: false,
      openid: '',
      bind_scene_str: '',
      bound_at: '',
      daily_digest: false,
      earnings_alert: false,
      risk_alert: false,
    },
    sms: { enabled: false, phone: '', risk_alert: false },
  };
  const v1 = buildMatrixView(cfg1);
  expectEqual('feishu daily_digest cell', v1.matrix.daily_digest.feishu.enabled, true);
  // channel.enabled=false + field=true → cell.enabled=false (channel.enabled 锁住)
  expectEqual('email weekly_review cell (channel off)', v1.matrix.weekly_review.email.enabled, false);
  // feishu earnings_alert: enabled=true + field=false → cell=false
  expectEqual('feishu earnings_alert cell (field off)', v1.matrix.earnings_alert.feishu.enabled, false);
  // configured 字段
  expectEqual('feishu.configured', v1.channels.feishu.configured, true);
  expectEqual('email.configured (空 address)', v1.channels.email.configured, false);
}

// ----- T4: matrixUpdatesToConfigPatch 把矩阵反向翻译 -----------------------
console.log('T4 — matrixUpdatesToConfigPatch');
{
  const patch = matrixUpdatesToConfigPatch({
    daily_digest: { feishu: false, wechat: true },
    risk_alert: { feishu: true, email: true, wechat: true, sms: false },
  });
  // 期望 patch.feishu.daily_digest=false / feishu.risk_alert=true
  expectEqual('patch.feishu.daily_digest', (patch as any).feishu?.daily_digest, false);
  expectEqual('patch.feishu.risk_alert', (patch as any).feishu?.risk_alert, true);
  // patch.wechat.daily_digest=true / wechat.risk_alert=true
  expectEqual('patch.wechat.daily_digest', (patch as any).wechat?.daily_digest, true);
  expectEqual('patch.wechat.risk_alert', (patch as any).wechat?.risk_alert, true);
  // sms.risk_alert=false (sms 唯一 applicable 字段)
  expectEqual('patch.sms.risk_alert', (patch as any).sms?.risk_alert, false);
  // email.risk_alert=true
  expectEqual('patch.email.risk_alert', (patch as any).email?.risk_alert, true);
}

// ----- T5: 非 applicable 矩阵格 + 非 boolean 值静默忽略 -------------------
console.log('T5 — 非 applicable / 非 boolean 静默忽略');
{
  const patch = matrixUpdatesToConfigPatch({
    // daily_digest.email + daily_digest.sms 非 applicable，应忽略
    daily_digest: { feishu: true, email: true, sms: true, wechat: false },
    // weekly_review.feishu / weekly_review.sms 非 applicable
    weekly_review: { email: true, feishu: true, sms: true },
    // earnings_alert.feishu 接受字符串 'true' —— 应静默忽略
    earnings_alert: { feishu: 'true', wechat: false } as any,
    // 整行非对象，应跳过
    risk_alert: 'oops' as any,
  });
  // daily_digest: 只 feishu/wechat applicable
  expectEqual('daily_digest.feishu got', (patch as any).feishu?.daily_digest, true);
  expectEqual('daily_digest.wechat got', (patch as any).wechat?.daily_digest, false);
  // email.daily_digest 不应该出现在 patch 里
  assert(
    'email.daily_digest 被忽略',
    (patch as any).email?.daily_digest === undefined
  );
  // sms.daily_digest 被忽略
  assert('sms.daily_digest 被忽略', (patch as any).sms?.daily_digest === undefined);
  // weekly_review.email applicable
  expectEqual('weekly_review.email', (patch as any).email?.weekly_review, true);
  // weekly_review.feishu / .sms 应被忽略
  assert('weekly_review.feishu 被忽略', (patch as any).feishu?.weekly_review === undefined);
  // earnings_alert.feishu = 'true' (string) 被忽略
  assert('earnings_alert.feishu string 被忽略', (patch as any).feishu?.earnings_alert === undefined);
  // earnings_alert.wechat 正常应用
  expectEqual('earnings_alert.wechat', (patch as any).wechat?.earnings_alert, false);
  // risk_alert 行非对象 → 不应该出现任何 risk_alert 字段
  assert(
    'risk_alert 整行非对象被忽略',
    (patch as any).feishu?.risk_alert === undefined &&
      (patch as any).email?.risk_alert === undefined &&
      (patch as any).sms?.risk_alert === undefined
  );
}

// ----- T6: 空 patch 容错 ---------------------------------------------------
console.log('T6 — 空 / 非法 patch 容错');
{
  expectEqual('null', matrixUpdatesToConfigPatch(null), {});
  expectEqual('undefined', matrixUpdatesToConfigPatch(undefined), {});
  expectEqual('string', matrixUpdatesToConfigPatch('oops'), {});
  expectEqual('空对象', matrixUpdatesToConfigPatch({}), {});
  expectEqual(
    '未知 event key 被忽略',
    matrixUpdatesToConfigPatch({ unknown_event: { feishu: true } }),
    {}
  );
}

// ----- T7: buildMatrixView 处理 wechat bound 状态 -------------------------
console.log('T7 — wechat bound 状态');
{
  const cfg: NotificationChannelsConfig = {
    feishu: {
      enabled: true,
      webhook_url: '',
      daily_digest: false,
      earnings_alert: false,
      risk_alert: false,
    },
    email: { enabled: false, address: '', weekly_review: false, risk_alert: false },
    wechat: {
      enabled: true,
      openid: 'oABCD123',
      bind_scene_str: 'bind-1-abc',
      bound_at: '2026-06-08T10:00:00Z',
      daily_digest: true,
      earnings_alert: true,
      risk_alert: false,
    },
    sms: { enabled: true, phone: '13800138000', risk_alert: true },
  };
  const v = buildMatrixView(cfg);
  expectEqual('wechat.bound=true (有 openid)', v.channels.wechat.bound, true);
  expectEqual('wechat.openid', v.channels.wechat.openid, 'oABCD123');
  expectEqual('wechat.bound_at', v.channels.wechat.bound_at, '2026-06-08T10:00:00Z');
  expectEqual('wechat 启用 + daily_digest 启用 → cell=true', v.matrix.daily_digest.wechat.enabled, true);
  expectEqual('sms.configured=true', v.channels.sms.configured, true);
  expectEqual('sms risk_alert cell=true', v.matrix.risk_alert.sms.enabled, true);
}

// ----- summary -------------------------------------------------------------
if (failed > 0) {
  console.error(`\n❌ ${failed} test(s) failed`);
  process.exit(1);
} else {
  console.log('\n✅ all tests passed');
}
