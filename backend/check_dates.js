const { Sequelize } = require('sequelize');

const sequelize = new Sequelize({
  database: 'stock_backtest',
  username: 'postgres',
  password: 'postgres',
  host: 'localhost',
  port: 5432,
  dialect: 'postgres',
  logging: false,
});

async function checkDateRanges() {
  try {
    await sequelize.authenticate();
    console.log('数据库连接成功');

    // 查询日期范围
    const [dateResult] = await sequelize.query(`
      SELECT
        MIN(time) as earliest_date,
        MAX(time) as latest_date,
        COUNT(*) as total_records
      FROM daily_bars
    `);

    console.log('整体数据统计:');
    console.log(`  最早日期: ${dateResult[0].earliest_date}`);
    console.log(`  最新日期: ${dateResult[0].latest_date}`);
    console.log(`  总记录数: ${dateResult[0].total_records}`);

    // 查询最近7天有多少数据
    const [recentResult] = await sequelize.query(`
      SELECT COUNT(*) as recent_count
      FROM daily_bars
      WHERE time >= NOW() - INTERVAL '7 days'
    `);

    console.log(`\n最近7天数据量: ${recentResult[0].recent_count}`);

    // 查询不同年份的数据分布
    const [yearResult] = await sequelize.query(`
      SELECT
        EXTRACT(YEAR FROM time) as year,
        COUNT(*) as record_count,
        MIN(time) as min_date,
        MAX(time) as max_date
      FROM daily_bars
      GROUP BY EXTRACT(YEAR FROM time)
      ORDER BY year DESC
    `);

    console.log('\n按年份分布:');
    yearResult.forEach(row => {
      console.log(`  ${row.year}: ${row.record_count} 条记录 (${row.min_date.toISOString().split('T')[0]} 到 ${row.max_date.toISOString().split('T')[0]})`);
    });

    // 随机选择5支股票查看它们的数据日期范围
    const [stockResult] = await sequelize.query(`
      SELECT
        s.symbol,
        s.name,
        MIN(db.time) as earliest,
        MAX(db.time) as latest,
        COUNT(db.id) as data_count
      FROM stocks s
      JOIN daily_bars db ON s.id = db.stock_id
      GROUP BY s.id, s.symbol, s.name
      ORDER BY RANDOM()
      LIMIT 5
    `);

    console.log('\n随机5支股票的日期范围:');
    stockResult.forEach((row, i) => {
      console.log(`  ${i+1}. ${row.symbol} (${row.name}):`);
      console.log(`     数据量: ${row.data_count}`);
      console.log(`     日期范围: ${row.earliest.toISOString().split('T')[0]} 到 ${row.latest.toISOString().split('T')[0]}`);
    });

    await sequelize.close();
  } catch (error) {
    console.error('错误:', error.message);
    if (error.stack) {
      console.error('堆栈:', error.stack.split('\n').slice(0, 3).join('\n'));
    }
  }
}

checkDateRanges();