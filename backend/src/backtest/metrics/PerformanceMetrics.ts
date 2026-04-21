export interface TradeMetrics {
  total_trades: number;
  profit_trades: number;
  loss_trades: number;
  win_rate: number;
  averageProfit: number;
  averageLoss: number;
  averageHoldingDays: number;
  profitFactor: number;
  expectancy: number;
}

export interface PortfolioMetrics {
  initial_capital: number;
  final_capital: number;
  total_return: number;
  annualized_return: number;
  sharpe_ratio: number;
  sortino_ratio: number;
  calmar_ratio: number;
  max_drawdown: number;
  volatility: number;
  downsideVolatility: number;
  valueAtRisk: number;
  conditionalValueAtRisk: number;
}

export interface RiskMetrics {
  beta: number;
  alpha: number;
  information_ratio: number;
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
        total_trades: 0,
        profit_trades: 0,
        loss_trades: 0,
        win_rate: 0,
        averageProfit: 0,
        averageLoss: 0,
        averageHoldingDays: 0,
        profitFactor: 0,
        expectancy: 0,
      };
    }

    const profit_trades = trades.filter(t => t.pnl && t.pnl > 0);
    const loss_trades = trades.filter(t => t.pnl && t.pnl <= 0);

    const totalProfit = profit_trades.reduce((sum, t) => sum + (t.pnl || 0), 0);
    const totalLoss = Math.abs(loss_trades.reduce((sum, t) => sum + (t.pnl || 0), 0));

    const averageProfit = profit_trades.length > 0 ? totalProfit / profit_trades.length : 0;
    const averageLoss = loss_trades.length > 0 ? totalLoss / loss_trades.length : 0;

    const win_rate = (profit_trades.length / trades.length) * 100;
    const profitFactor = totalLoss !== 0 ? totalProfit / totalLoss : 0;
    const expectancy = (win_rate / 100) * averageProfit - ((100 - win_rate) / 100) * averageLoss;

    const holding_days = trades.filter(t => t.holding_days).map(t => t.holding_days || 0);
    const averageHoldingDays =
      holding_days.length > 0
        ? holding_days.reduce((sum, days) => sum + days, 0) / holding_days.length
        : 0;

    return {
      total_trades: trades.length,
      profit_trades: profit_trades.length,
      loss_trades: loss_trades.length,
      win_rate,
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
    equity_curve: { date: Date; value: number }[],
    initial_capital: number,
    riskFreeRate = 0.03,
    benchmarkReturns?: number[]
  ): PortfolioMetrics {
    if (equity_curve.length < 2) {
      return {
        initial_capital,
        final_capital: initial_capital,
        total_return: 0,
        annualized_return: 0,
        sharpe_ratio: 0,
        sortino_ratio: 0,
        calmar_ratio: 0,
        max_drawdown: 0,
        volatility: 0,
        downsideVolatility: 0,
        valueAtRisk: 0,
        conditionalValueAtRisk: 0,
      };
    }

    const final_capital = equity_curve[equity_curve.length - 1].value;
    const total_return = ((final_capital - initial_capital) / initial_capital) * 100;

    // 计算日收益率
    const daily_returns: number[] = [];
    for (let i = 1; i < equity_curve.length; i++) {
      const prevValue = equity_curve[i - 1].value;
      const currValue = equity_curve[i].value;
      const dailyReturn = ((currValue - prevValue) / prevValue) * 100;
      daily_returns.push(dailyReturn);
    }

    // 年化收益率
    const start_date = equity_curve[0].date;
    const end_date = equity_curve[equity_curve.length - 1].date;
    const years = (end_date.getTime() - start_date.getTime()) / (1000 * 60 * 60 * 24 * 365.25);
    const annualized_return = years > 0 ? (Math.pow(1 + total_return / 100, 1 / years) - 1) * 100 : 0;

    // 波动率
    const volatility = this.calculateVolatility(daily_returns);
    const downsideVolatility = this.calculateDownsideVolatility(daily_returns);

    // 夏普比率
    const sharpe_ratio = this.calculateSharpeRatio(daily_returns, riskFreeRate);

    // 索提诺比率
    const sortino_ratio = this.calculateSortinoRatio(daily_returns, riskFreeRate);

    // 最大回撤
    const max_drawdown = this.calculateMaxDrawdown(equity_curve);

    // 卡玛比率
    const calmar_ratio = annualized_return !== 0 ? annualized_return / Math.abs(max_drawdown) : 0;

    // 风险价值 (VaR) - 95% 置信度
    const valueAtRisk = this.calculateValueAtRisk(daily_returns, 0.95);

    // 条件风险价值 (CVaR)
    const conditionalValueAtRisk = this.calculateConditionalValueAtRisk(daily_returns, 0.95);

    return {
      initial_capital,
      final_capital,
      total_return,
      annualized_return,
      sharpe_ratio,
      sortino_ratio,
      calmar_ratio,
      max_drawdown,
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
        information_ratio: 0,
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
    const information_ratio =
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
      information_ratio,
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
    const annualized_return = avgReturn * 252;

    return (annualized_return - riskFreeRate) / volatility;
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
    const annualized_return = avgReturn * 252;

    return (annualized_return - riskFreeRate) / downsideVolatility;
  }

  /**
   * 计算最大回撤
   */
  static calculateMaxDrawdown(equity_curve: { date: Date; value: number }[]): number {
    if (equity_curve.length === 0) return 0;

    let peak = equity_curve[0].value;
    let max_drawdown = 0;

    for (const point of equity_curve) {
      if (point.value > peak) {
        peak = point.value;
      }
      const drawdown = ((peak - point.value) / peak) * 100;
      if (drawdown > max_drawdown) {
        max_drawdown = drawdown;
      }
    }

    return max_drawdown;
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
        total_return: `${portfolioMetrics.total_return.toFixed(2)}%`,
        annualized_return: `${portfolioMetrics.annualized_return.toFixed(2)}%`,
        sharpe_ratio: portfolioMetrics.sharpe_ratio.toFixed(3),
        max_drawdown: `${portfolioMetrics.max_drawdown.toFixed(2)}%`,
        win_rate: `${tradeMetrics.win_rate.toFixed(2)}%`,
        total_trades: tradeMetrics.total_trades,
      },
      tradeMetrics,
      portfolioMetrics,
      riskMetrics,
      timestamp: new Date().toISOString(),
    };
  }
}
