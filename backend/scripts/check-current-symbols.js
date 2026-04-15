const { sequelize } = require('../dist/config/database');

async function checkCurrentSymbols() {
  try {
    await sequelize.authenticate();
    console.log('数据库连接成功\n');

    // 检查格式分布
    const query = `
      SELECT
        CASE
          WHEN symbol ~ '^[a-z]{2}\.[0-9]{6}$' THEN '标准格式(小写带点)'
          WHEN symbol ~ '^[A-Z]{2}\.[0-9]{6}$' THEN '标准格式(大写带点)'
          WHEN symbol ~ '^[a-z]{2}[0-9]{6}$' THEN '小写前缀无点'
          WHEN symbol ~ '^[A-Z]{2}[0-9]{6}$' THEN '大写前缀无点'
          WHEN symbol ~ '^[0-9]{6}$' THEN '纯数字'
          ELSE '其他格式'
        END as format_type,
        COUNT(*) as count,
        ARRAY_AGG(symbol ORDER BY symbol LIMIT 5) as examples
      FROM stocks
      GROUP BY format_type
      ORDER BY count DESC
    `;

    const results = await sequelize.query(query, { type: sequelize.QueryTypes.SELECT });

    console.log('当前股票代码格式分析:');
    results.forEach(row => {
      console.log(`\n${row.format_type}: ${row.count} 只`);
      if (row.examples && row.examples.length > 0) {
        console.log(`  示例: ${row.examples.join(', ')}`);
      }
    });

    // 检查市场前缀分布
    console.log('\n\n市场前缀分析:');
    const marketQuery = `
      SELECT
        LEFT(symbol, 2) as prefix,
        COUNT(*) as count
      FROM stocks
      GROUP BY LEFT(symbol, 2)
      ORDER BY count DESC
      LIMIT 10
    `;

    const marketResults = await sequelize.query(marketQuery, { type: sequelize.QueryTypes.SELECT });
    marketResults.forEach(row => {
      console.log(`  ${row.prefix}: ${row.count} 只`);
    });

    // 检查有数据的股票格式
    console.log('\n有日线数据的股票格式:');
    const withDataQuery = `
      SELECT
        s.symbol,
        COUNT(db.time) as bar_count
      FROM stocks s
      INNER JOIN daily_bars db ON s.id = db.stock_id
      GROUP BY s.id, s.symbol
      ORDER BY bar_count DESC
      LIMIT 10
    `;

    const withDataResults = await sequelize.query(withDataQuery, { type: sequelize.QueryTypes.SELECT });
    withDataResults.forEach(row => {
      console.log(`  ${row.symbol}: ${row.bar_count} 条数据`);
    });

  } catch (error) {
    console.error('检查失败:', error);
  } finally {
    await sequelize.close();
  }
}

checkCurrentSymbols();