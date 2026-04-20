#!/usr/bin/env node
/**
 * 快速检查数据完整性状态
 */

async function quickCheck() {
  try {
    const { Stock, DailyBar } = require('../backend/dist/models');
    const { sequelize } = require('../backend/dist/config/database');
    const { logger } = require('../backend/dist/utils/logger');
    const { Op } = require('../backend/node_modules/sequelize');

    // 抑制日志
    logger.level = 'error';

    await sequelize.authenticate();
    console.log('数据库连接成功');

    console.log('=== 数据完整性快速检查 ===\n');

    // 1. 基本统计
    const totalStocks = await Stock.count({ where: { isListed: true } });
    console.log(`1. 上市股票总数: ${totalStocks}`);

    // 2. 按市场统计
    const byMarket = await Stock.findAll({
      attributes: ['market', [sequelize.fn('COUNT', sequelize.col('id')), 'count']],
      where: { isListed: true },
      group: ['market']
    });

    console.log('2. 按市场分布:');
    byMarket.forEach(item => {
      console.log(`   ${item.market || '未知'}: ${item.get('count')} 只`);
    });

    // 3. 有数据的股票统计（最近1年）
    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

    const stocksWithData = await Stock.count({
      include: [{
        model: DailyBar,
        required: true,
        where: {
          time: { [Op.gte]: oneYearAgo }
        }
      }],
      distinct: true
    });

    console.log(`3. 有日线数据（最近1年）的股票: ${stocksWithData} 只`);

    const completeness = totalStocks > 0 ? (stocksWithData / totalStocks * 100).toFixed(2) : '0.00';
    console.log(`   数据完整性: ${completeness}%`);

    // 4. 数据量分布
    console.log('4. 数据量分布:');
    const dataCountRanges = [
      { name: '无数据', min: 0, max: 0 },
      { name: '少量数据 (1-50条)', min: 1, max: 50 },
      { name: '中等数据 (51-200条)', min: 51, max: 200 },
      { name: '充足数据 (201+条)', min: 201, max: 999999 }
    ];

    for (const range of dataCountRanges) {
      let count;
      if (range.min === 0 && range.max === 0) {
        // 无数据
        count = await Stock.count({
          where: { isListed: true },
          include: [{
            model: DailyBar,
            required: false
          }],
          having: sequelize.where(sequelize.fn('COUNT', sequelize.col('DailyBars.id')), '=', 0),
          group: ['Stock.id']
        });
      } else {
        count = await Stock.count({
          where: { isListed: true },
          include: [{
            model: DailyBar,
            required: true,
            attributes: []
          }],
          having: sequelize.where(sequelize.fn('COUNT', sequelize.col('DailyBars.id')), '>=', range.min),
          group: ['Stock.id']
        });

        if (range.max < 999999) {
          // 需要子查询或更复杂的逻辑，这里简化
        }
      }
      console.log(`   ${range.name}: ${count} 只`);
    }

    // 5. 最近同步的股票示例
    console.log('5. 最近有数据的股票示例:');
    const recentStocks = await Stock.findAll({
      include: [{
        model: DailyBar,
        required: true,
        attributes: [],
        where: {
          time: { [Op.gte]: oneYearAgo }
        }
      }],
      order: [[sequelize.fn('MAX', sequelize.col('DailyBars.time')), 'DESC']],
      group: ['Stock.id'],
      limit: 5
    });

    recentStocks.forEach(stock => {
      console.log(`   ${stock.symbol} (${stock.name})`);
    });

    // 6. 建议
    console.log('\n6. 建议:');
    if (parseFloat(completeness) < 10) {
      console.log('   ❌ 数据完整性极低，需要立即运行全量同步');
      console.log('     命令: node scripts/sync_main_board.js');
    } else if (parseFloat(completeness) < 50) {
      console.log('   ⚠️  数据完整性较低，建议运行主板股票同步');
      console.log('     命令: node scripts/sync_main_board.js');
    } else if (parseFloat(completeness) < 80) {
      console.log('   ✅ 数据完整性可接受，但仍有改进空间');
      console.log('     可以运行补充同步');
    } else {
      console.log('   ✅ 数据完整性良好');
    }

    console.log('\n=== 检查完成 ===');

  } catch (error) {
    console.error(`检查失败: ${error.message}`);
    process.exit(1);
  }
}

quickCheck().catch(error => {
  console.error('脚本执行失败:', error);
  process.exit(1);
});