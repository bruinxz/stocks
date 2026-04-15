import { BacktestJobData } from './queue';
import { BacktestEngine, BacktestConfig } from '../backtest/engine/BacktestEngine';
import { DataService } from '../data/services/DataService';
import { MovingAverageCrossoverStrategy } from '../backtest/strategies/MovingAverageCrossoverStrategy';
import { Strategy } from '../backtest/strategies/Strategy';
import { BacktestResult, BacktestStatus } from '../models/BacktestResult';
import { Trade } from '../models/Trade';
import { logger } from '../utils/logger';

export async function processBacktestJob(jobData: BacktestJobData): Promise<{ backtestResultId: string }> {
  const {
    userId,
    name,
    description,
    symbols,
    startDate,
    endDate,
    initialCapital,
    strategyType,
    strategyParams,
    slippage,
    commissionRate,
    frequency,
  } = jobData;

  logger.info('开始处理回测任务', { userId, name, symbols });

  try {
    // 创建策略实例
    let strategy: Strategy;
    const symbol = Array.isArray(symbols) ? symbols[0] : symbols;

    switch (strategyType) {
      case 'moving_average_crossover':
        const strategyConfig = {
          id: `strategy_${Date.now()}`,
          name: 'Moving Average Crossover',
          parameters: {
            shortWindow: strategyParams?.shortWindow || strategyParams?.shortPeriod || 10,
            longWindow: strategyParams?.longWindow || strategyParams?.longPeriod || 30,
            threshold: strategyParams?.threshold || 0,
          },
        };
        strategy = new MovingAverageCrossoverStrategy(strategyConfig, symbol);
        break;
      default:
        throw new Error(`不支持的策略类型: ${strategyType}`);
    }

    // 创建数据服务实例
    const dataService = new DataService();

    // 创建回测配置
    const config: BacktestConfig = {
      startDate: new Date(startDate),
      endDate: new Date(endDate),
      initialCapital,
      symbols: Array.isArray(symbols) ? symbols : [symbols],
      strategy,
      dataService,
      slippage,
      commissionRate,
      frequency: frequency as 'daily' | 'weekly' | 'monthly',
    };

    // 创建回测引擎并运行
    const engine = new BacktestEngine(config);
    const result = await engine.run();

    // 保存回测结果到数据库
    const backtestResult = await BacktestResult.create({
      userId,
      name,
      description,
      symbols: config.symbols,
      startDate: config.startDate,
      endDate: config.endDate,
      initialCapital: config.initialCapital,
      finalCapital: result.metrics.finalCapital,
      totalReturn: result.metrics.totalReturn,
      annualizedReturn: result.metrics.annualizedReturn,
      sharpeRatio: result.metrics.sharpeRatio,
      maxDrawdown: result.metrics.maxDrawdown,
      winRate: result.metrics.winRate,
      totalTrades: result.metrics.totalTrades,
      status: BacktestStatus.COMPLETED,
      config: {
        strategyType,
        strategyParams,
        slippage,
        commissionRate,
        frequency,
      },
    });

    // 保存交易记录
    if (result.trades && result.trades.length > 0) {
      const tradesData = result.trades.map((trade: any) => ({
        backtestId: backtestResult.id,
        symbol: trade.symbol,
        direction: trade.direction,
        entryPrice: trade.entryPrice,
        exitPrice: trade.exitPrice,
        quantity: trade.quantity,
        entryDate: trade.entryDate,
        exitDate: trade.exitDate,
        pnl: trade.pnl,
        pnlPercent: trade.pnlPercent,
        holdingDays: trade.holdingDays,
      }));
      await Trade.bulkCreate(tradesData);
    }

    logger.info('回测任务处理完成', { backtestResultId: backtestResult.id });
    return { backtestResultId: backtestResult.id };
  } catch (error) {
    logger.error('回测任务处理失败:', error);
    throw error;
  }
}