import dotenv from 'dotenv';
// Load environment variables immediately to ensure config is available for imports
dotenv.config();

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
import journalRoutes from './api/routes/journal.routes';
import userRoutes from './api/routes/user.routes';
import logRoutes from './api/routes/log.routes';
import internalRoutes from './api/routes/internal.routes';
import quantRoutes from './api/routes/quant.routes';
import todayRoutes from './api/routes/today.routes';
import reviewRoutes from './api/routes/review.routes';
import strategyResearchRoutes from './api/routes/strategyResearch.routes';
import signalTraceRoutes from './api/routes/signalTrace.routes';
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
app.use(
  cors({
    origin: function (origin, callback) {
      // 允许任何来源访问，配合 credentials: true 会动态反射 Origin
      callback(null, true);
    },
    credentials: true, // Allow cookies to be sent
  })
);
app.use(helmet({ crossOriginResourcePolicy: false })); // Allow cross-origin for static files
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Serve static files (like avatars)
ensureUploadsRuntime();
app.use('/uploads', express.static(getUploadsRoot()));

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
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
app.use('/api/journals', journalRoutes);
app.use('/api/users', userRoutes);
app.use('/api/logs', logRoutes);
app.use('/api/internal', internalRoutes); // 给TradingAgents预留的安全数据接口
app.use('/api/quant', quantRoutes);
app.use('/api/today', todayRoutes);
app.use('/api/review', reviewRoutes);
app.use('/api/strategy-research', strategyResearchRoutes);
app.use('/api/signals', signalTraceRoutes);

import { User } from './models/User';
import { AIInvestmentSignal } from './models/AIInvestmentSignal';
import { RecommendationTradeOutcome } from './models/RecommendationTradeOutcome';
import { PaperTradingOrderIntent } from './models/PaperTradingOrderIntent';
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
import { quantStrategyService } from './quant/services/QuantStrategyService';

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

  const syncItems = [
    { model: AIInvestmentSignal, label: 'AIInvestmentSignal' },
    { model: RecommendationTradeOutcome, label: 'RecommendationTradeOutcome' },
    { model: PaperTradingOrderIntent, label: 'PaperTradingOrderIntent' },
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

    app.listen(Number(PORT), HOST, () => {
      console.log(`Server is running on ${HOST}:${PORT}`);
      console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    });
  } catch (error) {
    console.error('Unable to connect to the database:', error);
    console.warn('Starting server without database connection. Some features may be limited.');

    // Start server even without database connection
    app.listen(Number(PORT), HOST, () => {
      console.log(`Server is running on ${HOST}:${PORT} (without database connection)`);
      console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    });
  }
}

initializeApp();

export default app;
