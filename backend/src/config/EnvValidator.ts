/**
 * EnvValidator — US-068 运维：环境一致性脚本与 .env 验证
 *
 * 设计要点：
 *  1. **joi 作为校验引擎**（项目已有依赖，无需新增 zod / envalid）。Schema 描述
 *     "必填" / "可选但有默认值" / "可选不校验默认值" 三类字段，joi 自带的
 *     `.required()` + `.default()` 已能精准表达全部需求。
 *  2. **结构化输出**：`validateEnv()` 返回 `EnvValidationResult` 含 `ok` /
 *     `errors[]` / `warnings[]` / `validated` 四个字段，而非简单 throw。让
 *     caller (`index.ts` / CLI `check-env`) 自由决定 "立即 exit" 还是 "降级
 *     运行" —— production 必须 exit，CLI 报告型工具显示完整 errors 然后 exit。
 *  3. **必填 vs 可选 4 个分类**：
 *     - REQUIRED_ALWAYS：DB 连接 / JWT_SECRET —— 任何
 *       env 下都必须存在；缺失 = 启动失败。
 *     - REQUIRED_PRODUCTION：production 模式下追加要求（如 JWT_SECRET 必须
 *       非占位符值）；development 模式不强制。
 *     - OPTIONAL_WARN_IF_MISSING：Feishu / SMTP / WeChat / Aliyun SMS —— 缺
 *       失不阻塞启动，但记录到 warnings 让运维知道某些 channel 不可用。
 *     - OPTIONAL_NO_VALIDATION：DISABLE_SCHEDULER / DISABLE_FEISHU_BOT_WEBHOOK
 *       等开关，不在 schema 里 —— 单纯的运行时 boolean 开关。
 *  4. **`shouldExitOnFailure(env)`**：在 production 模式下 errors > 0 一律
 *     exit；development / test 模式可以容忍（让单测无需准备完整 env）。
 *  5. **format functions exported for unit testing**：formatErrorReport /
 *     formatWarningReport 把 result → 可读字符串，让 CLI / index.ts 启动日志 /
 *     单测共享同一报告格式。
 *  6. **`process.env` 注入**: validateEnv(env?: NodeJS.ProcessEnv) 默认 process.env，
 *     单测注入任意 env 对象完全脱离真实环境。同款模式适用未来需要 env 校验的
 *     submodule (e.g. live-trading env subset)。
 *  7. **不读 `.env` 文件**：本模块只校验 `process.env`，不重复 dotenv.config()
 *     的工作。caller 应该在调用前确保 dotenv 已加载（`index.ts` 第 3 行
 *     已经 `dotenv.config()`）。
 */

import { createHash } from 'crypto';
import Joi from 'joi';
import {
  KNOWN_LEAKED_SECRET_FINGERPRINTS,
  secretFingerprint,
} from '../security/leakedSecretFingerprints';
import {
  REPLAY_OPERATIONAL_ENV_NAMES,
  REPLAY_OPERATIONAL_LIMIT_BOUNDS,
} from '../replay/ReplayOperationalLimits';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EnvValidationError {
  field: string;
  message: string;
  category: 'required' | 'production_required' | 'invalid_format';
}

export interface EnvValidationWarning {
  field: string;
  message: string;
  category: 'optional_missing' | 'placeholder_value' | 'production_recommendation';
}

export interface EnvValidationResult {
  ok: boolean;
  errors: EnvValidationError[];
  warnings: EnvValidationWarning[];
  /** validated env 仅在 ok=true 时填充；包含 default 注入后的全部已通过字段 */
  validated: Record<string, string | number | boolean | undefined>;
  /** 实际使用的 NODE_ENV (default development) */
  node_env: string;
}

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 已知占位符值 —— 出现在 production 时升级为 error；development 时只 warn */
export const PLACEHOLDER_VALUES: readonly string[] = Object.freeze([
  'change-me',
  'change_me',
  'placeholder',
  'TODO',
  'REPLACE_ME',
]);

/** Tab6/7 replay 缺任一项都不能安全运行真实 durable worker。 */
export const REPLAY_REQUIRED_GROUP: readonly string[] = Object.freeze([
  'STOCKS_REPLAY_RUNTIME_DIR',
  'DATABASE_URL',
  'STOCKS_REPLAY_MODEL_VERSION',
  'STOCKS_REPLAY_TEMPLATE_HASH',
  'STOCKS_REPLAY_DISCLAIMERS_JSON',
]);

/** Production must pin every worker-capacity and recovery limit explicitly. */
export const REPLAY_OPERATIONAL_REQUIRED_GROUP: readonly string[] = Object.freeze(
  Object.values(REPLAY_OPERATIONAL_ENV_NAMES)
);

const REPLAY_DISCLAIMER_LOCALES = Object.freeze(['zh-CN', 'ja-JP', 'ko-KR'] as const);
const REPLAY_DISCLAIMER_FIELDS = Object.freeze([
  'version',
  'short_text',
  'full_text',
  'language',
  'effective_at',
  'hash',
] as const);
const REPLAY_SEMVER =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const REPLAY_UTC_SECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const REPLAY_SHA256 = /^[0-9a-f]{64}$/;

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function isReplayDisclaimerConfiguration(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const disclaimers = value as Record<string, unknown>;
  if (!hasExactKeys(disclaimers, REPLAY_DISCLAIMER_LOCALES)) return false;
  return REPLAY_DISCLAIMER_LOCALES.every(locale => {
    const raw = disclaimers[locale];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
    const disclaimer = raw as Record<string, unknown>;
    if (!hasExactKeys(disclaimer, REPLAY_DISCLAIMER_FIELDS)) return false;
    const version = disclaimer.version;
    const shortText = disclaimer.short_text;
    const fullText = disclaimer.full_text;
    const effectiveAt = disclaimer.effective_at;
    const digest = disclaimer.hash;
    if (
      typeof version !== 'string' ||
      !REPLAY_SEMVER.test(version) ||
      typeof shortText !== 'string' ||
      shortText.length === 0 ||
      Array.from(shortText).length > 200 ||
      typeof fullText !== 'string' ||
      fullText.length === 0 ||
      Array.from(fullText).length > 4000 ||
      disclaimer.language !== locale ||
      typeof effectiveAt !== 'string' ||
      !REPLAY_UTC_SECONDS.test(effectiveAt) ||
      typeof digest !== 'string' ||
      !REPLAY_SHA256.test(digest) ||
      createHash('sha256').update(fullText, 'utf8').digest('hex') !== digest
    ) {
      return false;
    }
    const parsed = new Date(effectiveAt);
    return (
      Number.isFinite(parsed.getTime()) &&
      parsed.toISOString() === effectiveAt.replace('Z', '.000Z')
    );
  });
}

/** SMTP channel 任一关键 env 提供时即视为"开启"，缺其它字段升级 error */
export const SMTP_REQUIRED_GROUP: readonly string[] = Object.freeze([
  'SMTP_HOST',
  'SMTP_USER',
  'SMTP_PASS',
]);

/** WeChat OA channel 任一关键 env 提供时即视为"开启" */
export const WECHAT_REQUIRED_GROUP: readonly string[] = Object.freeze([
  'WECHAT_APP_ID',
  'WECHAT_APP_SECRET',
]);

/** Aliyun SMS channel 任一关键 env 提供时即视为"开启" */
export const ALIYUN_SMS_REQUIRED_GROUP: readonly string[] = Object.freeze([
  'ALIYUN_SMS_ACCESS_KEY_ID',
  'ALIYUN_SMS_ACCESS_KEY_SECRET',
]);

// ---------------------------------------------------------------------------
// Schema 构造
// ---------------------------------------------------------------------------

/**
 * 必填 schema：任何 env 下都必填。
 * - DB_HOST / DB_PORT / DB_NAME / DB_USER / DB_PASSWORD —— Postgres 连接四件套
 * - REDIS_HOST / REDIS_PORT —— Bull 队列 + redisLock 依赖
 * - JWT_SECRET —— access-token auth trust boundary，缺失时 fail-closed
 * TradingAgents 固定走同机 127.0.0.1:8000，由独立 systemd unit 管理，不再收远程 URL。
 */
function buildBaseSchema(): Joi.ObjectSchema {
  return Joi.object({
    NODE_ENV: Joi.string().valid('development', 'production', 'test').default('development'),
    PORT: Joi.number().integer().min(1).max(65535).default(3000),
    HOST: Joi.string().default('0.0.0.0'),

    // ----------- 必填: DB -----------
    DB_HOST: Joi.string().min(1).required(),
    DB_PORT: Joi.number().integer().min(1).max(65535).default(5432),
    DB_NAME: Joi.string().min(1).required(),
    DB_USER: Joi.string().min(1).required(),
    DB_PASSWORD: Joi.string().min(1).required(),
    DB_SSL: Joi.string().valid('true', 'false').default('false'),

    // ----------- 必填: Redis -----------
    REDIS_HOST: Joi.string().min(1).required(),
    REDIS_PORT: Joi.number().integer().min(1).max(65535).default(6379),
    REDIS_PASSWORD: Joi.string().allow('').optional(),
    REDIS_DB: Joi.number().integer().min(0).max(15).default(0),

    // ----------- 必填: JWT -----------
    JWT_SECRET: Joi.string().min(8).required(),
    JWT_REFRESH_SECRET: Joi.string().min(8).optional(),
    JWT_EXPIRES_IN: Joi.string().default('7d'),
    ENABLE_SECURE_COOKIE: Joi.string().valid('true', 'false').optional(),

    // ----------- production 必填: Tab6/7 durable replay -----------
    STOCKS_REPLAY_RUNTIME_DIR: Joi.string().pattern(/^\//).allow('').optional(),
    DATABASE_URL: Joi.string()
      .uri({ scheme: ['postgres', 'postgresql'] })
      .allow('')
      .optional(),
    STOCKS_REPLAY_MODEL_VERSION: Joi.string()
      .pattern(
        /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
      )
      .allow('')
      .optional(),
    STOCKS_REPLAY_TEMPLATE_HASH: Joi.string()
      .pattern(/^[0-9a-f]{64}$/)
      .allow('')
      .optional(),
    STOCKS_REPLAY_DISCLAIMERS_JSON: Joi.string()
      .max(64 * 1024)
      .allow('')
      .optional(),
    STOCKS_REPLAY_PYTHON: Joi.string().default('python3'),
    STOCKS_REPLAY_CLI_TIMEOUT_MS: Joi.number().integer().min(0).max(3_600_000).default(10000),
    STOCKS_REPLAY_HTTP_WAIT_MS: Joi.number().integer().min(0).max(10000).default(1000),
    STOCKS_REPLAY_CONTROL_TIMEOUT_MS: Joi.number().integer().min(1).max(30000).default(5000),
    STOCKS_REPLAY_WORKER_DEADLINE_SECONDS: Joi.number()
      .integer()
      .min(REPLAY_OPERATIONAL_LIMIT_BOUNDS.worker_deadline_seconds.minimum)
      .max(REPLAY_OPERATIONAL_LIMIT_BOUNDS.worker_deadline_seconds.maximum)
      .default(REPLAY_OPERATIONAL_LIMIT_BOUNDS.worker_deadline_seconds.fallback),
    STOCKS_REPLAY_LEASE_SECONDS: Joi.number()
      .integer()
      .min(REPLAY_OPERATIONAL_LIMIT_BOUNDS.lease_seconds.minimum)
      .max(REPLAY_OPERATIONAL_LIMIT_BOUNDS.lease_seconds.maximum)
      .default(REPLAY_OPERATIONAL_LIMIT_BOUNDS.lease_seconds.fallback),
    STOCKS_REPLAY_MAX_CONCURRENCY: Joi.number()
      .integer()
      .min(REPLAY_OPERATIONAL_LIMIT_BOUNDS.max_concurrency.minimum)
      .max(REPLAY_OPERATIONAL_LIMIT_BOUNDS.max_concurrency.maximum)
      .default(REPLAY_OPERATIONAL_LIMIT_BOUNDS.max_concurrency.fallback),
    STOCKS_REPLAY_MAX_QUEUE_DEPTH: Joi.number()
      .integer()
      .min(REPLAY_OPERATIONAL_LIMIT_BOUNDS.max_queue_depth.minimum)
      .max(REPLAY_OPERATIONAL_LIMIT_BOUNDS.max_queue_depth.maximum)
      .default(REPLAY_OPERATIONAL_LIMIT_BOUNDS.max_queue_depth.fallback),
    STOCKS_REPLAY_SUBMIT_RATE_PER_MINUTE: Joi.number()
      .integer()
      .min(REPLAY_OPERATIONAL_LIMIT_BOUNDS.submit_rate_per_minute.minimum)
      .max(REPLAY_OPERATIONAL_LIMIT_BOUNDS.submit_rate_per_minute.maximum)
      .default(REPLAY_OPERATIONAL_LIMIT_BOUNDS.submit_rate_per_minute.fallback),
    STOCKS_REPLAY_STATUS_RATE_PER_MINUTE: Joi.number()
      .integer()
      .min(REPLAY_OPERATIONAL_LIMIT_BOUNDS.status_rate_per_minute.minimum)
      .max(REPLAY_OPERATIONAL_LIMIT_BOUNDS.status_rate_per_minute.maximum)
      .default(REPLAY_OPERATIONAL_LIMIT_BOUNDS.status_rate_per_minute.fallback),
    STOCKS_REPLAY_RATE_MAX_USERS: Joi.number()
      .integer()
      .min(REPLAY_OPERATIONAL_LIMIT_BOUNDS.rate_max_users.minimum)
      .max(REPLAY_OPERATIONAL_LIMIT_BOUNDS.rate_max_users.maximum)
      .default(REPLAY_OPERATIONAL_LIMIT_BOUNDS.rate_max_users.fallback),

    // ----------- 可选: Feishu Bot -----------
    // Open Platform / Bitable 旧配置已弃用；兼容读取但从 validated env 剥离。
    FEISHU_APP_ID: Joi.string().allow('').optional().strip(),
    FEISHU_APP_SECRET: Joi.string().allow('').optional().strip(),
    FEISHU_BITABLE_APP_TOKEN: Joi.string().allow('').optional().strip(),
    FEISHU_BITABLE_TABLE_ID: Joi.string().allow('').optional().strip(),
    FEISHU_BITABLE_URL: Joi.string().allow('').optional().strip(),
    FEISHU_RECOMMENDATION_BOT_WEBHOOK: Joi.string().uri().allow('').optional(),
    FEISHU_BOT_WEBHOOK: Joi.string().uri().allow('').optional(),
    FEISHU_BOT_WEBHOOK_TIMEOUT_MS: Joi.number().integer().min(500).max(60000).default(10000),
    // US-003 [OPS-003]: dry_run 巡检 / 其他 ops 系统告警的飞书 text-msg 通道.
    // 与 FEISHU_BOT_WEBHOOK (业务推送 card) 分离，避免淹没在日常推送里。
    OPS_ALERT_FEISHU_WEBHOOK: Joi.string().uri().allow('').optional(),
    // 实盘审计专群；严格禁止回退到业务/OPS 群。
    LIVE_ALERT_FEISHU_WEBHOOK: Joi.string().uri().allow('').optional(),
    DISABLE_LIVE_ALERT: Joi.string().optional(),
    LIVE_ALERT_INCLUDE_WARNING: Joi.string().optional(),

    // ----------- 可选: Email SMTP (US-065) -----------
    SMTP_HOST: Joi.string().allow('').optional(),
    SMTP_PORT: Joi.number().integer().min(1).max(65535).default(587),
    SMTP_USER: Joi.string().allow('').optional(),
    SMTP_PASS: Joi.string().allow('').optional(),
    SMTP_SECURE: Joi.string().valid('true', 'false').default('false'),
    SMTP_FROM: Joi.string().allow('').optional(),

    // ----------- 可选: WeChat OA (US-066) -----------
    WECHAT_APP_ID: Joi.string().allow('').optional(),
    WECHAT_APP_SECRET: Joi.string().allow('').optional(),
    WECHAT_TEMPLATE_DAILY_DIGEST: Joi.string().allow('').optional(),
    WECHAT_TEMPLATE_EARNINGS_FORECAST: Joi.string().allow('').optional(),
    WECHAT_TEMPLATE_RISK_ALERT: Joi.string().allow('').optional(),

    // ----------- 可选: Aliyun SMS (US-067) -----------
    ALIYUN_SMS_ACCESS_KEY_ID: Joi.string().allow('').optional(),
    ALIYUN_SMS_ACCESS_KEY_SECRET: Joi.string().allow('').optional(),
    ALIYUN_SMS_REGION: Joi.string().default('cn-hangzhou'),
    ALIYUN_SMS_ENDPOINT: Joi.string().default('dysmsapi.aliyuncs.com'),
    ALIYUN_SMS_SIGN_NAME: Joi.string().allow('').optional(),
    ALIYUN_SMS_TEMPLATE_RISK_ALERT: Joi.string().allow('').optional(),

    // ----------- 可选: Tushare / 数据源 -----------
    TUSHARE_TOKEN: Joi.string().allow('').optional(),
    TUSHARE_PRO_TOKEN: Joi.string().allow('').optional(),
    TUSHARE_ENABLED: Joi.string().valid('true', 'false').default('false'),
    PYTHON_PATH: Joi.string().default('python3'),

    // ----------- 可选: 限流 -----------
    RATE_LIMIT_WINDOW_MS: Joi.number().integer().min(1000).default(900000),
    RATE_LIMIT_MAX_REQUESTS: Joi.number().integer().min(1).default(100),

    // ----------- 可选: Scheduler/Misc 开关 (不强校验) -----------
    DISABLE_SCHEDULER: Joi.string().optional(),
    DISABLE_DEFAULT_TASK_SEED: Joi.string().optional(),
    DISABLE_QUEUE_WORKERS: Joi.string().optional(),
    DISABLE_LIVE_TRADING_BACKGROUND: Joi.string().optional(),
    SKIP_DB_SYNC: Joi.string().optional(),
    SKIP_LEGACY_SCHEMA_REPAIR: Joi.string().optional(),
    SKIP_RECOMMENDATION_RUNTIME_SYNC: Joi.string().optional(),
    SKIP_DEFAULT_USER_INIT: Joi.string().optional(),
    DISABLE_FEISHU_BOT_WEBHOOK: Joi.string().optional(),
    DISABLE_EMAIL_NOTIFICATION: Joi.string().optional(),
    DISABLE_WECHAT_NOTIFICATION: Joi.string().optional(),
    FRONTEND_BASE_URL: Joi.string().uri().allow('').optional(),

    // 测试环境的 sentinel
    ALLOW_WECHAT_BIND_SIMULATE: Joi.string().optional(),
  }).unknown(true); // 允许未列出的 env (project 有十几个 _MS / _COUNT 类调参)
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit testing)
// ---------------------------------------------------------------------------

/**
 * 是否占位符值（development 时 warn / production 时 error）。
 * 空字符串和 undefined 不算占位符（缺失 vs 留默认是不同语义）。
 */
export function isPlaceholderValue(
  value: unknown,
  leakedFingerprints: ReadonlySet<string> = KNOWN_LEAKED_SECRET_FINGERPRINTS
): boolean {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (leakedFingerprints.has(secretFingerprint(trimmed))) return true;
  for (const placeholder of PLACEHOLDER_VALUES) {
    if (trimmed === placeholder) return true;
    if (trimmed.toLowerCase() === placeholder.toLowerCase()) return true;
  }
  return false;
}

/**
 * 检测一组 channel env 是否"部分填写"——即至少一个字段有值但不是全部。
 * 返回 missing 字段列表（caller 升级为 error）。任一字段全空或全填都返回 []。
 */
export function detectPartialChannelGroup(
  env: NodeJS.ProcessEnv,
  group: readonly string[]
): string[] {
  const presentCount = group.filter(field => {
    const v = env[field];
    return typeof v === 'string' && v.trim().length > 0;
  }).length;

  if (presentCount === 0 || presentCount === group.length) {
    return [];
  }
  return group.filter(field => {
    const v = env[field];
    return !v || (typeof v === 'string' && !v.trim());
  });
}

/**
 * 把 joi 校验错误转 EnvValidationError[]。joi.details[] 每条对应一个失败字段。
 */
export function mapJoiErrorsToValidationErrors(
  err: Joi.ValidationError | undefined
): EnvValidationError[] {
  if (!err) return [];
  const out: EnvValidationError[] = [];
  for (const detail of err.details || []) {
    const field = detail.path && detail.path[0] ? String(detail.path[0]) : 'unknown';
    let category: EnvValidationError['category'] = 'invalid_format';
    if (detail.type === 'any.required') {
      category = 'required';
    } else if (
      detail.type === 'string.uri' ||
      detail.type === 'number.base' ||
      detail.type === 'number.integer' ||
      detail.type === 'number.min' ||
      detail.type === 'number.max' ||
      detail.type === 'string.min' ||
      detail.type === 'any.only'
    ) {
      category = 'invalid_format';
    }
    out.push({ field, message: detail.message, category });
  }
  return out;
}

/**
 * 把 ok=true 的 result 渲染为 ANSI-free 单段字符串（适合写日志/stdout/CI 输出）。
 */
export function formatErrorReport(result: EnvValidationResult): string {
  if (result.ok) return 'Environment validation passed';
  const lines: string[] = [];
  lines.push(`Environment validation FAILED (${result.errors.length} error(s)):`);
  for (const err of result.errors) {
    lines.push(`  [${err.category}] ${err.field}: ${err.message}`);
  }
  return lines.join('\n');
}

/**
 * 把 warnings 渲染为可读字符串（即便 ok=true 也可能有 warnings）。
 */
export function formatWarningReport(result: EnvValidationResult): string {
  if (!result.warnings.length) return '';
  const lines: string[] = [];
  lines.push(`Environment validation warnings (${result.warnings.length}):`);
  for (const warn of result.warnings) {
    lines.push(`  [${warn.category}] ${warn.field}: ${warn.message}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * 主校验函数。返回 EnvValidationResult，不 throw。
 * - 默认 env=process.env；单测可注入任意 env 对象。
 * - 默认 schema=buildBaseSchema()；若未来要按 module 拆分可扩展 customSchema 参数。
 */
export function validateEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: { customSchema?: Joi.ObjectSchema } = {}
): EnvValidationResult {
  const schema = options.customSchema || buildBaseSchema();
  const nodeEnv = String(env.NODE_ENV || 'development').toLowerCase();

  const errors: EnvValidationError[] = [];
  const warnings: EnvValidationWarning[] = [];

  // 1. joi 主校验（abortEarly:false 拿到所有错误，stripUnknown:false 保留未知 env）
  const { error, value } = schema.validate(env, { abortEarly: false, stripUnknown: false });
  errors.push(...mapJoiErrorsToValidationErrors(error));

  // 2. 占位符值校验（production = error，development = warning）
  const PLACEHOLDER_FIELDS = [
    'JWT_SECRET',
    'JWT_REFRESH_SECRET',
    'TUSHARE_TOKEN',
    'STOCKS_REPLAY_TEMPLATE_HASH',
  ];
  for (const field of PLACEHOLDER_FIELDS) {
    const v = env[field];
    if (isPlaceholderValue(v)) {
      if (nodeEnv === 'production') {
        errors.push({
          field,
          message: `${field} 命中占位符或已泄漏值，production 必须改为新的随机密钥`,
          category: 'production_required',
        });
      } else {
        warnings.push({
          field,
          message: `${field} 命中占位符或已泄漏值，production 部署前必须替换`,
          category: 'placeholder_value',
        });
      }
    }
  }

  // 3. 部分填写的 channel group（任一字段有值则全部必填）
  const channelGroups: Array<{ name: string; fields: readonly string[] }> = [
    { name: 'Email SMTP', fields: SMTP_REQUIRED_GROUP },
    { name: 'WeChat OA', fields: WECHAT_REQUIRED_GROUP },
    { name: 'Aliyun SMS', fields: ALIYUN_SMS_REQUIRED_GROUP },
  ];
  for (const group of channelGroups) {
    const missing = detectPartialChannelGroup(env, group.fields);
    if (missing.length) {
      // 部分填写 = error（用户已表达启用意图，缺字段直接挡）
      errors.push({
        field: missing.join(', '),
        message: `${group.name} 部分配置：填写了部分字段但缺少 ${missing.join(
          ', '
        )}，启用此通道必须全部填齐`,
        category: 'required',
      });
    }
  }

  // 4. Replay 是 Tab6 Generate 的产品链：部分配置在任何环境都失败；
  // production 中全空也失败，避免 UI 看似可用但每次都返回 503。
  const missingReplay = detectPartialChannelGroup(env, REPLAY_REQUIRED_GROUP);
  if (missingReplay.length) {
    errors.push({
      field: missingReplay.join(', '),
      message: `durable replay 部分配置，缺少 ${missingReplay.join(', ')}`,
      category: 'required',
    });
  }
  const replayAllEmpty = REPLAY_REQUIRED_GROUP.every(field => {
    const configured = env[field];
    return !configured || !configured.trim();
  });
  if (nodeEnv === 'production' && replayAllEmpty) {
    errors.push({
      field: REPLAY_REQUIRED_GROUP.join(', '),
      message: 'production 必须配置完整 durable replay runtime',
      category: 'production_required',
    });
  }
  if (nodeEnv === 'production') {
    const missingOperationalLimits = REPLAY_OPERATIONAL_REQUIRED_GROUP.filter(field => {
      const configured = env[field];
      return configured === undefined || configured.trim() === '';
    });
    if (missingOperationalLimits.length) {
      errors.push({
        field: missingOperationalLimits.join(', '),
        message: `production 必须显式配置 replay 运行上限，缺少 ${missingOperationalLimits.join(
          ', '
        )}`,
        category: 'production_required',
      });
    }
  }
  const workerDeadlineSeconds = Number(value?.STOCKS_REPLAY_WORKER_DEADLINE_SECONDS);
  const leaseSeconds = Number(value?.STOCKS_REPLAY_LEASE_SECONDS);
  if (
    Number.isInteger(workerDeadlineSeconds) &&
    Number.isInteger(leaseSeconds) &&
    leaseSeconds < workerDeadlineSeconds + 5
  ) {
    errors.push({
      field: 'STOCKS_REPLAY_WORKER_DEADLINE_SECONDS, STOCKS_REPLAY_LEASE_SECONDS',
      message: 'STOCKS_REPLAY_LEASE_SECONDS 必须至少比 worker deadline 多 5 秒',
      category: 'invalid_format',
    });
  }
  const disclaimersJson = env.STOCKS_REPLAY_DISCLAIMERS_JSON;
  if (disclaimersJson && disclaimersJson.trim()) {
    try {
      const parsed = JSON.parse(disclaimersJson);
      if (!isReplayDisclaimerConfiguration(parsed)) throw new Error();
    } catch {
      errors.push({
        field: 'STOCKS_REPLAY_DISCLAIMERS_JSON',
        message: 'STOCKS_REPLAY_DISCLAIMERS_JSON 不满足严格 locale/disclaimer 契约',
        category: 'invalid_format',
      });
    }
  }

  // 5. 可选 channel 全空时只 warn（production 才 warn，development 不啰嗦）
  if (nodeEnv === 'production') {
    for (const group of channelGroups) {
      const allEmpty = group.fields.every(field => {
        const v = env[field];
        return !v || (typeof v === 'string' && !v.trim());
      });
      if (allEmpty) {
        warnings.push({
          field: group.fields.join(', '),
          message: `${group.name} 完全未配置，相关推送通道将不可用`,
          category: 'optional_missing',
        });
      }
    }
  }

  // 6. Access and refresh JWTs are separate trust domains. Sharing one
  // secret would let either token class cross the signing-key boundary.
  let effectiveRefreshSecret = env.JWT_REFRESH_SECRET || '';
  if (!effectiveRefreshSecret && nodeEnv !== 'production') {
    effectiveRefreshSecret = env.LIVE_DEV_JWT_REFRESH_SECRET || 'dev-only-refresh-secret';
  }
  if (
    typeof env.JWT_SECRET === 'string' &&
    typeof effectiveRefreshSecret === 'string' &&
    env.JWT_SECRET.length > 0 &&
    env.JWT_SECRET === effectiveRefreshSecret
  ) {
    errors.push({
      field: 'JWT_SECRET, JWT_REFRESH_SECRET',
      message: 'JWT_SECRET 与 JWT_REFRESH_SECRET 必须使用不同的密钥',
      category: 'invalid_format',
    });
  }

  // 7. production 模式下 JWT secret 应足够长，refresh cookie 必须 Secure。
  if (nodeEnv === 'production' && typeof env.JWT_SECRET === 'string') {
    if (env.JWT_SECRET.length < 32) {
      errors.push({
        field: 'JWT_SECRET',
        message: 'production 模式下 JWT_SECRET 长度必须 >= 32 字符（建议 64 字符随机串）',
        category: 'production_required',
      });
    }
  }
  if (nodeEnv === 'production') {
    if (!env.JWT_REFRESH_SECRET) {
      errors.push({
        field: 'JWT_REFRESH_SECRET',
        message: 'production 模式必须配置 JWT_REFRESH_SECRET',
        category: 'production_required',
      });
    } else if (env.JWT_REFRESH_SECRET.length < 32) {
      errors.push({
        field: 'JWT_REFRESH_SECRET',
        message: 'production 模式下 JWT_REFRESH_SECRET 长度必须 >= 32 字符',
        category: 'production_required',
      });
    }
    if (env.ENABLE_SECURE_COOKIE !== 'true') {
      errors.push({
        field: 'ENABLE_SECURE_COOKIE',
        message: 'production 模式必须显式设置 ENABLE_SECURE_COOKIE=true',
        category: 'production_required',
      });
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    validated: errors.length === 0 ? (value as Record<string, any>) : {},
    node_env: nodeEnv,
  };
}

/**
 * production 模式下任何 error 都应 exit；development/test 模式只警告不阻塞
 * （单测无需准备完整 env 文件就能跑）。
 */
export function shouldExitOnFailure(result: EnvValidationResult): boolean {
  if (result.ok) return false;
  return result.node_env === 'production';
}
