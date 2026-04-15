const { sequelize } = require('../dist/config/database');

async function markIncompleteStocks() {
  try {
    await sequelize.authenticate();
    console.log('数据库连接成功\n');

    // 计算日期范围
    const today = new Date('2026-04-06');
    const fiveYearsAgo = new Date('2021-04-06');
    const tenYearsAgo = new Date('2016-04-06');

    console.log(`统计时间: ${today.toLocaleDateString()}`);
    console.log(`过去5年: ${fiveYearsAgo.toLocaleDateString()} 至 ${today.toLocaleDateString()}`);
    console.log(`理论交易日数: 约1250天 (每年250个交易日)`);
    console.log(`完整阈值: ≥1125天 (90%)\n`);

    // 获取所有有数据的股票
    const stocksQuery = `
      SELECT s.id, s.symbol, s.name
      FROM stocks s
      INNER JOIN daily_bars db ON s.id = db.stock_id
      GROUP BY s.id, s.symbol, s.name
      ORDER BY s.symbol
    `;
    const stocks = await sequelize.query(stocksQuery, { type: sequelize.QueryTypes.SELECT });

    console.log(`有数据的股票总数: ${stocks.length}`);

    // 重置所有股票的dataStatus为null（先清除之前的标记）
    console.log('重置所有股票的dataStatus...');
    const resetQuery = `UPDATE stocks SET "dataStatus" = NULL`;
    await sequelize.query(resetQuery, { type: sequelize.QueryTypes.UPDATE });

    let completeCount = 0;
    let incompleteCount = 0;
    let processed = 0;

    // 分析每只股票的数据完整性
    console.log('\n正在分析数据完整性...');
    for (const stock of stocks) {
      // 查询该股票过去5年的交易日数
      const dateQuery = `
        SELECT COUNT(DISTINCT DATE(time)) as trading_days
        FROM daily_bars
        WHERE stock_id = :stockId
          AND time >= :startDate
          AND time <= :endDate
      `;
      const result = await sequelize.query(dateQuery, {
        replacements: {
          stockId: stock.id,
          startDate: fiveYearsAgo,
          endDate: today
        },
        type: sequelize.QueryTypes.SELECT
      });

      const tradingDays = parseInt(result[0].trading_days);
      const expectedDays = 1250; // 理论值
      const completenessRatio = tradingDays / expectedDays;
      const isComplete = completenessRatio >= 0.9;

      // 更新dataStatus
      const status = isComplete ? 'complete' : 'incomplete';
      const updateQuery = `
        UPDATE stocks
        SET "dataStatus" = :status
        WHERE id = :stockId
      `;
      await sequelize.query(updateQuery, {
        replacements: { status, stockId: stock.id },
        type: sequelize.QueryTypes.UPDATE
      });

      if (isComplete) {
        completeCount++;
      } else {
        incompleteCount++;
      }

      processed++;

      // 显示进度
      if (processed % 500 === 0 || processed === stocks.length) {
        console.log(`  已分析 ${processed}/${stocks.length} 只股票`);
      }
    }

    // 统计结果
    console.log('\n=== 数据完整性标记结果 ===');
    console.log(`完整数据 (≥90%): ${completeCount} 只 (${(completeCount/stocks.length*100).toFixed(2)}%)`);
    console.log(`不完整数据 (<90%): ${incompleteCount} 只 (${(incompleteCount/stocks.length*100).toFixed(2)}%)`);

    // 显示示例
    console.log('\n不完整股票示例 (前10只):');
    const incompleteSampleQuery = `
      SELECT symbol, name, "dataStatus"
      FROM stocks
      WHERE "dataStatus" = 'incomplete'
      ORDER BY symbol
      LIMIT 10
    `;
    const incompleteSamples = await sequelize.query(incompleteSampleQuery, { type: sequelize.QueryTypes.SELECT });

    incompleteSamples.forEach((stock, i) => {
      console.log(`  ${i+1}. ${stock.symbol} - ${stock.name}`);
    });

    // 按市场统计
    console.log('\n=== 按市场统计 ===');
    const marketStatsQuery = `
      SELECT
        CASE
          WHEN symbol LIKE 'sh.%' THEN '上海'
          WHEN symbol LIKE 'sz.%' THEN '深圳'
          WHEN symbol LIKE 'bj.%' THEN '北京'
          ELSE '其他'
        END as market,
        "dataStatus",
        COUNT(*) as count
      FROM stocks
      GROUP BY market, "dataStatus"
      ORDER BY market, "dataStatus"
    `;
    const marketStats = await sequelize.query(marketStatsQuery, { type: sequelize.QueryTypes.SELECT });

    const markets = {};
    marketStats.forEach(stat => {
      if (!markets[stat.market]) {
        markets[stat.market] = { complete: 0, incomplete: 0, total: 0 };
      }
      if (stat.dataStatus === 'complete') {
        markets[stat.market].complete = parseInt(stat.count);
      } else if (stat.dataStatus === 'incomplete') {
        markets[stat.market].incomplete = parseInt(stat.count);
      }
      markets[stat.market].total = markets[stat.market].complete + markets[stat.market].incomplete;
    });

    Object.entries(markets).forEach(([market, stats]) => {
      const completePct = stats.total > 0 ? (stats.complete / stats.total * 100).toFixed(2) : '0.00';
      const incompletePct = stats.total > 0 ? (stats.incomplete / stats.total * 100).toFixed(2) : '0.00';
      console.log(`\n${market}:`);
      console.log(`  总股票数: ${stats.total}`);
      console.log(`  完整数据: ${stats.complete} (${completePct}%)`);
      console.log(`  不完整数据: ${stats.incomplete} (${incompletePct}%)`);
    });

    // 数据质量总结
    console.log('\n=== 数据质量总结 ===');
    console.log(`1. 整体数据完整性:`);
    console.log(`   - 完整数据: ${completeCount} 只 (${(completeCount/stocks.length*100).toFixed(2)}%)`);
    console.log(`   - 不完整数据: ${incompleteCount} 只 (${(incompleteCount/stocks.length*100).toFixed(2)}%)`);

    console.log(`\n2. 回测适用性:`);
    if (completeCount >= 1000) {
      console.log(`   ✅ 有足够股票 (${completeCount}只) 进行可靠的策略回测`);
    } else if (completeCount >= 500) {
      console.log(`   ⚠️  有基本可用的股票 (${completeCount}只) 进行回测`);
    } else {
      console.log(`   ❌ 完整数据股票不足 (仅${completeCount}只)，需补充数据`);
    }

  } catch (error) {
    console.error('标记失败:', error);
    console.error('错误详情:', error.message);
  } finally {
    await sequelize.close();
  }
}

markIncompleteStocks();