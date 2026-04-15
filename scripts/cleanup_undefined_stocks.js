#!/usr/bin/env node
/**
 * 清理无效股票记录（symbol为'undefined'）
 */

async function cleanupUndefinedStocks() {
  try {
    const { sequelize } = require('../backend/dist/config/database');
    const { Stock, DailyBar } = require('../backend/dist/models');

    await sequelize.authenticate();
    console.log('数据库连接成功');

    // 1. 查找所有symbol为'undefined'的股票
    const undefinedStocks = await Stock.findAll({
      where: { symbol: 'undefined' },
      attributes: ['id', 'symbol', 'name', 'market']
    });

    console.log(`找到 ${undefinedStocks.length} 只无效股票（symbol为'undefined'）`);

    if (undefinedStocks.length === 0) {
      console.log('没有无效股票需要清理');
      return;
    }

    // 显示前10条
    console.log('\n前10条无效股票:');
    undefinedStocks.slice(0, 10).forEach((stock, index) => {
      console.log(`${index + 1}. ID: ${stock.id}, Symbol: "${stock.symbol}", Name: "${stock.name}", Market: ${stock.market}`);
    });

    // 2. 删除关联的日线数据
    const stockIds = undefinedStocks.map(stock => stock.id);
    console.log(`\n删除关联的日线数据...`);
    const deletedBars = await DailyBar.destroy({
      where: { stockId: stockIds }
    });
    console.log(`已删除 ${deletedBars} 条日线数据`);

    // 3. 删除无效股票记录
    console.log(`删除无效股票记录...`);
    const deletedStocks = await Stock.destroy({
      where: { id: stockIds }
    });
    console.log(`已删除 ${deletedStocks} 只无效股票`);

    // 4. 验证清理结果
    const remainingUndefined = await Stock.count({
      where: { symbol: 'undefined' }
    });
    console.log(`\n清理后，剩余无效股票数: ${remainingUndefined}`);

    if (remainingUndefined === 0) {
      console.log('✅ 清理完成');
    } else {
      console.log('⚠️  仍有无效股票存在');
    }

  } catch (error) {
    console.error(`清理失败: ${error.message}`);
    console.error(`堆栈: ${error.stack}`);
    process.exit(1);
  }
}

cleanupUndefinedStocks().catch(error => {
  console.error('脚本执行失败:', error);
  process.exit(1);
});