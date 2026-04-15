// 初始化数据库连接
import './src/config/database';

import { PortfolioReturnSimulator } from './src/portfolio/PortfolioReturnSimulator';
import { logger } from './src/utils/logger';

async function testPortfolioSimulator() {
  try {
    console.log('Testing Portfolio Return Simulator...');

    // 创建模拟器实例
    const simulator = new PortfolioReturnSimulator();

    // 测试配置
    const config = {
      symbols: ['sh.600000', 'sh.600036'], // 浦发银行、招商银行
      buyDate: new Date('2024-01-01'),
      days: 30, // 持有30天
      initialCapital: 100000,
      allocationStrategy: 'equal' as const,
      includeDividends: false,
      reinvest: false,
    };

    console.log('Running portfolio simulation with config:', {
      symbols: config.symbols,
      buyDate: config.buyDate.toISOString().split('T')[0],
      days: config.days,
      initialCapital: config.initialCapital,
    });

    // 运行模拟
    const result = await simulator.simulate(config);

    console.log('\n=== 模拟结果摘要 ===');
    console.log(`初始资金: ${result.summary.initialCapital.toFixed(2)}`);
    console.log(`最终资金: ${result.summary.finalCapital.toFixed(2)}`);
    console.log(`总收益率: ${result.summary.totalReturn.toFixed(2)}%`);
    console.log(`年化收益率: ${result.summary.annualizedReturn.toFixed(2)}%`);
    console.log(`持有天数: ${result.summary.totalDays}`);
    console.log(`开始日期: ${result.summary.startDate.toISOString().split('T')[0]}`);
    console.log(`结束日期: ${result.summary.endDate.toISOString().split('T')[0]}`);

    console.log('\n=== 性能指标 ===');
    console.log(`夏普比率: ${result.performanceMetrics.sharpeRatio.toFixed(2)}`);
    console.log(`最大回撤: ${result.performanceMetrics.maxDrawdown.toFixed(2)}%`);
    console.log(`波动率: ${result.performanceMetrics.volatility.toFixed(2)}%`);
    console.log(`盈利天数: ${result.performanceMetrics.winDays}`);
    console.log(`亏损天数: ${result.performanceMetrics.lossDays}`);
    console.log(`平均日收益率: ${result.performanceMetrics.avgDailyReturn.toFixed(2)}%`);
    console.log(`最佳交易日: ${result.performanceMetrics.bestDay.date.toISOString().split('T')[0]}, 收益率: ${result.performanceMetrics.bestDay.return.toFixed(2)}%`);
    console.log(`最差交易日: ${result.performanceMetrics.worstDay.date.toISOString().split('T')[0]}, 收益率: ${result.performanceMetrics.worstDay.return.toFixed(2)}%`);

    console.log('\n=== 各股票收益 ===');
    result.stockReturns.forEach((stock, index) => {
      console.log(`\n股票 ${index + 1}: ${stock.symbol} (${stock.name})`);
      console.log(`  买入价格: ${stock.buyPrice.toFixed(2)}`);
      console.log(`  分配金额: ${stock.allocationAmount.toFixed(2)}`);
      console.log(`  买入股数: ${stock.shares}`);

      if (stock.dailyReturns.length > 0) {
        const lastReturn = stock.dailyReturns[stock.dailyReturns.length - 1];
        console.log(`  最终价格: ${lastReturn.price.toFixed(2)}`);
        console.log(`  最终市值: ${lastReturn.value.toFixed(2)}`);
        console.log(`  总收益率: ${(lastReturn.cumulativeReturn * 100).toFixed(2)}%`);
      }
    });

    console.log('\n=== 前5日收益走势 ===');
    result.dailyReturns.slice(0, 5).forEach((day, index) => {
      console.log(`第${index + 1}天 ${day.date.toISOString().split('T')[0]}: 总市值=${day.totalValue.toFixed(2)}, 日收益率=${(day.dailyReturn * 100).toFixed(2)}%, 累计收益率=${(day.cumulativeReturn * 100).toFixed(2)}%`);
    });

    if (result.dailyReturns.length > 5) {
      const lastDay = result.dailyReturns[result.dailyReturns.length - 1];
      console.log(`... 省略中间 ${result.dailyReturns.length - 10} 天 ...`);
      console.log(`最后一天 ${lastDay.date.toISOString().split('T')[0]}: 总市值=${lastDay.totalValue.toFixed(2)}, 日收益率=${(lastDay.dailyReturn * 100).toFixed(2)}%, 累计收益率=${(lastDay.cumulativeReturn * 100).toFixed(2)}%`);
    }

    console.log('\n测试完成！');
    return result;
  } catch (error) {
    console.error('测试失败:', error);
    throw error;
  }
}

// 运行测试
testPortfolioSimulator()
  .then(() => {
    console.log('Portfolio simulator test completed successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Portfolio simulator test failed:', error);
    process.exit(1);
  });