const { sequelize } = require('../dist/config/database');

async function dataCompletenessStats() {
  try {
    await sequelize.authenticate();
    console.log('数据库连接成功\n');

    // 计算日期范围
    const today = new Date('2026-04-06');
    const fiveYearsAgo = new Date('2021-04-06');
    const tenYearsAgo = new Date('2016-04-06');

    console.log(`统计时间: ${today.toLocaleDateString()}`);
    console.log(`过去5年: ${fiveYearsAgo.toLocaleDateString()} 至 ${today.toLocaleDateString()}`);
    console.log(`过去10年: ${tenYearsAgo.toLocaleDateString()} 至 ${today.toLocaleDateString()}\n`);

    // 1. 获取所有股票总数
    const totalQuery = 'SELECT COUNT(*) as total FROM stocks';
    const totalResult = await sequelize.query(totalQuery, { type: sequelize.QueryTypes.SELECT });
    const totalStocks = parseInt(totalResult[0].total);

    // 2. 获取有数据的股票
    const withDataQuery = `
      SELECT DISTINCT s.id, s.symbol, s.name, s."listingDate"
      FROM stocks s
      INNER JOIN daily_bars db ON s.id = db.stock_id
      ORDER BY s.symbol
    `;
    const stocksWithData = await sequelize.query(withDataQuery, { type: sequelize.QueryTypes.SELECT });

    console.log(`总股票数: ${totalStocks}`);
    console.log(`有日线数据的股票: ${stocksWithData.length} (${(stocksWithData.length/totalStocks*100).toFixed(2)}%)\n`);

    // 3. 分析数据完整性
    let fiveYearComplete = 0;
    let tenYearComplete = 0;
    let fiveYearPartial = 0;
    let tenYearPartial = 0;
    let insufficientData = 0;

    const results = [];

    console.log('正在分析数据完整性...');

    for (let i = 0; i < stocksWithData.length; i++) {
      const stock = stocksWithData[i];

      // 查询该股票的所有交易日
      const dateQuery = `
        SELECT DISTINCT DATE(time) as trading_date
        FROM daily_bars
        WHERE stock_id = :stockId
        ORDER BY trading_date
      `;
      const dates = await sequelize.query(dateQuery, {
        replacements: { stockId: stock.id },
        type: sequelize.QueryTypes.SELECT
      });

      const tradingDates = dates.map(d => new Date(d.trading_date));

      if (tradingDates.length === 0) {
        insufficientData++;
        continue;
      }

      // 计算最早和最晚交易日
      const earliestDate = new Date(Math.min(...tradingDates.map(d => d.getTime())));
      const latestDate = new Date(Math.max(...tradingDates.map(d => d.getTime())));

      // 统计过去5年和10年的交易日数量
      const fiveYearDates = tradingDates.filter(d => d >= fiveYearsAgo && d <= today);
      const tenYearDates = tradingDates.filter(d => d >= tenYearsAgo && d <= today);

      // 估算理论交易日数量（每年约250个交易日）
      const fiveYearExpected = 5 * 250; // 约1250个交易日
      const tenYearExpected = 10 * 250; // 约2500个交易日

      // 判断完整性（阈值设为90%）
      const fiveYearRatio = fiveYearDates.length / fiveYearExpected;
      const tenYearRatio = tenYearDates.length / tenYearExpected;

      const isFiveYearComplete = fiveYearRatio >= 0.9;
      const isTenYearComplete = tenYearRatio >= 0.9;

      results.push({
        symbol: stock.symbol,
        name: stock.name,
        listingDate: stock.listingDate,
        totalDays: tradingDates.length,
        earliestDate: earliestDate.toISOString().split('T')[0],
        latestDate: latestDate.toISOString().split('T')[0],
        fiveYearDays: fiveYearDates.length,
        fiveYearRatio: fiveYearRatio,
        tenYearDays: tenYearDates.length,
        tenYearRatio: tenYearRatio,
        isFiveYearComplete,
        isTenYearComplete
      });

      if (isFiveYearComplete) fiveYearComplete++;
      if (isTenYearComplete) tenYearComplete++;

      if (fiveYearDates.length > 0 && !isFiveYearComplete) fiveYearPartial++;
      if (tenYearDates.length > 0 && !isTenYearComplete) tenYearPartial++;

      // 显示进度
      if ((i + 1) % 100 === 0 || i === stocksWithData.length - 1) {
        console.log(`  已分析 ${i + 1}/${stocksWithData.length} 只股票`);
      }
    }

    console.log('\n=== 数据完整性统计结果 ===\n');

    // 按数据完整性分类
    console.log('数据完整性分类:');
    console.log(`  过去5年完整数据 (≥90%): ${fiveYearComplete} 只 (${(fiveYearComplete/stocksWithData.length*100).toFixed(2)}%)`);
    console.log(`  过去5年部分数据 (<90%): ${fiveYearPartial} 只 (${(fiveYearPartial/stocksWithData.length*100).toFixed(2)}%)`);
    console.log(`  过去10年完整数据 (≥90%): ${tenYearComplete} 只 (${(tenYearComplete/stocksWithData.length*100).toFixed(2)}%)`);
    console.log(`  过去10年部分数据 (<90%): ${tenYearPartial} 只 (${(tenYearPartial/stocksWithData.length*100).toFixed(2)}%)`);
    console.log(`  数据不足: ${insufficientData} 只\n`);

    // 整体占比（基于总股票数）
    console.log('基于总股票数的占比:');
    console.log(`  过去5年完整数据: ${fiveYearComplete}/${totalStocks} (${(fiveYearComplete/totalStocks*100).toFixed(2)}%)`);
    console.log(`  过去10年完整数据: ${tenYearComplete}/${totalStocks} (${(tenYearComplete/totalStocks*100).toFixed(2)}%)\n`);

    // 显示示例
    console.log('过去5年完整数据示例 (前10只):');
    results.filter(r => r.isFiveYearComplete)
      .slice(0, 10)
      .forEach((stock, i) => {
        console.log(`  ${i+1}. ${stock.symbol} - ${stock.name}: ${stock.fiveYearDays} 个交易日 (${(stock.fiveYearRatio*100).toFixed(1)}%)`);
      });

    console.log('\n过去10年完整数据示例 (前10只):');
    results.filter(r => r.isTenYearComplete)
      .slice(0, 10)
      .forEach((stock, i) => {
        console.log(`  ${i+1}. ${stock.symbol} - ${stock.name}: ${stock.tenYearDays} 个交易日 (${(stock.tenYearRatio*100).toFixed(1)}%)`);
      });

    // 按市场统计
    console.log('\n=== 按市场统计 ===');

    const marketStats = {};
    results.forEach(stock => {
      // 确定市场
      let market = '其他';
      if (stock.symbol.startsWith('sh.')) market = '上海';
      else if (stock.symbol.startsWith('sz.')) market = '深圳';
      else if (stock.symbol.startsWith('bj.')) market = '北京';

      if (!marketStats[market]) {
        marketStats[market] = {
          total: 0,
          fiveYearComplete: 0,
          tenYearComplete: 0
        };
      }

      marketStats[market].total++;
      if (stock.isFiveYearComplete) marketStats[market].fiveYearComplete++;
      if (stock.isTenYearComplete) marketStats[market].tenYearComplete++;
    });

    Object.entries(marketStats).forEach(([market, stats]) => {
      const fiveYearPct = stats.total > 0 ? (stats.fiveYearComplete / stats.total * 100).toFixed(2) : '0.00';
      const tenYearPct = stats.total > 0 ? (stats.tenYearComplete / stats.total * 100).toFixed(2) : '0.00';
      console.log(`\n${market}:`);
      console.log(`  总股票数: ${stats.total}`);
      console.log(`  过去5年完整数据: ${stats.fiveYearComplete} (${fiveYearPct}%)`);
      console.log(`  过去10年完整数据: ${stats.tenYearComplete} (${tenYearPct}%)`);
    });

    // 数据质量总结
    console.log('\n=== 数据质量总结 ===');
    console.log('1. 整体数据覆盖率:');
    console.log(`   - 有数据股票占比: ${(stocksWithData.length/totalStocks*100).toFixed(2)}%`);
    console.log(`   - 过去5年完整数据占比: ${(fiveYearComplete/totalStocks*100).toFixed(2)}%`);
    console.log(`   - 过去10年完整数据占比: ${(tenYearComplete/totalStocks*100).toFixed(2)}%`);

    console.log('\n2. 回测适用性评估:');
    if (fiveYearComplete >= 1000) {
      console.log(`   ✅ 过去5年数据完整性良好 (${fiveYearComplete}只股票)，适合短期策略回测`);
    } else if (fiveYearComplete >= 500) {
      console.log(`   ⚠️  过去5年数据基本可用 (${fiveYearComplete}只股票)，可进行大部分策略回测`);
    } else {
      console.log(`   ❌ 过去5年数据不足 (仅${fiveYearComplete}只股票)，需补充数据`);
    }

    if (tenYearComplete >= 500) {
      console.log(`   ✅ 过去10年数据完整性良好 (${tenYearComplete}只股票)，适合中长期策略回测`);
    } else if (tenYearComplete >= 200) {
      console.log(`   ⚠️  过去10年数据基本可用 (${tenYearComplete}只股票)，可进行部分中长期策略回测`);
    } else {
      console.log(`   ❌ 过去10年数据不足 (仅${tenYearComplete}只股票)，需补充数据`);
    }

  } catch (error) {
    console.error('统计失败:', error);
    console.error('错误详情:', error.message);
  } finally {
    await sequelize.close();
  }
}

dataCompletenessStats();