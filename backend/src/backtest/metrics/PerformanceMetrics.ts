export interface TradeMetrics {
  totalTrades: number;
  profitTrades: number;
  lossTrades: number;
  winRate: number;
  averageProfit: number;
  averageLoss: number;
  averageHoldingDays: number;
  profitFactor: number;
  expectancy: number;
}

export interface PortfolioMetrics {
  initialCapital: number;
  finalCapital: number;
  totalReturn: number;
  annualizedReturn: number;
  sharpeRatio: number;
  sortinoRatio: number;
  calmarRatio: number;
  maxDrawdown: number;
  volatility: number;
  downsideVolatility: number;
  valueAtRisk: number;
  conditionalValueAtRisk: number;
}

export interface RiskMetrics {
  beta: number;
  alpha: number;
  informationRatio: number;
  treynorRatio: number;
  rSquared: number;
  trackingError: number;
}

export class PerformanceCalculator {
  /**
   * 计算交易指标
   */
  static calculateTradeMetrics(trades: any[]): TradeMetrics {
    if (trades.length === 0) {
      return {
        totalTrades: 0,
        profitTrades: 0,
        lossTrades: 0,
        winRate: 0,
        averageProfit: 0,
        averageLoss: 0,
        averageHoldingDays: 0,
        profitFactor: 0,
        expectancy: 0,
      };
    }

    const profitTrades = trades.filter(t => t.pnl && t.pnl > 0);
    const lossTrades = trades.filter(t => t.pnl && t.pnl <= 0);

    const totalProfit = profitTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);
    const totalLoss = Math.abs(lossTrades.reduce((sum, t) => sum + (t.pnl || 0), 0));

    const averageProfit = profitTrades.length > 0 ? totalProfit / profitTrades.length : 0;
    const averageLoss = lossTrades.length > 0 ? totalLoss / lossTrades.length : 0;

    const winRate = (profitTrades.length / trades.length) * 100;
    const profitFactor = totalLoss !== 0 ? totalProfit / totalLoss : 0;
    const expectancy = (winRate / 100) * averageProfit - ((100 - winRate) / 100) * averageLoss;

    const holdingDays = trades.filter(t => t.holdingDays).map(t => t.holdingDays || 0);
    const averageHoldingDays =
      holdingDays.length > 0
        ? holdingDays.reduce((sum, days) => sum + days, 0) / holdingDays.length
        : 0;

    return {
      totalTrades: trades.length,
      profitTrades: profitTrades.length,
      lossTrades: lossTrades.length,
      winRate,
      averageProfit,
      averageLoss,
      averageHoldingDays,
      profitFactor,
      expectancy,
    };
  }

  /**
   * 计算投资组合指标
   */
  static calculatePortfolioMetrics(
    equityCurve: { date: Date; value: number }[],
    initialCapital: number,
    riskFreeRate = 0.03,
    benchmarkReturns?: number[]
  ): PortfolioMetrics {
    if (equityCurve.length < 2) {
      return {
        initialCapital,
        finalCapital: initialCapital,
        totalReturn: 0,
        annualizedReturn: 0,
        sharpeRatio: 0,
        sortinoRatio: 0,
        calmarRatio: 0,
        maxDrawdown: 0,
        volatility: 0,
        downsideVolatility: 0,
        valueAtRisk: 0,
        conditionalValueAtRisk: 0,
      };
    }

    const finalCapital = equityCurve[equityCurve.length - 1].value;
    const totalReturn = ((finalCapital - initialCapital) / initialCapital) * 100;

    // 计算日收益率
    const dailyReturns: number[] = [];
    for (let i = 1; i < equityCurve.length; i++) {
      const prevValue = equityCurve[i - 1].value;
      const currValue = equityCurve[i].value;
      const dailyReturn = ((currValue - prevValue) / prevValue) * 100;
      dailyReturns.push(dailyReturn);
    }

    // 年化收益率
    const startDate = equityCurve[0].date;
    const endDate = equityCurve[equityCurve.length - 1].date;
    const years = (endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24 * 365.25);
    const annualizedReturn = years > 0 ? (Math.pow(1 + totalReturn / 100, 1 / years) - 1) * 100 : 0;

    // 波动率
    const volatility = this.calculateVolatility(dailyReturns);
    const downsideVolatility = this.calculateDownsideVolatility(dailyReturns);

    // 夏普比率
    const sharpeRatio = this.calculateSharpeRatio(dailyReturns, riskFreeRate);

    // 索提诺比率
    const sortinoRatio = this.calculateSortinoRatio(dailyReturns, riskFreeRate);

    // 最大回撤
    const maxDrawdown = this.calculateMaxDrawdown(equityCurve);

    // 卡玛比率
    const calmarRatio = annualizedReturn !== 0 ? annualizedReturn / Math.abs(maxDrawdown) : 0;

    // 风险价值 (VaR) - 95% 置信度
    const valueAtRisk = this.calculateValueAtRisk(dailyReturns, 0.95);

    // 条件风险价值 (CVaR)
    const conditionalValueAtRisk = this.calculateConditionalValueAtRisk(dailyReturns, 0.95);

    return {
      initialCapital,
      finalCapital,
      totalReturn,
      annualizedReturn,
      sharpeRatio,
      sortinoRatio,
      calmarRatio,
      maxDrawdown,
      volatility,
      downsideVolatility,
      valueAtRisk,
      conditionalValueAtRisk,
    };
  }

  /**
   * 计算风险指标
   */
  static calculateRiskMetrics(
    portfolioReturns: number[],
    benchmarkReturns: number[],
    riskFreeRate = 0.03
  ): RiskMetrics {
    if (portfolioReturns.length !== benchmarkReturns.length || portfolioReturns.length === 0) {
      return {
        beta: 0,
        alpha: 0,
        informationRatio: 0,
        treynorRatio: 0,
        rSquared: 0,
        trackingError: 0,
      };
    }

    // 计算协方差和方差
    const avgPortfolioReturn =
      portfolioReturns.reduce((sum, r) => sum + r, 0) / portfolioReturns.length;
    const avgBenchmarkReturn =
      benchmarkReturns.reduce((sum, r) => sum + r, 0) / benchmarkReturns.length;

    let covariance = 0;
    let benchmarkVariance = 0;
    let portfolioVariance = 0;

    for (let i = 0; i < portfolioReturns.length; i++) {
      const portfolioDiff = portfolioReturns[i] - avgPortfolioReturn;
      const benchmarkDiff = benchmarkReturns[i] - avgBenchmarkReturn;

      covariance += portfolioDiff * benchmarkDiff;
      benchmarkVariance += benchmarkDiff * benchmarkDiff;
      portfolioVariance += portfolioDiff * portfolioDiff;
    }

    covariance /= portfolioReturns.length;
    benchmarkVariance /= portfolioReturns.length;
    portfolioVariance /= portfolioReturns.length;

    const benchmarkStd = Math.sqrt(benchmarkVariance);

    // Beta
    const beta = benchmarkVariance !== 0 ? covariance / benchmarkVariance : 0;

    // Alpha
    const alpha = avgPortfolioReturn - (riskFreeRate + beta * (avgBenchmarkReturn - riskFreeRate));

    // 跟踪误差
    const trackingErrors: number[] = [];
    for (let i = 0; i < portfolioReturns.length; i++) {
      trackingErrors.push(portfolioReturns[i] - benchmarkReturns[i]);
    }
    const trackingError = Math.sqrt(
      trackingErrors.reduce((sum, te) => sum + te * te, 0) / trackingErrors.length
    );

    // 信息比率
    const informationRatio =
      trackingError !== 0 ? (avgPortfolioReturn - avgBenchmarkReturn) / trackingError : 0;

    // 特雷诺比率
    const treynorRatio = beta !== 0 ? (avgPortfolioReturn - riskFreeRate) / beta : 0;

    // R²
    const totalVariance = portfolioVariance;
    const explainedVariance = beta * beta * benchmarkVariance;
    const rSquared = totalVariance !== 0 ? explainedVariance / totalVariance : 0;

    return {
      beta,
      alpha,
      informationRatio,
      treynorRatio,
      rSquared,
      trackingError,
    };
  }

  /**
   * 计算波动率（年化）
   */
  static calculateVolatility(returns: number[]): number {
    if (returns.length === 0) return 0;

    const avgReturn = returns.reduce((sum, r) => sum + r, 0) / returns.length;
    const variance =
      returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length;
    const dailyStd = Math.sqrt(variance);

    // 年化波动率（假设252个交易日）
    return dailyStd * Math.sqrt(252);
  }

  /**
   * 计算下行波动率
   */
  static calculateDownsideVolatility(returns: number[]): number {
    if (returns.length === 0) return 0;

    const downsideReturns = returns.filter(r => r < 0);
    if (downsideReturns.length === 0) return 0;

    const avgDownsideReturn =
      downsideReturns.reduce((sum, r) => sum + r, 0) / downsideReturns.length;
    const variance =
      downsideReturns.reduce((sum, r) => sum + Math.pow(r - avgDownsideReturn, 2), 0) /
      downsideReturns.length;
    const dailyDownsideStd = Math.sqrt(variance);

    // 年化下行波动率
    return dailyDownsideStd * Math.sqrt(252);
  }

  /**
   * 计算夏普比率
   */
  static calculateSharpeRatio(returns: number[], riskFreeRate = 0.03): number {
    if (returns.length === 0) return 0;

    const avgReturn = returns.reduce((sum, r) => sum + r, 0) / returns.length;
    const volatility = this.calculateVolatility(returns);

    if (volatility === 0) return 0;

    // 年化平均收益率
    const annualizedReturn = avgReturn * 252;

    return (annualizedReturn - riskFreeRate) / volatility;
  }

  /**
   * 计算索提诺比率
   */
  static calculateSortinoRatio(returns: number[], riskFreeRate = 0.03): number {
    if (returns.length === 0) return 0;

    const avgReturn = returns.reduce((sum, r) => sum + r, 0) / returns.length;
    const downsideVolatility = this.calculateDownsideVolatility(returns);

    if (downsideVolatility === 0) return 0;

    // 年化平均收益率
    const annualizedReturn = avgReturn * 252;

    return (annualizedReturn - riskFreeRate) / downsideVolatility;
  }

  /**
   * 计算最大回撤
   */
  static calculateMaxDrawdown(equityCurve: { date: Date; value: number }[]): number {
    if (equityCurve.length === 0) return 0;

    let peak = equityCurve[0].value;
    let maxDrawdown = 0;

    for (const point of equityCurve) {
      if (point.value > peak) {
        peak = point.value;
      }
      const drawdown = ((peak - point.value) / peak) * 100;
      if (drawdown > maxDrawdown) {
        maxDrawdown = drawdown;
      }
    }

    return maxDrawdown;
  }

  /**
   * 计算风险价值 (VaR)
   */
  static calculateValueAtRisk(returns: number[], confidenceLevel = 0.95): number {
    if (returns.length === 0) return 0;

    const sortedReturns = [...returns].sort((a, b) => a - b);
    const index = Math.floor((1 - confidenceLevel) * sortedReturns.length);
    return sortedReturns[index] || 0;
  }

  /**
   * 计算条件风险价值 (CVaR)
   */
  static calculateConditionalValueAtRisk(returns: number[], confidenceLevel = 0.95): number {
    if (returns.length === 0) return 0;

    const sortedReturns = [...returns].sort((a, b) => a - b);
    const varIndex = Math.floor((1 - confidenceLevel) * sortedReturns.length);
    const tailReturns = sortedReturns.slice(0, varIndex + 1);

    if (tailReturns.length === 0) return 0;

    const averageTailLoss = tailReturns.reduce((sum, r) => sum + r, 0) / tailReturns.length;
    return averageTailLoss;
  }

  /**
   * 生成回测报告
   */
  static generateReport(
    tradeMetrics: TradeMetrics,
    portfolioMetrics: PortfolioMetrics,
    riskMetrics?: RiskMetrics
  ): any {
    return {
      summary: {
        totalReturn: `${portfolioMetrics.totalReturn.toFixed(2)}%`,
        annualizedReturn: `${portfolioMetrics.annualizedReturn.toFixed(2)}%`,
        sharpeRatio: portfolioMetrics.sharpeRatio.toFixed(3),
        maxDrawdown: `${portfolioMetrics.maxDrawdown.toFixed(2)}%`,
        winRate: `${tradeMetrics.winRate.toFixed(2)}%`,
        totalTrades: tradeMetrics.totalTrades,
      },
      tradeMetrics,
      portfolioMetrics,
      riskMetrics,
      timestamp: new Date().toISOString(),
    };
  }
}
