#!/usr/bin/env node
/**
 * 检查数据库统计信息
 */

async function checkDatabaseStats() {
  try {
    const { sequelize } = require('../backend/dist/config/database');
    const { Stock, DailyBar } = require('../backend/dist/models');
    const { Op } = require('../backend/node_modules/sequelize');

    await sequelize.authenticate();
    console.log('数据库连接成功');

    // 1. 统计股票基本信息
    console.log('\n=== 股票统计 ===');

    const totalStocks = await Stock.count();
    console.log(`总股票数: ${totalStocks}`);

    const listedStocks = await Stock.count({ where: { isListed: true } });
    console.log(`上市股票数: ${listedStocks}`);

    const delistedStocks = await Stock.count({ where: { isListed: false } });
    console.log(`退市股票数: ${delistedStocks}`);

    // 按市场统计
    const marketStats = await Stock.findAll({
      attributes: ['market', [sequelize.fn('COUNT', sequelize.col('id')), 'count']],
      group: ['market'],
      raw: true
    });

    console.log('\n按市场统计:');
    marketStats.forEach(stat => {
      console.log(`  ${stat.market || '未知'}: ${stat.count} 只`);
    });

    // 2. 统计日线数据
    console.log('\n=== 日线数据统计 ===');

    const totalBars = await DailyBar.count();
    console.log(`总日线数据条数: ${totalBars}`);

    // 有日线数据的股票数
    const stocksWithBars = await Stock.count({
      include: [{
        model: DailyBar,
        as: 'dailyBars',
        required: true
      }]
    });

    console.log(`有日线数据的股票数: ${stocksWithBars}`);

    // 日线数据日期范围
    const dateRange = await DailyBar.findOne({
      attributes: [
        [sequelize.fn('MIN', sequelize.col('time')), 'minDate'],
        [sequelize.fn('MAX', sequelize.col('time')), 'maxDate']
      ],
      raw: true
    });

    if (dateRange.minDate && dateRange.maxDate) {
      console.log(`日线数据日期范围: ${dateRange.minDate} 到 ${dateRange.maxDate}`);
    } else {
      console.log('没有日线数据');
    }

    // 3. 按日期统计日线数据
    console.log('\n=== 日线数据按日期分布 ===');

    const dailyStats = await DailyBar.findAll({
      attributes: [
        [sequelize.fn('DATE', sequelize.col('time')), 'date'],
        [sequelize.fn('COUNT', sequelize.col('id')), 'count']
      ],
      group: [sequelize.fn('DATE', sequelize.col('time'))],
      order: [[sequelize.fn('DATE', sequelize.col('time')), 'DESC']],
      limit: 10,
      raw: true
    });

    console.log('最近10个交易日的日线数据数量:');
    dailyStats.forEach(stat => {
      console.log(`  ${stat.date}: ${stat.count} 条`);
    });

    // 4. 数据完整性初步检查
    console.log('\n=== 数据完整性初步检查 ===');

    // 获取所有股票及日线数据数量
    const allStocks = await Stock.findAll({
      attributes: ['id', 'symbol', 'name', 'market'],
      include: [{
        model: DailyBar,
        as: 'dailyBars',
        attributes: []
      }],
      raw: true,
      nest: true
    });

    const stockBarCounts = [];
    for (const stock of allStocks) {
      const barCount = await DailyBar.count({
        where: { stockId: stock.id }
      });
      stockBarCounts.push({
        symbol: stock.symbol,
        name: stock.name,
        market: stock.market,
        barCount
      });
    }

    // 统计不同日线数据量的股票
    const completenessStats = {
      zero: 0,
      lessThan100: 0,
      lessThan500: 0,
      lessThan1000: 0,
      moreThan1000: 0
    };

    stockBarCounts.forEach(stock => {
      if (stock.barCount === 0) {
        completenessStats.zero++;
      } else if (stock.barCount < 100) {
        completenessStats.lessThan100++;
      } else if (stock.barCount < 500) {
        completenessStats.lessThan500++;
      } else if (stock.barCount < 1000) {
        completenessStats.lessThan1000++;
      } else {
        completenessStats.moreThan1000++;
      }
    });

    console.log('日线数据完整性分布:');
    console.log(`  无日线数据: ${completenessStats.zero} 只`);
    console.log(`  少于100条: ${completenessStats.lessThan100} 只`);
    console.log(`  100-499条: ${completenessStats.lessThan500} 只`);
    console.log(`  500-999条: ${completenessStats.lessThan1000} 只`);
    console.log(`  1000条以上: ${completenessStats.moreThan1000} 只`);

    // 显示部分没有日线数据的股票
    const stocksWithoutBars = stockBarCounts.filter(s => s.barCount === 0).slice(0, 10);
    if (stocksWithoutBars.length > 0) {
      console.log('\n没有日线数据的股票（前10只）:');
      stocksWithoutBars.forEach((stock, index) => {
        console.log(`  ${index + 1}. ${stock.symbol} (${stock.name})`);
      });
    }

    // 5. 数据库大小估算（近似）
    console.log('\n=== 数据库大小估算 ===');
    console.log('股票表估算大小:', Math.ceil(totalStocks * 0.5), 'KB');
    console.log('日线数据表估算大小:', Math.ceil(totalBars * 0.1), 'KB');
    console.log('总估算大小:', Math.ceil(totalStocks * 0.5 + totalBars * 0.1), 'KB');

  } catch (error) {
    console.error(`统计失败: ${error.message}`);
    console.error(`堆栈: ${error.stack}`);
    process.exit(1);
  }
}

checkDatabaseStats().catch(error => {
  console.error('脚本执行失败:', error);
  process.exit(1);
});