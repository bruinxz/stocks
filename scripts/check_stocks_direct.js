#!/usr/bin/env node
/**
 * 直接检查股票数据
 */

async function checkStocksDirect() {
  try {
    const { sequelize } = require('../backend/dist/config/database');
    const { Stock, DailyBar } = require('../backend/dist/models');
    const { Op } = require('../backend/node_modules/sequelize');

    await sequelize.authenticate();
    console.log('数据库连接成功');

    // 1. 直接查询前20条记录
    console.log('\n=== 股票表前20条记录（原始查询） ===');
    const stocks = await Stock.findAll({
      attributes: ['id', 'symbol', 'name', 'market', 'listingDate'],
      limit: 20,
      order: [['id', 'ASC']]
    });

    stocks.forEach((stock, index) => {
      console.log(`${index + 1}. ID: ${stock.id}, Symbol: "${stock.symbol}", Name: "${stock.name}", Market: ${stock.market}`);
    });

    // 2. 检查是否有symbol包含'undefined'的
    console.log('\n=== 检查包含"undefined"的股票 ===');
    const allStocks = await Stock.findAll({
      attributes: ['id', 'symbol', 'name']
    });

    const undefinedSymbols = allStocks.filter(s =>
      s.symbol && (s.symbol.includes('undefined') || s.symbol === 'undefined')
    );
    const undefinedNames = allStocks.filter(s =>
      s.name && (s.name.includes('undefined') || s.name === 'undefined')
    );

    console.log(`总股票数: ${allStocks.length}`);
    console.log(`symbol包含"undefined"的股票数: ${undefinedSymbols.length}`);
    console.log(`name包含"undefined"的股票数: ${undefinedNames.length}`);

    if (undefinedSymbols.length > 0) {
      console.log('\n前5个有问题的symbol:');
      undefinedSymbols.slice(0, 5).forEach((stock, index) => {
        console.log(`${index + 1}. ID: ${stock.id}, Symbol: "${stock.symbol}", Name: "${stock.name}"`);
      });
    }

    // 3. 检查数据完整性统计的查询逻辑
    console.log('\n=== 数据完整性统计逻辑测试 ===');

    // 选择一个正常股票测试
    const normalStock = allStocks.find(s =>
      s.symbol && !s.symbol.includes('undefined') &&
      s.symbol.includes('.') &&
      s.symbol.length > 5
    );

    if (normalStock) {
      console.log(`测试股票: ${normalStock.symbol} (ID: ${normalStock.id})`);

      // 使用数据完整性统计脚本的相同逻辑
      const startDate = new Date('2020-01-01');
      const endDate = new Date('2026-04-10');

      console.log(`查询日期范围: ${startDate.toISOString()} 到 ${endDate.toISOString()}`);

      const barCount = await DailyBar.count({
        where: {
          stockId: normalStock.id,
          time: {
            [Op.between]: [startDate, endDate]
          }
        }
      });

      console.log(`日线数据条数: ${barCount}`);

      // 查询所有日线数据
      const allBarCount = await DailyBar.count({
        where: { stockId: normalStock.id }
      });
      console.log(`该股票总日线数据条数: ${allBarCount}`);

      // 查询日期范围
      const dateRange = await DailyBar.findOne({
        attributes: [
          [sequelize.fn('MIN', sequelize.col('time')), 'minDate'],
          [sequelize.fn('MAX', sequelize.col('time')), 'maxDate']
        ],
        where: { stockId: normalStock.id },
        raw: true
      });

      if (dateRange.minDate && dateRange.maxDate) {
        console.log(`日线数据实际日期范围: ${dateRange.minDate} 到 ${dateRange.maxDate}`);
      }
    } else {
      console.log('没有找到正常的股票进行测试');
    }

    // 4. 检查数据统计口径问题
    console.log('\n=== 统计口径分析 ===');

    // 获取所有有日线数据的股票
    const stocksWithBars = await Stock.findAll({
      include: [{
        model: DailyBar,
        as: 'dailyBars',
        required: true
      }],
      attributes: ['id', 'symbol', 'name'],
      limit: 10
    });

    console.log(`有日线数据的股票数: ${stocksWithBars.length}`);

    if (stocksWithBars.length > 0) {
      console.log('前5只有日线数据的股票:');
      stocksWithBars.slice(0, 5).forEach((stock, index) => {
        console.log(`${index + 1}. ${stock.symbol} (${stock.name}): ${stock.dailyBars.length} 条数据`);
      });
    }

  } catch (error) {
    console.error(`检查失败: ${error.message}`);
    console.error(`堆栈: ${error.stack}`);
    process.exit(1);
  }
}

checkStocksDirect().catch(error => {
  console.error('脚本执行失败:', error);
  process.exit(1);
});