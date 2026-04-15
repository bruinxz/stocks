const { sequelize } = require('../dist/config/database');

async function checkStockFormat() {
  try {
    await sequelize.authenticate();
    console.log('数据库连接成功\n');

    // 1. 检查股票总数
    const totalResult = await sequelize.query(
      'SELECT COUNT(*) as total FROM stocks',
      { type: sequelize.QueryTypes.SELECT }
    );
    console.log(`总股票数: ${totalResult[0].total}\n`);

    // 2. 检查股票代码格式分布
    const formatQuery = `
      SELECT
        CASE
          WHEN symbol LIKE 'sh.%' THEN '上海'
          WHEN symbol LIKE 'sz.%' THEN '深圳'
          WHEN symbol LIKE 'bj.%' THEN '北京'
          ELSE '其他格式'
        END as market_type,
        COUNT(*) as count
      FROM stocks
      GROUP BY market_type
      ORDER BY count DESC
    `;

    const formatResults = await sequelize.query(formatQuery, { type: sequelize.QueryTypes.SELECT });
    console.log('股票代码格式分布:');
    formatResults.forEach(row => {
      console.log(`  ${row.market_type}: ${row.count} 只`);
    });

    // 3. 检查具体的前缀
    const prefixQuery = `
      SELECT
        LEFT(symbol, 5) as prefix,
        COUNT(*) as count
      FROM stocks
      GROUP BY LEFT(symbol, 5)
      ORDER BY count DESC
      LIMIT 10
    `;

    console.log('\n具体前缀分布 (前10):');
    const prefixResults = await sequelize.query(prefixQuery, { type: sequelize.QueryTypes.SELECT });
    prefixResults.forEach(row => {
      console.log(`  ${row.prefix}: ${row.count} 只`);
    });

    // 4. 检查有数据和没数据的股票
    const dataQuery = `
      SELECT
        COUNT(*) as total,
        COUNT(CASE WHEN db.time IS NOT NULL THEN 1 END) as with_data,
        COUNT(CASE WHEN db.time IS NULL THEN 1 END) as without_data
      FROM stocks s
      LEFT JOIN daily_bars db ON s.id = db.stock_id
    `;

    const dataResults = await sequelize.query(dataQuery, { type: sequelize.QueryTypes.SELECT });
    const data = dataResults[0];
    console.log('\n数据情况:');
    console.log(`  有日线数据: ${data.with_data} 只`);
    console.log(`  无日线数据: ${data.without_data} 只`);
    console.log(`  总计: ${data.total} 只`);

    // 5. 查看一些示例
    console.log('\n有数据的股票示例 (前5只):');
    const withDataExample = await sequelize.query(`
      SELECT s.symbol, s.name, COUNT(db.time) as bar_count
      FROM stocks s
      INNER JOIN daily_bars db ON s.id = db.stock_id
      GROUP BY s.id, s.symbol, s.name
      LIMIT 5
    `, { type: sequelize.QueryTypes.SELECT });

    withDataExample.forEach(stock => {
      console.log(`  ${stock.symbol} - ${stock.name}: ${stock.bar_count} 条数据`);
    });

    console.log('\n无数据的股票示例 (前5只):');
    const withoutDataExample = await sequelize.query(`
      SELECT s.symbol, s.name
      FROM stocks s
      LEFT JOIN daily_bars db ON s.id = db.stock_id
      WHERE db.time IS NULL
      LIMIT 5
    `, { type: sequelize.QueryTypes.SELECT });

    withoutDataExample.forEach(stock => {
      console.log(`  ${stock.symbol} - ${stock.name}`);
    });

  } catch (error) {
    console.error('检查失败:', error);
  } finally {
    await sequelize.close();
  }
}

checkStockFormat();