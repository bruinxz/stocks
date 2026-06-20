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
 *     - 缺 TRADING_AGENTS_URL → required error
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
 *     - TRADING_AGENTS_URL 非 URL → invalid_format
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
  FEISHU_REQUIRED_GROUP,
  SMTP_REQUIRED_GROUP,
  WECHAT_REQUIRED_GROUP,
  ALIYUN_SMS_REQUIRED_GROUP,
  EnvValidationResult,
} from '../../src/config/EnvValidator';
import Joi from 'joi';

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
    TRADING_AGENTS_URL: 'http://127.0.0.1:8000',
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
assert('FEISHU_REQUIRED_GROUP frozen', Object.isFrozen(FEISHU_REQUIRED_GROUP));
assert('SMTP_REQUIRED_GROUP frozen', Object.isFrozen(SMTP_REQUIRED_GROUP));
assert('WECHAT_REQUIRED_GROUP frozen', Object.isFrozen(WECHAT_REQUIRED_GROUP));
assert('ALIYUN_SMS_REQUIRED_GROUP frozen', Object.isFrozen(ALIYUN_SMS_REQUIRED_GROUP));
assert('PLACEHOLDER_VALUES 含已知占位符', PLACEHOLDER_VALUES.includes('your_jwt_secret_key_here'));
assert('PLACEHOLDER_VALUES 含 TODO', PLACEHOLDER_VALUES.includes('TODO'));

console.log('\n[2] isPlaceholderValue 纯函数...');
assertEqual('占位符', isPlaceholderValue('your_jwt_secret_key_here'), true);
assertEqual('占位符大小写不敏感', isPlaceholderValue('YOUR_JWT_SECRET_KEY_HERE'), true);
assertEqual('占位符 trim', isPlaceholderValue('  your_jwt_secret_key_here  '), true);
assertEqual('真实值', isPlaceholderValue('real-secret-123'), false);
assertEqual('空串非占位符', isPlaceholderValue(''), false);
assertEqual('undefined 非占位符', isPlaceholderValue(undefined), false);
assertEqual('null 非占位符', isPlaceholderValue(null), false);
assertEqual('数字非占位符', isPlaceholderValue(123), false);
assertEqual('TODO 占位符', isPlaceholderValue('TODO'), true);
assertEqual('change-me 占位符', isPlaceholderValue('change-me'), true);

console.log('\n[3] detectPartialChannelGroup...');
assertEqual(
  '全空',
  detectPartialChannelGroup({}, SMTP_REQUIRED_GROUP),
  []
);
assertEqual(
  '全填',
  detectPartialChannelGroup(
    { SMTP_HOST: 'h', SMTP_USER: 'u', SMTP_PASS: 'p' },
    SMTP_REQUIRED_GROUP
  ),
  []
);
assertEqual(
  '只填 HOST',
  detectPartialChannelGroup({ SMTP_HOST: 'h' }, SMTP_REQUIRED_GROUP),
  ['SMTP_USER', 'SMTP_PASS']
);
assertEqual(
  '填 HOST + USER 缺 PASS',
  detectPartialChannelGroup(
    { SMTP_HOST: 'h', SMTP_USER: 'u' },
    SMTP_REQUIRED_GROUP
  ),
  ['SMTP_PASS']
);
assertEqual(
  '空字符串视为空',
  detectPartialChannelGroup({ SMTP_HOST: '', SMTP_USER: '   ' }, SMTP_REQUIRED_GROUP),
  []
);
assertEqual(
  '部分空字符串部分有值',
  detectPartialChannelGroup(
    { SMTP_HOST: 'h', SMTP_USER: '', SMTP_PASS: 'p' },
    SMTP_REQUIRED_GROUP
  ),
  ['SMTP_USER']
);

console.log('\n[4] mapJoiErrorsToValidationErrors...');
assertEqual('undefined 返回空数组', mapJoiErrorsToValidationErrors(undefined), []);
const requiredErr = Joi.object({ X: Joi.string().required() }).validate({}).error!;
const mappedReq = mapJoiErrorsToValidationErrors(requiredErr);
assertEqual('required 1 个', mappedReq.length, 1);
assertEqual('required category', mappedReq[0].category, 'required');
assertEqual('required field', mappedReq[0].field, 'X');

const formatErr = Joi.object({ N: Joi.number().integer().required() })
  .validate({ N: 'abc' }).error!;
const mappedFmt = mapJoiErrorsToValidationErrors(formatErr);
assertEqual('invalid_format category', mappedFmt[0].category, 'invalid_format');

const uriErr = Joi.object({ U: Joi.string().uri().required() })
  .validate({ U: 'not-a-url' }).error!;
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
  warnings: [
    { field: 'JWT_SECRET', message: 'placeholder', category: 'placeholder_value' },
  ],
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
assert('errors 含 DB_HOST', r7.errors.some(e => e.field === 'DB_HOST'));
assert('DB_HOST is required', r7.errors.some(e => e.field === 'DB_HOST' && e.category === 'required'));

const r7b = validateEnv(makeValidEnv({ JWT_SECRET: undefined }));
assertEqual('缺 JWT_SECRET → ok=false', r7b.ok, false);
assert('errors 含 JWT_SECRET', r7b.errors.some(e => e.field === 'JWT_SECRET'));

const r7c = validateEnv(makeValidEnv({ TRADING_AGENTS_URL: undefined }));
assertEqual('缺 TRADING_AGENTS_URL → ok=false', r7c.ok, false);
assert('errors 含 TRADING_AGENTS_URL', r7c.errors.some(e => e.field === 'TRADING_AGENTS_URL'));

const r7d = validateEnv(makeValidEnv({ REDIS_HOST: undefined }));
assertEqual('缺 REDIS_HOST → ok=false', r7d.ok, false);

console.log('\n[8] 占位符值: production = error, development = warning...');
const r8prod = validateEnv(
  makeValidEnv({
    NODE_ENV: 'production',
    JWT_SECRET: 'your_jwt_secret_key_here',
  })
);
// production 模式 + 占位符 + 长度不够 32 → 至少 1 个 error
assertEqual('production 占位符 → ok=false', r8prod.ok, false);
assert(
  'production 占位符触发 production_required',
  r8prod.errors.some(e => e.field === 'JWT_SECRET' && e.category === 'production_required')
);

const r8dev = validateEnv(
  makeValidEnv({
    NODE_ENV: 'development',
    JWT_SECRET: 'your_jwt_secret_key_here',
  })
);
assertEqual('development 占位符 ok=true', r8dev.ok, true);
assert(
  'development 占位符 → warning',
  r8dev.warnings.some(w => w.field === 'JWT_SECRET' && w.category === 'placeholder_value')
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
  r9prod.errors.some(e => e.field === 'JWT_SECRET' && e.category === 'production_required' && e.message.includes('32'))
);
// development 容忍
const r9dev = validateEnv(makeValidEnv({ NODE_ENV: 'development', JWT_SECRET: 'short-key-123' }));
assertEqual('development 短 JWT_SECRET ok', r9dev.ok, true);

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

console.log('\n[11] FEISHU 部分填写...');
const r11 = validateEnv(
  makeValidEnv({
    FEISHU_APP_ID: 'cli_xxx',
    // FEISHU_APP_SECRET 缺
  })
);
assertEqual('FEISHU 部分填写 → ok=false', r11.ok, false);
assert(
  'errors 提及 FEISHU_APP_SECRET',
  r11.errors.some(e => e.field.includes('FEISHU_APP_SECRET'))
);

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
assert('errors 含 PORT invalid_format', r16.errors.some(e => e.field === 'PORT' && e.category === 'invalid_format'));

const r16b = validateEnv(makeValidEnv({ PORT: '0' }));
assertEqual('PORT 0 → ok=false', r16b.ok, false);

const r16c = validateEnv(makeValidEnv({ PORT: '-1' }));
assertEqual('PORT -1 → ok=false', r16c.ok, false);

console.log('\n[17] DB_PORT 非数字...');
const r17 = validateEnv(makeValidEnv({ DB_PORT: 'abc' }));
assertEqual('DB_PORT abc → ok=false', r17.ok, false);
assert('errors 含 DB_PORT', r17.errors.some(e => e.field === 'DB_PORT'));

console.log('\n[18] TRADING_AGENTS_URL 非 URL...');
const r18 = validateEnv(makeValidEnv({ TRADING_AGENTS_URL: 'not-a-url' }));
assertEqual('TRADING_AGENTS_URL 非 URL → ok=false', r18.ok, false);
assert(
  'TRADING_AGENTS_URL invalid_format',
  r18.errors.some(e => e.field === 'TRADING_AGENTS_URL' && e.category === 'invalid_format')
);

console.log('\n[19] 默认值注入...');
const r19 = validateEnv(makeValidEnv({ PORT: undefined, DB_PORT: undefined, REDIS_PORT: undefined }));
assertEqual('PORT 默认 3000', r19.validated.PORT, 3000);
assertEqual('DB_PORT 默认 5432', r19.validated.DB_PORT, 5432);
assertEqual('REDIS_PORT 默认 6379', r19.validated.REDIS_PORT, 6379);
assertEqual('FEISHU_MESSAGE_MAX_LENGTH 默认 12000', r19.validated.FEISHU_MESSAGE_MAX_LENGTH, 12000);
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
    ok: true, errors: [], warnings: [], validated: {}, node_env: 'production',
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
assert(
  '不再有 SMTP 部分配置 error',
  !r25.errors.some(e => e.field.includes('SMTP_'))
);

console.log('\n[26] 多 channel 同时部分填写 → 多 errors...');
const r26 = validateEnv(
  makeValidEnv({
    SMTP_HOST: 'h',
    FEISHU_APP_ID: 'cli_xxx',
    WECHAT_APP_ID: 'wx_xxx',
    ALIYUN_SMS_ACCESS_KEY_ID: 'AK_XXX',
  })
);
assertEqual('多 channel 部分填 ok=false', r26.ok, false);
assert('errors 总数 >= 4', r26.errors.length >= 4);

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
assert('errors 含 DB_USER', r29.errors.some(e => e.field === 'DB_USER'));

console.log('\n[30] customSchema 选项...');
const customSchema = Joi.object({ ONLY_THIS: Joi.string().required() }).unknown(true);
const r30 = validateEnv({ ONLY_THIS: 'value' }, { customSchema });
assertEqual('customSchema 简化', r30.ok, true);
const r30b = validateEnv({}, { customSchema });
assertEqual('customSchema 缺必填 ok=false', r30b.ok, false);
assert('errors 含 ONLY_THIS', r30b.errors.some(e => e.field === 'ONLY_THIS'));

// ===========================================================================
console.log('\n--------------------------------------------------------------');
console.log(`Total: ${passed} ok, ${failed} failed`);
console.log('--------------------------------------------------------------');
if (failed > 0) {
  process.exit(1);
}
process.exit(0);
