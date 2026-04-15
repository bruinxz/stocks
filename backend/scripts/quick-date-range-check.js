const { sequelize } = require('../dist/config/database');

async function quickDateRangeCheck() {
  try {
    await sequelize.authenticate();
    console.log('数据库连接成功\n');

    // 1. 检查整体日期范围
    const dateRangeQuery = `
      SELECT
        MIN(time) as earliest_date,
        MAX(time) as latest_date,
        COUNT(DISTINCT DATE(time)) as total_trading_days
      FROM daily_bars
    `;
    const dateRange = await sequelize.query(dateRangeQuery, { type: sequelize.QueryTypes.SELECT });
    console.log('整体数据日期范围:');
    console.log(`  最早交易日: ${dateRange[0].earliest_date}`);
    console.log(`  最晚交易日: ${dateRange[0].latest_date}`);
    console.log(`  总交易日数: ${dateRange[0].total_trading_days}`);

    // 2. 检查过去5年和10年的理论交易日
    const today = new Date('2026-04-06');
    const fiveYearsAgo = new Date('2021-04-06');
    const tenYearsAgo = new Date('2016-04-06');

    console.log(`\n分析时间范围:`);
    console.log(`  今天: ${today.toISOString().split('T')[0]}`);
    console.log(`  5年前: ${fiveYearsAgo.toISOString().split('T')[0]}`);
    console.log(`  10年前: ${tenYearsAgo.toISOString().split('T')[0]}`);

    // 3. 检查过去5年和10年的实际交易日
    const fiveYearDaysQuery = `
      SELECT COUNT(DISTINCT DATE(time)) as trading_days
      FROM daily_bars
      WHERE time >= $1 AND time <= $2
    `;
    const fiveYearDays = await sequelize.query(fiveYearDaysQuery, {
      replacements: [fiveYearsAgo, today],
      type: sequelize.QueryTypes.SELECT
    });

    const tenYearDaysQuery = `
      SELECT COUNT(DISTINCT DATE(time)) as trading_days
      FROM daily_bars
      WHERE time >= $1 AND time <= $2
    `;
    const tenYearDays = await sequelize.query(tenYearDaysQuery, {
      replacements: [tenYearsAgo, today],
      type: sequelize.QueryTypes.SELECT
    });

    console.log(`\n实际交易日统计:`);
    console.log(`  过去5年实际交易日: ${fiveYearDays[0].trading_days}`);
    console.log(`  过去10年实际交易日: ${tenYearDays[0].trading_days}`);
    console.log(`  理论交易日（每年250天）:`);
    console.log(`    - 5年: 1250天`);
    console.log(`    - 10年: 2500天`);

    // 4. 检查股票上市日期分布
    const listingDateQuery = `
      SELECT
        EXTRACT(YEAR FROM "listingDate") as year,
        COUNT(*) as count
      FROM stocks
      WHERE "listingDate" IS NOT NULL
      GROUP BY EXTRACT(YEAR FROM "listingDate")
      ORDER BY year
    `;
    const listingDates = await sequelize.query(listingDateQuery, { type: sequelize.QueryTypes.SELECT });

    console.log('\n股票上市年份分布:');
    listingDates.forEach(row => {
      console.log(`  ${row.year}年: ${row.count} 只`);
    });

    // 5. 快速统计过去5年和10年数据完整性
    console.log('\n正在快速统计数据完整性...');

    // 使用更高效的查询
    const completenessQuery = `
      SELECT
        s.symbol,
        COUNT(DISTINCT CASE WHEN db.time >= $1 AND db.time <= $2 THEN DATE(db.time) END) as five_year_days,
        COUNT(DISTINCT CASE WHEN db.time >= $3 AND db.time <= $4 THEN DATE(db.time) END) as ten_year_days
      FROM stocks s
      INNER JOIN daily_bars db ON s.id = db.stock_id
      GROUP BY s.id, s.symbol
      LIMIT 1000
    `;

    const sampleResults = await sequelize.query(completenessQuery, {
      replacements: [fiveYearsAgo, today, tenYearsAgo, today],
      type: sequelize.QueryTypes.SELECT
    });

    const fiveYearExpected = 1250; // 理论值
    const tenYearExpected = 2500; // 理论值

    let fiveYearCompleteCount = 0;
    let tenYearCompleteCount = 0;
    let totalChecked = sampleResults.length;

    sampleResults.forEach(row => {
      const fiveYearRatio = row.five_year_days / fiveYearExpected;
      const tenYearRatio = row.ten_year_days / tenYearExpected;

      if (fiveYearRatio >= 0.9) fiveYearCompleteCount++;
      if (tenYearRatio >= 0.9) tenYearCompleteCount++;
    });

    console.log(`\n基于 ${totalChecked} 只股票样本的统计:`);
    console.log(`  过去5年完整数据 (≥90%): ${fiveYearCompleteCount} 只 (${(fiveYearCompleteCount/totalChecked*100).toFixed(2)}%)`);
    console.log(`  过去10年完整数据 (≥90%): ${tenYearCompleteCount} 只 (${(tenYearCompleteCount/totalChecked*100).toFixed(2)}%)`);

    // 6. 显示示例
    console.log('\n数据完整性示例:');
    sampleResults.slice(0, 5).forEach((row, i) => {
      const fiveYearRatio = (row.five_year_days / fiveYearExpected * 100).toFixed(1);
      const tenYearRatio = (row.ten_year_days / tenYearExpected * 100).toFixed(1);
      console.log(`  ${i+1}. ${row.symbol}: 5年${row.five_year_days}天(${fiveYearRatio}%), 10年${row.ten_year_days}天(${tenYearRatio}%)`);
    });

  } catch (error) {
    console.error('检查失败:', error);
  } finally {
    await sequelize.close();
  }
}

quickDateRangeCheck();