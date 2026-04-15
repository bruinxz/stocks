const { sequelize } = require('../dist/config/database');
const { DataSyncService } = require('../dist/data/services/DataSyncService');

async function miniSyncTest() {
  console.log('=== 小规模数据同步测试 ===\n');

  try {
    await sequelize.authenticate();
    console.log('数据库连接成功\n');

    const dataSyncService = new DataSyncService();

    // 获取10只没有数据的股票
    const query = `
      SELECT s.symbol, s.name, s.market
      FROM stocks s
      LEFT JOIN daily_bars db ON s.id = db.stock_id
      WHERE db.time IS NULL
        AND s.symbol LIKE 'sh.6%'
      LIMIT 5
    `;

    const stocks = await sequelize.query(query, { type: sequelize.QueryTypes.SELECT });

    if (stocks.length === 0) {
      console.log('没有找到需要同步的股票');
      return;
    }

    console.log(`找到 ${stocks.length} 只需要同步的股票:\n`);
    stocks.forEach((stock, i) => {
      console.log(`  ${i+1}. ${stock.symbol} - ${stock.name} (${stock.market})`);
    });

    const symbols = stocks.map(s => s.symbol);
    const startDate = '2025-01-01';
    const endDate = '2025-12-31';

    console.log(`\n同步时间范围: ${startDate} 至 ${endDate}`);
    console.log('开始同步...\n');

    const startTime = Date.now();

    // 使用批量同步，每批2只股票
    const results = await dataSyncService.syncMultipleStocksHistory(
      symbols,
      startDate,
      endDate,
      2
    );

    const endTime = Date.now();
    const elapsedSeconds = (endTime - startTime) / 1000;

    console.log('\n同步完成:');
    console.log(`  耗时: ${elapsedSeconds.toFixed(2)} 秒\n`);

    let success = 0;
    let fail = 0;
    let skip = 0;

    console.log('详细结果:');
    Object.entries(results).forEach(([symbol, count]) => {
      let status;
      if (count > 0) {
        status = `成功: ${count} 条数据`;
        success++;
      } else if (count === 0) {
        status = '跳过: 已有数据或无新数据';
        skip++;
      } else {
        status = '失败';
        fail++;
      }
      console.log(`  ${symbol}: ${status}`);
    });

    console.log(`\n统计: 成功 ${success}, 失败 ${fail}, 跳过 ${skip}`);

    // 验证数据是否插入
    console.log('\n=== 验证数据 ===');
    for (const stock of stocks) {
      const countQuery = `
        SELECT COUNT(*) as count
        FROM daily_bars db
        JOIN stocks s ON s.id = db.stock_id
        WHERE s.symbol = :symbol
          AND db.time BETWEEN :startDate AND :endDate
      `;

      const countResult = await sequelize.query(countQuery, {
        replacements: {
          symbol: stock.symbol,
          startDate: new Date(startDate),
          endDate: new Date(endDate)
        },
        type: sequelize.QueryTypes.SELECT
      });

      const count = parseInt(countResult[0].count);
      console.log(`  ${stock.symbol}: ${count} 条数据 (2025年)`);
    }

  } catch (error) {
    console.error('同步测试失败:', error);
    console.error('错误信息:', error.message);

    if (error.stack) {
      console.error('错误堆栈 (前5行):');
      console.error(error.stack.split('\n').slice(0, 5).join('\n'));
    }
  } finally {
    await sequelize.close();
    console.log('\n测试结束');
  }
}

miniSyncTest();