const { sequelize } = require('../dist/config/database');
const { DataSyncService } = require('../dist/data/services/DataSyncService');

async function testSyncAfterFix() {
  console.log('=== 修复后数据同步测试 ===\n');

  try {
    await sequelize.authenticate();
    console.log('数据库连接成功\n');

    const dataSyncService = new DataSyncService();

    // 测试几只不同市场的股票
    const testStocks = [
      { symbol: 'sh.600016', name: '民生银行', market: '上海主板' },
      { symbol: 'sz.000002', name: '万科A', market: '深圳主板' },
      { symbol: 'sz.300001', name: '特锐德', market: '创业板' },
      { symbol: 'sh.688001', name: '华兴源创', market: '科创板' },
      { symbol: 'bj.920000', name: '科创板', market: '北京交易所' }
    ];

    console.log('测试股票列表:');
    testStocks.forEach((stock, i) => {
      console.log(`  ${i+1}. ${stock.symbol} - ${stock.name} (${stock.market})`);
    });

    const startDate = '2025-01-01';
    const endDate = '2025-01-31'; // 只测试一个月的数据，减少API调用

    console.log(`\n同步时间范围: ${startDate} 至 ${endDate}`);
    console.log('开始同步...\n');

    const symbols = testStocks.map(s => s.symbol);
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
      const stock = testStocks.find(s => s.symbol === symbol);
      const stockName = stock ? stock.name : '未知';

      let status;
      if (count > 0) {
        status = `✅ 成功: ${count} 条数据`;
        success++;
      } else if (count === 0) {
        status = `⚠️  跳过: 已有数据或无新数据`;
        skip++;
      } else {
        status = `❌ 失败`;
        fail++;
      }
      console.log(`  ${symbol} (${stockName}): ${status}`);
    });

    console.log(`\n统计: 成功 ${success}, 失败 ${fail}, 跳过 ${skip}`);

    // 验证数据是否插入
    console.log('\n=== 数据验证 ===');
    for (const stock of testStocks) {
      const countQuery = `
        SELECT COUNT(*) as count
        FROM daily_bars db
        JOIN stocks s ON s.id = db.stock_id
        WHERE s.symbol = :symbol
          AND db.time BETWEEN :startDate AND :endDate
      `;

      try {
        const countResult = await sequelize.query(countQuery, {
          replacements: {
            symbol: stock.symbol,
            startDate: new Date(startDate),
            endDate: new Date(endDate)
          },
          type: sequelize.QueryTypes.SELECT
        });

        const count = parseInt(countResult[0].count);
        console.log(`  ${stock.symbol}: ${count} 条数据 (${startDate} 至 ${endDate})`);
      } catch (error) {
        console.log(`  ${stock.symbol}: 查询失败 - ${error.message}`);
      }
    }

    // 检查总数
    console.log('\n=== 数据库统计 ===');
    const totalStocksQuery = 'SELECT COUNT(*) as total FROM stocks';
    const totalStocksResult = await sequelize.query(totalStocksQuery, { type: sequelize.QueryTypes.SELECT });
    console.log(`总股票数: ${totalStocksResult[0].total}`);

    const stocksWithDataQuery = `
      SELECT COUNT(DISTINCT s.id) as count
      FROM stocks s
      INNER JOIN daily_bars db ON s.id = db.stock_id
    `;
    const stocksWithDataResult = await sequelize.query(stocksWithDataQuery, { type: sequelize.QueryTypes.SELECT });
    console.log(`有数据的股票: ${stocksWithDataResult[0].count}`);

    const dataCoverage = (stocksWithDataResult[0].count / totalStocksResult[0].total * 100).toFixed(2);
    console.log(`数据覆盖率: ${dataCoverage}%`);

  } catch (error) {
    console.error('测试失败:', error);
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

testSyncAfterFix();