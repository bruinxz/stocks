#!/usr/bin/env node
/**
 * 同步主板股票数据（上证、深证主板）
 * 先同步这些核心股票，改善数据完整性
 */

async function syncMainBoardStocks() {
  try {
    // 导入必要的模块
    const { DataSyncService } = require('../backend/dist/data/services/DataSyncService');
    const { Stock, DailyBar } = require('../backend/dist/models');
    const { sequelize } = require('../backend/dist/config/database');
    const { logger } = require('../backend/dist/utils/logger');
    const { Op } = require('../backend/node_modules/sequelize');

    // 设置日志级别
    logger.level = 'warn'; // 减少日志输出

    await sequelize.authenticate();
    console.log('数据库连接成功');

    const syncService = new DataSyncService();

    console.log('=== 同步主板股票数据 ===\n');

    // 获取主板股票（上证：6开头，深证：0、3开头）
    const mainBoardStocks = await Stock.findAll({
      where: {
        isListed: true,
        [Op.or]: [
          { symbol: { [Op.like]: 'sh.6%' } }, // 上证主板
          { symbol: { [Op.like]: 'sz.0%' } }, // 深证主板（000、001等）
          { symbol: { [Op.like]: 'sz.3%' } }  // 深证创业板（300开头）
        ],
        // 排除已经有很多数据的股票
        id: {
          [Op.notIn]: sequelize.literal(`(
            SELECT DISTINCT stock_id
            FROM daily_bars
            WHERE time >= '2025-01-01'
            GROUP BY stock_id
            HAVING COUNT(*) >= 100
          )`)
        }
      },
      order: [
        ['market', 'ASC'],
        ['symbol', 'ASC']
      ]
    });

    console.log(`找到 ${mainBoardStocks.length} 只主板股票需要同步`);

    if (mainBoardStocks.length === 0) {
      console.log('✅ 所有主板股票已有足够数据');
      return;
    }

    // 配置
    const config = {
      startDate: '2024-01-01', // 2年前
      endDate: '2025-12-31',   // 到2025年底
      batchSize: 10,           // 批次大小
      delayBetweenBatches: 5000, // 批次间延迟
      delayBetweenStocks: 300,   // 股票间延迟
      maxRetries: 2            // 最大重试次数
    };

    console.log(`日期范围: ${config.startDate} 到 ${config.endDate}`);
    console.log(`批次大小: ${config.batchSize}`);
    console.log('');

    const totalBatches = Math.ceil(mainBoardStocks.length / config.batchSize);
    let totalInserted = 0;
    let successCount = 0;
    let failCount = 0;
    const errors = [];

    const overallStart = Date.now();

    // 分批处理
    for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
      const batchStart = batchIndex * config.batchSize;
      const batchEnd = Math.min(batchStart + config.batchSize, mainBoardStocks.length);
      const batch = mainBoardStocks.slice(batchStart, batchEnd);

      console.log(`批次 ${batchIndex + 1}/${totalBatches} (股票 ${batchStart + 1}-${batchEnd}/${mainBoardStocks.length})`);

      const batchStartTime = Date.now();

      // 处理批次中的每只股票
      for (let i = 0; i < batch.length; i++) {
        const stock = batch[i];
        const stockNum = batchStart + i + 1;
        const progress = `${stockNum}/${mainBoardStocks.length}`;

        process.stdout.write(`  ${progress} ${stock.symbol} (${stock.name})... `);

        let inserted = 0;
        let errorMsg = null;

        // 重试机制
        for (let retry = 1; retry <= config.maxRetries; retry++) {
          try {
            if (retry > 1) {
              process.stdout.write(`重试${retry}... `);
              await new Promise(resolve => setTimeout(resolve, 1000));
            }

            inserted = await syncService.syncStockHistory(
              stock.symbol,
              config.startDate,
              config.endDate
            );

            successCount++;
            totalInserted += inserted;
            errorMsg = null;
            break;
          } catch (error) {
            errorMsg = error.message;
            if (retry === config.maxRetries) {
              failCount++;
              errors.push({
                symbol: stock.symbol,
                error: errorMsg
              });
            }
          }
        }

        if (errorMsg) {
          console.log(`❌ ${errorMsg}`);
        } else {
          console.log(`✅ ${inserted}条`);
        }

        // 股票间延迟
        if (i < batch.length - 1) {
          await new Promise(resolve => setTimeout(resolve, config.delayBetweenStocks));
        }
      }

      const batchTime = Date.now() - batchStartTime;
      console.log(`  批次完成，耗时 ${Math.round(batchTime / 1000)}秒`);

      // 显示进度统计
      const elapsedTime = Date.now() - overallStart;
      const estimatedTotalTime = (elapsedTime / (batchIndex + 1)) * totalBatches;
      const remainingTime = estimatedTotalTime - elapsedTime;

      console.log(`  进度: ${successCount + failCount}/${mainBoardStocks.length}`);
      console.log(`  已插入: ${totalInserted}条数据`);
      console.log(`  预计剩余: ${Math.round(remainingTime / 60000)}分钟`);

      // 批次间延迟（最后一个批次除外）
      if (batchIndex < totalBatches - 1) {
        console.log(`  等待 ${config.delayBetweenBatches / 1000}秒后继续...\n`);
        await new Promise(resolve => setTimeout(resolve, config.delayBetweenBatches));
      }
    }

    const overallTime = Date.now() - overallStart;

    console.log('\n=== 同步完成 ===');
    console.log(`总耗时: ${Math.round(overallTime / 1000)}秒 (${Math.round(overallTime / 60000)}分钟)`);
    console.log(`处理股票: ${successCount + failCount}/${mainBoardStocks.length}`);
    console.log(`成功: ${successCount}, 失败: ${failCount}`);
    console.log(`成功率: ${((successCount / (successCount + failCount)) * 100).toFixed(1)}%`);
    console.log(`插入记录: ${totalInserted} 条`);

    if (errors.length > 0) {
      console.log(`\n错误列表 (前5个):`);
      errors.slice(0, 5).forEach(err => {
        console.log(`  ${err.symbol}: ${err.error}`);
      });
      if (errors.length > 5) {
        console.log(`  ... 还有 ${errors.length - 5} 个错误`);
      }
    }

    // 更新数据完整性统计
    console.log('\n=== 更新数据完整性统计 ===');
    await updateDataCompleteness();

  } catch (error) {
    console.error(`\n❌ 同步失败: ${error.message}`);
    console.error(`堆栈: ${error.stack}`);
    process.exit(1);
  }
}

// 更新数据完整性统计
async function updateDataCompleteness() {
  try {
    const { Stock, DailyBar } = require('../backend/dist/models');
    const { Op } = require('../backend/node_modules/sequelize');

    // 统计总股票数
    const totalStocks = await Stock.count({
      where: { isListed: true }
    });

    // 统计有日线数据的股票数（最近1年）
    const cutoffDate = new Date();
    cutoffDate.setFullYear(cutoffDate.getFullYear() - 1);

    const stocksWithData = await Stock.count({
      include: [{
        model: DailyBar,
        required: true,
        where: {
          time: { [Op.gte]: cutoffDate }
        }
      }],
      distinct: true
    });

    const completenessPercent = totalStocks > 0
      ? (stocksWithData / totalStocks * 100).toFixed(1)
      : '0.0';

    console.log(`总股票数: ${totalStocks} 只`);
    console.log(`有日线数据的股票数: ${stocksWithData} 只`);
    console.log(`数据完整性: ${completenessPercent}%`);

    // 如果完整性仍然很低，建议运行更多同步
    if (parseFloat(completenessPercent) < 50) {
      console.log('\n⚠️  数据完整性仍然较低 (< 50%)');
      console.log('建议:');
      console.log('  1. 运行北交所股票同步: node scripts/sync_bse_stocks.js');
      console.log('  2. 运行全量同步: node scripts/bulk_sync_all_stocks.js');
    } else {
      console.log('\n✅ 数据完整性良好');
    }

  } catch (error) {
    console.error(`更新统计失败: ${error.message}`);
  }
}

// 处理Ctrl+C
process.on('SIGINT', () => {
  console.log('\n\n⚠️  同步被用户中断');
  console.log('下次可以重新运行此脚本继续同步');
  process.exit(0);
});

syncMainBoardStocks().catch(error => {
  console.error('脚本执行失败:', error);
  process.exit(1);
});