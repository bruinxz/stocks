import { DataService } from '../data/services/DataService';
import { Stock } from '../models/Stock';
import { DailyBar } from '../models/DailyBar';
import { logger } from '../utils/logger';

export interface PortfolioSimulationConfig {
  symbols: string[];
  buyDate: Date;
  days: number; // 持有天数
  initialCapital: number;
  allocationStrategy: 'equal' | 'weighted'; // 资金分配策略
  includeDividends?: boolean; // 是否包含分红（暂不支持）
  reinvest?: boolean; // 是否再投资（暂不支持）
}

export interface StockReturnData {
  symbol: string;
  name: string;
  buyPrice: number; // 买入价格（买入日收盘价）
  allocationAmount: number; // 分配的金额
  shares: number; // 买入股数
  dailyReturns: Array<{
    date: Date;
    price: number;
    value: number; // 当日市值
    dailyReturn: number; // 当日收益率
    cumulativeReturn: number; // 累计收益率
  }>;
}

export interface PortfolioSimulationResult {
  summary: {
    initialCapital: number;
    finalCapital: number;
    totalReturn: number;
    annualizedReturn: number;
    totalDays: number;
    startDate: Date;
    endDate: Date;
  };
  dailyReturns: Array<{
    date: Date;
    totalValue: number;
    dailyReturn: number; // 组合当日收益率
    cumulativeReturn: number; // 组合累计收益率
  }>;
  stockReturns: StockReturnData[];
  performanceMetrics: {
    sharpeRatio: number;
    maxDrawdown: number;
    volatility: number;
    winDays: number;
    lossDays: number;
    avgDailyReturn: number;
    bestDay: { date: Date; return: number };
    worstDay: { date: Date; return: number };
  };
}

/**
 * 投资组合收益模拟器
 * 用于计算买入持有策略的收益走势
 */
export class PortfolioReturnSimulator {
  private dataService: DataService;

  constructor() {
    this.dataService = new DataService();
  }

  /**
   * 运行投资组合收益模拟
   */
  async simulate(config: PortfolioSimulationConfig): Promise<PortfolioSimulationResult> {
    try {
      logger.info('Starting portfolio return simulation', {
        symbols: config.symbols,
        buyDate: config.buyDate,
        days: config.days,
        initialCapital: config.initialCapital,
      });

      // 计算结束日期
      const endDate = this.calculateEndDate(config.buyDate, config.days);

      // 验证股票存在并获取基本信息
      const stockInfos = await this.validateAndGetStockInfo(config.symbols);

      // 获取每只股票的日线数据
      const stockData = await this.fetchStockData(config.symbols, config.buyDate, endDate);

      // 计算买入价格和分配金额
      const allocation = this.calculateAllocation(config, stockData);

      // 计算每日收益
      const stockReturns = this.calculateStockReturns(allocation, stockData);

      // 计算组合每日收益
      const portfolioReturns = this.calculatePortfolioReturns(stockReturns);

      // 计算性能指标
      const performanceMetrics = this.calculatePerformanceMetrics(portfolioReturns);

      // 生成摘要
      const summary = this.generateSummary(config, portfolioReturns);

      logger.info('Portfolio simulation completed successfully', {
        totalDays: portfolioReturns.length,
        finalCapital: summary.finalCapital,
        totalReturn: summary.totalReturn,
      });

      return {
        summary,
        dailyReturns: portfolioReturns,
        stockReturns,
        performanceMetrics,
      };
    } catch (error) {
      logger.error('Portfolio simulation failed:', error);
      throw error;
    }
  }

  /**
   * 计算结束日期
   */
  private calculateEndDate(buyDate: Date, days: number): Date {
    const endDate = new Date(buyDate);
    endDate.setDate(endDate.getDate() + days);
    return endDate;
  }

  /**
   * 验证股票存在并获取基本信息
   */
  private async validateAndGetStockInfo(symbols: string[]): Promise<Map<string, Stock>> {
    const stockInfos = new Map<string, Stock>();

    for (const symbol of symbols) {
      const stock = await Stock.findOne({ where: { symbol } });
      if (!stock) {
        throw new Error(`股票 ${symbol} 不存在`);
      }
      stockInfos.set(symbol, stock);
    }

    return stockInfos;
  }

  /**
   * 获取股票日线数据
   */
  private async fetchStockData(
    symbols: string[],
    startDate: Date,
    endDate: Date
  ): Promise<Map<string, DailyBar[]>> {
    const stockData = new Map<string, DailyBar[]>();

    for (const symbol of symbols) {
      const bars = await this.dataService.getDailyBars(symbol, startDate, endDate);
      if (bars.length === 0) {
        logger.warn(`股票 ${symbol} 在指定日期范围内没有数据`);
      }
      stockData.set(symbol, bars);
    }

    return stockData;
  }

  /**
   * 计算资金分配
   */
  private calculateAllocation(
    config: PortfolioSimulationConfig,
    stockData: Map<string, DailyBar[]>
  ): Map<string, { allocationAmount: number; buyPrice: number; shares: number }> {
    const allocation = new Map();

    if (config.allocationStrategy === 'equal') {
      // 等权重分配
      const perStockAmount = config.initialCapital / config.symbols.length;

      for (const symbol of config.symbols) {
        const bars = stockData.get(symbol);
        if (!bars || bars.length === 0) {
          throw new Error(`股票 ${symbol} 没有买入日数据`);
        }

        // 买入日收盘价作为买入价格（转换为数字）
        const buyPrice = parseFloat(String(bars[0].close));
        if (isNaN(buyPrice) || buyPrice <= 0) {
          throw new Error(`股票 ${symbol} 买入价格无效: ${bars[0].close}`);
        }

        // 计算可买入股数（取整）
        const shares = Math.floor(perStockAmount / buyPrice);
        const actualAmount = shares * buyPrice;

        allocation.set(symbol, {
          allocationAmount: actualAmount,
          buyPrice,
          shares,
        });

        logger.info(
          `股票 ${symbol} 分配: 金额=${actualAmount.toFixed(
            2
          )}, 股数=${shares}, 买入价=${buyPrice.toFixed(2)}`
        );
      }
    } else {
      // 加权分配（这里简化为等权重，可扩展）
      // TODO: 实现加权分配逻辑
      throw new Error('加权分配策略暂未实现');
    }

    return allocation;
  }

  /**
   * 计算单只股票收益
   */
  private calculateStockReturns(
    allocation: Map<string, { allocationAmount: number; buyPrice: number; shares: number }>,
    stockData: Map<string, DailyBar[]>
  ): StockReturnData[] {
    const stockReturns: StockReturnData[] = [];

    for (const [symbol, allocInfo] of allocation.entries()) {
      const bars = stockData.get(symbol);
      if (!bars || bars.length === 0) {
        continue;
      }

      // 按日期排序
      bars.sort((a, b) => a.time.getTime() - b.time.getTime());

      const dailyReturns = bars.map((bar, index) => {
        const price = parseFloat(String(bar.close));
        const prevPrice = index === 0 ? price : parseFloat(String(bars[index - 1].close));
        const value = allocInfo.shares * price;
        const dailyReturn = index === 0 ? 0 : price / prevPrice - 1;
        const cumulativeReturn = price / allocInfo.buyPrice - 1;

        return {
          date: bar.time,
          price,
          value,
          dailyReturn,
          cumulativeReturn,
        };
      });

      stockReturns.push({
        symbol,
        name: symbol, // 实际应从数据库获取名称
        buyPrice: allocInfo.buyPrice,
        allocationAmount: allocInfo.allocationAmount,
        shares: allocInfo.shares,
        dailyReturns,
      });
    }

    return stockReturns;
  }

  /**
   * 计算组合每日收益
   */
  private calculatePortfolioReturns(stockReturns: StockReturnData[]): Array<{
    date: Date;
    totalValue: number;
    dailyReturn: number;
    cumulativeReturn: number;
  }> {
    if (stockReturns.length === 0) {
      return [];
    }

    // 收集所有日期
    const allDates = new Set<Date>();
    for (const stockReturn of stockReturns) {
      for (const dailyReturn of stockReturn.dailyReturns) {
        allDates.add(dailyReturn.date);
      }
    }

    // 按日期排序
    const sortedDates = Array.from(allDates).sort((a, b) => a.getTime() - b.getTime());

    // 按日期汇总（使用普通循环避免引用未完全构建的数组）
    const portfolioReturns: Array<{
      date: Date;
      totalValue: number;
      dailyReturn: number;
      cumulativeReturn: number;
    }> = [];

    for (let i = 0; i < sortedDates.length; i++) {
      const date = sortedDates[i];
      let totalValue = 0;

      // 计算当日总市值
      for (const stockReturn of stockReturns) {
        const dailyReturn = stockReturn.dailyReturns.find(
          dr => dr.date.getTime() === date.getTime()
        );
        if (dailyReturn) {
          totalValue += dailyReturn.value;
        }
      }

      // 计算当日收益率
      let dailyReturn = 0;
      if (i > 0) {
        const prevReturn = portfolioReturns[i - 1];
        const previousTotalValue = prevReturn.totalValue;
        dailyReturn = previousTotalValue > 0 ? totalValue / previousTotalValue - 1 : 0;
      }

      // 计算累计收益率（相对于第一日）
      const firstDayValue = i === 0 ? totalValue : portfolioReturns[0].totalValue;
      const cumulativeReturn = firstDayValue > 0 ? totalValue / firstDayValue - 1 : 0;

      portfolioReturns.push({
        date,
        totalValue,
        dailyReturn,
        cumulativeReturn,
      });
    }

    return portfolioReturns;
  }

  /**
   * 计算性能指标
   */
  private calculatePerformanceMetrics(
    portfolioReturns: Array<{
      date: Date;
      totalValue: number;
      dailyReturn: number;
      cumulativeReturn: number;
    }>
  ): PortfolioSimulationResult['performanceMetrics'] {
    if (portfolioReturns.length < 2) {
      return {
        sharpeRatio: 0,
        maxDrawdown: 0,
        volatility: 0,
        winDays: 0,
        lossDays: 0,
        avgDailyReturn: 0,
        bestDay: { date: new Date(), return: 0 },
        worstDay: { date: new Date(), return: 0 },
      };
    }

    // 提取日收益率（跳过第一日）
    const dailyReturns = portfolioReturns.slice(1).map(r => r.dailyReturn);

    // 计算平均日收益率
    const avgDailyReturn = dailyReturns.reduce((sum, r) => sum + r, 0) / dailyReturns.length;

    // 计算波动率（标准差）
    const variance =
      dailyReturns.reduce((sum, r) => sum + Math.pow(r - avgDailyReturn, 2), 0) /
      dailyReturns.length;
    const volatility = Math.sqrt(variance);

    // 计算夏普比率（假设无风险利率3%，年化）
    const riskFreeRate = 0.03 / 252; // 日无风险利率
    const sharpeRatio =
      volatility > 0 ? ((avgDailyReturn - riskFreeRate) / volatility) * Math.sqrt(252) : 0;

    // 计算最大回撤
    let peak = portfolioReturns[0].totalValue;
    let maxDrawdown = 0;
    const maxDrawdownStart = portfolioReturns[0].date;
    let maxDrawdownEnd = portfolioReturns[0].date;

    for (const ret of portfolioReturns) {
      if (ret.totalValue > peak) {
        peak = ret.totalValue;
      }
      const drawdown = (peak - ret.totalValue) / peak;
      if (drawdown > maxDrawdown) {
        maxDrawdown = drawdown;
        maxDrawdownEnd = ret.date;
      }
    }

    // 计算盈利/亏损天数
    const winDays = dailyReturns.filter(r => r > 0).length;
    const lossDays = dailyReturns.filter(r => r < 0).length;

    // 找出最好和最差交易日
    const bestDayIndex = dailyReturns.indexOf(Math.max(...dailyReturns));
    const worstDayIndex = dailyReturns.indexOf(Math.min(...dailyReturns));

    return {
      sharpeRatio,
      maxDrawdown: maxDrawdown * 100, // 转换为百分比
      volatility: volatility * 100, // 转换为百分比
      winDays,
      lossDays,
      avgDailyReturn: avgDailyReturn * 100, // 转换为百分比
      bestDay: {
        date: portfolioReturns[bestDayIndex + 1]?.date || new Date(),
        return: dailyReturns[bestDayIndex] * 100,
      },
      worstDay: {
        date: portfolioReturns[worstDayIndex + 1]?.date || new Date(),
        return: dailyReturns[worstDayIndex] * 100,
      },
    };
  }

  /**
   * 生成摘要信息
   */
  private generateSummary(
    config: PortfolioSimulationConfig,
    portfolioReturns: Array<{ date: Date; totalValue: number; cumulativeReturn: number }>
  ): PortfolioSimulationResult['summary'] {
    if (portfolioReturns.length === 0) {
      return {
        initialCapital: config.initialCapital,
        finalCapital: config.initialCapital,
        totalReturn: 0,
        annualizedReturn: 0,
        totalDays: 0,
        startDate: config.buyDate,
        endDate: config.buyDate,
      };
    }

    const initialCapital = config.initialCapital;
    const finalCapital = portfolioReturns[portfolioReturns.length - 1].totalValue;
    const totalReturn = ((finalCapital - initialCapital) / initialCapital) * 100;

    const startDate = portfolioReturns[0].date;
    const endDate = portfolioReturns[portfolioReturns.length - 1].date;
    const totalDays = portfolioReturns.length;

    // 计算年化收益率
    const daysDiff = (endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24);
    const years = daysDiff / 365.25;
    const annualizedReturn = years > 0 ? (Math.pow(1 + totalReturn / 100, 1 / years) - 1) * 100 : 0;

    return {
      initialCapital,
      finalCapital,
      totalReturn,
      annualizedReturn,
      totalDays,
      startDate,
      endDate,
    };
  }
}
