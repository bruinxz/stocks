const { sequelize } = require('../dist/config/database');

async function quickCoverageCheck() {
  try {
    await sequelize.authenticate();
    console.log('数据库连接成功\n');

    // 总股票数
    const totalResult = await sequelize.query(
      'SELECT COUNT(*) as total FROM stocks',
      { type: sequelize.QueryTypes.SELECT }
    );
    const total = parseInt(totalResult[0].total);

    // 有数据的股票数
    const withDataResult = await sequelize.query(`
      SELECT COUNT(DISTINCT s.id) as with_data
      FROM stocks s
      INNER JOIN daily_bars db ON s.id = db.stock_id
    `, { type: sequelize.QueryTypes.SELECT });
    const withData = parseInt(withDataResult[0].with_data);

    // 无数据的股票数
    const withoutDataResult = await sequelize.query(`
      SELECT COUNT(DISTINCT s.id) as without_data
      FROM stocks s
      LEFT JOIN daily_bars db ON s.id = db.stock_id
      WHERE db.time IS NULL
    `, { type: sequelize.QueryTypes.SELECT });
    const withoutData = parseInt(withoutDataResult[0].without_data);

    // 数据条数
    const barCountResult = await sequelize.query(
      'SELECT COUNT(*) as bar_count FROM daily_bars',
      { type: sequelize.QueryTypes.SELECT }
    );
    const barCount = parseInt(barCountResult[0].bar_count);

    console.log('=== 数据覆盖率快照 ===');
    console.log(`时间: ${new Date().toLocaleString()}`);
    console.log(`总股票数: ${total}`);
    console.log(`有日线数据的股票: ${withData} (${(withData/total*100).toFixed(2)}%)`);
    console.log(`无日线数据的股票: ${withoutData} (${(withoutData/total*100).toFixed(2)}%)`);
    console.log(`总日线数据条数: ${barCount}`);
    console.log(`平均每只有数据股票的条数: ${withData > 0 ? (barCount/withData).toFixed(1) : 0}`);

    // 市场分布
    const marketQuery = `
      SELECT
        market,
        COUNT(*) as total,
        SUM(CASE WHEN has_data THEN 1 ELSE 0 END) as with_data
      FROM (
        SELECT
          CASE
            WHEN symbol LIKE 'sh.%' THEN '上海'
            WHEN symbol LIKE 'sz.%' THEN '深圳'
            WHEN symbol LIKE 'bj.%' THEN '北京'
            ELSE '其他'
          END as market,
          CASE WHEN db.time IS NOT NULL THEN TRUE ELSE FALSE END as has_data
        FROM stocks s
        LEFT JOIN daily_bars db ON s.id = db.stock_id
      ) as subquery
      GROUP BY market
      ORDER BY total DESC
    `;
    const marketResults = await sequelize.query(marketQuery, { type: sequelize.QueryTypes.SELECT });
    console.log('\n各市场数据覆盖率:');
    marketResults.forEach(row => {
      const coverage = row.total > 0 ? (row.with_data / row.total * 100).toFixed(2) : '0.00';
      console.log(`  ${row.market}: ${row.with_data}/${row.total} (${coverage}%)`);
    });

  } catch (error) {
    console.error('检查失败:', error);
  } finally {
    await sequelize.close();
  }
}

quickCoverageCheck();