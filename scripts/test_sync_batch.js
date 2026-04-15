#!/usr/bin/env node
/**
 * 测试批量同步脚本（只同步少量股票）
 */

async function testSyncBatch() {
  try {
    // 导入必要的模块
    const { DataSyncService } = require('../backend/dist/data/services/DataSyncService');
    const { Stock } = require('../backend/dist/models');
    const { sequelize } = require('../backend/dist/config/database');
    const { logger } = require('../backend/dist/utils/logger');
    const { Op } = require('../backend/node_modules/sequelize');

    // 设置日志级别
    logger.level = 'info';

    await sequelize.authenticate();
    console.log('数据库连接成功');

    const syncService = new DataSyncService();

    console.log('=== 测试批量同步（少量股票） ===\n');

    // 获取少量股票进行测试
    const testStocks = await Stock.findAll({
      where: {
        isListed: true,
        symbol: {
          [Op.or]: [
            { [Op.like]: 'sh.600000' }, // 浦发银行
            { [Op.like]: 'sz.000001' }, // 平安银行
            { [Op.like]: 'sz.000002' }, // 万科A
            { [Op.like]: 'sh.600036' }, // 招商银行
            { [Op.like]: 'sh.600519' }  // 贵州茅台
          ]
        }
      },
      limit: 10
    });

    console.log(`选择 ${testStocks.length} 只股票进行测试:`);
    testStocks.forEach(stock => {
      console.log(`  ${stock.symbol} (${stock.name})`);
    });

    const startDate = '2025-01-01';
    const endDate = '2025-12-31';

    console.log(`\n同步日期范围: ${startDate} 到 ${endDate}`);
    console.log('开始同步...\n');

    const results = {};

    for (const stock of testStocks) {
      console.log(`同步 ${stock.symbol} (${stock.name})...`);

      const startTime = Date.now();
      try {
        const inserted = await syncService.syncStockHistory(
          stock.symbol,
          startDate,
          endDate
        );
        const elapsedTime = Date.now() - startTime;

        results[stock.symbol] = {
          success: true,
          inserted: inserted,
          time: elapsedTime
        };

        console.log(`  ✅ 插入 ${inserted} 条数据 (${elapsedTime}ms)`);
      } catch (error) {
        const elapsedTime = Date.now() - startTime;
        results[stock.symbol] = {
          success: false,
          error: error.message,
          time: elapsedTime
        };
        console.log(`  ❌ 失败: ${error.message} (${elapsedTime}ms)`);
      }

      // 短暂延迟，避免请求过于频繁
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    console.log('\n=== 测试结果汇总 ===');
    let totalInserted = 0;
    let totalTime = 0;
    let successCount = 0;

    for (const [symbol, result] of Object.entries(results)) {
      if (result.success) {
        totalInserted += result.inserted;
        totalTime += result.time;
        successCount++;
        console.log(`  ${symbol}: ✅ ${result.inserted} 条数据 (${result.time}ms)`);
      } else {
        console.log(`  ${symbol}: ❌ ${result.error} (${result.time}ms)`);
      }
    }

    console.log(`\n统计:`);
    console.log(`  成功: ${successCount}/${testStocks.length}`);
    console.log(`  总插入数据: ${totalInserted} 条`);
    console.log(`  总耗时: ${totalTime}ms`);
    console.log(`  平均每只股票: ${successCount > 0 ? Math.round(totalTime / successCount) : 0}ms`);

    if (successCount > 0) {
      console.log(`  平均数据量: ${Math.round(totalInserted / successCount)} 条/股票`);
    }

    // 检查同步服务统计
    const syncStats = syncService.getSyncStats();
    console.log(`\n同步服务统计:`);
    console.log(`  总同步次数: ${syncStats.totalSyncs}`);
    console.log(`  成功同步: ${syncStats.successfulSyncs}`);
    console.log(`  失败同步: ${syncStats.failedSyncs}`);
    console.log(`  总尝试记录: ${syncStats.totalRecordsAttempted}`);
    console.log(`  总失败记录: ${syncStats.totalRecordsFailed}`);

    if (successCount === 0) {
      console.error('\n❌ 所有股票同步都失败了，请检查AKShare配置');
      process.exit(1);
    }

    console.log('\n✅ 测试完成，可以运行全量同步了');

  } catch (error) {
    console.error(`测试失败: ${error.message}`);
    console.error(`堆栈: ${error.stack}`);
    process.exit(1);
  }
}

testSyncBatch().catch(error => {
  console.error('脚本执行失败:', error);
  process.exit(1);
});