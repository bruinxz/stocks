const { sequelize } = require('../dist/config/database');
const { DataSyncService } = require('../dist/data/services/DataSyncService');
const { Stock, DailyBar } = require('../dist/models');

async function testSync() {
  try {
    console.log('=== 测试数据同步 ===\n');
    await sequelize.authenticate();
    console.log('数据库连接成功\n');

    const dataSyncService = new DataSyncService();

    // 测试股票：sh.600016 民生银行（假设没有数据）
    const testSymbol = 'sh.600016';
    const startDate = '2025-01-01';
    const endDate = '2025-12-31';

    console.log(`测试股票: ${testSymbol}`);
    console.log(`时间范围: ${startDate} 至 ${endDate}\n`);

    // 首先检查股票是否存在
    const stock = await Stock.findOne({ where: { symbol: testSymbol } });
    if (!stock) {
      console.log(`股票 ${testSymbol} 不存在，尝试从数据源获取...`);
      // 这里应该先同步股票基本信息，但为了简单起见，我们假设股票存在
      console.log('股票不存在，跳过测试');
      return;
    }

    console.log(`股票ID: ${stock.id}, 名称: ${stock.name}`);

    // 检查当前数据量
    const existingBars = await DailyBar.count({
      where: { stockId: stock.id }
    });
    console.log(`当前已有数据: ${existingBars} 条\n`);

    // 开始同步
    console.log('开始同步数据...');
    const startTime = Date.now();

    const insertedCount = await dataSyncService.syncStockHistory(
      testSymbol,
      startDate,
      endDate
    );

    const endTime = Date.now();
    const elapsedSeconds = (endTime - startTime) / 1000;

    console.log(`\n同步完成:`);
    console.log(`  插入条数: ${insertedCount}`);
    console.log(`  耗时: ${elapsedSeconds.toFixed(2)} 秒`);

    // 验证结果
    const newBars = await DailyBar.findAll({
      where: {
        stockId: stock.id,
        time: {
          $between: [new Date(startDate), new Date(endDate)]
        }
      },
      order: [['time', 'ASC']],
      limit: 5
    });

    console.log(`\n验证结果:`);
    console.log(`  查询到 ${newBars.length} 条数据`);

    if (newBars.length > 0) {
      console.log('  前5条数据:');
      newBars.forEach((bar, i) => {
        const date = bar.time.toISOString().split('T')[0];
        console.log(`  ${i+1}. ${date}: open=${bar.open}, close=${bar.close}, volume=${bar.volume}`);
      });
    }

    // 测试批量同步
    console.log('\n=== 测试批量同步 ===\n');
    const testSymbols = ['sh.600000', 'sz.000001', 'sh.600016'];

    console.log(`批量测试 ${testSymbols.length} 只股票:`);
    console.log(`  ${testSymbols.join(', ')}`);

    const batchStartTime = Date.now();
    const batchResults = await dataSyncService.syncMultipleStocksHistory(
      testSymbols,
      '2025-01-01',
      '2025-01-31',
      2 // 小批次
    );

    const batchEndTime = Date.now();
    const batchElapsed = (batchEndTime - batchStartTime) / 1000;

    console.log(`\n批量同步完成:`);
    console.log(`  耗时: ${batchElapsed.toFixed(2)} 秒`);
    console.log(`  结果:`);
    Object.entries(batchResults).forEach(([symbol, count]) => {
      console.log(`    ${symbol}: ${count} 条数据`);
    });

  } catch (error) {
    console.error('测试失败:', error);
    console.error('错误详情:', error.message);
    if (error.stack) {
      console.error('堆栈:', error.stack.split('\n').slice(0, 5).join('\n'));
    }
  } finally {
    await sequelize.close();
    console.log('\n测试结束');
  }
}

// 运行测试
testSync();