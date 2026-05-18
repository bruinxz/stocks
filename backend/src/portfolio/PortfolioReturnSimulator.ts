import { DataService } from '../data/services/DataService';
import { Stock } from '../models/Stock';
import { DailyBar } from '../models/DailyBar';
import { logger } from '../utils/logger';
import { normalizeSymbol } from '../utils/stockSymbol';

export interface PortfolioSimulationConfig {
  symbols: string[];
  buyDate: Date;
  days: number; // 持有天数
  initial_capital: number;
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
  daily_returns: Array<{
    date: Date;
    price: number;
    value: number; // 当日市值
    dailyReturn: number; // 当日收益率
    cumulativeReturn: number; // 累计收益率
  }>;
}

export interface PortfolioSimulationResult {
  summary: {
    initial_capital: number;
    final_capital: number;
    total_return: number;
    annualized_return: number;
    totalDays: number;
    start_date: Date;
    end_date: Date;
  };
  daily_returns: Array<{
    date: Date;
    total_value: number;
    dailyReturn: number; // 组合当日收益率
    cumulativeReturn: number; // 组合累计收益率
  }>;
  stockReturns: StockReturnData[];
  performanceMetrics: {
    sharpe_ratio: number;
    max_drawdown: number;
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
  private stockInfoMap: Map<string, Stock> = new Map();

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
        initial_capital: config.initial_capital,
      });

      // 计算结束日期
      const end_date = this.calculateEndDate(config.buyDate, config.days);

      // 验证股票存在并获取基本信息
      const stockInfos = await this.validateAndGetStockInfo(config.symbols);
      this.stockInfoMap = stockInfos;

      // 获取每只股票的日线数据
      const stockData = await this.fetchStockData(config.symbols, config.buyDate, end_date);

      // 计算买入价格和分配金额
      const allocation = this.calculateAllocation(config, stockData);
      const remainingCash = this.calculateRemainingCash(config, allocation);

      // 计算每日收益
      const stockReturns = this.calculateStockReturns(allocation, stockData);

      // 计算组合每日收益
      const portfolioReturns = this.calculatePortfolioReturns(stockReturns, remainingCash);

      // 计算性能指标
      const performanceMetrics = this.calculatePerformanceMetrics(portfolioReturns);

      // 生成摘要
      const summary = this.generateSummary(config, portfolioReturns);

      logger.info('Portfolio simulation completed successfully', {
        totalDays: portfolioReturns.length,
        final_capital: summary.final_capital,
        total_return: summary.total_return,
      });

      return {
        summary,
        daily_returns: portfolioReturns,
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
    const end_date = new Date(buyDate);
    end_date.setDate(end_date.getDate() + days);
    return end_date;
  }

  /**
   * 验证股票存在并获取基本信息
   */
  private async validateAndGetStockInfo(symbols: string[]): Promise<Map<string, Stock>> {
    const stockInfos = new Map<string, Stock>();

    for (const rawSymbol of symbols) {
      const symbol = normalizeSymbol(rawSymbol);
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
    start_date: Date,
    end_date: Date
  ): Promise<Map<string, DailyBar[]>> {
    const stockData = new Map<string, DailyBar[]>();

    for (const rawSymbol of symbols) {
      const symbol = normalizeSymbol(rawSymbol);
      const bars = await this.dataService.getDailyBars(symbol, start_date, end_date);
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
      const symbols = config.symbols.map(symbol => normalizeSymbol(symbol));
      const perStockAmount = config.initial_capital / symbols.length;

      for (const symbol of symbols) {
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

      const daily_returns = bars.map((bar, index) => {
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
        name: this.stockInfoMap.get(symbol)?.name || symbol,
        buyPrice: allocInfo.buyPrice,
        allocationAmount: allocInfo.allocationAmount,
        shares: allocInfo.shares,
        daily_returns,
      });
    }

    return stockReturns;
  }

  /**
   * 计算未使用现金。
   * 等权分配下因为股数向下取整，通常会有少量剩余现金，需要计入组合总资产。
   */
  private calculateRemainingCash(
    config: PortfolioSimulationConfig,
    allocation: Map<string, { allocationAmount: number; buyPrice: number; shares: number }>
  ): number {
    const investedAmount = Array.from(allocation.values()).reduce(
      (sum, item) => sum + item.allocationAmount,
      0
    );

    return Number((config.initial_capital - investedAmount).toFixed(4));
  }

  /**
   * 计算组合每日收益
   */
  private calculatePortfolioReturns(
    stockReturns: StockReturnData[],
    remainingCash = 0
  ): Array<{
    date: Date;
    total_value: number;
    dailyReturn: number;
    cumulativeReturn: number;
  }> {
    if (stockReturns.length === 0) {
      return [];
    }

    // 收集所有日期（按时间戳去重，不能直接用 Date 对象引用）
    const allTimestamps = new Set<number>();
    for (const stockReturn of stockReturns) {
      for (const dailyReturn of stockReturn.daily_returns) {
        allTimestamps.add(dailyReturn.date.getTime());
      }
    }

    // 按日期排序
    const sortedDates = Array.from(allTimestamps)
      .sort((a, b) => a - b)
      .map(timestamp => new Date(timestamp));

    const stockValueMaps = stockReturns.map(stockReturn => ({
      symbol: stockReturn.symbol,
      valueMap: new Map(
        stockReturn.daily_returns.map(dailyReturn => [
          dailyReturn.date.getTime(),
          dailyReturn.value,
        ])
      ),
    }));
    const lastKnownValues = new Map<string, number>();

    // 按日期汇总（使用普通循环避免引用未完全构建的数组）
    const portfolioReturns: Array<{
      date: Date;
      total_value: number;
      dailyReturn: number;
      cumulativeReturn: number;
    }> = [];

    for (let i = 0; i < sortedDates.length; i++) {
      const date = sortedDates[i];
      const currentTimestamp = date.getTime();
      let total_value = remainingCash;

      // 计算当日总市值
      for (const stockValueMap of stockValueMaps) {
        const exactValue = stockValueMap.valueMap.get(currentTimestamp);
        if (exactValue !== undefined) {
          lastKnownValues.set(stockValueMap.symbol, exactValue);
        }

        const carriedValue = lastKnownValues.get(stockValueMap.symbol);
        if (carriedValue !== undefined) {
          total_value += carriedValue;
        }
      }

      // 计算当日收益率
      let dailyReturn = 0;
      if (i > 0) {
        const prevReturn = portfolioReturns[i - 1];
        const previousTotalValue = prevReturn.total_value;
        dailyReturn = previousTotalValue > 0 ? total_value / previousTotalValue - 1 : 0;
      }

      // 计算累计收益率（相对于第一日）
      const firstDayValue = i === 0 ? total_value : portfolioReturns[0].total_value;
      const cumulativeReturn = firstDayValue > 0 ? total_value / firstDayValue - 1 : 0;

      portfolioReturns.push({
        date,
        total_value: Number(total_value.toFixed(4)),
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
      total_value: number;
      dailyReturn: number;
      cumulativeReturn: number;
    }>
  ): PortfolioSimulationResult['performanceMetrics'] {
    if (portfolioReturns.length < 2) {
      return {
        sharpe_ratio: 0,
        max_drawdown: 0,
        volatility: 0,
        winDays: 0,
        lossDays: 0,
        avgDailyReturn: 0,
        bestDay: { date: new Date(), return: 0 },
        worstDay: { date: new Date(), return: 0 },
      };
    }

    // 提取日收益率（跳过第一日）
    const daily_returns = portfolioReturns.slice(1).map(r => r.dailyReturn);

    // 计算平均日收益率
    const avgDailyReturn = daily_returns.reduce((sum, r) => sum + r, 0) / daily_returns.length;

    // 计算波动率（标准差）
    const variance =
      daily_returns.reduce((sum, r) => sum + Math.pow(r - avgDailyReturn, 2), 0) /
      daily_returns.length;
    const volatility = Math.sqrt(variance);

    // 计算夏普比率（假设无风险利率3%，年化）
    const riskFreeRate = 0.03 / 252; // 日无风险利率
    const sharpe_ratio =
      volatility > 0 ? ((avgDailyReturn - riskFreeRate) / volatility) * Math.sqrt(252) : 0;

    // 计算最大回撤
    let peak = portfolioReturns[0].total_value;
    let max_drawdown = 0;
    const maxDrawdownStart = portfolioReturns[0].date;
    let maxDrawdownEnd = portfolioReturns[0].date;

    for (const ret of portfolioReturns) {
      if (ret.total_value > peak) {
        peak = ret.total_value;
      }
      const drawdown = (peak - ret.total_value) / peak;
      if (drawdown > max_drawdown) {
        max_drawdown = drawdown;
        maxDrawdownEnd = ret.date;
      }
    }

    // 计算盈利/亏损天数
    const winDays = daily_returns.filter(r => r > 0).length;
    const lossDays = daily_returns.filter(r => r < 0).length;

    // 找出最好和最差交易日
    const bestDayIndex = daily_returns.indexOf(Math.max(...daily_returns));
    const worstDayIndex = daily_returns.indexOf(Math.min(...daily_returns));

    return {
      sharpe_ratio,
      max_drawdown: max_drawdown * 100, // 转换为百分比
      volatility: volatility * 100, // 转换为百分比
      winDays,
      lossDays,
      avgDailyReturn: avgDailyReturn * 100, // 转换为百分比
      bestDay: {
        date: portfolioReturns[bestDayIndex + 1]?.date || new Date(),
        return: daily_returns[bestDayIndex] * 100,
      },
      worstDay: {
        date: portfolioReturns[worstDayIndex + 1]?.date || new Date(),
        return: daily_returns[worstDayIndex] * 100,
      },
    };
  }

  /**
   * 生成摘要信息
   */
  private generateSummary(
    config: PortfolioSimulationConfig,
    portfolioReturns: Array<{ date: Date; total_value: number; cumulativeReturn: number }>
  ): PortfolioSimulationResult['summary'] {
    if (portfolioReturns.length === 0) {
      return {
        initial_capital: config.initial_capital,
        final_capital: config.initial_capital,
        total_return: 0,
        annualized_return: 0,
        totalDays: 0,
        start_date: config.buyDate,
        end_date: config.buyDate,
      };
    }

    const initial_capital = config.initial_capital;
    const final_capital = portfolioReturns[portfolioReturns.length - 1].total_value;
    const total_return = ((final_capital - initial_capital) / initial_capital) * 100;

    const start_date = portfolioReturns[0].date;
    const end_date = portfolioReturns[portfolioReturns.length - 1].date;
    const totalDays = portfolioReturns.length;

    // 计算年化收益率
    const daysDiff = (end_date.getTime() - start_date.getTime()) / (1000 * 60 * 60 * 24);
    const years = daysDiff / 365.25;
    const annualized_return =
      years > 0 ? (Math.pow(1 + total_return / 100, 1 / years) - 1) * 100 : 0;

    return {
      initial_capital,
      final_capital,
      total_return,
      annualized_return,
      totalDays,
      start_date,
      end_date,
    };
  }
}
