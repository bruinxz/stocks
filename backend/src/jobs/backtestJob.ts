import { BacktestJobData } from './queue';
import { BacktestEngine, BacktestConfig } from '../backtest/engine/BacktestEngine';
import { DataService } from '../data/services/DataService';
import { MovingAverageCrossoverStrategy } from '../backtest/strategies/MovingAverageCrossoverStrategy';
import { Strategy } from '../backtest/strategies/Strategy';
import { BacktestResult, BacktestStatus } from '../models/BacktestResult';
import { Trade } from '../models/Trade';
import { logger } from '../utils/logger';

export async function processBacktestJob(
  jobData: BacktestJobData
): Promise<{ backtestResultId: string }> {
  const {
    user_id,
    name,
    description,
    symbols,
    start_date,
    end_date,
    initial_capital,
    strategyType,
    strategyParams,
    slippage,
    commissionRate,
    frequency,
  } = jobData;

  logger.info('开始处理回测任务', { user_id, name, symbols });

  try {
    // 创建策略实例
    let strategy: Strategy;
    const symbol = Array.isArray(symbols) ? symbols[0] : symbols;

    switch (strategyType) {
      case 'moving_average_crossover':
        const strategy_config = {
          id: `strategy_${Date.now()}`,
          name: 'Moving Average Crossover',
          parameters: {
            shortWindow: strategyParams?.shortWindow || strategyParams?.shortPeriod || 10,
            longWindow: strategyParams?.longWindow || strategyParams?.longPeriod || 30,
            threshold: strategyParams?.threshold || 0,
          },
        };
        strategy = new MovingAverageCrossoverStrategy(strategy_config, symbol);
        break;
      default:
        throw new Error(`不支持的策略类型: ${strategyType}`);
    }

    // 创建数据服务实例
    const dataService = new DataService();

    // 创建回测配置
    const config: BacktestConfig = {
      start_date: new Date(start_date),
      end_date: new Date(end_date),
      initial_capital,
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
      user_id,
      name,
      description,
      symbols: config.symbols,
      start_date: config.start_date,
      end_date: config.end_date,
      initial_capital: config.initial_capital,
      final_capital: result.metrics.final_capital,
      total_return: result.metrics.total_return,
      annualized_return: result.metrics.annualized_return,
      sharpe_ratio: result.metrics.sharpe_ratio,
      max_drawdown: result.metrics.max_drawdown,
      win_rate: result.metrics.win_rate,
      total_trades: result.metrics.total_trades,
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
        backtest_id: backtestResult.id,
        symbol: trade.symbol,
        direction: trade.direction,
        entry_price: trade.entry_price,
        exit_price: trade.exit_price,
        quantity: trade.quantity,
        entry_date: trade.entry_date,
        exit_date: trade.exit_date,
        pnl: trade.pnl,
        pnl_percent: trade.pnl_percent,
        holding_days: trade.holding_days,
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
