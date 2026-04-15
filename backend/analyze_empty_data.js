const { sequelize } = require('./dist/config/database');
const { Stock, DailyBar } = require('./dist/models');

async function analyzeEmptyData() {
  try {
    await sequelize.authenticate();
    console.log('Database connected\n');

    console.log('=== A股股票数据空值分析报告 ===\n');

    // 1. 统计总股票数
    const totalStocks = await Stock.count();
    console.log(`1. 总股票数: ${totalStocks} 只\n`);

    // 2. 统计基本信息缺失情况
    console.log('2. 基本信息缺失统计:');

    const missingName = await Stock.count({ where: { name: null } });
    const missingMarket = await Stock.count({ where: { market: null } });
    const missingIndustry = await Stock.count({ where: { industry: null } });
    const missingListingDate = await Stock.count({ where: { listingDate: null } });
    const missingType = await Stock.count({ where: { type: null } });

    console.log(`   名称缺失: ${missingName} 只 (${((missingName / totalStocks) * 100).toFixed(2)}%)`);
    console.log(`   市场缺失: ${missingMarket} 只 (${((missingMarket / totalStocks) * 100).toFixed(2)}%)`);
    console.log(`   行业缺失: ${missingIndustry} 只 (${((missingIndustry / totalStocks) * 100).toFixed(2)}%)`);
    console.log(`   上市日期缺失: ${missingListingDate} 只 (${((missingListingDate / totalStocks) * 100).toFixed(2)}%)`);
    console.log(`   类型缺失: ${missingType} 只 (${((missingType / totalStocks) * 100).toFixed(2)}%)`);

    // 检查退市股票比例
    const delistedStocks = await Stock.count({ where: { isListed: false } });
    console.log(`   退市股票: ${delistedStocks} 只 (${((delistedStocks / totalStocks) * 100).toFixed(2)}%)\n`);

    // 3. 统计日线数据缺失情况
    console.log('3. 日线数据缺失统计:');

    // 获取所有股票及其日线数据数量
    const stocksWithBarCount = await sequelize.query(`
      SELECT s.id, s.symbol, s.name, COUNT(db.time) as bar_count
      FROM stocks s
      LEFT JOIN daily_bars db ON s.id = db.stock_id
      GROUP BY s.id, s.symbol, s.name
      ORDER BY bar_count DESC
    `, { type: sequelize.QueryTypes.SELECT });

    const noBars = stocksWithBarCount.filter(row => row.bar_count === '0');
    const lessThan10Bars = stocksWithBarCount.filter(row => parseInt(row.bar_count) > 0 && parseInt(row.bar_count) < 10);
    const lessThan50Bars = stocksWithBarCount.filter(row => parseInt(row.bar_count) > 0 && parseInt(row.bar_count) < 50);
    const moreThan100Bars = stocksWithBarCount.filter(row => parseInt(row.bar_count) >= 100);

    console.log(`   无日线数据: ${noBars.length} 只 (${((noBars.length / totalStocks) * 100).toFixed(2)}%)`);
    console.log(`   <10条日线数据: ${lessThan10Bars.length} 只 (${((lessThan10Bars.length / totalStocks) * 100).toFixed(2)}%)`);
    console.log(`   <50条日线数据: ${lessThan50Bars.length} 只 (${((lessThan50Bars.length / totalStocks) * 100).toFixed(2)}%)`);
    console.log(`   ≥100条日线数据: ${moreThan100Bars.length} 只 (${((moreThan100Bars.length / totalStocks) * 100).toFixed(2)}%)\n`);

    // 4. 统计近期数据缺失（最近30天）
    console.log('4. 近期数据统计（最近30天）:');

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - 30);
    const cutoffDateStr = cutoffDate.toISOString().split('T')[0];

    const recentBarsCount = await sequelize.query(`
      SELECT s.id, COUNT(db.time) as recent_bar_count
      FROM stocks s
      LEFT JOIN daily_bars db ON s.id = db.stock_id AND db.time >= :cutoffDate
      GROUP BY s.id
    `, {
      replacements: { cutoffDate: cutoffDateStr },
      type: sequelize.QueryTypes.SELECT
    });

    const noRecentBars = recentBarsCount.filter(row => row.recent_bar_count === '0');
    const recentBarStats = await sequelize.query(`
      SELECT
        COUNT(DISTINCT stock_id) as stocks_with_recent_data,
        COUNT(*) as total_recent_bars
      FROM daily_bars
      WHERE time >= :cutoffDate
    `, {
      replacements: { cutoffDate: cutoffDateStr },
      type: sequelize.QueryTypes.SELECT
    });

    console.log(`   最近30天无数据: ${noRecentBars.length} 只 (${((noRecentBars.length / totalStocks) * 100).toFixed(2)}%)`);
    console.log(`   最近30天有数据: ${recentBarStats[0].stocks_with_recent_data} 只`);
    console.log(`   最近30天总数据条数: ${recentBarStats[0].total_recent_bars} 条\n`);

    // 5. 样本分析 - 显示缺少数据的股票示例
    console.log('5. 缺少数据股票示例:');

    // 找10个完全没有日线数据的股票
    if (noBars.length > 0) {
      const sampleNoBars = noBars.slice(0, 5);
      console.log('\n   A. 无日线数据股票示例 (前5个):');
      sampleNoBars.forEach((stock, i) => {
        console.log(`      ${i+1}. ${stock.symbol} - ${stock.name || '无名'}`);
      });
    }

    // 找10个缺少基本信息的股票
    const missingBasicStocks = await Stock.findAll({
      where: {
        [sequelize.Op.or]: [
          { name: null },
          { market: null },
          { listingDate: null }
        ]
      },
      limit: 5,
      attributes: ['symbol', 'name', 'market', 'listingDate']
    });

    if (missingBasicStocks.length > 0) {
      console.log('\n   B. 缺少基本信息股票示例 (前5个):');
      missingBasicStocks.forEach((stock, i) => {
        console.log(`      ${i+1}. ${stock.symbol} - 名称:${stock.name || '缺失'}, 市场:${stock.market || '缺失'}, 上市日期:${stock.listingDate || '缺失'}`);
      });
    }

    // 6. 数据分布分析
    console.log('\n6. 日线数据分布分析:');

    const barDistribution = await sequelize.query(`
      SELECT
        CASE
          WHEN bar_count = 0 THEN '0条'
          WHEN bar_count < 10 THEN '1-9条'
          WHEN bar_count < 50 THEN '10-49条'
          WHEN bar_count < 100 THEN '50-99条'
          WHEN bar_count < 200 THEN '100-199条'
          WHEN bar_count < 500 THEN '200-499条'
          ELSE '500条以上'
        END as data_range,
        COUNT(*) as stock_count,
        ROUND(COUNT(*)::decimal / :totalStocks * 100, 2) as percentage
      FROM (
        SELECT s.id, COUNT(db.time) as bar_count
        FROM stocks s
        LEFT JOIN daily_bars db ON s.id = db.stock_id
        GROUP BY s.id
      ) stock_bar_counts
      GROUP BY data_range
      ORDER BY
        CASE data_range
          WHEN '0条' THEN 1
          WHEN '1-9条' THEN 2
          WHEN '10-49条' THEN 3
          WHEN '50-99条' THEN 4
          WHEN '100-199条' THEN 5
          WHEN '200-499条' THEN 6
          ELSE 7
        END
    `, {
      replacements: { totalStocks: totalStocks },
      type: sequelize.QueryTypes.SELECT
    });

    console.log('   数据范围       股票数量     占比');
    console.log('   -------------------------------------');
    barDistribution.forEach(row => {
      console.log(`   ${row.data_range.padEnd(10)} ${row.stock_count.toString().padStart(6)} 只  ${row.percentage.toString().padStart(5)}%`);
    });

    // 7. 总结
    console.log('\n7. 数据质量总结:');
    console.log(`   • 数据库中共有 ${totalStocks} 只A股股票`);
    console.log(`   • ${noBars.length} 只股票 (${((noBars.length / totalStocks) * 100).toFixed(2)}%) 完全无日线数据`);
    console.log(`   • ${missingName} 只股票 (${((missingName / totalStocks) * 100).toFixed(2)}%) 缺少名称信息`);
    console.log(`   • ${recentBarStats[0].stocks_with_recent_data} 只股票有最近30天的数据`);

    console.log('\n8. 建议:');
    if (noBars.length > 0) {
      console.log(`   • 需要为 ${noBars.length} 只股票获取日线数据`);
    }
    if (missingName > 0) {
      console.log(`   • 需要为 ${missingName} 只股票补全名称信息`);
    }
    if (noRecentBars.length > 0) {
      console.log(`   • 有 ${noRecentBars.length} 只股票最近30天无数据，需要检查数据源同步`);
    }

  } catch (error) {
    console.error('分析错误:', error);
  } finally {
    await sequelize.close();
  }
}

analyzeEmptyData();