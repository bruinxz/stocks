import sequelize from '../config/database';
import { logger } from './logger';
import { ScheduledTask } from '../models/ScheduledTask';
import { TaskExecutionLog } from '../models/TaskExecutionLog';
import { DailyScreener } from '../models/DailyScreener';
import { PaperTradingPortfolio } from '../models/PaperTradingPortfolio';
import { PaperTradingPosition } from '../models/PaperTradingPosition';
import { PaperTradingTrade } from '../models/PaperTradingTrade';
import { PaperTradingSnapshot } from '../models/PaperTradingSnapshot';
import { RiskAlert } from '../models/RiskAlert';
import { TradingJournal } from '../models/TradingJournal';
import { FavoriteStock } from '../models/FavoriteStock';
import { AIInvestmentSignal } from '../models/AIInvestmentSignal';

type ColumnRename = {
  table: string;
  from: string;
  to: string;
};

type ColumnDefinition = {
  table: string;
  column: string;
  definition: string;
};

const LEGACY_COLUMN_RENAMES: ColumnRename[] = [
  // 收藏、自选股
  { table: 'favorite_stocks', from: 'userId', to: 'user_id' },
  { table: 'favorite_stocks', from: 'stockId', to: 'stock_id' },
  { table: 'favorite_stocks', from: 'groupId', to: 'group_id' },
  { table: 'favorite_stocks', from: 'sortOrder', to: 'sort_order' },

  // 模拟交易
  { table: 'paper_trading_portfolios', from: 'userId', to: 'user_id' },
  { table: 'paper_trading_portfolios', from: 'initialCapital', to: 'initial_capital' },
  { table: 'paper_trading_portfolios', from: 'currentCash', to: 'current_cash' },
  { table: 'paper_trading_portfolios', from: 'totalValue', to: 'total_value' },
  { table: 'paper_trading_portfolios', from: 'isActive', to: 'is_active' },
  { table: 'paper_trading_positions', from: 'portfolioId', to: 'portfolio_id' },
  { table: 'paper_trading_positions', from: 'avgCost', to: 'avg_cost' },
  { table: 'paper_trading_positions', from: 'currentPrice', to: 'current_price' },
  { table: 'paper_trading_positions', from: 'marketValue', to: 'market_value' },
  { table: 'paper_trading_positions', from: 'unrealizedPnl', to: 'unrealized_pnl' },
  { table: 'paper_trading_trades', from: 'portfolioId', to: 'portfolio_id' },
  { table: 'paper_trading_trades', from: 'executePrice', to: 'execute_price' },
  { table: 'paper_trading_trades', from: 'realizedPnl', to: 'realized_pnl' },
  { table: 'paper_trading_snapshots', from: 'portfolioId', to: 'portfolio_id' },
  { table: 'paper_trading_snapshots', from: 'totalValue', to: 'total_value' },
  { table: 'paper_trading_snapshots', from: 'currentCash', to: 'current_cash' },
  { table: 'paper_trading_snapshots', from: 'positionValue', to: 'position_value' },

  // 风控、复盘
  { table: 'risk_alerts', from: 'userId', to: 'user_id' },
  { table: 'risk_alerts', from: 'isRead', to: 'is_read' },
  { table: 'trading_journals', from: 'userId', to: 'user_id' },
  { table: 'trading_journals', from: 'marketSummary', to: 'market_summary' },
  { table: 'trading_journals', from: 'portfolioAnalysis', to: 'portfolio_analysis' },
  { table: 'trading_journals', from: 'actionPlan', to: 'action_plan' },

  // 定时任务
  { table: 'scheduled_tasks', from: 'cronExpression', to: 'cron_expression' },
  { table: 'scheduled_tasks', from: 'isActive', to: 'is_active' },
  { table: 'scheduled_tasks', from: 'lastRunAt', to: 'last_run_at' },
  { table: 'scheduled_tasks', from: 'lastRunStatus', to: 'last_run_status' },

  // 通用时间戳：旧表曾经由 camelCase 模型创建
  { table: 'favorite_stocks', from: 'createdAt', to: 'created_at' },
  { table: 'favorite_stocks', from: 'updatedAt', to: 'updated_at' },
  { table: 'paper_trading_portfolios', from: 'createdAt', to: 'created_at' },
  { table: 'paper_trading_portfolios', from: 'updatedAt', to: 'updated_at' },
  { table: 'paper_trading_positions', from: 'createdAt', to: 'created_at' },
  { table: 'paper_trading_positions', from: 'updatedAt', to: 'updated_at' },
  { table: 'paper_trading_trades', from: 'createdAt', to: 'created_at' },
  { table: 'paper_trading_trades', from: 'updatedAt', to: 'updated_at' },
  { table: 'paper_trading_snapshots', from: 'createdAt', to: 'created_at' },
  { table: 'paper_trading_snapshots', from: 'updatedAt', to: 'updated_at' },
  { table: 'risk_alerts', from: 'createdAt', to: 'created_at' },
  { table: 'risk_alerts', from: 'updatedAt', to: 'updated_at' },
  { table: 'trading_journals', from: 'createdAt', to: 'created_at' },
  { table: 'trading_journals', from: 'updatedAt', to: 'updated_at' },
  { table: 'scheduled_tasks', from: 'createdAt', to: 'created_at' },
  { table: 'scheduled_tasks', from: 'updatedAt', to: 'updated_at' },
  { table: 'task_execution_logs', from: 'taskId', to: 'task_id' },
  { table: 'task_execution_logs', from: 'taskName', to: 'task_name' },
  { table: 'task_execution_logs', from: 'totalItems', to: 'total_items' },
  { table: 'task_execution_logs', from: 'completedItems', to: 'completed_items' },
  { table: 'task_execution_logs', from: 'failedItems', to: 'failed_items' },
  { table: 'task_execution_logs', from: 'errorMessage', to: 'error_message' },
  { table: 'task_execution_logs', from: 'startedAt', to: 'started_at' },
  { table: 'task_execution_logs', from: 'completedAt', to: 'completed_at' },
  { table: 'task_execution_logs', from: 'createdAt', to: 'created_at' },
  { table: 'task_execution_logs', from: 'updatedAt', to: 'updated_at' },
  { table: 'daily_screeners', from: 'createdAt', to: 'created_at' },
  { table: 'daily_screeners', from: 'updatedAt', to: 'updated_at' },

  // 数据更新日志
  { table: 'data_update_logs', from: 'affectedStocks', to: 'affected_stocks' },
  { table: 'data_update_logs', from: 'insertedRecords', to: 'inserted_records' },
  { table: 'data_update_logs', from: 'startedAt', to: 'started_at' },
  { table: 'data_update_logs', from: 'completedAt', to: 'completed_at' },
  { table: 'data_update_logs', from: 'createdAt', to: 'created_at' },
  { table: 'data_update_logs', from: 'updatedAt', to: 'updated_at' },
];

const COMPATIBILITY_COLUMNS: ColumnDefinition[] = [
  // 旧库没有这些后续功能需要的 snake_case 字段时，先补齐字段避免页面 500。
  { table: 'daily_screeners', column: 'detail', definition: 'TEXT' },
  { table: 'daily_screeners', column: 'current_price', definition: 'DECIMAL(10, 2)' },
  { table: 'daily_screeners', column: 'price_change_pct', definition: 'DECIMAL(10, 2)' },

  { table: 'scheduled_tasks', column: 'cron_expression', definition: 'VARCHAR(100)' },
  { table: 'scheduled_tasks', column: 'is_active', definition: 'BOOLEAN DEFAULT TRUE' },
  { table: 'scheduled_tasks', column: 'last_run_at', definition: 'TIMESTAMP WITH TIME ZONE' },
  { table: 'scheduled_tasks', column: 'last_run_status', definition: 'VARCHAR(50)' },
];

const TABLES_WITH_TIMESTAMPS = [
  'favorite_stocks',
  'paper_trading_portfolios',
  'paper_trading_positions',
  'paper_trading_trades',
  'paper_trading_snapshots',
  'risk_alerts',
  'trading_journals',
  'scheduled_tasks',
  'task_execution_logs',
  'daily_screeners',
  'data_update_logs',
];

async function tableExists(tableName: string): Promise<boolean> {
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

async function columnExists(tableName: string, columnName: string): Promise<boolean> {
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

async function renameColumnIfNeeded({ table, from, to }: ColumnRename): Promise<void> {
  if (!(await tableExists(table))) {
    return;
  }

  const hasOldColumn = await columnExists(table, from);
  const hasNewColumn = await columnExists(table, to);

  if (hasOldColumn && !hasNewColumn) {
    await sequelize.query(`ALTER TABLE "${table}" RENAME COLUMN "${from}" TO "${to}"`);
    logger.info(`Renamed legacy column ${table}.${from} -> ${to}`);
  }
}

async function addColumnIfMissing({ table, column, definition }: ColumnDefinition): Promise<void> {
  if (!(await tableExists(table)) || (await columnExists(table, column))) {
    return;
  }

  await sequelize.query(`ALTER TABLE "${table}" ADD COLUMN "${column}" ${definition}`);
  logger.info(`Added compatibility column ${table}.${column}`);
}

async function ensureTimestampColumns(table: string): Promise<void> {
  if (!(await tableExists(table))) {
    return;
  }

  await addColumnIfMissing({
    table,
    column: 'created_at',
    definition: 'TIMESTAMP WITH TIME ZONE DEFAULT NOW()',
  });
  await addColumnIfMissing({
    table,
    column: 'updated_at',
    definition: 'TIMESTAMP WITH TIME ZONE DEFAULT NOW()',
  });
}

/**
 * 开发环境历史库结构修复。
 *
 * dev_lym 分支全局切换为 snake_case 后，部分本地数据库仍保留旧 camelCase 列名。
 * 在 sequelize.sync({ alter: true }) 之前先做幂等修复，可避免定时任务、模拟盘、
 * 风控告警、交易日记、AI 优选、自选股等页面因为字段不存在直接 500。
 */
export async function repairLegacyDevelopmentSchema(): Promise<void> {
  if (process.env.NODE_ENV !== 'development') {
    return;
  }

  try {
    logger.info('Checking legacy development schema compatibility...');

    // 先创建这些新增功能表；sync() 不带 alter，不会改动已有表结构。
    await Promise.all([
      ScheduledTask.sync(),
      TaskExecutionLog.sync(),
      DailyScreener.sync(),
      FavoriteStock.sync(),
      PaperTradingPortfolio.sync(),
      PaperTradingPosition.sync(),
      PaperTradingTrade.sync(),
      PaperTradingSnapshot.sync(),
      RiskAlert.sync(),
      TradingJournal.sync(),
      AIInvestmentSignal.sync(),
    ]);

    for (const rename of LEGACY_COLUMN_RENAMES) {
      await renameColumnIfNeeded(rename);
    }

    for (const table of TABLES_WITH_TIMESTAMPS) {
      await ensureTimestampColumns(table);
    }

    for (const column of COMPATIBILITY_COLUMNS) {
      await addColumnIfMissing(column);
    }

    logger.info('Legacy development schema compatibility check completed');
  } catch (error: any) {
    logger.warn('Legacy development schema compatibility check failed:', error.message);
  }
}
