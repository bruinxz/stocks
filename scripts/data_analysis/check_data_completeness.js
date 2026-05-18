#!/usr/bin/env node
/**
 * 检查数据完整性：统计有多少股票有日线数据
 */

async function checkDataCompleteness() {
  try {
    // 导入必要的模块
    const { Stock, DailyBar } = require('../backend/dist/models');
    const { sequelize } = require('../backend/dist/config/database');
    const { logger } = require('../backend/dist/utils/logger');

    // 抑制日志输出
    logger.level = 'error';

    await sequelize.authenticate();
    console.log('数据库连接成功');

    console.log('=== 数据完整性检查 ===\n');

    // 1. 统计总股票数
    const totalStocks = await Stock.count();
    console.log(`1. 总股票数: ${totalStocks} 只`);

    // 2. 统计有日线数据的股票数
    const stocksWithData = await Stock.count({
      include: [{
        model: DailyBar,
        required: true,
        where: {
          // 只统计最近1年的数据
          time: {
            [require('../backend/node_modules/sequelize').Op.gte]: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000)
          }
        }
      }],
      distinct: true
    });

    console.log(`2. 有日线数据（最近1年）的股票数: ${stocksWithData} 只`);

    // 3. 计算完整性百分比
    const completenessPercent = totalStocks > 0 ? (stocksWithData / totalStocks * 100).toFixed(1) : 0;
    console.log(`3. 数据完整性: ${completenessPercent}%`);

    // 4. 统计每个股票的数据条数
    console.log('\n4. 按数据量统计股票:');
    const stocksByDataCount = await Stock.findAll({
      attributes: [
        'symbol',
        'name',
        [sequelize.fn('COUNT', sequelize.col('DailyBars.id')), 'data_count']
      ],
      include: [{
        model: DailyBar,
        attributes: [],
        required: false
      }],
      group: ['Stock.id', 'Stock.symbol', 'Stock.name'],
      order: [[sequelize.literal('data_count'), 'DESC']],
      limit: 10
    });

    console.log('   数据最多的10只股票:');
    stocksByDataCount.forEach(stock => {
      const count = stock.get('data_count');
      console.log(`   ${stock.symbol} (${stock.name}): ${count} 条数据`);
    });

    // 5. 检查数据库中日线数据总数
    const totalDailyBars = await DailyBar.count();
    console.log(`\n5. 日线数据总条数: ${totalDailyBars} 条`);

    // 6. 检查日期范围
    const oldestBar = await DailyBar.findOne({
      order: [['time', 'ASC']],
      attributes: ['time']
    });

    const newestBar = await DailyBar.findOne({
      order: [['time', 'DESC']],
      attributes: ['time']
    });

    if (oldestBar && newestBar) {
      console.log(`6. 数据日期范围: ${oldestBar.time.toISOString().split('T')[0]} 到 ${newestBar.time.toISOString().split('T')[0]}`);
    } else {
      console.log('6. 无日线数据');
    }

    console.log('\n=== 检查完成 ===');
    console.log('\n问题分析:');
    if (stocksWithData === 0) {
      console.log('   ❌ 严重: 没有任何股票有日线数据');
      console.log('   建议: 运行全量数据同步脚本');
    } else if (completenessPercent < 50) {
      console.log('   ⚠️  警告: 数据完整性较低 (< 50%)');
      console.log('   建议: 运行数据同步脚本补充数据');
    } else {
      console.log('   ✅ 良好: 数据完整性可以接受');
    }

    process.exit(0);

  } catch (error) {
    console.error(`检查失败: ${error.message}`);
    console.error(`堆栈: ${error.stack}`);
    process.exit(1);
  }
}

checkDataCompleteness().catch(error => {
  console.error('脚本执行失败:', error);
  process.exit(1);
});