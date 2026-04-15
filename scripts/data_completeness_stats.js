#!/usr/bin/env node
/**
 * 数据完整性统计脚本
 * 统计从2020年到最新交易日的数据完整性
 */

async function calculateDataCompleteness(startDate, endDate) {
  try {
    const { sequelize } = require('../backend/dist/config/database');
    const { Stock, DailyBar } = require('../backend/dist/models');
    const { Op } = require('../backend/node_modules/sequelize');

    await sequelize.authenticate();
    console.log('数据库连接成功');

    // 使用传入的时间范围

    console.log(`\n=== 数据完整性统计 (${startDate} 到 ${endDate}) ===`);

    // 获取所有股票
    const allStocks = await Stock.findAll({
      attributes: ['id', 'symbol', 'name', 'market', 'isListed', 'listingDate'],
      where: { isListed: true },
      order: [['market', 'ASC'], ['symbol', 'ASC']]
    });

    console.log(`总上市股票数: ${allStocks.length}`);

    // 计算期望的交易天数（估算）
    // 从2020-01-01到2026-04-10大约有6年零3.5个月
    // 每年约250个交易日，总共约 6.3 * 250 = 1575 个交易日
    const expectedTradingDays = 1575;
    console.log(`期望交易天数（估算）: ${expectedTradingDays} 天`);

    // 统计阶梯
    const completenessLevels = [
      { min: 0.9, max: 1.0, label: '90%-100%', count: 0 },
      { min: 0.7, max: 0.9, label: '70%-89%', count: 0 },
      { min: 0.5, max: 0.7, label: '50%-69%', count: 0 },
      { min: 0.3, max: 0.5, label: '30%-49%', count: 0 },
      { min: 0.1, max: 0.3, label: '10%-29%', count: 0 },
      { min: 0.0, max: 0.1, label: '0%-9%', count: 0 }
    ];

    // 按市场统计
    const marketStats = {
      SH: { total: 0, completeCount: 0 },
      SZ: { total: 0, completeCount: 0 },
      BJ: { total: 0, completeCount: 0 },
      UNKNOWN: { total: 0, completeCount: 0 }
    };

    // 详细的股票统计
    const stockStats = [];
    let processed = 0;
    const batchSize = 100;

    for (let i = 0; i < allStocks.length; i += batchSize) {
      const batch = allStocks.slice(i, i + batchSize);

      for (const stock of batch) {
        try {
          // 获取该股票的日线数据数量
          const barCount = await DailyBar.count({
            where: {
              stockId: stock.id,
              time: {
                [Op.between]: [new Date(startDate), new Date(endDate)]
              }
            }
          });

          // 计算完整性比例
          const completeness = barCount / expectedTradingDays;

          // 判断完整性等级
          let completenessLabel = '';
          for (const level of completenessLevels) {
            if (completeness >= level.min && completeness < level.max) {
              level.count++;
              completenessLabel = level.label;
              break;
            }
          }

          // 更新市场统计
          const market = stock.market || 'UNKNOWN';
          if (!marketStats[market]) {
            marketStats[market] = { total: 0, completeCount: 0 };
          }
          marketStats[market].total++;
          if (completeness >= 0.9) {
            marketStats[market].completeCount++;
          }

          stockStats.push({
            symbol: stock.symbol,
            name: stock.name,
            market: stock.market,
            barCount,
            completeness: Math.min(1.0, completeness), // 限制最大为1.0
            completenessLabel,
            listingDate: stock.listingDate
          });

          processed++;
          if (processed % 500 === 0) {
            console.log(`已处理 ${processed}/${allStocks.length} 只股票`);
          }
        } catch (error) {
          console.error(`处理股票 ${stock.symbol} 失败: ${error.message}`);
        }
      }
    }

    console.log(`\n已完成 ${processed} 只股票的统计`);

    // 1. 总体统计
    console.log('\n=== 总体统计 ===');
    console.log(`总股票数: ${allStocks.length}`);
    console.log(`已处理股票数: ${processed}`);

    const stocksWithData = stockStats.filter(s => s.barCount > 0).length;
    console.log(`有日线数据的股票数: ${stocksWithData}`);
    console.log(`无日线数据的股票数: ${processed - stocksWithData}`);

    // 2. 完整性阶梯统计
    console.log('\n=== 数据完整性阶梯统计 ===');
    completenessLevels.forEach(level => {
      const percentage = (level.count / processed * 100).toFixed(1);
      console.log(`${level.label}: ${level.count} 只 (${percentage}%)`);
    });

    // 3. 按市场统计
    console.log('\n=== 按市场统计 ===');
    for (const [market, stats] of Object.entries(marketStats)) {
      if (stats.total > 0) {
        const completeRate = (stats.completeCount / stats.total * 100).toFixed(1);
        console.log(`${market}: ${stats.total} 只，完整率≥90%: ${stats.completeCount} 只 (${completeRate}%)`);
      }
    }

    // 4. 完整性最高的股票（前10）
    const mostCompleteStocks = [...stockStats]
      .sort((a, b) => b.completeness - a.completeness)
      .slice(0, 10);

    console.log('\n=== 数据最完整的股票（前10） ===');
    mostCompleteStocks.forEach((stock, index) => {
      const completenessPercent = (stock.completeness * 100).toFixed(1);
      console.log(`${index + 1}. ${stock.symbol} (${stock.name}): ${stock.barCount} 条数据，完整性: ${completenessPercent}%`);
    });

    // 5. 完整性最低的股票（前10）
    const leastCompleteStocks = [...stockStats]
      .filter(s => s.barCount > 0) // 排除完全没有数据的
      .sort((a, b) => a.completeness - b.completeness)
      .slice(0, 10);

    console.log('\n=== 数据最不完整的股票（有数据的前10） ===');
    leastCompleteStocks.forEach((stock, index) => {
      const completenessPercent = (stock.completeness * 100).toFixed(1);
      console.log(`${index + 1}. ${stock.symbol} (${stock.name}): ${stock.barCount} 条数据，完整性: ${completenessPercent}%`);
    });

    // 6. 完全没有数据的股票（前10）
    const noDataStocks = stockStats
      .filter(s => s.barCount === 0)
      .slice(0, 10);

    if (noDataStocks.length > 0) {
      console.log(`\n=== 完全没有数据的股票（前10，共${stockStats.filter(s => s.barCount === 0).length}只） ===`);
      noDataStocks.forEach((stock, index) => {
        console.log(`${index + 1}. ${stock.symbol} (${stock.name})`);
      });
    }

    // 7. 汇总指标
    console.log('\n=== 汇总指标 ===');

    const avgCompleteness = stockStats.reduce((sum, s) => sum + s.completeness, 0) / processed;
    console.log(`平均完整性: ${(avgCompleteness * 100).toFixed(2)}%`);

    const medianCompleteness = stockStats
      .map(s => s.completeness)
      .sort((a, b) => a - b)[Math.floor(processed / 2)];
    console.log(`中位数完整性: ${(medianCompleteness * 100).toFixed(2)}%`);

    const highQualityStocks = stockStats.filter(s => s.completeness >= 0.9).length;
    console.log(`高质量股票（完整性≥90%）: ${highQualityStocks} 只 (${(highQualityStocks / processed * 100).toFixed(1)}%)`);

    const lowQualityStocks = stockStats.filter(s => s.completeness < 0.3).length;
    console.log(`低质量股票（完整性<30%）: ${lowQualityStocks} 只 (${(lowQualityStocks / processed * 100).toFixed(1)}%)`);

    // 8. 生成建议
    console.log('\n=== 数据质量建议 ===');
    if (avgCompleteness < 0.5) {
      console.log('⚠️  警告：平均数据完整性低于50%，建议执行全量数据更新');
    } else if (avgCompleteness < 0.8) {
      console.log('ℹ️  提示：数据完整性一般，建议检查缺失数据的股票');
    } else {
      console.log('✅ 良好：数据完整性较高');
    }

    if (noDataStocks.length > 100) {
      console.log(`⚠️  警告：有 ${stockStats.filter(s => s.barCount === 0).length} 只股票完全没有数据，建议优先处理`);
    }

    // 9. 保存统计结果到文件（可选）
    const fs = require('fs');
    const result = {
      timestamp: new Date().toISOString(),
      dateRange: { startDate, endDate },
      expectedTradingDays,
      stats: {
        totalStocks: allStocks.length,
        processedStocks: processed,
        stocksWithData: stocksWithData,
        stocksWithoutData: processed - stocksWithData,
        completenessLevels: completenessLevels.map(level => ({
          label: level.label,
          count: level.count,
          percentage: (level.count / processed * 100).toFixed(1)
        })),
        marketStats,
        avgCompleteness,
        medianCompleteness,
        highQualityStocks,
        lowQualityStocks
      }
    };

    fs.writeFileSync(
      'data_completeness_report.json',
      JSON.stringify(result, null, 2)
    );
    console.log('\n详细统计报告已保存到: data_completeness_report.json');

  } catch (error) {
    console.error(`统计失败: ${error.message}`);
    console.error(`堆栈: ${error.stack}`);
    process.exit(1);
  }
}

// 命令行参数处理
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`
数据完整性统计工具

用法:
  node scripts/data_completeness_stats.js [选项]

选项:
  --start-date  开始日期 (默认: 2020-01-01)
  --end-date    结束日期 (默认: 2026-04-10)
  --help, -h    显示帮助信息

示例:
  node scripts/data_completeness_stats.js
  node scripts/data_completeness_stats.js --start-date 2021-01-01 --end-date 2026-04-10
  `);
  process.exit(0);
}

// 解析命令行参数
let startDate = '2020-01-01';
let endDate = '2026-04-10';

for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--start-date' && process.argv[i + 1]) {
    startDate = process.argv[i + 1];
  } else if (process.argv[i] === '--end-date' && process.argv[i + 1]) {
    endDate = process.argv[i + 1];
  }
}

calculateDataCompleteness(startDate, endDate).catch(error => {
  console.error('脚本执行失败:', error);
  process.exit(1);
});