#!/usr/bin/env node

import { Command } from 'commander';
import { logger } from '../utils/logger';
import sequelize from '../config/database';
import '../models';

const program = new Command();

program.version('1.0.0').description('A股数据管理命令行工具');

program
  .command('sync-stocks')
  .description('同步所有股票列表')
  .action(async () => {
    try {
      await sequelize.authenticate();
      await sequelize.sync();
      // 动态导入DataSyncService，确保环境变量已设置
      const { DataSyncService } = await import('../data/services/DataSyncService');
      const dataSyncService = new DataSyncService();

      logger.info('开始同步股票列表...');
      const count = await dataSyncService.syncAllStocks();
      logger.info(`股票列表同步完成，处理了 ${count} 只股票`);
      process.exit(0);
    } catch (error) {
      logger.error('同步股票列表失败:', error);
      process.exit(1);
    }
  });

program
  .command('sync-history <symbol>')
  .description('同步单只股票历史数据')
  .option('-s, --start <date>', '开始日期 (YYYY-MM-DD)', '2020-01-01')
  .option('-e, --end <date>', '结束日期 (YYYY-MM-DD)', new Date().toISOString().split('T')[0])
  .action(async (symbol, options) => {
    try {
      await sequelize.authenticate();
      await sequelize.sync();
      // 动态导入DataSyncService，确保环境变量已设置
      const { DataSyncService } = await import('../data/services/DataSyncService');
      const dataSyncService = new DataSyncService();

      logger.info(`开始同步股票 ${symbol} 的历史数据...`);
      const count = await dataSyncService.syncStockHistory(symbol, options.start, options.end);
      logger.info(`历史数据同步完成，新增了 ${count} 条日线数据`);
      process.exit(0);
    } catch (error) {
      logger.error(`同步股票 ${symbol} 历史数据失败:`, error);
      process.exit(1);
    }
  });

program
  .command('sync-batch <symbols...>')
  .description('批量同步多只股票历史数据')
  .option('-s, --start <date>', '开始日期 (YYYY-MM-DD)', '2020-01-01')
  .option('-e, --end <date>', '结束日期 (YYYY-MM-DD)', new Date().toISOString().split('T')[0])
  .option('-b, --batch-size <number>', '批次大小', '10')
  .action(async (symbols, options) => {
    try {
      await sequelize.authenticate();
      await sequelize.sync();
      // 动态导入DataSyncService，确保环境变量已设置
      const { DataSyncService } = await import('../data/services/DataSyncService');
      const dataSyncService = new DataSyncService();

      logger.info(`开始批量同步 ${symbols.length} 只股票的历史数据...`);
      const results = await dataSyncService.syncMultipleStocksHistory(
        symbols,
        options.start,
        options.end,
        parseInt(options.batchSize)
      );

      const success = Object.values(results).filter(count => count > 0).length;
      const failed = Object.values(results).filter(count => count === -1).length;
      const skipped = Object.values(results).filter(count => count === 0).length;

      logger.info(`批量同步完成: 成功 ${success} 只, 失败 ${failed} 只, 跳过 ${skipped} 只`);
      process.exit(0);
    } catch (error) {
      logger.error('批量同步失败:', error);
      process.exit(1);
    }
  });

program
  .command('sync-index <indexCode>')
  .description('同步指数成分股')
  .action(async indexCode => {
    try {
      await sequelize.authenticate();
      await sequelize.sync();
      // 动态导入DataSyncService，确保环境变量已设置
      const { DataSyncService } = await import('../data/services/DataSyncService');
      const dataSyncService = new DataSyncService();

      logger.info(`开始同步指数 ${indexCode} 的成分股...`);
      const count = await dataSyncService.syncIndexStocks(indexCode);
      logger.info(`指数成分股同步完成，新增了 ${count} 只股票`);
      process.exit(0);
    } catch (error) {
      logger.error(`同步指数 ${indexCode} 成分股失败:`, error);
      process.exit(1);
    }
  });

program
  .command('daily-update')
  .description('执行每日数据更新')
  .action(async () => {
    try {
      await sequelize.authenticate();
      await sequelize.sync();
      // 动态导入DataSyncService，确保环境变量已设置
      const { DataSyncService } = await import('../data/services/DataSyncService');
      const dataSyncService = new DataSyncService();

      logger.info('开始每日数据更新...');
      const results = await dataSyncService.dailyUpdate();

      const success = Object.values(results).filter(count => count > 0).length;
      const failed = Object.values(results).filter(count => count === -1).length;
      const skipped = Object.values(results).filter(count => count === 0).length;

      logger.info(`每日更新完成: 成功 ${success} 只, 失败 ${failed} 只, 跳过 ${skipped} 只`);
      process.exit(0);
    } catch (error) {
      logger.error('每日更新失败:', error);
      process.exit(1);
    }
  });

program
  .command('check-update')
  .description('检查需要更新的股票')
  .option('-d, --days <number>', '天数阈值', '7')
  .action(async options => {
    try {
      await sequelize.authenticate();
      await sequelize.sync();
      // 动态导入DataSyncService，确保环境变量已设置
      const { DataSyncService } = await import('../data/services/DataSyncService');
      const dataSyncService = new DataSyncService();

      const symbols = await dataSyncService.getStocksNeedingUpdate(parseInt(options.days));
      logger.info(`有 ${symbols.length} 只股票需要更新:`);
      symbols.forEach(symbol => console.log(`  ${symbol}`));
      process.exit(0);
    } catch (error) {
      logger.error('检查更新失败:', error);
      process.exit(1);
    }
  });

program
  .command('status')
  .description('查看数据服务状态')
  .action(async () => {
    try {
      await sequelize.authenticate();
      await sequelize.sync();
      // 动态导入DataSyncService，确保环境变量已设置
      const { DataSyncService } = await import('../data/services/DataSyncService');
      const dataSyncService = new DataSyncService();

      const status = dataSyncService.getStatus();
      console.log('数据服务状态:');
      console.log(JSON.stringify(status, null, 2));
      process.exit(0);
    } catch (error) {
      logger.error('获取状态失败:', error);
      process.exit(1);
    }
  });

program.parse();
