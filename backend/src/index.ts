import dotenv from 'dotenv';
// Load environment variables immediately to ensure config is available for imports
dotenv.config();

// US-068 环境一致性校验 —— 必须在所有其他 import 之前执行（除 dotenv），
// 因为下游 service / config / queue 在 import-time 就读 process.env。
// production 模式下任何缺失立即 exit；development 模式下打印 errors+warnings 继续。
import {
  validateEnv,
  shouldExitOnFailure,
  formatErrorReport,
  formatWarningReport,
} from './config/EnvValidator';

// Phase 0 安全硬化：production 启动预检（缺关键 env 或弱密钥直接退出，避免半启动放流量）
import { runProductionPreflight } from './utils/productionPreflight';

const __envValidationResult = validateEnv();
if (__envValidationResult.errors.length > 0) {
  console.error(formatErrorReport(__envValidationResult));
}
if (__envValidationResult.warnings.length > 0) {
  console.warn(formatWarningReport(__envValidationResult));
}
if (shouldExitOnFailure(__envValidationResult)) {
  console.error('Refusing to start: environment validation failed in production mode');
  process.exit(1);
}

// 再跑 productionPreflight 作为双重保险（针对硬编码 fallback 密钥的额外严格检查）
if (!runProductionPreflight()) {
  // eslint-disable-next-line no-console
  console.error('[startup] production preflight failed, exiting');
  process.exit(1);
}

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import cookieParser from 'cookie-parser';
import { sequelize } from './config/database';
import authRoutes from './api/routes/auth.routes';
import stockRoutes from './api/routes/stock.routes';
import backtestRoutes from './api/routes/backtest.routes';
import strategyRoutes from './api/routes/strategy.routes';
import portfolioRoutes from './api/routes/portfolio.routes';
import marketRoutes from './api/routes/market.routes';
import aiRoutes from './api/routes/ai.routes';
import taskRoutes from './api/routes/task.routes';
import paperTradingRoutes from './api/routes/paperTrading.routes';
import riskAlertRoutes from './api/routes/riskAlert.routes';
import riskRoutes from './api/routes/risk.routes';
import advancedQuantRoutes from './api/routes/advancedQuant.routes';
import journalRoutes from './api/routes/journal.routes';
import userRoutes from './api/routes/user.routes';
import logRoutes from './api/routes/log.routes';
import internalRoutes from './api/routes/internal.routes';
import quantRoutes from './api/routes/quant.routes';
import todayRoutes from './api/routes/today.routes';
import reviewRoutes from './api/routes/review.routes';
import strategyResearchRoutes from './api/routes/strategyResearch.routes';
import signalTraceRoutes from './api/routes/signalTrace.routes';
import liveTradingRoutes from './live-trading/routes/liveTrading.routes';
import factorRoutes from './api/routes/factor.routes';
import sentimentRoutes from './api/routes/sentiment.routes';
import announcementRoutes from './api/routes/announcement.routes';
import settingsRoutes from './api/routes/settings.routes';
import dataRoutes from './api/routes/data.routes';
import macroRoutes from './api/routes/macro.routes';
import bridgeRoutes from './live-trading/routes/bridge.routes';
import './jobs/dataUpdateWorker'; // 初始化数据更新队列处理器
import './jobs/aiPollingWorker'; // 初始化 AI 分析轮询队列处理器
import './jobs/quantBacktestWorker'; // 初始化量化跑分队列处理器
import { schedulerService } from './services/SchedulerService';
import { repairLegacyDevelopmentSchema } from './utils/developmentSchemaRepair';
import { ensureUploadsRuntime, getUploadsRoot } from './utils/runtimePaths';

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const disableScheduler = String(process.env.DISABLE_SCHEDULER || '').toLowerCase() === 'true';
const disableDefaultTaskSeed =
  disableScheduler || String(process.env.DISABLE_DEFAULT_TASK_SEED || '').toLowerCase() === 'true';

// Middleware
// CORS：默认收紧到 ALLOWED_ORIGINS 白名单（逗号分隔），仅在显式 LIVE_TRADING_CORS_RELAX=true 时全反射。
// 这是为了堵 CSRF：实盘下单/kill switch resolve 等高敏感接口走 cookie 鉴权，cors 全开 + credentials=true
// 等于把所有真实下单接口暴露给任意网站。
const allowedOrigins = String(process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const corsRelax = String(process.env.LIVE_TRADING_CORS_RELAX || '').toLowerCase() === 'true';
app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin) {
        // 无 Origin（curl/server-to-server/同源）一律放行
        return callback(null, true);
      }
      if (corsRelax) {
        return callback(null, true);
      }
      if (allowedOrigins.length === 0) {
        // 未配置白名单时默认仅放行 localhost 开发场景
        if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
          return callback(null, true);
        }
        // 静默拒绝（cors 包会自动返回不带 ACAO 头的响应），避免反复 warn
        return callback(null, false);
      }
      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(null, false);
    },
    credentials: true, // Allow cookies to be sent
  })
);
app.use(helmet({ crossOriginResourcePolicy: false })); // Allow cross-origin for static files
app.use(
  express.json({
    limit: process.env.LIVE_BRIDGE_BODY_LIMIT || '2mb',
    // bridge 鉴权需要原始 body 计算 HMAC，挂在 req.rawBody 上供 bridgeAuthMiddleware 使用
    verify: (req: any, _res, buf) => {
      req.rawBody = buf.toString('utf8');
    },
  })
);
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// US-072 Prometheus 指标埋点 —— middleware 必须在所有 route 之前挂载才能拦截每个请求；
// `res.on('finish')` 是异步触发的，挂在最前面也能拿到 req.route（routing 阶段填充）。
import {
  getMetricsContent,
  getMetricsContentType,
  httpMetricsMiddleware,
} from './metrics/PrometheusRegistry';
app.use(httpMetricsMiddleware());

// Serve static files (like avatars)
ensureUploadsRuntime();
app.use('/uploads', express.static(getUploadsRoot()));

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// US-096 运维：系统启动自检页 —— /health/detail
// 5 个外部依赖 + uptime；each timeout protected；总永远 200，正文表达失败。
// 设计 / 单测 见 src/services/SystemHealthDetailService.ts。
import axios from 'axios';
import {
  buildDefaultProbeFns,
  collectSystemHealthDetail,
} from './services/SystemHealthDetailService';
import { redisLock } from './utils/redisLock';
app.get('/health/detail', async (_req, res) => {
  try {
    const probes = buildDefaultProbeFns({
      sequelize: { query: (sql: string) => sequelize.query(sql) },
      redisHealthCheck: () => redisLock.healthCheck(),
      httpGet: (url, opts) => axios.get(url, { timeout: opts.timeout }),
      tradingAgentsUrl: process.env.TRADING_AGENTS_URL || 'http://47.93.224.109:8000',
    });
    const detail = await collectSystemHealthDetail(probes);
    res.json(detail);
  } catch (error: any) {
    // 保守兜底：collectSystemHealthDetail 内部不应抛出，但若构造 probes 时配置严重缺失
    // 仍可能炸 —— 返回 200 + 全 fail，让监控显示"自检本身坏了"。
    res.json({
      db: 'fail',
      redis: 'fail',
      tradingAgents: 'fail',
      akshare: 'fail',
      feishu: 'fail',
      uptime_seconds: Math.floor(process.uptime()),
      probe_construction_error: String(error?.message || error),
    });
  }
});

// US-072 Prometheus /metrics endpoint —— 暴露 Prometheus 抓取端
// 故意 *不加鉴权*：Prometheus scraper 通常在内网 + 通过 reverse proxy / firewall 控访问；
// 任何 auth middleware 都会让 scraping 失败。Content-Type 必须按 prom-client 约定。
app.get('/metrics', async (_req, res) => {
  try {
    res.setHeader('Content-Type', getMetricsContentType());
    res.send(await getMetricsContent());
  } catch (error: any) {
    res.status(500).send(`# metrics collection error: ${error?.message || error}`);
  }
});

// Basic route
app.get('/', (req, res) => {
  res.json({ message: 'A-Share Stock Backtesting API', version: '1.0.0' });
});

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/stocks', stockRoutes);
app.use('/api/backtests', backtestRoutes);
app.use('/api/strategies', strategyRoutes);
app.use('/api/portfolio', portfolioRoutes);
app.use('/api/market', marketRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/paper-trading', paperTradingRoutes);
app.use('/api/risk-alerts', riskAlertRoutes);
app.use('/api/risk', riskRoutes);
app.use('/api/advanced-quant', advancedQuantRoutes);
app.use('/api/journals', journalRoutes);
app.use('/api/users', userRoutes);
app.use('/api/logs', logRoutes);
app.use('/api/internal', internalRoutes); // 给TradingAgents预留的安全数据接口
app.use('/api/quant', quantRoutes);
app.use('/api/today', todayRoutes);
app.use('/api/review', reviewRoutes);
app.use('/api/strategy-research', strategyResearchRoutes);
app.use('/api/signals', signalTraceRoutes);
// bridge 路由必须比 liveTradingRoutes **先**挂载，否则会被前者全局 authController.authenticate 拦下
app.use('/api/live-trading/bridge', bridgeRoutes);
app.use('/api/live-trading', liveTradingRoutes);
app.use('/api/factors', factorRoutes);
app.use('/api/sentiment', sentimentRoutes);
app.use('/api/announcements', announcementRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/data', dataRoutes);
app.use('/api/macro', macroRoutes);

// US-070 OpenAPI / Swagger UI —— 仅 development 模式暴露 /api-docs（不需鉴权方便联调）
// production 默认禁用避免泄露内部 endpoint 列表；通过 ENABLE_SWAGGER_UI=true 可强制开启
import { buildOpenApiSpec, shouldExposeSwaggerUI } from './config/swagger';
import swaggerUi from 'swagger-ui-express';
if (shouldExposeSwaggerUI()) {
  const openApiSpec = buildOpenApiSpec();
  app.use(
    '/api-docs',
    swaggerUi.serve,
    swaggerUi.setup(openApiSpec, {
      swaggerOptions: { persistAuthorization: true },
      customSiteTitle: 'A-Share Quant Platform API Docs',
    })
  );
  // 同时暴露 raw JSON 让客户端 codegen 工具直接拉取
  app.get('/api-docs.json', (_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.send(openApiSpec);
  });
}

import { User } from './models/User';
import { AIInvestmentSignal } from './models/AIInvestmentSignal';
import { RecommendationTradeOutcome } from './models/RecommendationTradeOutcome';
import { PaperTradingOrderIntent } from './models/PaperTradingOrderIntent';
import { PaperTradingOrderIntentOutcome } from './models/PaperTradingOrderIntentOutcome';
import { PaperTradingCanaryReviewSnapshot } from './models/PaperTradingCanaryReviewSnapshot';
import { RecommendationLoopPolicySnapshot } from './models/RecommendationLoopPolicySnapshot';
import { BudgetPolicyVersionSnapshot } from './models/BudgetPolicyVersionSnapshot';
import { QuantStrategyModel } from './models/QuantStrategyModel';
import { QuantBacktestTask } from './models/QuantBacktestTask';
import { QuantBacktestResult } from './models/QuantBacktestResult';
import { QuantBacktestTrade } from './models/QuantBacktestTrade';
import { QuantSignal } from './models/QuantSignal';
import { QuantStrategyPerformanceSnapshot } from './models/QuantStrategyPerformanceSnapshot';
import { QuantStrategyWeight } from './models/QuantStrategyWeight';
import { QuantStrategyExperiment } from './models/QuantStrategyExperiment';
import { QuantStrategyParamVersion } from './models/QuantStrategyParamVersion';
import { QuantStrategyParamValidation } from './models/QuantStrategyParamValidation';
import { QuantFusionAudit } from './models/QuantFusionAudit';
import { TaskParameterAuditLog } from './models/TaskParameterAuditLog';
import { RealtimeQuote } from './models/RealtimeQuote';
import { StockFundamentalFactor } from './models/StockFundamentalFactor';
import { StockMoneyFlowFactor } from './models/StockMoneyFlowFactor';
import { StockValuationFactor } from './models/StockValuationFactor';
import { LiveBrokerAccount } from './models/LiveBrokerAccount';
import { LiveAccountSnapshot } from './models/LiveAccountSnapshot';
import { LivePosition } from './models/LivePosition';
import { LiveOrderDraft } from './models/LiveOrderDraft';
import { LiveOrder } from './models/LiveOrder';
import { LiveTrade } from './models/LiveTrade';
import { LiveExecutionAuditLog } from './models/LiveExecutionAuditLog';
import { LiveKillSwitchState } from './models/LiveKillSwitchState';
import { LiveBrokerCommand } from './models/LiveBrokerCommand';
import { LiveBrokerCommandDispatch } from './models/LiveBrokerCommandDispatch';
import { LiveBrokerEvent } from './models/LiveBrokerEvent';
import { LiveBrokerBridgeHeartbeat } from './models/LiveBrokerBridgeHeartbeat';
import { LiveBridgeNonce } from './models/LiveBridgeNonce';
import { killSwitchService } from './live-trading/services/KillSwitchService';
import { bridgeCommandExpiryService } from './live-trading/services/BridgeCommandExpiryService';
// main 上 QuantStrategyService 位于 quant/engine/internal/，dev_lym 旧路径 quant/services/ 已不存在
import { quantStrategyService } from './quant/engine/internal/QuantStrategyService';

async function publicTableExists(tableName: string): Promise<boolean> {
  const [rows] = await sequelize.query(
    `
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = :tableName
      LIMIT 1
    `,
    { replacements: { tableName } }
  );

  return (rows as any[]).length > 0;
}

async function publicColumnExists(tableName: string, columnName: string): Promise<boolean> {
  const [rows] = await sequelize.query(
    `
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = :tableName
        AND column_name = :columnName
      LIMIT 1
    `,
    { replacements: { tableName, columnName } }
  );

  return (rows as any[]).length > 0;
}

async function publicIndexExists(indexName: string): Promise<boolean> {
  const [rows] = await sequelize.query(
    `
      SELECT 1
      FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = :indexName
      LIMIT 1
    `,
    { replacements: { indexName } }
  );

  return (rows as any[]).length > 0;
}

async function dropPublicIndexIfExists(indexName: string): Promise<void> {
  if (!(await publicIndexExists(indexName))) {
    return;
  }

  try {
    await sequelize.query(`DROP INDEX IF EXISTS "${indexName}"`);
    console.log(`Dropped legacy runtime schema index ${indexName}`);
  } catch (error: any) {
    console.warn(`Failed to drop legacy runtime schema index ${indexName}:`, error?.message || error);
  }
}

async function dropLegacyLiveBrokerAccountUniqueIndexes(): Promise<void> {
  if (!(await publicTableExists('live_broker_accounts'))) {
    return;
  }

  const [rows] = await sequelize.query(
    `
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'live_broker_accounts'
        AND indexdef ILIKE '%UNIQUE%'
        AND indexdef LIKE '%"user_id"%'
        AND indexdef LIKE '%"broker_key"%'
    `
  );

  for (const row of rows as Array<{ indexname: string }>) {
    await dropPublicIndexIfExists(row.indexname);
  }
}

async function createPublicIndexIfMissing(
  table: string,
  indexName: string,
  columns: string[],
  unique = false,
  whereClause?: string
): Promise<void> {
  if (!(await publicTableExists(table)) || (await publicIndexExists(indexName))) {
    return;
  }

  const uniqueSql = unique ? 'UNIQUE ' : '';
  const columnSql = columns.map(column => `"${column}"`).join(', ');
  const whereSql = whereClause ? ` WHERE ${whereClause}` : '';
  try {
    await sequelize.query(
      `CREATE ${uniqueSql}INDEX "${indexName}" ON "${table}" (${columnSql})${whereSql}`
    );
    console.log(`Added runtime schema index ${indexName}`);
  } catch (error: any) {
    console.warn(`Failed to add runtime schema index ${indexName}:`, error?.message || error);
  }
}

async function ensureRecommendationLoopRuntimeSchema() {
  const indexedAdditions = [
    {
      table: 'ai_investment_signals',
      column: 'loop_run_id',
      index: 'idx_ai_investment_signals_loop_run_id',
    },
    {
      table: 'recommendation_trade_outcomes',
      column: 'loop_run_id',
      index: 'idx_recommendation_trade_outcomes_loop_run_id',
    },
    {
      table: 'recommendation_loop_policy_snapshots',
      column: 'loop_run_id',
      index: 'idx_loop_policy_snapshots_loop_run_id',
    },
  ];

  for (const item of indexedAdditions) {
    if (!(await publicTableExists(item.table))) {
      continue;
    }

    const hasColumn = await publicColumnExists(item.table, item.column);
    if (!hasColumn) {
      try {
        await sequelize.query(
          `ALTER TABLE "${item.table}" ADD COLUMN "${item.column}" VARCHAR(80)`
        );
        console.log(`Added runtime schema column ${item.table}.${item.column}`);
      } catch (error: any) {
        // 线上历史库可能存在 owner=postgres 的表；字段兼容失败不应阻断新量化表创建。
        console.warn(
          `Failed to add runtime schema column ${item.table}.${item.column}:`,
          error?.message || error
        );
        continue;
      }
    }

    const hasIndex = await publicIndexExists(item.index);
    if (!hasIndex) {
      try {
        await sequelize.query(`CREATE INDEX "${item.index}" ON "${item.table}" ("${item.column}")`);
        console.log(`Added runtime schema index ${item.index}`);
      } catch (error: any) {
        console.warn(`Failed to add runtime schema index ${item.index}:`, error?.message || error);
      }
    }
  }

  await ensureQuantStrategyRuntimeSchema();
}

async function addColumnIfMissing(
  table: string,
  column: string,
  definition: string
): Promise<boolean> {
  if (!(await publicTableExists(table))) {
    return false;
  }

  const hasColumn = await publicColumnExists(table, column);
  if (hasColumn) {
    return true;
  }

  try {
    await sequelize.query(`ALTER TABLE "${table}" ADD COLUMN "${column}" ${definition}`);
    console.log(`Added runtime schema column ${table}.${column}`);
    return true;
  } catch (error: any) {
    console.warn(
      `Failed to add runtime schema column ${table}.${column}:`,
      error?.message || error
    );
    return false;
  }
}

async function ensureQuantStrategyRuntimeSchema() {
  if (!(await publicTableExists('quant_strategies'))) {
    return;
  }

  const additions = [
    {
      column: 'execution_policy',
      definition: `JSONB NOT NULL DEFAULT '{}'::jsonb`,
    },
    {
      column: 'environment_policy',
      definition: `JSONB NOT NULL DEFAULT '{}'::jsonb`,
    },
    {
      column: 'lifecycle_policy',
      definition: `JSONB NOT NULL DEFAULT '{}'::jsonb`,
    },
    {
      column: 'notes',
      definition: 'TEXT',
    },
    {
      column: 'display_order',
      definition: 'INTEGER',
    },
  ];

  for (const item of additions) {
    await addColumnIfMissing('quant_strategies', item.column, item.definition);
  }

  const jsonbDefaults = ['execution_policy', 'environment_policy', 'lifecycle_policy'];
  for (const column of jsonbDefaults) {
    if (await publicColumnExists('quant_strategies', column)) {
      try {
        await sequelize.query(
          `UPDATE "quant_strategies" SET "${column}" = '{}'::jsonb WHERE "${column}" IS NULL`
        );
      } catch (error: any) {
        console.warn(`Failed to normalize quant_strategies.${column}:`, error?.message || error);
      }
    }
  }
}

async function ensureTaskExecutionLogRuntimeSchema() {
  if (!(await publicTableExists('task_execution_logs'))) {
    return;
  }

  await addColumnIfMissing(
    'task_execution_logs',
    'result_summary',
    `JSONB NOT NULL DEFAULT '{}'::jsonb`
  );
}

async function ensureLiveTradingRuntimeSchema() {
  if (await publicTableExists('live_broker_accounts')) {
    await addColumnIfMissing('live_broker_accounts', 'broker_account_key', 'VARCHAR(160)');
    await addColumnIfMissing('live_broker_accounts', 'bridge_key', 'VARCHAR(120)');
    await addColumnIfMissing(
      'live_broker_accounts',
      'account_role',
      `VARCHAR(30) NOT NULL DEFAULT 'main'`
    );

    await sequelize.query(
      `
        UPDATE "live_broker_accounts"
        SET "account_role" = 'main'
        WHERE "account_role" IS NULL OR "account_role" = ''
      `
    );
    await sequelize.query(
      `
        UPDATE "live_broker_accounts"
        SET "broker_account_key" = "broker_key" || ':' || "account_role" || ':' || COALESCE(NULLIF("account_no_masked", ''), '未绑定')
        WHERE "broker_account_key" IS NULL OR "broker_account_key" = ''
      `
    );

    await dropLegacyLiveBrokerAccountUniqueIndexes();
    await createPublicIndexIfMissing(
      'live_broker_accounts',
      'idx_live_broker_accounts_user_account_key_unique',
      ['user_id', 'broker_account_key'],
      true,
      '"broker_account_key" IS NOT NULL'
    );
    await createPublicIndexIfMissing(
      'live_broker_accounts',
      'idx_live_broker_accounts_bridge_key_unique',
      ['bridge_key'],
      true,
      '"bridge_key" IS NOT NULL'
    );
    await createPublicIndexIfMissing(
      'live_broker_accounts',
      'idx_live_broker_accounts_account_role',
      ['account_role']
    );
  }

  if (await publicTableExists('live_orders')) {
    await addColumnIfMissing('live_orders', 'client_order_id', 'VARCHAR(100)');
    await addColumnIfMissing('live_orders', 'bridge_status', 'VARCHAR(30)');
    await createPublicIndexIfMissing(
      'live_orders',
      'idx_live_orders_client_order_id_unique',
      ['client_order_id'],
      true,
      '"client_order_id" IS NOT NULL'
    );
    await createPublicIndexIfMissing(
      'live_orders',
      'idx_live_orders_bridge_status',
      ['bridge_status']
    );
    // P1 review：bridge ingestOrders 用 (account_id, broker_order_id) 做幂等 lookup；
    // 没有 unique 兜底时并发会产生重复 LiveOrder 行
    await createPublicIndexIfMissing(
      'live_orders',
      'idx_live_orders_account_broker_order_id_unique',
      ['account_id', 'broker_order_id'],
      true,
      '"broker_order_id" IS NOT NULL'
    );
  }

  // LiveTrade.broker_trade_id 唯一索引（partial），review #5 P0
  if (await publicTableExists('live_trades')) {
    await createPublicIndexIfMissing(
      'live_trades',
      'idx_live_trades_broker_trade_id_unique',
      ['broker_trade_id'],
      true,
      '"broker_trade_id" IS NOT NULL'
    );
  }

  // live_kill_switch_states：表本身由 sequelize sync 创建（见 syncRuntimeModel）；
  // 这里只补幂等的"活跃唯一性"部分索引（同一时间只允许 1 条 active=true 记录）。
  if (await publicTableExists('live_kill_switch_states')) {
    await createPublicIndexIfMissing(
      'live_kill_switch_states',
      'idx_live_kill_switch_states_active_unique',
      ['active'],
      true,
      '"active" = true'
    );
  }

  // bridge 命令与事件唯一约束 + 高频查询复合索引
  if (await publicTableExists('live_broker_commands')) {
    await createPublicIndexIfMissing(
      'live_broker_commands',
      'idx_live_broker_commands_client_order_id_unique',
      ['client_order_id'],
      true
    );
    await createPublicIndexIfMissing(
      'live_broker_commands',
      'idx_live_broker_commands_account_status_created',
      ['account_id', 'status', 'created_at']
    );
  }
  if (await publicTableExists('live_broker_events')) {
    await createPublicIndexIfMissing(
      'live_broker_events',
      'idx_live_broker_events_command_seq_unique',
      ['command_id', 'event_seq'],
      true
    );
  }
  // dispatch 未 ack 行的 partial 索引，避免全列索引浪费
  if (await publicTableExists('live_broker_command_dispatches')) {
    await createPublicIndexIfMissing(
      'live_broker_command_dispatches',
      'idx_live_broker_dispatches_pending_ack',
      ['command_id', 'bridge_key'],
      false,
      '"acked_at" IS NULL'
    );
  }
  // bridge nonce 过期清理索引（runtime 已有 expires_at 索引，无需额外）
}

async function syncRuntimeModel(model: any, label: string): Promise<boolean> {
  try {
    await model.sync();
    console.log(`${label} table checked successfully`);
    return true;
  } catch (error: any) {
    // 单表权限/索引异常不应让后续新增表全部跳过；部署脚本会补齐 owner/grant。
    console.warn(`Failed to sync ${label} table:`, error?.message || error);
    return false;
  }
}

async function syncRecommendationRuntimeTables(): Promise<void> {
  await ensureRecommendationLoopRuntimeSchema();
  await ensureTaskExecutionLogRuntimeSchema();
  await ensureLiveTradingRuntimeSchema();

  const syncItems = [
    { model: AIInvestmentSignal, label: 'AIInvestmentSignal' },
    { model: RecommendationTradeOutcome, label: 'RecommendationTradeOutcome' },
    { model: PaperTradingOrderIntent, label: 'PaperTradingOrderIntent' },
    { model: PaperTradingOrderIntentOutcome, label: 'PaperTradingOrderIntentOutcome' },
    { model: PaperTradingCanaryReviewSnapshot, label: 'PaperTradingCanaryReviewSnapshot' },
    { model: RecommendationLoopPolicySnapshot, label: 'RecommendationLoopPolicySnapshot' },
    { model: BudgetPolicyVersionSnapshot, label: 'BudgetPolicyVersionSnapshot' },
    { model: QuantStrategyModel, label: 'QuantStrategyModel' },
    { model: QuantBacktestTask, label: 'QuantBacktestTask' },
    { model: QuantBacktestResult, label: 'QuantBacktestResult' },
    { model: QuantBacktestTrade, label: 'QuantBacktestTrade' },
    { model: QuantSignal, label: 'QuantSignal' },
    { model: QuantStrategyPerformanceSnapshot, label: 'QuantStrategyPerformanceSnapshot' },
    { model: QuantStrategyWeight, label: 'QuantStrategyWeight' },
    { model: QuantStrategyExperiment, label: 'QuantStrategyExperiment' },
    { model: QuantStrategyParamVersion, label: 'QuantStrategyParamVersion' },
    { model: QuantStrategyParamValidation, label: 'QuantStrategyParamValidation' },
    { model: QuantFusionAudit, label: 'QuantFusionAudit' },
    { model: RealtimeQuote, label: 'RealtimeQuote' },
    { model: StockFundamentalFactor, label: 'StockFundamentalFactor' },
    { model: StockMoneyFlowFactor, label: 'StockMoneyFlowFactor' },
    { model: StockValuationFactor, label: 'StockValuationFactor' },
    { model: TaskParameterAuditLog, label: 'TaskParameterAuditLog' },
    { model: LiveBrokerAccount, label: 'LiveBrokerAccount' },
    { model: LiveAccountSnapshot, label: 'LiveAccountSnapshot' },
    { model: LivePosition, label: 'LivePosition' },
    { model: LiveOrderDraft, label: 'LiveOrderDraft' },
    { model: LiveOrder, label: 'LiveOrder' },
    { model: LiveTrade, label: 'LiveTrade' },
    { model: LiveExecutionAuditLog, label: 'LiveExecutionAuditLog' },
    { model: LiveKillSwitchState, label: 'LiveKillSwitchState' },
    { model: LiveBrokerCommand, label: 'LiveBrokerCommand' },
    { model: LiveBrokerCommandDispatch, label: 'LiveBrokerCommandDispatch' },
    { model: LiveBrokerEvent, label: 'LiveBrokerEvent' },
    { model: LiveBrokerBridgeHeartbeat, label: 'LiveBrokerBridgeHeartbeat' },
    { model: LiveBridgeNonce, label: 'LiveBridgeNonce' },
  ];

  const results = [];
  for (const item of syncItems) {
    results.push(await syncRuntimeModel(item.model, item.label));
  }

  try {
    await quantStrategyService.syncRegistry();
    console.log('Quant strategy registry checked successfully');
  } catch (error: any) {
    console.warn('Failed to sync quant strategy registry:', error?.message || error);
  }

  await ensureRecommendationLoopRuntimeSchema();

  const failedCount = results.filter(result => !result).length;
  if (failedCount > 0) {
    console.warn(`Recommendation runtime schema check completed with ${failedCount} warning(s)`);
  } else {
    console.log('Recommendation runtime schema check completed successfully');
  }
}

// Initialize database connection and start server
async function initializeApp() {
  try {
    // Test database connection
    await sequelize.authenticate();
    console.log('Database connection has been established successfully.');

    await repairLegacyDevelopmentSchema();

    // 生产环境当前没有独立 migration runner；新闭环收益表必须在启动时幂等创建，
    // 以免定时任务先于开发环境 alter 同步执行导致接口 500。
    try {
      await syncRecommendationRuntimeTables();
    } catch (schemaError: any) {
      console.warn(
        'Failed to sync recommendation loop tables:',
        schemaError?.message || schemaError
      );
    }

    // Sync models in development environment
    if (process.env.NODE_ENV === 'development') {
      console.log('Syncing database models...');
      try {
        await sequelize.sync({ alter: true }); // 创建缺失的表并修改现有表结构
        console.log('Database models synced successfully with alter: true');

        const lymCount = await User.count({ where: { username: 'lym' } });
        if (lymCount === 0) {
          await User.create({
            username: 'lym',
            password_hash: '666',
            email: 'lym@example.com',
            role: 'admin',
            is_active: true,
          });
          console.log('Default admin user "lym" created successfully');
        }

        if (disableDefaultTaskSeed) {
          console.log('Default scheduled task seeding skipped by environment flag');
        } else {
          await schedulerService.ensureDefaultTasks();
          console.log('Default scheduled tasks checked successfully');
        }
      } catch (error: any) {
        console.warn('Database sync failed, continuing with existing schema:', error.message);
        console.warn('Error details:', error);

        // 尝试单独同步DataUpdateLog表（重要表）
        try {
          console.log('Attempting to sync DataUpdateLog table separately...');
          const DataUpdateLogModel = sequelize.models.DataUpdateLog;
          if (DataUpdateLogModel) {
            await DataUpdateLogModel.sync();
            console.log('DataUpdateLog table synced successfully');
          }
        } catch (logSyncError) {
          console.warn('Failed to sync DataUpdateLog table:', logSyncError.message);
        }

        // 全量 alter 可能被旧表结构阻断；确保组合收益模拟核心表仍可独立创建。
        try {
          console.log('Attempting to sync PortfolioSimulation table separately...');
          const PortfolioSimulationModel = sequelize.models.PortfolioSimulation;
          if (PortfolioSimulationModel) {
            await PortfolioSimulationModel.sync();
            console.log('PortfolioSimulation table synced successfully');
          }
        } catch (portfolioSyncError) {
          console.warn('Failed to sync PortfolioSimulation table:', portfolioSyncError.message);
        }

        // 确保数据源健康状态表可独立创建。
        try {
          console.log('Attempting to sync DataSourceHealth table separately...');
          const DataSourceHealthModel = sequelize.models.DataSourceHealth;
          if (DataSourceHealthModel) {
            await DataSourceHealthModel.sync();
            console.log('DataSourceHealth table synced successfully');
          }
        } catch (dataSourceHealthSyncError) {
          console.warn('Failed to sync DataSourceHealth table:', dataSourceHealthSyncError.message);
        }

        // 确保 AI 投研信号归档表可独立创建。
        try {
          console.log('Attempting to sync AIInvestmentSignal table separately...');
          const AIInvestmentSignalModel = sequelize.models.AIInvestmentSignal;
          if (AIInvestmentSignalModel) {
            await AIInvestmentSignalModel.sync();
            console.log('AIInvestmentSignal table synced successfully');
          }
        } catch (aiSignalSyncError) {
          console.warn('Failed to sync AIInvestmentSignal table:', aiSignalSyncError.message);
        }

        try {
          console.log('Attempting to sync BudgetPolicyVersionSnapshot table separately...');
          const BudgetPolicyVersionSnapshotModel = sequelize.models.BudgetPolicyVersionSnapshot;
          if (BudgetPolicyVersionSnapshotModel) {
            await BudgetPolicyVersionSnapshotModel.sync();
            console.log('BudgetPolicyVersionSnapshot table synced successfully');
          }
        } catch (budgetPolicyVersionSyncError) {
          console.warn(
            'Failed to sync BudgetPolicyVersionSnapshot table:',
            budgetPolicyVersionSyncError.message
          );
        }

        try {
          if (disableDefaultTaskSeed) {
            console.log('Default scheduled task seeding skipped by environment flag');
          } else {
            await schedulerService.ensureDefaultTasks();
            console.log('Default scheduled tasks checked successfully after partial sync');
          }
        } catch (taskSeedError: any) {
          console.warn('Failed to check default scheduled tasks:', taskSeedError.message);
        }
      }
    }

    // 生产环境不执行 sequelize.sync，但默认任务仍需要随版本演进做幂等补齐。
    // ensureDefaultTasks 只会 findOrCreate / 补缺省字段，不会覆盖用户已有 cron 配置。
    try {
      if (disableDefaultTaskSeed) {
        console.log('Default scheduled task seeding skipped by environment flag');
      } else {
        await schedulerService.ensureDefaultTasks();
        console.log('Default scheduled tasks checked successfully');
      }
    } catch (taskSeedError: any) {
      console.warn('Failed to check default scheduled tasks:', taskSeedError.message);
    }

    // Initialize scheduler after development schema repair/sync to avoid stale local schemas
    // blocking server startup or task listing APIs.
    if (disableScheduler) {
      console.log('Scheduler initialization skipped by environment flag');
    } else {
      await schedulerService.initialize();
    }

    // 实盘 kill switch 自动巡检：每 60 秒检查订单失败率/连败/订单数，命中阈值即触发熔断。
    // 仅在数据库可用时启用；NODE_ENV=test 不启动避免污染单元测试。
    // 显式 unref，让 ts-node smoke / CI 跑完不被 timer 阻塞退出。
    if (process.env.NODE_ENV !== 'test') {
      const intervalMs = Math.max(Number(process.env.LIVE_KILL_SWITCH_SCAN_INTERVAL_MS || 60000), 15000);
      const ksTimer = setInterval(async () => {
        try {
          const result = await killSwitchService.runAutoTriggerScan();
          if (result.triggered) {
            console.warn(
              `[kill-switch] auto-triggered: ${result.reasons.join('; ')} (checked=${result.checked})`
            );
          }
        } catch (err: any) {
          console.warn('[kill-switch] auto scan failed:', err?.message || err);
        }
      }, intervalMs);
      ksTimer.unref?.();

      // Bridge 命令 TTL 巡检：默认每 15 秒一次，把 pending/dispatched 超 TTL 的标 expired
      const expiryIntervalMs = Math.max(
        Number(process.env.LIVE_BRIDGE_EXPIRY_SCAN_INTERVAL_MS || 15000),
        5000
      );
      const expTimer = setInterval(async () => {
        try {
          const result = await bridgeCommandExpiryService.runOnce();
          if (result.orders_expired || result.commands_expired) {
            console.warn(
              `[bridge-expiry] expired orders=${result.orders_expired}, commands=${result.commands_expired}`
            );
          }
        } catch (err: any) {
          console.warn('[bridge-expiry] scan failed:', err?.message || err);
        }
      }, expiryIntervalMs);
      expTimer.unref?.();
    }

    app.listen(Number(PORT), HOST, () => {
      console.log(`Server is running on ${HOST}:${PORT}`);
      console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    });
  } catch (error) {
    console.error('Unable to connect to the database:', error);
    // 实盘交易系统：DB 不可用时绝对不能允许"半启动"。
    // 任何 /api/live-trading/* 请求依赖 DB；启动 server 只会让上游误以为健康并把流量灌进来。
    // 仅当显式 LIVE_TRADING_ALLOW_DB_OFFLINE=true 才允许半启动（开发/演示用）；
    // test 环境自动允许半启动，避免 jest/CI 因为没接 DB 而 process.exit。
    const allowDbOffline =
      String(process.env.LIVE_TRADING_ALLOW_DB_OFFLINE || '').toLowerCase() === 'true' ||
      process.env.NODE_ENV === 'test';
    if (!allowDbOffline) {
      console.error('DB connection failed; refusing to start. Set LIVE_TRADING_ALLOW_DB_OFFLINE=true to override.');
      process.exit(1);
    }
    console.warn('Starting server without database connection (override enabled). Many features will 5xx.');
    app.listen(Number(PORT), HOST, () => {
      console.log(`Server is running on ${HOST}:${PORT} (without database connection)`);
      console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    });
  }
}

initializeApp();

export default app;
