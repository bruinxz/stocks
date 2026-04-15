const { sequelize } = require('./dist/config/database');

async function checkDataStocks() {
  try {
    await sequelize.authenticate();
    console.log('Database connected\n');

    console.log('=== 数据库中有效数据股票分析 ===\n');

    // 1. 总股票数
    const totalResult = await sequelize.query(
      'SELECT COUNT(*) as total FROM stocks',
      { type: sequelize.QueryTypes.SELECT }
    );
    const totalStocks = parseInt(totalResult[0].total);
    console.log(`1. 总股票数: ${totalStocks.toLocaleString()} 只\n`);

    // 2. 有日线数据的股票
    const stocksWithData = await sequelize.query(`
      SELECT s.symbol, s.name, s.market, COUNT(db.time) as bar_count,
             MIN(db.time) as first_date, MAX(db.time) as last_date
      FROM stocks s
      INNER JOIN daily_bars db ON s.id = db.stock_id
      GROUP BY s.id, s.symbol, s.name, s.market
      ORDER BY bar_count DESC
    `, { type: sequelize.QueryTypes.SELECT });

    console.log(`2. 有日线数据的股票: ${stocksWithData.length} 只 (${((stocksWithData.length / totalStocks) * 100).toFixed(2)}%)\n`);

    if (stocksWithData.length > 0) {
      console.log('3. 有数据股票详情:');
      console.log('   代码        名称             市场   数据条数  最早日期    最晚日期');
      console.log('   -------------------------------------------------------------------');
      stocksWithData.forEach(stock => {
        const firstDate = stock.first_date ? new Date(stock.first_date).toISOString().split('T')[0] : 'N/A';
        const lastDate = stock.last_date ? new Date(stock.last_date).toISOString().split('T')[0] : 'N/A';
        console.log(`   ${stock.symbol.padEnd(10)} ${(stock.name || '').padEnd(15)} ${(stock.market || '').padEnd(4)} ${stock.bar_count.toString().padStart(8)}   ${firstDate.padEnd(10)} ${lastDate}`);
      });

      // 统计市场分布
      const marketDistribution = {};
      stocksWithData.forEach(stock => {
        marketDistribution[stock.market] = (marketDistribution[stock.market] || 0) + 1;
      });

      console.log('\n4. 有数据股票市场分布:');
      Object.entries(marketDistribution).forEach(([market, count]) => {
        console.log(`   ${market}: ${count} 只 (${((count / stocksWithData.length) * 100).toFixed(2)}%)`);
      });

      // 数据条数统计
      const totalBars = stocksWithData.reduce((sum, stock) => sum + parseInt(stock.bar_count), 0);
      const avgBars = totalBars / stocksWithData.length;
      console.log(`\n5. 数据条数统计:`);
      console.log(`   总数据条数: ${totalBars.toLocaleString()} 条`);
      console.log(`   平均每只股票: ${avgBars.toFixed(1)} 条`);
      console.log(`   最多数据股票: ${stocksWithData[0].symbol} - ${stocksWithData[0].bar_count} 条`);
      console.log(`   最少数据股票: ${stocksWithData[stocksWithData.length - 1].symbol} - ${stocksWithData[stocksWithData.length - 1].bar_count} 条`);
    }

    // 3. 无数据股票统计
    console.log('\n6. 无日线数据统计:');
    const noDataStocks = totalStocks - stocksWithData.length;
    console.log(`   无日线数据股票: ${noDataStocks.toLocaleString()} 只 (${((noDataStocks / totalStocks) * 100).toFixed(2)}%)`);

    // 随机查看10只无数据股票
    const sampleNoData = await sequelize.query(`
      SELECT s.symbol, s.name, s.market, s.listingDate
      FROM stocks s
      LEFT JOIN daily_bars db ON s.id = db.stock_id
      WHERE db.time IS NULL
      LIMIT 10
    `, { type: sequelize.QueryTypes.SELECT });

    console.log('\n7. 无数据股票示例 (随机10只):');
    console.log('   代码        名称             市场   上市日期');
    console.log('   ---------------------------------------------');
    sampleNoData.forEach(stock => {
      const listingDate = stock.listingdate ? stock.listingdate.split('T')[0] : '未知';
      console.log(`   ${stock.symbol.padEnd(10)} ${(stock.name || '无名').padEnd(15)} ${(stock.market || '未知').padEnd(4)} ${listingDate}`);
    });

    // 4. 行业信息统计
    console.log('\n8. 行业信息统计:');
    const industryStats = await sequelize.query(`
      SELECT
        CASE WHEN industry IS NULL OR industry = '' THEN '未分类' ELSE industry END as industry,
        COUNT(*) as count
      FROM stocks
      GROUP BY CASE WHEN industry IS NULL OR industry = '' THEN '未分类' ELSE industry END
      ORDER BY count DESC
      LIMIT 10
    `, { type: sequelize.QueryTypes.SELECT });

    console.log('   行业分布 (前10):');
    industryStats.forEach(stat => {
      console.log(`   ${stat.industry.padEnd(15)}: ${stat.count} 只 (${((stat.count / totalStocks) * 100).toFixed(2)}%)`);
    });

    // 5. 数据质量总结
    console.log('\n9. 数据质量总结:');
    const coverageRate = (stocksWithData.length / totalStocks) * 100;

    if (coverageRate < 1) {
      console.log(`   ⚠️  严重问题: 数据覆盖率仅 ${coverageRate.toFixed(2)}%`);
      console.log(`   • 数据库中 ${totalStocks} 只股票只有 ${stocksWithData.length} 只有日线数据`);
      console.log(`   • ${noDataStocks} 只股票 (${((noDataStocks / totalStocks) * 100).toFixed(2)}%) 完全无数据`);
    } else if (coverageRate < 10) {
      console.log(`   ⚠️  较大问题: 数据覆盖率 ${coverageRate.toFixed(2)}%`);
      console.log(`   • 需要紧急同步数据`);
    } else if (coverageRate < 50) {
      console.log(`   ⚠️  需要改善: 数据覆盖率 ${coverageRate.toFixed(2)}%`);
      console.log(`   • 建议尽快同步缺失数据`);
    } else {
      console.log(`   ✓ 数据覆盖率 ${coverageRate.toFixed(2)}%`);
    }

    console.log(`\n10. 建议:`);
    console.log(`   • 运行数据同步任务: 需要为 ${noDataStocks} 只股票获取日线数据`);
    console.log(`   • 建议分批同步，避免请求过多`);
    console.log(`   • 优先同步常用股票（主板、流动性好的股票）`);
    console.log(`   • 考虑实现增量更新机制`);

  } catch (error) {
    console.error('分析错误:', error);
  } finally {
    await sequelize.close();
  }
}

checkDataStocks();