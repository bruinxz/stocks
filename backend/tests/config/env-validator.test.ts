/**
 * EnvValidator 单元测试 (US-068 运维：环境一致性脚本与 .env 验证)
 *
 * 不依赖 jest；node 直接跑:
 *   cd backend && npx ts-node --transpile-only tests/config/env-validator.test.ts
 *
 * 完全脱离真实 process.env：注入 fake env 对象。
 *
 * 覆盖维度：
 *   - 常量冻结 (PLACEHOLDER_VALUES / 4 个 channel group)
 *   - 纯函数:
 *     - isPlaceholderValue (字符串 / 数字 / null / 空串 / 全部 PLACEHOLDER_VALUES / 大小写不敏感)
 *     - detectPartialChannelGroup (全空 / 全填 / 部分填 / 空字符串视为空)
 *     - mapJoiErrorsToValidationErrors (空 / required / format / 多种 type)
 *     - formatErrorReport (ok=true / 多 errors)
 *     - formatWarningReport (empty / 多 warnings)
 *   - validateEnv e2e:
 *     - 完整 env → ok=true
 *     - 缺 DB_HOST → ok=false + errors 含 DB_HOST required
 *     - 缺 JWT_SECRET → required error
 *     - JWT_SECRET 是占位符 production → error / development → warning
 *     - JWT_SECRET 短于 32 production → error / development → ok
 *     - SMTP_HOST 填了但 SMTP_USER/PASS 空 → error (部分配置)
 *     - SMTP 全空 + production → warning (channel 不可用)
 *     - SMTP 全空 + development → no warning
 *     - FEISHU 部分填写 → error
 *     - WECHAT 部分填写 → error
 *     - ALIYUN_SMS 部分填写 → error
 *     - 端口非法 (PORT=99999) → invalid_format error
 *     - DB_PORT 非数字 → invalid_format
 *     - NODE_ENV 默认 'development'
 *     - PORT 默认 3000 / DB_PORT 默认 5432 / REDIS_PORT 默认 6379
 *     - 未知 env 字段不报 error (允许 unknown)
 *   - shouldExitOnFailure:
 *     - ok=true → false
 *     - ok=false + production → true
 *     - ok=false + development → false
 *     - ok=false + test → false
 */

import {
  validateEnv,
  isPlaceholderValue,
  detectPartialChannelGroup,
  mapJoiErrorsToValidationErrors,
  formatErrorReport,
  formatWarningReport,
  shouldExitOnFailure,
  PLACEHOLDER_VALUES,
  SMTP_REQUIRED_GROUP,
  WECHAT_REQUIRED_GROUP,
  ALIYUN_SMS_REQUIRED_GROUP,
  REPLAY_REQUIRED_GROUP,
  REPLAY_OPERATIONAL_REQUIRED_GROUP,
  EnvValidationResult,
} from '../../src/config/EnvValidator';
import Joi from 'joi';
import { secretFingerprint } from '../../src/security/leakedSecretFingerprints';

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

function replayDisclaimer(language: string, fullText: string) {
  return {
    version: '1.0.0',
    short_text: fullText,
    full_text: fullText,
    language,
    effective_at: '2026-01-01T00:00:00Z',
    hash: secretFingerprint(fullText),
  };
}

const VALID_REPLAY_DISCLAIMERS = JSON.stringify({
  'zh-CN': replayDisclaimer('zh-CN', '仅供研究参考'),
  'ja-JP': replayDisclaimer('ja-JP', '調査目的のみ'),
  'ko-KR': replayDisclaimer('ko-KR', '연구 목적 전용'),
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeValidEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const base: Record<string, string> = {
    NODE_ENV: 'development',
    PORT: '3000',
    HOST: '0.0.0.0',
    DB_HOST: 'localhost',
    DB_PORT: '5432',
    DB_NAME: 'stock_backtest',
    DB_USER: 'postgres',
    DB_PASSWORD: 'postgres',
    REDIS_HOST: 'localhost',
    REDIS_PORT: '6379',
    JWT_SECRET: 'a-real-secret-key-not-a-placeholder',
    JWT_REFRESH_SECRET: 'a-real-refresh-secret-not-placeholder',
    ENABLE_SECURE_COOKIE: 'true',
    STOCKS_REPLAY_RUNTIME_DIR: '/var/lib/stocks/replay-test',
    DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/stock_backtest',
    STOCKS_REPLAY_MODEL_VERSION: '1.0.0',
    STOCKS_REPLAY_TEMPLATE_HASH: 'b'.repeat(64),
    STOCKS_REPLAY_DISCLAIMERS_JSON: VALID_REPLAY_DISCLAIMERS,
    STOCKS_REPLAY_WORKER_DEADLINE_SECONDS: '120',
    STOCKS_REPLAY_LEASE_SECONDS: '150',
    STOCKS_REPLAY_MAX_CONCURRENCY: '2',
    STOCKS_REPLAY_MAX_QUEUE_DEPTH: '32',
    STOCKS_REPLAY_SUBMIT_RATE_PER_MINUTE: '10',
    STOCKS_REPLAY_STATUS_RATE_PER_MINUTE: '120',
    STOCKS_REPLAY_RATE_MAX_USERS: '10000',
  };
  const merged: Record<string, string | undefined> = { ...base };
  for (const k of Object.keys(overrides)) {
    if (overrides[k] === undefined) {
      delete merged[k];
    } else {
      merged[k] = overrides[k];
    }
  }
  return merged as NodeJS.ProcessEnv;
}

// ===========================================================================
// Test entrypoint
// ===========================================================================

console.log('[1] 常量冻结...');
assert('PLACEHOLDER_VALUES frozen', Object.isFrozen(PLACEHOLDER_VALUES));
assert('SMTP_REQUIRED_GROUP frozen', Object.isFrozen(SMTP_REQUIRED_GROUP));
assert('WECHAT_REQUIRED_GROUP frozen', Object.isFrozen(WECHAT_REQUIRED_GROUP));
assert('ALIYUN_SMS_REQUIRED_GROUP frozen', Object.isFrozen(ALIYUN_SMS_REQUIRED_GROUP));
assert('REPLAY_REQUIRED_GROUP frozen', Object.isFrozen(REPLAY_REQUIRED_GROUP));
assert(
  'REPLAY_OPERATIONAL_REQUIRED_GROUP frozen',
  Object.isFrozen(REPLAY_OPERATIONAL_REQUIRED_GROUP)
);
assert('PLACEHOLDER_VALUES 含 change-me', PLACEHOLDER_VALUES.includes('change-me'));
assert('PLACEHOLDER_VALUES 含 TODO', PLACEHOLDER_VALUES.includes('TODO'));

console.log('\n[2] isPlaceholderValue 纯函数...');
const syntheticLeakedPlaceholder = 'synthetic-leaked-placeholder-for-fingerprint-test';
const syntheticPlaceholderFingerprints = new Set([
  secretFingerprint(syntheticLeakedPlaceholder),
]);
assertEqual(
  '泄漏指纹按精确值识别',
  isPlaceholderValue(syntheticLeakedPlaceholder, syntheticPlaceholderFingerprints),
  true
);
assertEqual('占位符大小写不敏感', isPlaceholderValue('todo'), true);
assertEqual('占位符 trim', isPlaceholderValue('  change-me  '), true);
assertEqual('真实值', isPlaceholderValue('real-secret-123'), false);
assertEqual('空串非占位符', isPlaceholderValue(''), false);
assertEqual('undefined 非占位符', isPlaceholderValue(undefined), false);
assertEqual('null 非占位符', isPlaceholderValue(null), false);
assertEqual('数字非占位符', isPlaceholderValue(123), false);
assertEqual('TODO 占位符', isPlaceholderValue('TODO'), true);
assertEqual('change-me 占位符', isPlaceholderValue('change-me'), true);

console.log('\n[3] detectPartialChannelGroup...');
assertEqual('全空', detectPartialChannelGroup({}, SMTP_REQUIRED_GROUP), []);
assertEqual(
  '全填',
  detectPartialChannelGroup(
    { SMTP_HOST: 'h', SMTP_USER: 'u', SMTP_PASS: 'p' },
    SMTP_REQUIRED_GROUP
  ),
  []
);
assertEqual('只填 HOST', detectPartialChannelGroup({ SMTP_HOST: 'h' }, SMTP_REQUIRED_GROUP), [
  'SMTP_USER',
  'SMTP_PASS',
]);
assertEqual(
  '填 HOST + USER 缺 PASS',
  detectPartialChannelGroup({ SMTP_HOST: 'h', SMTP_USER: 'u' }, SMTP_REQUIRED_GROUP),
  ['SMTP_PASS']
);
assertEqual(
  '空字符串视为空',
  detectPartialChannelGroup({ SMTP_HOST: '', SMTP_USER: '   ' }, SMTP_REQUIRED_GROUP),
  []
);
assertEqual(
  '部分空字符串部分有值',
  detectPartialChannelGroup({ SMTP_HOST: 'h', SMTP_USER: '', SMTP_PASS: 'p' }, SMTP_REQUIRED_GROUP),
  ['SMTP_USER']
);

console.log('\n[4] mapJoiErrorsToValidationErrors...');
assertEqual('undefined 返回空数组', mapJoiErrorsToValidationErrors(undefined), []);
const requiredErr = Joi.object({ X: Joi.string().required() }).validate({}).error!;
const mappedReq = mapJoiErrorsToValidationErrors(requiredErr);
assertEqual('required 1 个', mappedReq.length, 1);
assertEqual('required category', mappedReq[0].category, 'required');
assertEqual('required field', mappedReq[0].field, 'X');

const formatErr = Joi.object({ N: Joi.number().integer().required() }).validate({ N: 'abc' })
  .error!;
const mappedFmt = mapJoiErrorsToValidationErrors(formatErr);
assertEqual('invalid_format category', mappedFmt[0].category, 'invalid_format');

const uriErr = Joi.object({ U: Joi.string().uri().required() }).validate({ U: 'not-a-url' }).error!;
const mappedUri = mapJoiErrorsToValidationErrors(uriErr);
assertEqual('uri 是 invalid_format', mappedUri[0].category, 'invalid_format');

console.log('\n[5] formatErrorReport / formatWarningReport...');
const okResult: EnvValidationResult = {
  ok: true,
  errors: [],
  warnings: [],
  validated: {},
  node_env: 'development',
};
assertEqual('ok report', formatErrorReport(okResult), 'Environment validation passed');
const errResult: EnvValidationResult = {
  ok: false,
  errors: [{ field: 'DB_HOST', message: 'is required', category: 'required' }],
  warnings: [],
  validated: {},
  node_env: 'production',
};
assert('error report 含 FAILED', formatErrorReport(errResult).includes('FAILED'));
assert('error report 含 DB_HOST', formatErrorReport(errResult).includes('DB_HOST'));
assert('error report 含 category', formatErrorReport(errResult).includes('[required]'));

const warnResult: EnvValidationResult = {
  ok: true,
  errors: [],
  warnings: [{ field: 'JWT_SECRET', message: 'placeholder', category: 'placeholder_value' }],
  validated: {},
  node_env: 'development',
};
assert('warning report 非空', formatWarningReport(warnResult).length > 0);
assert('warning report 含 JWT_SECRET', formatWarningReport(warnResult).includes('JWT_SECRET'));
assertEqual('空 warning empty string', formatWarningReport(okResult), '');

console.log('\n[6] validateEnv e2e 完整 env...');
const r6 = validateEnv(makeValidEnv());
assertEqual('完整 env ok', r6.ok, true);
assertEqual('完整 env 0 errors', r6.errors.length, 0);
assertEqual('node_env 默认 development', r6.node_env, 'development');
assert('validated 含 DB_HOST', r6.validated.DB_HOST === 'localhost');

console.log('\n[7] validateEnv 缺必填...');
const r7 = validateEnv(makeValidEnv({ DB_HOST: undefined }));
assertEqual('缺 DB_HOST → ok=false', r7.ok, false);
assert(
  'errors 含 DB_HOST',
  r7.errors.some(e => e.field === 'DB_HOST')
);
assert(
  'DB_HOST is required',
  r7.errors.some(e => e.field === 'DB_HOST' && e.category === 'required')
);

const r7b = validateEnv(makeValidEnv({ JWT_SECRET: undefined }));
assertEqual('缺 JWT_SECRET → ok=false', r7b.ok, false);
assert(
  'errors 含 JWT_SECRET',
  r7b.errors.some(e => e.field === 'JWT_SECRET')
);

const r7bRefresh = validateEnv(
  makeValidEnv({
    NODE_ENV: 'production',
    JWT_SECRET: 'a'.repeat(40),
    JWT_REFRESH_SECRET: undefined,
  })
);
assertEqual('production 缺 JWT_REFRESH_SECRET → ok=false', r7bRefresh.ok, false);
assert(
  'errors 含 JWT_REFRESH_SECRET',
  r7bRefresh.errors.some(e => e.field === 'JWT_REFRESH_SECRET')
);

const r7d = validateEnv(makeValidEnv({ REDIS_HOST: undefined }));
assertEqual('缺 REDIS_HOST → ok=false', r7d.ok, false);

const r7e = validateEnv(makeValidEnv({ STOCKS_REPLAY_MODEL_VERSION: undefined }));
assertEqual('durable replay 部分配置 → ok=false', r7e.ok, false);
assert(
  'replay errors 含缺失版本',
  r7e.errors.some(e => e.field.includes('STOCKS_REPLAY_MODEL_VERSION'))
);

const replayEmpty = Object.fromEntries(REPLAY_REQUIRED_GROUP.map(field => [field, undefined]));
const r7f = validateEnv(
  makeValidEnv({
    NODE_ENV: 'production',
    JWT_SECRET: 'p'.repeat(40),
    ...replayEmpty,
  })
);
assertEqual('production durable replay 全空 → ok=false', r7f.ok, false);
assert(
  'production replay missing is production_required',
  r7f.errors.some(e => e.category === 'production_required' && e.message.includes('replay'))
);

const r7g = validateEnv(makeValidEnv({ STOCKS_REPLAY_DISCLAIMERS_JSON: 'not-json' }));
assertEqual('replay disclaimer 非 JSON → ok=false', r7g.ok, false);
const invalidReplayDisclaimers = JSON.parse(VALID_REPLAY_DISCLAIMERS);
invalidReplayDisclaimers['ja-JP'].language = 'zh-CN';
const r7g2 = validateEnv(
  makeValidEnv({ STOCKS_REPLAY_DISCLAIMERS_JSON: JSON.stringify(invalidReplayDisclaimers) })
);
assertEqual('replay disclaimer locale 内容不匹配 → ok=false', r7g2.ok, false);
const badHashReplayDisclaimers = JSON.parse(VALID_REPLAY_DISCLAIMERS);
badHashReplayDisclaimers['ko-KR'].hash = '0'.repeat(64);
const r7g3 = validateEnv(
  makeValidEnv({ STOCKS_REPLAY_DISCLAIMERS_JSON: JSON.stringify(badHashReplayDisclaimers) })
);
assertEqual('replay disclaimer 正文 hash 不匹配 → ok=false', r7g3.ok, false);

const r7h = validateEnv(
  makeValidEnv({
    NODE_ENV: 'production',
    JWT_SECRET: 'p'.repeat(40),
    STOCKS_REPLAY_MAX_CONCURRENCY: undefined,
  })
);
assertEqual('production 缺 replay 运行上限 → ok=false', r7h.ok, false);
assert(
  'production replay 运行上限必须显式配置',
  r7h.errors.some(
    e =>
      e.category === 'production_required' && e.field.includes('STOCKS_REPLAY_MAX_CONCURRENCY')
  )
);

const r7i = validateEnv(
  makeValidEnv({
    STOCKS_REPLAY_WORKER_DEADLINE_SECONDS: '120',
    STOCKS_REPLAY_LEASE_SECONDS: '124',
  })
);
assertEqual('replay lease 缺少 5 秒恢复余量 → ok=false', r7i.ok, false);

const r7j = validateEnv(
  makeValidEnv({
    STOCKS_REPLAY_WORKER_DEADLINE_SECONDS: '120',
    STOCKS_REPLAY_LEASE_SECONDS: '125',
  })
);
assertEqual('replay lease 恰有 5 秒恢复余量 → ok=true', r7j.ok, true);

const replayOperationalEmpty = Object.fromEntries(
  REPLAY_OPERATIONAL_REQUIRED_GROUP.map(field => [field, undefined])
);
const r7k = validateEnv(makeValidEnv(replayOperationalEmpty));
assertEqual('development 可使用 replay 运行上限默认值', r7k.ok, true);
assertEqual('默认 worker deadline', r7k.validated.STOCKS_REPLAY_WORKER_DEADLINE_SECONDS, 120);
assertEqual('默认 lease', r7k.validated.STOCKS_REPLAY_LEASE_SECONDS, 150);

const r7l = validateEnv(makeValidEnv({ STOCKS_REPLAY_MAX_CONCURRENCY: '17' }));
assertEqual('replay concurrency 超过安全上限 → ok=false', r7l.ok, false);

console.log('\n[8] 占位符值: production = error, development = warning...');
const r8prod = validateEnv(
  makeValidEnv({
    NODE_ENV: 'production',
    JWT_SECRET: 'change-me',
  })
);
// production 模式 + 占位符 + 长度不够 32 → 至少 1 个 error
assertEqual('production 占位符 → ok=false', r8prod.ok, false);
assert(
  'production 占位符触发 production_required',
  r8prod.errors.some(e => e.field === 'JWT_SECRET' && e.category === 'production_required')
);
assert(
  'production 占位符错误不回显原值',
  !JSON.stringify(r8prod.errors).includes('change-me')
);

const r8dev = validateEnv(
  makeValidEnv({
    NODE_ENV: 'development',
    JWT_SECRET: 'change-me',
  })
);
assertEqual('development 占位符 ok=true', r8dev.ok, true);
assert(
  'development 占位符 → warning',
  r8dev.warnings.some(w => w.field === 'JWT_SECRET' && w.category === 'placeholder_value')
);
assert(
  'development 占位符告警不回显原值',
  !JSON.stringify(r8dev.warnings).includes('change-me')
);

console.log('\n[9] JWT_SECRET 短于 32 production → error...');
const r9prod = validateEnv(
  makeValidEnv({
    NODE_ENV: 'production',
    JWT_SECRET: 'short-secret-12345', // 18 字符 < 32
  })
);
assertEqual('production 短 JWT_SECRET → ok=false', r9prod.ok, false);
assert(
  'JWT_SECRET 短 production_required error',
  r9prod.errors.some(
    e =>
      e.field === 'JWT_SECRET' && e.category === 'production_required' && e.message.includes('32')
  )
);
// development 容忍
const r9dev = validateEnv(makeValidEnv({ NODE_ENV: 'development', JWT_SECRET: 'short-key-123' }));
assertEqual('development 短 JWT_SECRET ok', r9dev.ok, true);

console.log('\n[9b] JWT secret 分域 + production Secure cookie...');
const sharedJwtSecret = 'two-token-classes-must-not-share-this-secret';
const r9bShared = validateEnv(
  makeValidEnv({
    JWT_SECRET: sharedJwtSecret,
    JWT_REFRESH_SECRET: sharedJwtSecret,
  })
);
assertEqual('access/refresh secret 相同 → ok=false', r9bShared.ok, false);
assert(
  'secret 相同触发 invalid_format',
  r9bShared.errors.some(
    e => e.field.includes('JWT_SECRET') && e.field.includes('JWT_REFRESH_SECRET')
  )
);

const r9bProdCookie = validateEnv(
  makeValidEnv({ NODE_ENV: 'production', ENABLE_SECURE_COOKIE: 'false' })
);
assertEqual('production Secure cookie=false → ok=false', r9bProdCookie.ok, false);
assert(
  'production Secure cookie error',
  r9bProdCookie.errors.some(
    e => e.field === 'ENABLE_SECURE_COOKIE' && e.category === 'production_required'
  )
);

const r9bDevCookie = validateEnv(
  makeValidEnv({ NODE_ENV: 'development', ENABLE_SECURE_COOKIE: 'false' })
);
assertEqual('development 可显式 Secure cookie=false', r9bDevCookie.ok, true);

console.log('\n[10] SMTP 部分填写...');
const r10 = validateEnv(
  makeValidEnv({
    SMTP_HOST: 'smtp.example.com',
    // SMTP_USER, SMTP_PASS 缺
  })
);
assertEqual('SMTP 部分填写 → ok=false', r10.ok, false);
assert(
  'errors 提及 SMTP_USER + SMTP_PASS',
  r10.errors.some(
    e => e.field.includes('SMTP_USER') && e.field.includes('SMTP_PASS') && e.category === 'required'
  )
);
assert(
  'errors 解释信息含 部分配置',
  r10.errors.some(e => e.message.includes('部分'))
);

console.log('\n[11] 废弃 Feishu Open Platform 配置剥离...');
const r11 = validateEnv(
  makeValidEnv({
    FEISHU_APP_ID: 'cli_xxx',
    FEISHU_APP_SECRET: 'legacy_secret',
    FEISHU_BITABLE_APP_TOKEN: 'legacy_token',
  })
);
assertEqual('废弃 Feishu 配置不再触发部分填写错误', r11.ok, true);
assert('FEISHU_APP_ID 从 validated 剥离', !('FEISHU_APP_ID' in r11.validated));
assert('FEISHU_APP_SECRET 从 validated 剥离', !('FEISHU_APP_SECRET' in r11.validated));
assert('FEISHU_BITABLE_APP_TOKEN 从 validated 剥离', !('FEISHU_BITABLE_APP_TOKEN' in r11.validated));

console.log('\n[12] WECHAT 部分填写...');
const r12 = validateEnv(
  makeValidEnv({
    WECHAT_APP_ID: 'wx_xxx',
  })
);
assertEqual('WECHAT 部分填写 → ok=false', r12.ok, false);
assert(
  'errors 提及 WECHAT_APP_SECRET',
  r12.errors.some(e => e.field.includes('WECHAT_APP_SECRET'))
);

console.log('\n[13] ALIYUN_SMS 部分填写...');
const r13 = validateEnv(
  makeValidEnv({
    ALIYUN_SMS_ACCESS_KEY_ID: 'AK_XXX',
  })
);
assertEqual('ALIYUN_SMS 部分填写 → ok=false', r13.ok, false);
assert(
  'errors 提及 ALIYUN_SMS_ACCESS_KEY_SECRET',
  r13.errors.some(e => e.field.includes('ALIYUN_SMS_ACCESS_KEY_SECRET'))
);

console.log('\n[14] SMTP 全空 + production → warning (不阻塞)...');
const r14prod = validateEnv(makeValidEnv({ NODE_ENV: 'production', JWT_SECRET: 'a'.repeat(40) }));
assertEqual('SMTP 全空 production ok=true', r14prod.ok, true);
assert(
  'SMTP 全空 production warning',
  r14prod.warnings.some(w => w.message.includes('SMTP') && w.category === 'optional_missing')
);

console.log('\n[15] SMTP 全空 + development → no warning (不啰嗦)...');
const r15dev = validateEnv(makeValidEnv({ NODE_ENV: 'development' }));
assertEqual('SMTP 全空 development ok=true', r15dev.ok, true);
assert(
  'development 不产生 optional_missing warning',
  !r15dev.warnings.some(w => w.category === 'optional_missing')
);

console.log('\n[16] PORT 非法范围...');
const r16 = validateEnv(makeValidEnv({ PORT: '99999' }));
assertEqual('PORT 99999 → ok=false', r16.ok, false);
assert(
  'errors 含 PORT invalid_format',
  r16.errors.some(e => e.field === 'PORT' && e.category === 'invalid_format')
);

const r16b = validateEnv(makeValidEnv({ PORT: '0' }));
assertEqual('PORT 0 → ok=false', r16b.ok, false);

const r16c = validateEnv(makeValidEnv({ PORT: '-1' }));
assertEqual('PORT -1 → ok=false', r16c.ok, false);

console.log('\n[17] DB_PORT 非数字...');
const r17 = validateEnv(makeValidEnv({ DB_PORT: 'abc' }));
assertEqual('DB_PORT abc → ok=false', r17.ok, false);
assert(
  'errors 含 DB_PORT',
  r17.errors.some(e => e.field === 'DB_PORT')
);

console.log('\n[18] TradingAgents 固定走 loopback，不再校验远程 URL...');

console.log('\n[19] 默认值注入...');
const r19 = validateEnv(
  makeValidEnv({ PORT: undefined, DB_PORT: undefined, REDIS_PORT: undefined })
);
assertEqual('PORT 默认 3000', r19.validated.PORT, 3000);
assertEqual('DB_PORT 默认 5432', r19.validated.DB_PORT, 5432);
assertEqual('REDIS_PORT 默认 6379', r19.validated.REDIS_PORT, 6379);
assertEqual(
  'FEISHU_BOT_WEBHOOK_TIMEOUT_MS 默认 10000',
  r19.validated.FEISHU_BOT_WEBHOOK_TIMEOUT_MS,
  10000
);
assertEqual('SMTP_PORT 默认 587', r19.validated.SMTP_PORT, 587);
assertEqual('PYTHON_PATH 默认 python3', r19.validated.PYTHON_PATH, 'python3');
assertEqual('NODE_ENV 默认 development', r19.validated.NODE_ENV, 'development');

console.log('\n[20] 未知 env 字段允许...');
const r20 = validateEnv(makeValidEnv({ UNKNOWN_RANDOM_FIELD: 'whatever' }));
assertEqual('未知 env ok=true', r20.ok, true);

console.log('\n[21] shouldExitOnFailure...');
assertEqual(
  'ok=true → false',
  shouldExitOnFailure({
    ok: true,
    errors: [],
    warnings: [],
    validated: {},
    node_env: 'production',
  }),
  false
);
assertEqual(
  'ok=false production → true',
  shouldExitOnFailure({
    ok: false,
    errors: [{ field: 'X', message: 'm', category: 'required' }],
    warnings: [],
    validated: {},
    node_env: 'production',
  }),
  true
);
assertEqual(
  'ok=false development → false',
  shouldExitOnFailure({
    ok: false,
    errors: [{ field: 'X', message: 'm', category: 'required' }],
    warnings: [],
    validated: {},
    node_env: 'development',
  }),
  false
);
assertEqual(
  'ok=false test → false',
  shouldExitOnFailure({
    ok: false,
    errors: [{ field: 'X', message: 'm', category: 'required' }],
    warnings: [],
    validated: {},
    node_env: 'test',
  }),
  false
);

console.log('\n[22] NODE_ENV 校验...');
const r22 = validateEnv(makeValidEnv({ NODE_ENV: 'staging' }));
assertEqual('NODE_ENV staging → ok=false', r22.ok, false);
assert(
  'NODE_ENV invalid_format',
  r22.errors.some(e => e.field === 'NODE_ENV' && e.category === 'invalid_format')
);

const r22b = validateEnv(makeValidEnv({ NODE_ENV: 'test' }));
assertEqual('NODE_ENV test → ok=true', r22b.ok, true);
assertEqual('node_env=test', r22b.node_env, 'test');

console.log('\n[23] REDIS_PASSWORD 空串允许...');
const r23 = validateEnv(makeValidEnv({ REDIS_PASSWORD: '' }));
assertEqual('REDIS_PASSWORD 空串 ok=true', r23.ok, true);

console.log('\n[24] DB_SSL 字符串 true/false 校验...');
const r24a = validateEnv(makeValidEnv({ DB_SSL: 'true' }));
assertEqual('DB_SSL=true ok=true', r24a.ok, true);
const r24b = validateEnv(makeValidEnv({ DB_SSL: 'yes' }));
assertEqual('DB_SSL=yes → ok=false', r24b.ok, false);

console.log('\n[25] SMTP 全填齐 + 部分填写互斥...');
const r25 = validateEnv(
  makeValidEnv({
    SMTP_HOST: 'smtp.example.com',
    SMTP_USER: 'me@example.com',
    SMTP_PASS: 'pwd',
  })
);
assertEqual('SMTP 三件套齐 ok=true', r25.ok, true);
assert('不再有 SMTP 部分配置 error', !r25.errors.some(e => e.field.includes('SMTP_')));

console.log('\n[26] 多 channel 同时部分填写 → 多 errors...');
const r26 = validateEnv(
  makeValidEnv({
    SMTP_HOST: 'h',
    WECHAT_APP_ID: 'wx_xxx',
    ALIYUN_SMS_ACCESS_KEY_ID: 'AK_XXX',
  })
);
assertEqual('多 channel 部分填 ok=false', r26.ok, false);
assert('errors 总数 >= 3', r26.errors.length >= 3);

console.log('\n[27] validated 在 ok=false 时为空对象...');
const r27 = validateEnv(makeValidEnv({ DB_HOST: undefined }));
assertEqual('failed validated empty', Object.keys(r27.validated).length, 0);

console.log('\n[28] node_env 来源大小写...');
const r28 = validateEnv(makeValidEnv({ NODE_ENV: 'production', JWT_SECRET: 'A'.repeat(40) }));
assertEqual('node_env 小写化', r28.node_env, 'production');
// 大写 PRODUCTION 应被 schema 拒绝（valid 只接受三个 lower-case）
const r28b = validateEnv(makeValidEnv({ NODE_ENV: 'PRODUCTION' }));
assertEqual('NODE_ENV PRODUCTION → ok=false', r28b.ok, false);

console.log('\n[29] DB_USER 空字符串 → required error...');
const r29 = validateEnv(makeValidEnv({ DB_USER: '' }));
assertEqual('DB_USER 空 → ok=false', r29.ok, false);
assert(
  'errors 含 DB_USER',
  r29.errors.some(e => e.field === 'DB_USER')
);

console.log('\n[30] customSchema 选项...');
const customSchema = Joi.object({ ONLY_THIS: Joi.string().required() }).unknown(true);
const r30 = validateEnv({ ONLY_THIS: 'value' }, { customSchema });
assertEqual('customSchema 简化', r30.ok, true);
const r30b = validateEnv({}, { customSchema });
assertEqual('customSchema 缺必填 ok=false', r30b.ok, false);
assert(
  'errors 含 ONLY_THIS',
  r30b.errors.some(e => e.field === 'ONLY_THIS')
);

// ===========================================================================
console.log('\n--------------------------------------------------------------');
console.log(`Total: ${passed} ok, ${failed} failed`);
console.log('--------------------------------------------------------------');
if (failed > 0) {
  process.exit(1);
}
process.exit(0);
