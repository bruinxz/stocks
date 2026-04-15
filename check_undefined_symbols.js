#!/usr/bin/env node
/**
 * 检查数据库中symbol为undefined或null的股票
 */

async function checkUndefinedSymbols() {
  try {
    const { sequelize } = require('./backend/dist/config/database');
    const { Stock, DailyBar } = require('./backend/dist/models');
    const { Op } = require('./backend/node_modules/sequelize');

    await sequelize.authenticate();
    console.log('数据库连接成功');

    // 1. 检查symbol为null或undefined的股票
    const undefinedStocks = await Stock.findAll({
      where: {
        [Op.or]: [
          { symbol: null },
          { symbol: '' }
        ]
      },
      attributes: ['id', 'symbol', 'name', 'market', 'isListed', 'createdAt'],
      limit: 100
    });

    console.log(`\n1. 找到 ${undefinedStocks.length} 只symbol为null/undefined/空字符串的股票:`);
    undefinedStocks.forEach(stock => {
      console.log(`   ID: ${stock.id}, symbol: ${stock.symbol}, name: ${stock.name}, market: ${stock.market}`);
    });

    // 2. 检查symbol包含"undefined"字符串的股票
    const undefinedStringStocks = await Stock.findAll({
      where: {
        symbol: 'undefined'
      },
      attributes: ['id', 'symbol', 'name', 'market', 'isListed'],
      limit: 100
    });

    console.log(`\n2. 找到 ${undefinedStringStocks.length} 只symbol为字符串"undefined"的股票:`);
    undefinedStringStocks.forEach(stock => {
      console.log(`   ID: ${stock.id}, symbol: "${stock.symbol}", name: ${stock.name}`);
    });

    // 3. 检查所有股票，找出有问题的symbol
    const allStocks = await Stock.findAll({
      attributes: ['id', 'symbol', 'name', 'market', 'isListed'],
      limit: 500
    });

    const problemStocks = allStocks.filter(stock => {
      const symbol = stock.symbol;
      return !symbol ||
             symbol.trim() === '' ||
             symbol.toLowerCase() === 'undefined' ||
             symbol.toLowerCase() === 'null' ||
             symbol.includes('undefined') ||
             symbol.includes('null');
    });

    console.log(`\n3. 在前500只股票中，找到 ${problemStocks.length} 只有问题的股票:`);
    problemStocks.forEach(stock => {
      console.log(`   ID: ${stock.id}, symbol: "${stock.symbol}", name: ${stock.name}`);
    });

    // 4. 检查平安银行的具体情况
    console.log('\n4. 检查ID为67的股票（平安银行）:');
    const pingan = await Stock.findByPk(67, {
      include: [{
        model: DailyBar,
        as: 'dailyBars',
        limit: 5,
        attributes: ['id', 'time', 'close']
      }]
    });

    if (pingan) {
      console.log(`   ID: ${pingan.id}, symbol: "${pingan.symbol}", name: "${pingan.name}"`);
      console.log(`   dailyBars数量: ${pingan.dailyBars ? pingan.dailyBars.length : 0}`);
      if (pingan.dailyBars && pingan.dailyBars.length > 0) {
        pingan.dailyBars.forEach(bar => {
          console.log(`   时间: ${bar.time}, 收盘价: ${bar.close}`);
        });
      }
    }

    // 5. 统计数据
    const totalStocks = await Stock.count();
    const validSymbolStocks = await Stock.count({
      where: {
        symbol: {
          [Op.and]: [
            { [Op.ne]: null },
            { [Op.ne]: '' },
            { [Op.notLike]: '%undefined%' },
            { [Op.notLike]: '%null%' }
          ]
        }
      }
    });

    console.log(`\n5. 统计数据:`);
    console.log(`   总股票数: ${totalStocks}`);
    console.log(`   有效symbol股票数: ${validSymbolStocks}`);
    console.log(`   无效symbol股票数: ${totalStocks - validSymbolStocks}`);

  } catch (error) {
    console.error(`检查数据库失败: ${error.message}`);
    console.error(`堆栈: ${error.stack}`);
  }
}

checkUndefinedSymbols().catch(console.error);