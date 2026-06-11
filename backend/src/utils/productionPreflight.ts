/**
 * Production environment preflight.
 *
 * 上线 launch-helper：production 启动前强制校验必填 env，缺失或弱值即 process.exit(1)。
 * 这一层是 backend/.env.example.production 的可执行兜底；CI 弱密钥 lint + 这里运行时双保险。
 *
 * 触发时机：在 src/index.ts initializeApp() 最前面调用一次。
 */

/* eslint-disable no-console */

interface RuleResult {
  key: string;
  level: 'error' | 'warn';
  message: string;
}

interface RuleCtx {
  results: RuleResult[];
  env: NodeJS.ProcessEnv;
}

const PLACEHOLDER_PATTERNS = [
  /your[-_].*secret/i,
  /your[-_].*key[-_]?here/i,
  /change[-_]me/i,
  /placeholder/i,
];

const KNOWN_LEAKED_SECRETS = new Set([
  'your-secret-key-change-in-production',
  'your-refresh-secret-key-change-in-production',
  'your_jwt_secret_key_here',
  'tr_agent_k8s_x9a1!b2c3d4e5f6g7h8i9j0',
]);

const WEAK_PASSWORDS = new Set(['666', '123456', 'password', 'admin']);

function requireEnv(ctx: RuleCtx, key: string, message?: string): void {
  const value = ctx.env[key];
  if (!value || !String(value).trim()) {
    ctx.results.push({
      key,
      level: 'error',
      message: message || `${key} 未设置`,
    });
  }
}

function requireSecret(ctx: RuleCtx, key: string, minLength: number): void {
  const raw = String(ctx.env[key] || '').trim();
  if (!raw) {
    ctx.results.push({ key, level: 'error', message: `${key} 未设置` });
    return;
  }
  if (raw.length < minLength) {
    ctx.results.push({
      key,
      level: 'error',
      message: `${key} 长度 ${raw.length} < 最低 ${minLength}`,
    });
  }
  if (KNOWN_LEAKED_SECRETS.has(raw)) {
    ctx.results.push({
      key,
      level: 'error',
      message: `${key} 是已泄露的旧默认值，必须立即轮换`,
    });
  }
  if (PLACEHOLDER_PATTERNS.some(re => re.test(raw))) {
    ctx.results.push({
      key,
      level: 'error',
      message: `${key} 看起来是占位符（your-/change-me/placeholder）`,
    });
  }
  if (WEAK_PASSWORDS.has(raw)) {
    ctx.results.push({
      key,
      level: 'error',
      message: `${key} 是弱密码，必须更换`,
    });
  }
}

function requireBool(ctx: RuleCtx, key: string, expected: boolean): void {
  const raw = String(ctx.env[key] || '').toLowerCase();
  const truthy = ['true', '1', 'yes', 'y', 'on'].includes(raw);
  const falsy = ['false', '0', 'no', 'n', 'off'].includes(raw);
  if (!truthy && !falsy) {
    ctx.results.push({
      key,
      level: 'error',
      message: `${key} 必须是 true/false，当前未设置`,
    });
    return;
  }
  const actual = truthy;
  if (actual !== expected) {
    ctx.results.push({
      key,
      level: 'error',
      message: `${key} 必须为 ${expected}，当前 ${actual}`,
    });
  }
}

function checkAllowedOrigins(ctx: RuleCtx): void {
  const raw = String(ctx.env.ALLOWED_ORIGINS || '').trim();
  if (!raw) {
    ctx.results.push({
      key: 'ALLOWED_ORIGINS',
      level: 'error',
      message: 'production 必须显式列出前端域名，禁止依赖默认 localhost 回退',
    });
    return;
  }
  const origins = raw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  for (const origin of origins) {
    if (!/^https?:\/\/[a-z0-9.-]+(:\d+)?$/i.test(origin)) {
      ctx.results.push({
        key: 'ALLOWED_ORIGINS',
        level: 'error',
        message: `非法 origin 格式: ${origin}`,
      });
    }
    if (/^http:\/\//i.test(origin) && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(origin)) {
      ctx.results.push({
        key: 'ALLOWED_ORIGINS',
        level: 'warn',
        message: `production 不建议使用非 HTTPS origin: ${origin}`,
      });
    }
  }
  if (ctx.env.LIVE_TRADING_CORS_RELAX === 'true') {
    ctx.results.push({
      key: 'LIVE_TRADING_CORS_RELAX',
      level: 'error',
      message: 'production 禁止打开 CORS 全反射；删掉该变量或设为 false',
    });
  }
}

function checkBridgeSecrets(ctx: RuleCtx): void {
  const raw = String(ctx.env.LIVE_BRIDGE_SECRETS || '').trim();
  if (!raw || raw === '{}') {
    ctx.results.push({
      key: 'LIVE_BRIDGE_SECRETS',
      level: 'error',
      message: '必须配置 JSON {bridge_key: secret} 映射',
    });
    return;
  }
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    ctx.results.push({
      key: 'LIVE_BRIDGE_SECRETS',
      level: 'error',
      message: '不是合法 JSON',
    });
    return;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    ctx.results.push({
      key: 'LIVE_BRIDGE_SECRETS',
      level: 'error',
      message: '必须是 JSON object',
    });
    return;
  }
  const entries = Object.entries(parsed);
  if (entries.length === 0) {
    ctx.results.push({
      key: 'LIVE_BRIDGE_SECRETS',
      level: 'error',
      message: '至少要有一个 bridge_key',
    });
  }
  for (const [k, v] of entries) {
    if (typeof v !== 'string' || v.length < 32) {
      ctx.results.push({
        key: 'LIVE_BRIDGE_SECRETS',
        level: 'error',
        message: `bridge_key=${k} 的 secret 长度 < 32`,
      });
    }
  }
  if (ctx.env.LIVE_BRIDGE_KEY || ctx.env.LIVE_BRIDGE_SECRET) {
    ctx.results.push({
      key: 'LIVE_BRIDGE_SECRETS',
      level: 'error',
      message: '不要与旧变量 LIVE_BRIDGE_KEY / LIVE_BRIDGE_SECRET 同时配置',
    });
  }
}

function checkRiskLimitsForGrayscale(ctx: RuleCtx): void {
  // 灰度阶段建议把单笔/日单收紧；不强制，只给 warn
  const maxSingle = Number(ctx.env.LIVE_RISK_MAX_SINGLE_ORDER_PCT || 5);
  const maxDaily = Number(ctx.env.LIVE_RISK_MAX_DAILY_ORDER_COUNT || 5);
  const dailyLoss = Number(ctx.env.LIVE_RISK_DAILY_LOSS_KILL_PCT || 2);
  if (maxSingle > 1) {
    ctx.results.push({
      key: 'LIVE_RISK_MAX_SINGLE_ORDER_PCT',
      level: 'warn',
      message: `灰度阶段建议 ≤1%，当前 ${maxSingle}%`,
    });
  }
  if (maxDaily > 5) {
    ctx.results.push({
      key: 'LIVE_RISK_MAX_DAILY_ORDER_COUNT',
      level: 'warn',
      message: `灰度阶段建议 ≤5，当前 ${maxDaily}`,
    });
  }
  if (dailyLoss > 2) {
    ctx.results.push({
      key: 'LIVE_RISK_DAILY_LOSS_KILL_PCT',
      level: 'warn',
      message: `灰度阶段建议 ≤2%，当前 ${dailyLoss}%`,
    });
  }
}

function checkLicensedQuote(ctx: RuleCtx): void {
  const provider = String(ctx.env.LIVE_MARKET_DATA_PROVIDER || '').trim();
  const ordersEnabled = String(ctx.env.LIVE_ORDER_EXECUTION_ENABLED || '').toLowerCase() === 'true';
  if (!ordersEnabled) return; // 只读模式不要求 licensed
  if (provider !== 'licensed_configured') {
    ctx.results.push({
      key: 'LIVE_MARKET_DATA_PROVIDER',
      level: 'error',
      message: '真实下单必须 LIVE_MARKET_DATA_PROVIDER=licensed_configured',
    });
  }
  if (provider === 'licensed_configured' && !ctx.env.LIVE_LICENSED_QUOTE_URL_TEMPLATE) {
    ctx.results.push({
      key: 'LIVE_LICENSED_QUOTE_URL_TEMPLATE',
      level: 'error',
      message: 'licensed_configured 必须同时配置 quote URL 模板',
    });
  }
}

function checkBrokerGateway(ctx: RuleCtx): void {
  const gateway = String(ctx.env.LIVE_BROKER_GATEWAY || '').trim();
  const ordersEnabled = String(ctx.env.LIVE_ORDER_EXECUTION_ENABLED || '').toLowerCase() === 'true';
  if (!ordersEnabled) return;
  if (!['qmt_bridge', 'ptrade_bridge'].includes(gateway)) {
    ctx.results.push({
      key: 'LIVE_BROKER_GATEWAY',
      level: 'error',
      message: `真实下单必须 LIVE_BROKER_GATEWAY ∈ {qmt_bridge, ptrade_bridge}，当前 ${gateway || 'unset'}`,
    });
  }
}

/**
 * production 强制校验入口；非 production 直接返回。
 * 返回 true 表示通过，false 表示有 error 级失败（调用方决定是否 exit）。
 */
export function runProductionPreflight(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NODE_ENV !== 'production') return true;

  const ctx: RuleCtx = { results: [], env };

  // 鉴权
  requireSecret(ctx, 'JWT_SECRET', 32);
  requireSecret(ctx, 'JWT_REFRESH_SECRET', 32);

  // 数据库
  requireEnv(ctx, 'DB_HOST');
  requireEnv(ctx, 'DB_NAME');
  requireEnv(ctx, 'DB_USER');
  requireEnv(ctx, 'DB_PASSWORD');

  // CORS
  checkAllowedOrigins(ctx);

  // Admin bootstrap：仅在 users 表可能为空时需要，但 production 缺它就拒
  // 注：这里只校验配了 → 不校验值的强度（密码强度交给数据库 bcrypt + 用户改密流程）
  requireEnv(
    ctx,
    'LIVE_ADMIN_BOOTSTRAP_PASSWORD',
    'production 必须显式配置；用于首次启动 bootstrap admin'
  );

  // 内部 API key
  requireSecret(ctx, 'INTERNAL_API_KEY', 16);

  // DB 半启动开关：production 不能开
  if (String(env.LIVE_TRADING_ALLOW_DB_OFFLINE || '').toLowerCase() === 'true') {
    ctx.results.push({
      key: 'LIVE_TRADING_ALLOW_DB_OFFLINE',
      level: 'error',
      message: 'production 禁止 DB 半启动模式',
    });
  }

  // 实盘开关组合
  const tradingEnabled = String(env.LIVE_TRADING_ENABLED || '').toLowerCase() === 'true';
  const executionEnabled = String(env.LIVE_ORDER_EXECUTION_ENABLED || '').toLowerCase() === 'true';
  if (executionEnabled && !tradingEnabled) {
    ctx.results.push({
      key: 'LIVE_ORDER_EXECUTION_ENABLED',
      level: 'error',
      message: 'LIVE_ORDER_EXECUTION_ENABLED=true 时 LIVE_TRADING_ENABLED 也必须为 true',
    });
  }

  // Bridge & licensed quote
  if (tradingEnabled) {
    checkBridgeSecrets(ctx);
    requireEnv(ctx, 'LIVE_BROKER_GATEWAY');
    checkBrokerGateway(ctx);
    checkLicensedQuote(ctx);
  }

  // 灰度风控阈值 warn
  if (executionEnabled) {
    checkRiskLimitsForGrayscale(ctx);
  }

  // 输出
  const errors = ctx.results.filter(r => r.level === 'error');
  const warns = ctx.results.filter(r => r.level === 'warn');
  if (warns.length) {
    for (const w of warns) {
      console.warn(`[preflight WARN] ${w.key}: ${w.message}`);
    }
  }
  if (errors.length) {
    console.error('==============================================');
    console.error('[preflight] production 启动预检失败：');
    for (const e of errors) {
      console.error(`  - ${e.key}: ${e.message}`);
    }
    console.error('==============================================');
    console.error(
      'fix：参照 backend/.env.example.production 列出的 [MUST] 项；详细解释 docs/live_trading_launch_checklist.md §1.2'
    );
    return false;
  }
  console.log('[preflight] production env 校验通过');
  return true;
}

export const __TESTING__ = {
  PLACEHOLDER_PATTERNS,
  KNOWN_LEAKED_SECRETS,
  WEAK_PASSWORDS,
};
