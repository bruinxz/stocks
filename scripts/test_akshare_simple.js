#!/usr/bin/env node
/**
 * 简单测试AKShare数据获取
 */

async function testAKShare() {
  try {
    const { AKShareClient } = require('../backend/dist/data/sources/AKShareClient');
    const client = new AKShareClient();

    console.log('=== 测试AKShare客户端 ===\n');

    // 1. 测试客户端状态
    const status = client.getStatus();
    console.log('1. 客户端状态:');
    console.log(`   Python路径: ${status.pythonPath}`);
    console.log(`   脚本路径: ${status.scriptPath}`);
    console.log(`   可用状态: ${status.isAvailable}`);

    // 2. 测试获取股票列表（少量）
    console.log('\n2. 测试获取股票列表（前10只）...');
    try {
      const stocks = await client.getAllStocks();
      console.log(`   获取到 ${stocks.length} 只股票`);

      if (stocks.length > 0) {
        console.log(`   前10只股票:`);
        stocks.slice(0, 10).forEach((stock, i) => {
          console.log(`     ${i+1}. ${stock.code} - ${stock.code_name}`);
        });
      }
    } catch (error) {
      console.error(`   获取股票列表失败: ${error.message}`);
    }

    // 3. 测试单只股票日线数据获取
    console.log('\n3. 测试单只股票日线数据获取...');
    const testSymbols = ['sh.600000', 'sz.000001', 'bj.830799'];

    for (const symbol of testSymbols) {
      console.log(`   测试 ${symbol}...`);
      try {
        const bars = await client.queryHistoryKData(symbol, '2025-01-01', '2025-01-10');
        console.log(`     获取到 ${bars.length} 条数据`);

        if (bars.length > 0) {
          console.log(`     示例数据:`);
          const sampleBar = bars[0];
          console.log(`       日期: ${sampleBar.date}, 开盘: ${sampleBar.open}, 收盘: ${sampleBar.close}`);
        }
      } catch (error) {
        console.error(`     获取失败: ${error.message}`);
      }
    }

    // 4. 测试股票基本信息
    console.log('\n4. 测试股票基本信息获取...');
    for (const symbol of testSymbols.slice(0, 2)) {
      console.log(`   测试 ${symbol}...`);
      try {
        const info = await client.queryStockBasic(symbol);
        if (info) {
          console.log(`     名称: ${info.code_name}, 上市日期: ${info.ipoDate}`);
        } else {
          console.log(`     未找到信息`);
        }
      } catch (error) {
        console.error(`     获取失败: ${error.message}`);
      }
    }

    console.log('\n=== 测试完成 ===');

  } catch (error) {
    console.error(`测试失败: ${error.message}`);
    console.error(`堆栈: ${error.stack}`);
    process.exit(1);
  }
}

testAKShare().catch(error => {
  console.error('脚本执行失败:', error);
  process.exit(1);
});