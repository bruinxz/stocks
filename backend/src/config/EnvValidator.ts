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
 *     - REQUIRED_ALWAYS：DB 连接 / JWT_SECRET / TradingAgents URL —— 任何
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

import Joi from 'joi';

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
  'your_jwt_secret_key_here',
  'your-secret-key-change-in-production',
  'your_feishu_app_id',
  'your_feishu_app_secret',
  'your_tushare_token_here',
  'change-me',
  'replace-me',
  'TODO',
]);

/** Feishu channel 任一关键 env 提供时即视为"开启"，缺其它字段升级 error */
export const FEISHU_REQUIRED_GROUP: readonly string[] = Object.freeze([
  'FEISHU_APP_ID',
  'FEISHU_APP_SECRET',
]);

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
 * - JWT_SECRET —— auth 中间件，缺失退回不安全 fallback
 * - TRADING_AGENTS_URL —— AI 投研 / 公告 NLP / KOL 等 6+ feature 共用
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
    JWT_EXPIRES_IN: Joi.string().default('7d'),

    // ----------- 必填: TradingAgents -----------
    TRADING_AGENTS_URL: Joi.string().uri().required(),

    // ----------- 可选: Feishu Bot -----------
    FEISHU_APP_ID: Joi.string().allow('').optional(),
    FEISHU_APP_SECRET: Joi.string().allow('').optional(),
    // 多维表格 (Bitable) 已弃用 — 改走 webhook 卡片统一推送
    FEISHU_BITABLE_APP_TOKEN: Joi.string().allow('').optional().strip(),
    FEISHU_BITABLE_TABLE_ID: Joi.string().allow('').optional().strip(),
    FEISHU_BITABLE_URL: Joi.string().allow('').optional().strip(),
    FEISHU_MESSAGE_MAX_LENGTH: Joi.number().integer().min(100).max(50000).default(12000),
    FEISHU_RECOMMENDATION_BOT_WEBHOOK: Joi.string().uri().allow('').optional(),
    FEISHU_BOT_WEBHOOK: Joi.string().uri().allow('').optional(),

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
export function isPlaceholderValue(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
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
  const PLACEHOLDER_FIELDS = ['JWT_SECRET', 'FEISHU_APP_ID', 'FEISHU_APP_SECRET', 'TUSHARE_TOKEN'];
  for (const field of PLACEHOLDER_FIELDS) {
    const v = env[field];
    if (isPlaceholderValue(v)) {
      if (nodeEnv === 'production') {
        errors.push({
          field,
          message: `${field} 仍为占位符值 "${v}"，production 必须改为真实密钥`,
          category: 'production_required',
        });
      } else {
        warnings.push({
          field,
          message: `${field} 是占位符值 "${v}"，production 部署前必须替换`,
          category: 'placeholder_value',
        });
      }
    }
  }

  // 3. 部分填写的 channel group（任一字段有值则全部必填）
  const channelGroups: Array<{ name: string; fields: readonly string[] }> = [
    { name: 'Feishu Open Platform', fields: FEISHU_REQUIRED_GROUP },
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

  // 4. 可选 channel 全空时只 warn（production 才 warn，development 不啰嗦）
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

  // 5. production 模式下 JWT_SECRET 应足够长
  if (nodeEnv === 'production' && typeof env.JWT_SECRET === 'string') {
    if (env.JWT_SECRET.length < 32) {
      errors.push({
        field: 'JWT_SECRET',
        message: 'production 模式下 JWT_SECRET 长度必须 >= 32 字符（建议 64 字符随机串）',
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
