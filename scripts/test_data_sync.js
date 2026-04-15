#!/usr/bin/env node
/**
 * 测试数据同步功能
 */

async function testDataSync() {
  try {
    const { DataSyncService } = require('../backend/dist/data/services/DataSyncService');
    const { Stock } = require('../backend/dist/models');
    const { getEast8DateString } = require('../backend/dist/utils/timezone');

    const syncService = new DataSyncService();

    console.log('=== 测试数据同步功能 ===');
    console.log(`当前时间: ${getEast8DateString()}`);

    // 1. 同步所有股票列表
    console.log('\n1. 同步所有股票列表...');
    const stockCount = await syncService.syncAllStocks();
    console.log(`同步完成，影响股票数: ${stockCount}`);

    // 2. 查看同步的股票
    const stocks = await Stock.findAll({
      attributes: ['id', 'symbol', 'name', 'market', 'isListed'],
      limit: 20,
      order: [['id', 'ASC']]
    });

    console.log(`\n2. 数据库中的股票 (前${stocks.length}只):`);
    stocks.forEach(stock => {
      console.log(`  ID: ${stock.id}, symbol: "${stock.symbol}", name: "${stock.name}", market: ${stock.market}`);
    });

    // 3. 测试单只股票数据同步
    if (stocks.length > 0) {
      const testStock = stocks[0];
      console.log(`\n3. 测试单只股票数据同步: ${testStock.symbol} (${testStock.name})`);

      // 同步最近30天的数据
      const endDate = getEast8DateString();
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - 30);
      const startDateStr = startDate.toISOString().split('T')[0];

      console.log(`   日期范围: ${startDateStr} 到 ${endDate}`);

      try {
        const inserted = await syncService.syncStockHistory(testStock.symbol, startDateStr, endDate);
        console.log(`   插入 ${inserted} 条日线数据`);
      } catch (error) {
        console.error(`   同步失败: ${error.message}`);
      }
    }

    // 4. 测试每日更新
    console.log('\n4. 测试每日更新...');
    try {
      const results = await syncService.dailyUpdate();
      const symbols = Object.keys(results);
      console.log(`   更新 ${symbols.length} 只股票`);
      if (symbols.length > 0) {
        console.log(`   示例股票 ${symbols[0]}: ${results[symbols[0]]} 条数据`);
      }
    } catch (error) {
      console.error(`   每日更新失败: ${error.message}`);
    }

    // 5. 统计
    const totalStocks = await Stock.count();
    const listedStocks = await Stock.count({ where: { isListed: true } });
    console.log(`\n5. 数据库统计:`);
    console.log(`   总股票数: ${totalStocks}`);
    console.log(`   上市股票数: ${listedStocks}`);

    console.log('\n=== 测试完成 ===');

  } catch (error) {
    console.error(`测试失败: ${error.message}`);
    console.error(`堆栈: ${error.stack}`);
    process.exit(1);
  }
}

testDataSync().catch(error => {
  console.error('测试脚本执行失败:', error);
  process.exit(1);
});