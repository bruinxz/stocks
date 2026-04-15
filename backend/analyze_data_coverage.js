const { sequelize } = require('./dist/config/database');
const { Stock } = require('./dist/models');
const { Op } = require('sequelize');

async function analyzeDataCoverage() {
  try {
    await sequelize.authenticate();
    console.log('Database connected\n');

    console.log('=== A股股票数据覆盖分析报告 ===\n');

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
    const delistedStocks = await Stock.count({ where: { isListed: false } });

    console.log(`   名称缺失: ${missingName} 只 (${((missingName / totalStocks) * 100).toFixed(2)}%)`);
    console.log(`   市场缺失: ${missingMarket} 只 (${((missingMarket / totalStocks) * 100).toFixed(2)}%)`);
    console.log(`   行业缺失: ${missingIndustry} 只 (${((missingIndustry / totalStocks) * 100).toFixed(2)}%)`);
    console.log(`   上市日期缺失: ${missingListingDate} 只 (${((missingListingDate / totalStocks) * 100).toFixed(2)}%)`);
    console.log(`   类型缺失: ${missingType} 只 (${((missingType / totalStocks) * 100).toFixed(2)}%)`);
    console.log(`   退市股票: ${delistedStocks} 只 (${((delistedStocks / totalStocks) * 100).toFixed(2)}%)\n`);

    // 3. 统计日线数据情况
    console.log('3. 日线数据覆盖统计:');

    // 获取日线数据分布
    const barDistribution = await sequelize.query(`
      SELECT
        CASE
          WHEN bar_count = 0 THEN '0条'
          WHEN bar_count < 10 THEN '1-9条'
          WHEN bar_count < 50 THEN '10-49条'
          WHEN bar_count < 100 THEN '50-99条'
          WHEN bar_count < 200 THEN '100-199条'
          WHEN bar_count < 500 THEN '200-499条'
          WHEN bar_count < 1000 THEN '500-999条'
          ELSE '1000条以上'
        END as data_range,
        COUNT(*) as stock_count,
        ROUND(COUNT(*)::decimal / ${totalStocks} * 100, 2) as percentage
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
          WHEN '500-999条' THEN 7
          ELSE 8
        END
    `, { type: sequelize.QueryTypes.SELECT });

    console.log('   数据范围       股票数量     占比');
    console.log('   -------------------------------------');
    barDistribution.forEach(row => {
      console.log(`   ${row.data_range.padEnd(10)} ${row.stock_count.toString().padStart(6)} 只  ${row.percentage.toString().padStart(5)}%`);
    });

    // 4. 分析有数据的股票详细信息
    console.log('\n4. 有日线数据股票分析:');

    // 获取有数据的股票
    const stocksWithData = await sequelize.query(`
      SELECT s.symbol, s.name, s.market, s.industry, COUNT(db.time) as bar_count,
             MIN(db.time) as first_date, MAX(db.time) as last_date
      FROM stocks s
      INNER JOIN daily_bars db ON s.id = db.stock_id
      GROUP BY s.id, s.symbol, s.name, s.market, s.industry
      HAVING COUNT(db.time) > 0
      ORDER BY bar_count DESC
    `, { type: sequelize.QueryTypes.SELECT });

    console.log(`   有日线数据的股票: ${stocksWithData.length} 只 (${((stocksWithData.length / totalStocks) * 100).toFixed(2)}%)`);

    if (stocksWithData.length > 0) {
      // 统计市场分布
      const marketDistribution = {};
      stocksWithData.forEach(stock => {
        marketDistribution[stock.market] = (marketDistribution[stock.market] || 0) + 1;
      });

      console.log('\n   市场分布:');
      Object.entries(marketDistribution).forEach(([market, count]) => {
        console.log(`     ${market}: ${count} 只 (${((count / stocksWithData.length) * 100).toFixed(2)}%)`);
      });

      // 显示数据最完整的股票
      console.log('\n   数据最完整的股票 (前10只):');
      console.log('   代码        名称             数据条数  最早日期    最晚日期');
      console.log('   ------------------------------------------------------------');
      stocksWithData.slice(0, 10).forEach(stock => {
        const firstDate = stock.first_date ? stock.first_date.split('T')[0] : 'N/A';
        const lastDate = stock.last_date ? stock.last_date.split('T')[0] : 'N/A';
        console.log(`   ${stock.symbol.padEnd(10)} ${(stock.name || '').padEnd(15)} ${stock.bar_count.toString().padStart(7)}   ${firstDate.padEnd(10)} ${lastDate}`);
      });

      // 计算数据时间跨度
      const totalBars = stocksWithData.reduce((sum, stock) => sum + parseInt(stock.bar_count), 0);
      const avgBarsPerStock = totalBars / stocksWithData.length;

      console.log(`\n   平均每只股票数据条数: ${avgBarsPerStock.toFixed(1)} 条`);
    }

    // 5. 分析完全无数据的股票
    console.log('\n5. 完全无日线数据股票分析:');

    const stocksWithoutData = await sequelize.query(`
      SELECT s.symbol, s.name, s.market, s.listingDate, s.isListed
      FROM stocks s
      LEFT JOIN daily_bars db ON s.id = db.stock_id
      WHERE db.time IS NULL
      LIMIT 10
    `, { type: sequelize.QueryTypes.SELECT });

    console.log(`   完全无日线数据的股票: ${stocksWithoutData.length} 只 (示例展示前10只)`);
    console.log('\n   示例股票:');
    console.log('   代码        名称             市场   上市日期     是否上市');
    console.log('   ---------------------------------------------------------');
    stocksWithoutData.forEach(stock => {
      const listingDate = stock.listingdate ? stock.listingdate.split('T')[0] : '未知';
      const isListed = stock.islisted ? '是' : '否';
      console.log(`   ${stock.symbol.padEnd(10)} ${(stock.name || '无名').padEnd(15)} ${(stock.market || '未知').padEnd(4)} ${listingDate.padEnd(10)} ${isListed}`);
    });

    // 6. 行业数据缺失分析
    console.log('\n6. 行业信息分析:');

    const industryStats = await Stock.findAll({
      attributes: ['industry', [sequelize.fn('COUNT', sequelize.col('id')), 'count']],
      group: ['industry'],
      order: [[sequelize.fn('COUNT', sequelize.col('id')), 'DESC']],
      limit: 10
    });

    console.log('   行业分布 (前10):');
    industryStats.forEach(stat => {
      const industry = stat.dataValues.industry || '未分类';
      const count = stat.dataValues.count;
      console.log(`     ${industry.padEnd(15)}: ${count} 只 (${((count / totalStocks) * 100).toFixed(2)}%)`);
    });

    // 7. 数据同步需求分析
    console.log('\n7. 数据同步需求分析:');

    // 计算需要同步的数据量（假设每个股票需要同步过去5年的数据）
    const tradingDaysPerYear = 242; // 近似交易日数
    const yearsOfData = 5;
    const expectedBarsPerStock = tradingDaysPerYear * yearsOfData; // 约1210条

    const missingBarsTotal = (totalStocks - stocksWithData.length) * expectedBarsPerStock;
    const existingBarsTotal = stocksWithData.reduce((sum, stock) => sum + parseInt(stock.bar_count), 0);

    console.log(`   理论总数据需求: ${totalStocks} 只 × ${expectedBarsPerStock} 条/只 = ${(totalStocks * expectedBarsPerStock).toLocaleString()} 条`);
    console.log(`   现有数据: ${existingBarsTotal.toLocaleString()} 条 (${((existingBarsTotal / (totalStocks * expectedBarsPerStock)) * 100).toFixed(2)}%)`);
    console.log(`   缺失数据: ${missingBarsTotal.toLocaleString()} 条 (${((missingBarsTotal / (totalStocks * expectedBarsPerStock)) * 100).toFixed(2)}%)`);

    // 估算同步时间（假设每个API调用获取1只股票1年数据，每次调用1秒）
    const estimatedCalls = Math.ceil((totalStocks - stocksWithData.length) * yearsOfData);
    const estimatedHours = estimatedCalls / 3600;

    console.log(`   预计API调用次数: ${estimatedCalls.toLocaleString()} 次`);
    console.log(`   预计同步时间: ${estimatedHours.toFixed(1)} 小时 (1秒/次)`);

    // 8. 建议
    console.log('\n8. 建议措施:');

    if (stocksWithData.length < totalStocks * 0.1) {
      console.log(`   ⚠️  严重: 只有 ${stocksWithData.length} 只股票 (${((stocksWithData.length / totalStocks) * 100).toFixed(2)}%) 有日线数据`);
      console.log(`   • 需要启动大规模数据同步任务`);
      console.log(`   • 建议分批同步，每次同步100-200只股票`);
      console.log(`   • 优先同步主板股票 (SH.6开头, SZ.0开头)`);
    }

    if (missingIndustry > totalStocks * 0.5) {
      console.log(`   • 需要补全行业信息 (${missingIndustry} 只股票缺少行业信息)`);
    }

    console.log(`   • 建议定期运行数据同步任务`);
    console.log(`   • 考虑实现增量同步，只同步缺失日期的数据`);

    // 9. 当前数据源情况
    console.log('\n9. 当前数据源状态:');
    console.log(`   • 数据库中已保存 ${totalStocks} 只股票基本信息`);
    console.log(`   • ${stocksWithData.length} 只股票有日线数据`);
    console.log(`   • ${stocksWithoutData.length} 只股票完全无日线数据`);
    console.log(`   • 数据覆盖率为 ${((stocksWithData.length / totalStocks) * 100).toFixed(2)}%`);

  } catch (error) {
    console.error('分析错误:', error);
  } finally {
    await sequelize.close();
  }
}

analyzeDataCoverage();