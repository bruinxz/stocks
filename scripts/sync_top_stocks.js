#!/usr/bin/env node
/**
 * 同步前N只核心股票数据（快速改善数据完整性）
 */

async function syncTopStocks() {
  try {
    // 导入必要的模块
    const { DataSyncService } = require('../backend/dist/data/services/DataSyncService');
    const { Stock, DailyBar } = require('../backend/dist/models');
    const { sequelize } = require('../backend/dist/config/database');
    const { logger } = require('../backend/dist/utils/logger');
    const { Op } = require('../backend/node_modules/sequelize');

    // 设置日志级别
    logger.level = 'warn';

    await sequelize.authenticate();
    console.log('数据库连接成功');

    const syncService = new DataSyncService();

    console.log('=== 同步核心股票数据（快速改善） ===\n');

    // 获取核心股票（前300只主板股票，按代码排序）
    const topStocks = await Stock.findAll({
      where: {
        isListed: true,
        [Op.or]: [
          { symbol: { [Op.like]: 'sh.6%' } }, // 上证主板
          { symbol: { [Op.like]: 'sz.000%' } }, // 深证主板（000开头）
          { symbol: { [Op.like]: 'sz.300%' } }  // 深证创业板（300开头）
        ]
      },
      order: [
        ['symbol', 'ASC'] // 按代码排序
      ],
      limit: 300 // 只处理300只
    });

    console.log(`选择 ${topStocks.length} 只核心股票进行同步`);

    // 显示前10只
    console.log('前10只股票:');
    topStocks.slice(0, 10).forEach((stock, i) => {
      console.log(`  ${i+1}. ${stock.symbol} (${stock.name})`);
    });

    // 配置 - 只同步最近6个月数据
    const endDate = '2025-12-31';
    const startDate = '2025-07-01'; // 最近6个月

    console.log(`\n日期范围: ${startDate} 到 ${endDate} (最近6个月)`);
    console.log('预计总时间: 约25-30分钟\n');

    const config = {
      batchSize: 5,           // 小批次，避免压力
      delayBetweenBatches: 2000, // 批次间延迟2秒
      delayBetweenStocks: 150,   // 股票间延迟150ms
      maxRetries: 2
    };

    const totalBatches = Math.ceil(topStocks.length / config.batchSize);
    let totalInserted = 0;
    let successCount = 0;
    let failCount = 0;
    const errors = [];

    const overallStart = Date.now();

    // 分批处理
    for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
      const batchStart = batchIndex * config.batchSize;
      const batchEnd = Math.min(batchStart + config.batchSize, topStocks.length);
      const batch = topStocks.slice(batchStart, batchEnd);

      console.log(`批次 ${batchIndex + 1}/${totalBatches} (股票 ${batchStart + 1}-${batchEnd}/${topStocks.length})`);

      const batchStartTime = Date.now();

      // 处理批次中的每只股票
      const batchPromises = batch.map(async (stock, i) => {
        const stockNum = batchStart + i + 1;

        try {
          const inserted = await syncService.syncStockHistory(
            stock.symbol,
            startDate,
            endDate
          );

          successCount++;
          totalInserted += inserted;

          console.log(`  ${stockNum}. ${stock.symbol}: ✅ ${inserted}条`);
          return { success: true, inserted };
        } catch (error) {
          failCount++;
          errors.push({
            symbol: stock.symbol,
            error: error.message
          });

          console.log(`  ${stockNum}. ${stock.symbol}: ❌ ${error.message}`);
          return { success: false, error: error.message };
        }
      });

      // 等待批次完成
      await Promise.all(batchPromises);

      const batchTime = Date.now() - batchStartTime;
      console.log(`  批次完成，耗时 ${Math.round(batchTime / 1000)}秒`);

      // 进度统计
      const elapsedTime = Date.now() - overallStart;
      const progressPercent = ((batchIndex + 1) / totalBatches * 100).toFixed(1);
      const estimatedTotalTime = (elapsedTime / (batchIndex + 1)) * totalBatches;
      const remainingTime = estimatedTotalTime - elapsedTime;

      console.log(`  进度: ${progressPercent}% (${successCount + failCount}/${topStocks.length})`);
      console.log(`  已插入: ${totalInserted}条数据`);
      console.log(`  预计剩余: ${Math.round(remainingTime / 60000)}分${Math.round((remainingTime % 60000) / 1000)}秒`);

      // 批次间延迟（最后一个批次除外）
      if (batchIndex < totalBatches - 1) {
        console.log(`  等待 ${config.delayBetweenBatches / 1000}秒后继续...\n`);
        await new Promise(resolve => setTimeout(resolve, config.delayBetweenBatches));
      }
    }

    const overallTime = Date.now() - overallStart;

    console.log('\n=== 同步完成 ===');
    console.log(`总耗时: ${Math.round(overallTime / 1000)}秒 (${Math.round(overallTime / 60000)}分钟)`);
    console.log(`处理股票: ${successCount + failCount}/${topStocks.length}`);
    console.log(`成功: ${successCount}, 失败: ${failCount}`);
    console.log(`成功率: ${((successCount / (successCount + failCount)) * 100).toFixed(1)}%`);
    console.log(`插入记录: ${totalInserted} 条`);

    if (errors.length > 0) {
      console.log(`\n错误列表 (前5个):`);
      errors.slice(0, 5).forEach(err => {
        console.log(`  ${err.symbol}: ${err.error}`);
      });
    }

    // 更新数据完整性统计
    console.log('\n=== 更新后数据完整性 ===');
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

    // 统计有日线数据的股票数（最近6个月）
    const sixMonthsAgo = new Date('2025-07-01');

    const stocksWithData = await Stock.count({
      include: [{
        model: DailyBar,
        required: true,
        where: {
          time: { [Op.gte]: sixMonthsAgo }
        }
      }],
      distinct: true
    });

    const completenessPercent = totalStocks > 0
      ? (stocksWithData / totalStocks * 100).toFixed(2)
      : '0.00';

    console.log(`总股票数: ${totalStocks} 只`);
    console.log(`有日线数据（最近6个月）的股票: ${stocksWithData} 只`);
    console.log(`数据完整性: ${completenessPercent}%`);

    // 建议
    console.log('\n建议:');
    if (parseFloat(completenessPercent) < 5) {
      console.log('   数据完整性仍然很低，建议继续同步更多股票');
      console.log('   可以运行: node scripts/sync_main_board.js --limit 1000');
    } else if (parseFloat(completenessPercent) < 20) {
      console.log('   数据完整性有所改善，但仍有很大提升空间');
      console.log('   核心股票已同步，可以满足基本使用需求');
    } else {
      console.log('   数据完整性良好，可以满足大部分使用需求');
    }

  } catch (error) {
    console.error(`更新统计失败: ${error.message}`);
  }
}

// 处理Ctrl+C
process.on('SIGINT', () => {
  console.log('\n\n⚠️  同步被用户中断');
  console.log('已同步的股票数据已保存');
  process.exit(0);
});

syncTopStocks().catch(error => {
  console.error('脚本执行失败:', error);
  process.exit(1);
});