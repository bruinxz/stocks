/**
 * productionPreflight 单测。
 * 不依赖 jest；node 直接跑。
 *
 *   cd backend && npx ts-node --transpile-only tests/utils/productionPreflight.test.ts
 */

import { __TESTING__, runProductionPreflight } from '../../src/utils/productionPreflight';

let failed = 0;
const ORIGINAL_ENV = { ...process.env };

function reset() {
  process.env = { ...ORIGINAL_ENV };
}

function assert(name: string, cond: boolean, detail = '') {
  if (cond) {
    console.log(`  ok  ${name}${detail ? ` (${detail})` : ''}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}${detail ? ` (${detail})` : ''}`);
  }
}

function capture<T>(fn: () => T): { result: T; logs: string[]; errors: string[] } {
  const logs: string[] = [];
  const errors: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  const origWarn = console.warn;
  console.log = (...args: any[]) => logs.push(args.join(' '));
  console.error = (...args: any[]) => errors.push(args.join(' '));
  console.warn = (...args: any[]) => logs.push(args.join(' '));
  try {
    const result = fn();
    return { result, logs, errors };
  } finally {
    console.log = origLog;
    console.error = origErr;
    console.warn = origWarn;
  }
}

function strongEnv(): Record<string, string> {
  return {
    NODE_ENV: 'production',
    JWT_SECRET: 'a'.repeat(40),
    JWT_REFRESH_SECRET: 'b'.repeat(40),
    DB_HOST: 'db.example.com',
    DB_NAME: 'stock_backtest',
    DB_USER: 'stock_admin',
    DB_PASSWORD: 'super-strong-db-pwd',
    ALLOWED_ORIGINS: 'https://app.example.com',
    LIVE_ADMIN_BOOTSTRAP_PASSWORD: 'a-strong-admin-bootstrap-pwd',
    INTERNAL_API_KEY: 'long-enough-api-key-not-leaked',
    LIVE_TRADING_ENABLED: 'false', // 默认关；只验最小集合
  };
}

// ------------------------------------------------------------

function test_non_production_returns_true() {
  reset();
  process.env = { NODE_ENV: 'development' } as any;
  const { result } = capture(() => runProductionPreflight());
  assert('non-production env 直接放行', result === true);
}

function test_minimum_strong_env_passes() {
  reset();
  process.env = strongEnv() as any;
  const { result, errors } = capture(() => runProductionPreflight());
  assert('strong env 最小集通过', result === true, errors.join('|').slice(0, 200));
}

function test_missing_jwt_secret_fails() {
  reset();
  const env = strongEnv();
  delete env.JWT_SECRET;
  process.env = env as any;
  const { result, errors } = capture(() => runProductionPreflight());
  assert('JWT_SECRET 缺失即失败', result === false);
  assert(
    'JWT_SECRET 错误进 errors',
    errors.some(e => e.includes('JWT_SECRET') && e.includes('未设置'))
  );
}

function test_known_leaked_secret_rejected() {
  reset();
  const env = strongEnv();
  const syntheticLeakedSecret = 'synthetic-leaked-secret-value-for-fingerprint-check';
  env.JWT_SECRET = syntheticLeakedSecret;
  const fingerprints = new Set([__TESTING__.secretFingerprint(syntheticLeakedSecret)]);
  const { result, errors } = capture(() =>
    __TESTING__.runProductionPreflightWithFingerprints(env, fingerprints)
  );
  assert('已泄露 secret 被拒', result === false);
  assert('错误信息包含历史泄漏指纹', errors.some(e => /历史泄漏指纹/.test(e)));
}

function test_placeholder_pattern_rejected() {
  reset();
  const env = strongEnv();
  env.JWT_SECRET = 'your-fancy-secret-here-padded-to-32chars';
  process.env = env as any;
  const { result, errors } = capture(() => runProductionPreflight());
  assert('占位符模式被拒', result === false);
  assert(
    '错误信息含占位符',
    errors.some(e => /占位符/.test(e))
  );
}

function test_weak_password_rejected() {
  reset();
  const env = strongEnv();
  env.JWT_SECRET = '666'; // 实际会先撞最低长度 32 → 仍能拒
  process.env = env as any;
  const { result } = capture(() => runProductionPreflight());
  assert('弱密码（短）被拒', result === false);
}

function test_short_secret_rejected() {
  reset();
  const env = strongEnv();
  env.JWT_SECRET = 'short';
  process.env = env as any;
  const { result, errors } = capture(() => runProductionPreflight());
  assert('< 32 字符被拒', result === false);
  assert(
    '错误信息含长度',
    errors.some(e => /长度/.test(e))
  );
}

function test_allowed_origins_missing_warns() {
  reset();
  const env = strongEnv();
  delete env.ALLOWED_ORIGINS;
  process.env = env as any;
  const { result, logs } = capture(() => runProductionPreflight());
  assert('ALLOWED_ORIGINS 缺失时按现行默认策略放行', result === true);
  assert(
    '日志明确提示 ALLOWED_ORIGINS 使用默认策略',
    logs.some(e => e.includes('ALLOWED_ORIGINS') && /默认策略/.test(e))
  );
}

function test_allowed_origins_invalid_format() {
  reset();
  const env = strongEnv();
  env.ALLOWED_ORIGINS = 'not-a-url';
  process.env = env as any;
  const { result, errors } = capture(() => runProductionPreflight());
  assert('非法 origin 被拒', result === false);
  assert(
    '错误信息含 非法 origin',
    errors.some(e => /非法 origin/.test(e))
  );
}

function test_cors_relax_in_production_rejected() {
  reset();
  const env = strongEnv();
  env.LIVE_TRADING_CORS_RELAX = 'true';
  process.env = env as any;
  const { result, errors } = capture(() => runProductionPreflight());
  assert('production CORS_RELAX 被拒', result === false);
  assert(
    '错误信息含 CORS',
    errors.some(e => /CORS_RELAX|CORS 全反射/.test(e))
  );
}

function test_db_offline_in_production_rejected() {
  reset();
  const env = strongEnv();
  env.LIVE_TRADING_ALLOW_DB_OFFLINE = 'true';
  process.env = env as any;
  const { result, errors } = capture(() => runProductionPreflight());
  assert('DB 半启动被拒', result === false);
  assert(
    '错误信息含 半启动',
    errors.some(e => /半启动/.test(e))
  );
}

function test_execution_requires_trading_enabled() {
  reset();
  const env = strongEnv();
  env.LIVE_TRADING_ENABLED = 'false';
  env.LIVE_ORDER_EXECUTION_ENABLED = 'true';
  process.env = env as any;
  const { result, errors } = capture(() => runProductionPreflight());
  assert('execution=true 但 trading=false 被拒', result === false, errors.join('|').slice(0, 200));
  assert(
    '错误信息说要 trading=true',
    errors.some(e => /LIVE_ORDER_EXECUTION_ENABLED/.test(e) && /LIVE_TRADING_ENABLED/.test(e))
  );
}

function test_trading_enabled_requires_bridge_secrets() {
  reset();
  const env = strongEnv();
  env.LIVE_TRADING_ENABLED = 'true';
  env.LIVE_BROKER_GATEWAY = 'qmt_bridge';
  // 缺 LIVE_BRIDGE_SECRETS
  process.env = env as any;
  const { result, errors } = capture(() => runProductionPreflight());
  assert('trading=true 但缺 BRIDGE_SECRETS 被拒', result === false);
  assert(
    '错误信息含 BRIDGE_SECRETS',
    errors.some(e => /LIVE_BRIDGE_SECRETS/.test(e))
  );
}

function test_bridge_secrets_must_be_json_with_long_secret() {
  reset();
  const env = strongEnv();
  env.LIVE_TRADING_ENABLED = 'true';
  env.LIVE_BROKER_GATEWAY = 'qmt_bridge';
  env.LIVE_BRIDGE_SECRETS = '{"k": "too-short"}';
  env.LIVE_MARKET_DATA_PROVIDER = 'licensed_configured';
  env.LIVE_LICENSED_QUOTE_URL_TEMPLATE = 'https://q.example.com/{symbol}';
  env.LIVE_ORDER_EXECUTION_ENABLED = 'true';
  process.env = env as any;
  const { result, errors } = capture(() => runProductionPreflight());
  assert('BRIDGE_SECRETS secret 太短被拒', result === false);
  assert(
    '错误信息含 长度',
    errors.some(e => /长度/.test(e))
  );
}

function test_legacy_single_var_rejected() {
  reset();
  const env = strongEnv();
  env.LIVE_TRADING_ENABLED = 'true';
  env.LIVE_BROKER_GATEWAY = 'qmt_bridge';
  env.LIVE_BRIDGE_SECRETS = '{"k": "' + 'x'.repeat(40) + '"}';
  env.LIVE_BRIDGE_KEY = 'k';
  env.LIVE_BRIDGE_SECRET = 'whatever';
  env.LIVE_MARKET_DATA_PROVIDER = 'licensed_configured';
  env.LIVE_LICENSED_QUOTE_URL_TEMPLATE = 'https://q.example.com/{symbol}';
  process.env = env as any;
  const { result, errors } = capture(() => runProductionPreflight());
  assert('旧单变量与 BRIDGE_SECRETS 同时存在被拒', result === false);
  assert(
    '错误信息说不要混用',
    errors.some(e => /不要与旧变量/.test(e))
  );
}

function test_licensed_provider_required_for_execution() {
  reset();
  const env = strongEnv();
  env.LIVE_TRADING_ENABLED = 'true';
  env.LIVE_ORDER_EXECUTION_ENABLED = 'true';
  env.LIVE_BROKER_GATEWAY = 'qmt_bridge';
  env.LIVE_BRIDGE_SECRETS = '{"k": "' + 'x'.repeat(40) + '"}';
  env.LIVE_MARKET_DATA_PROVIDER = 'database_realtime_quotes';
  process.env = env as any;
  const { result, errors } = capture(() => runProductionPreflight());
  assert('非 licensed provider + execution 被拒', result === false);
  assert(
    '错误信息含 licensed_configured',
    errors.some(e => /licensed_configured/.test(e))
  );
}

function test_invalid_broker_gateway_rejected() {
  reset();
  const env = strongEnv();
  env.LIVE_TRADING_ENABLED = 'true';
  env.LIVE_ORDER_EXECUTION_ENABLED = 'true';
  env.LIVE_BROKER_GATEWAY = 'mock_guarded';
  env.LIVE_BRIDGE_SECRETS = '{"k": "' + 'x'.repeat(40) + '"}';
  env.LIVE_MARKET_DATA_PROVIDER = 'licensed_configured';
  env.LIVE_LICENSED_QUOTE_URL_TEMPLATE = 'https://q.example.com/{symbol}';
  process.env = env as any;
  const { result, errors } = capture(() => runProductionPreflight());
  assert('mock_guarded + execution 被拒', result === false);
  assert(
    '错误信息含网关白名单',
    errors.some(e => /qmt_bridge, ptrade_bridge/.test(e))
  );
}

function test_full_passing_execution_env() {
  reset();
  const env = strongEnv();
  env.LIVE_TRADING_ENABLED = 'true';
  env.LIVE_ORDER_EXECUTION_ENABLED = 'true';
  env.LIVE_BROKER_GATEWAY = 'qmt_bridge';
  env.LIVE_BRIDGE_SECRETS = '{"k": "' + 'x'.repeat(40) + '"}';
  env.LIVE_MARKET_DATA_PROVIDER = 'licensed_configured';
  env.LIVE_LICENSED_QUOTE_URL_TEMPLATE = 'https://q.example.com/{symbol}';
  env.LIVE_RISK_MAX_SINGLE_ORDER_PCT = '0.2';
  env.LIVE_RISK_MAX_DAILY_ORDER_COUNT = '3';
  env.LIVE_RISK_DAILY_LOSS_KILL_PCT = '1';
  process.env = env as any;
  const { result, errors } = capture(() => runProductionPreflight());
  assert('完整 production execution env 通过', result === true, errors.join('|').slice(0, 300));
}

function test_high_risk_threshold_warns_but_passes() {
  reset();
  const env = strongEnv();
  env.LIVE_TRADING_ENABLED = 'true';
  env.LIVE_ORDER_EXECUTION_ENABLED = 'true';
  env.LIVE_BROKER_GATEWAY = 'qmt_bridge';
  env.LIVE_BRIDGE_SECRETS = '{"k": "' + 'x'.repeat(40) + '"}';
  env.LIVE_MARKET_DATA_PROVIDER = 'licensed_configured';
  env.LIVE_LICENSED_QUOTE_URL_TEMPLATE = 'https://q.example.com/{symbol}';
  env.LIVE_RISK_MAX_SINGLE_ORDER_PCT = '5'; // 灰度建议 1，超过只 warn 不 fail
  env.LIVE_RISK_MAX_DAILY_ORDER_COUNT = '20';
  process.env = env as any;
  const { result, logs } = capture(() => runProductionPreflight());
  assert('风控宽松只 warn 不 fail', result === true);
  assert(
    '日志含 灰度阶段建议',
    logs.some(l => /灰度阶段建议/.test(l))
  );
}

// ------------------------------------------------------------

const tests = [
  test_non_production_returns_true,
  test_minimum_strong_env_passes,
  test_missing_jwt_secret_fails,
  test_known_leaked_secret_rejected,
  test_placeholder_pattern_rejected,
  test_weak_password_rejected,
  test_short_secret_rejected,
  test_allowed_origins_missing_warns,
  test_allowed_origins_invalid_format,
  test_cors_relax_in_production_rejected,
  test_db_offline_in_production_rejected,
  test_execution_requires_trading_enabled,
  test_trading_enabled_requires_bridge_secrets,
  test_bridge_secrets_must_be_json_with_long_secret,
  test_legacy_single_var_rejected,
  test_licensed_provider_required_for_execution,
  test_invalid_broker_gateway_rejected,
  test_full_passing_execution_env,
  test_high_risk_threshold_warns_but_passes,
];

console.log(`\n=== productionPreflight unit tests (${tests.length}) ===\n`);
for (const t of tests) {
  try {
    t();
  } catch (err: any) {
    failed += 1;
    console.error(`  THROW ${t.name}: ${err?.message || err}`);
  }
}
process.env = ORIGINAL_ENV;
console.log(`\nResult: ${tests.length - failed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
