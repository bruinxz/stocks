#!/usr/bin/env node
/**
 * 诊断股票数据问题
 */

async function diagnoseStocks() {
  try {
    const { sequelize } = require('../backend/dist/config/database');
    const { Stock, DailyBar } = require('../backend/dist/models');
    const { Op } = require('../backend/node_modules/sequelize');

    await sequelize.authenticate();
    console.log('数据库连接成功');

    // 1. 检查股票表前10条记录
    console.log('\n=== 股票表前10条记录 ===');
    const sampleStocks = await Stock.findAll({
      attributes: ['id', 'symbol', 'name', 'market', 'listingDate'],
      limit: 10,
      order: [['id', 'ASC']]
    });

    sampleStocks.forEach(stock => {
      console.log(`ID: ${stock.id}, Symbol: "${stock.symbol}", Name: "${stock.name}", Market: ${stock.market}, Listing: ${stock.listingDate}`);
    });

    // 2. 检查symbol为"undefined"的股票数量
    console.log('\n=== 检查无效股票代码 ===');
    const undefinedStocks = await Stock.count({
      where: {
        symbol: 'undefined'
      }
    });
    console.log(`symbol为"undefined"的股票数量: ${undefinedStocks}`);

    const nullNameStocks = await Stock.count({
      where: {
        name: 'undefined'
      }
    });
    console.log(`name为"undefined"的股票数量: ${nullNameStocks}`);

    // 3. 检查有日线数据的股票样本
    console.log('\n=== 有日线数据的股票样本（前5只） ===');
    const stocksWithBars = await Stock.findAll({
      include: [{
        model: DailyBar,
        as: 'dailyBars',
        required: true
      }],
      attributes: ['id', 'symbol', 'name', 'market'],
      limit: 5
    });

    stocksWithBars.forEach(stock => {
      console.log(`Stock: ${stock.symbol} (${stock.name}), Market: ${stock.market}, 日线数据条数: ${stock.dailyBars.length}`);
    });

    // 4. 检查数据完整性统计中的查询逻辑
    console.log('\n=== 数据完整性统计查询测试 ===');
    const testStock = await Stock.findOne({
      where: { symbol: { [Op.ne]: 'undefined' } },
      order: [['id', 'ASC']]
    });

    if (testStock) {
      console.log(`测试股票: ${testStock.symbol} (ID: ${testStock.id})`);

      // 查询2020-01-01到2026-04-10的日线数据
      const startDate = new Date('2020-01-01');
      const endDate = new Date('2026-04-10');

      const barCount = await DailyBar.count({
        where: {
          stockId: testStock.id,
          time: {
            [Op.between]: [startDate, endDate]
          }
        }
      });

      console.log(`在 ${startDate.toISOString()} 到 ${endDate.toISOString()} 范围内的日线数据条数: ${barCount}`);

      // 查询所有日线数据
      const allBarCount = await DailyBar.count({
        where: { stockId: testStock.id }
      });
      console.log(`总日线数据条数: ${allBarCount}`);

      // 查询日线数据日期范围
      const dateRange = await DailyBar.findOne({
        attributes: [
          [sequelize.fn('MIN', sequelize.col('time')), 'minDate'],
          [sequelize.fn('MAX', sequelize.col('time')), 'maxDate']
        ],
        where: { stockId: testStock.id },
        raw: true
      });

      if (dateRange.minDate && dateRange.maxDate) {
        console.log(`该股票日线数据日期范围: ${dateRange.minDate} 到 ${dateRange.maxDate}`);
      }
    }

    // 5. 检查股票总数和有效股票数
    console.log('\n=== 股票统计 ===');
    const totalStocks = await Stock.count();
    const validStocks = await Stock.count({
      where: {
        symbol: { [Op.ne]: 'undefined' }
      }
    });
    console.log(`总股票数: ${totalStocks}`);
    console.log(`有效股票数（symbol不为undefined）: ${validStocks}`);
    console.log(`无效股票数: ${totalStocks - validStocks}`);

  } catch (error) {
    console.error(`诊断失败: ${error.message}`);
    console.error(`堆栈: ${error.stack}`);
    process.exit(1);
  }
}

diagnoseStocks().catch(error => {
  console.error('脚本执行失败:', error);
  process.exit(1);
});