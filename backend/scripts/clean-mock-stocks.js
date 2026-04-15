const { sequelize } = require('../dist/config/database');
const { Stock } = require('../dist/models');
const { Op } = require('sequelize');

async function cleanMockStocks() {
  try {
    console.log('开始清理模拟股票数据...');

    // 连接到数据库
    await sequelize.authenticate();
    console.log('数据库连接成功');

    // 查找模拟股票：名称包含"模拟"或行业为null且上市日期为2010-01-01
    const mockStocks = await Stock.findAll({
      where: {
        [Op.or]: [
          { name: { [Op.like]: '%模拟%' } },
          {
            [Op.and]: [
              { industry: null },
              { listingDate: '2010-01-01' }
            ]
          }
        ]
      }
    });

    console.log(`找到 ${mockStocks.length} 只模拟股票`);

    if (mockStocks.length > 0) {
      // 删除这些模拟股票
      const stockIds = mockStocks.map(stock => stock.id);
      await Stock.destroy({
        where: {
          id: {
            [Op.in]: stockIds
          }
        }
      });
      console.log(`已删除 ${mockStocks.length} 只模拟股票`);

      // 显示被删除的股票
      console.log('\n被删除的模拟股票:');
      mockStocks.forEach(stock => {
        console.log(`  ${stock.symbol} - ${stock.name} (${stock.market})`);
      });
    } else {
      console.log('未找到模拟股票');
    }

    // 统计剩余股票
    const totalStocks = await Stock.count();
    console.log(`\n数据库现有股票总数: ${totalStocks}`);

    await sequelize.close();
    console.log('清理完成');
    process.exit(0);
  } catch (error) {
    console.error('清理模拟股票失败:', error);
    process.exit(1);
  }
}

// 执行清理
cleanMockStocks();