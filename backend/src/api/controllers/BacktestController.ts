import { Request, Response, NextFunction } from 'express';
import { Op } from 'sequelize';
import { BacktestResult, BacktestStatus } from '../../models/BacktestResult';
import { Trade } from '../../models/Trade';
import { User } from '../../models/User';
import { BacktestEngine, BacktestConfig } from '../../backtest/engine/BacktestEngine';
import { DataService } from '../../data/services/DataService';
import { MovingAverageCrossoverStrategy } from '../../backtest/strategies/MovingAverageCrossoverStrategy';
import { RSIStrategy } from '../../backtest/strategies/RSIStrategy';
import { MACDStrategy } from '../../backtest/strategies/MACDStrategy';
import { BollingerBandsStrategy } from '../../backtest/strategies/BollingerBandsStrategy';
import { Strategy } from '../../backtest/strategies/Strategy';
import { logger } from '../../utils/logger';

export class BacktestController {
  private dataService: DataService;

  constructor() {
    this.dataService = new DataService();

    // 绑定方法以确保正确的this上下文
    this.createBacktest = this.createBacktest.bind(this);
    this.getBacktestList = this.getBacktestList.bind(this);
    this.getBacktestDetail = this.getBacktestDetail.bind(this);
    this.deleteBacktest = this.deleteBacktest.bind(this);
    this.getBacktestStats = this.getBacktestStats.bind(this);
  }

  /**
   * 创建并运行回测
   */
  async createBacktest(req: Request, res: Response, next: NextFunction) {
    try {
      const user_id = (req as any).user?.id || 1;
      const {
        name,
        description,
        symbols,
        start_date,
        end_date,
        initial_capital,
        strategyType = 'moving_average_crossover',
        strategyParams,
        slippage = 0.001,
        commissionRate = 0.0003,
        frequency = 'daily',
      } = req.body;

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
        case 'rsi':
          const rsiConfig = {
            id: `strategy_${Date.now()}`,
            name: 'RSI Strategy',
            parameters: {
              period: strategyParams?.period || 14,
              overbought: strategyParams?.overbought || 70,
              oversold: strategyParams?.oversold || 30,
            },
          };
          strategy = new RSIStrategy(rsiConfig, symbol);
          break;
        case 'macd':
          const macdConfig = {
            id: `strategy_${Date.now()}`,
            name: 'MACD Strategy',
            parameters: {
              fastPeriod: strategyParams?.fastPeriod || 12,
              slowPeriod: strategyParams?.slowPeriod || 26,
              signalPeriod: strategyParams?.signalPeriod || 9,
            },
          };
          strategy = new MACDStrategy(macdConfig, symbol);
          break;
        case 'bollinger_bands':
          const bbConfig = {
            id: `strategy_${Date.now()}`,
            name: 'Bollinger Bands Strategy',
            parameters: {
              period: strategyParams?.period || 20,
              stdDev: strategyParams?.stdDev || 2,
            },
          };
          strategy = new BollingerBandsStrategy(bbConfig, symbol);
          break;
        // 可以扩展其他策略类型
        default:
          return res.status(400).json({
            success: false,
            message: '不支持的策略类型',
          });
      }

      // 创建回测配置
      const config: BacktestConfig = {
        start_date: new Date(start_date),
        end_date: new Date(end_date),
        initial_capital: parseFloat(initial_capital),
        symbols: Array.isArray(symbols) ? symbols : [symbols],
        strategy,
        dataService: this.dataService,
        slippage,
        commissionRate,
        frequency,
      };

      // 创建回测引擎并运行
      const engine = new BacktestEngine(config);
      const result = await engine.run();

      // 保存回测结果到数据库
      const backtestResult = await BacktestResult.create({
        user_id: user_id,
        name,
        description,
        strategy_config: {
          strategyType,
          strategyParams,
          symbols: config.symbols,
          slippage,
          commissionRate,
          frequency,
        },
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
        profit_trades: result.metrics.profit_trades || 0,
        loss_trades: result.metrics.loss_trades || 0,
        status: BacktestStatus.COMPLETED,
        equity_curve: result.equity_curve,
        daily_returns: result.daily_returns,
        detailed_metrics: result.metrics,
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

      // 获取保存的完整结果
      const completeResult = await BacktestResult.findByPk(backtestResult.id, {
        include: [Trade],
      });

      res.status(201).json({
        success: true,
        message: '回测创建并运行成功',
        data: { backtest: completeResult },
      });
    } catch (error) {
      logger.error('创建回测失败:', error);
      next(error);
    }
  }

  /**
   * 获取回测列表
   */
  async getBacktestList(req: Request, res: Response, next: NextFunction) {
    try {
      const user_id = (req as any).user?.id || 1;
      const { page = '1', limit = '20', status, start_date, end_date } = req.query;

      const pageNum = parseInt(page as string, 10);
      const limitNum = parseInt(limit as string, 10);
      const offset = (pageNum - 1) * limitNum;

      const where: any = { user_id: user_id };

      if (status) {
        where.status = status;
      }

      if (start_date) {
        where.created_at = { ...where.created_at, [Op.gte]: new Date(start_date as string) };
      }

      if (end_date) {
        where.created_at = { ...where.created_at, [Op.lte]: new Date(end_date as string) };
      }

      const { count, rows } = await BacktestResult.findAndCountAll({
        where,
        limit: limitNum,
        offset,
        order: [['created_at', 'DESC']],
        include: [
          {
            model: Trade,
            attributes: ['id', 'direction', 'pnl', 'entry_date', 'exit_date'],
            limit: 5,
          },
        ],
      });

      res.json({
        success: true,
        data: {
          backtests: rows,
          pagination: {
            total: count,
            page: pageNum,
            limit: limitNum,
            totalPages: Math.ceil(count / limitNum),
          },
        },
      });
    } catch (error) {
      logger.error('获取回测列表失败:', error);
      next(error);
    }
  }

  /**
   * 获取回测详情
   */
  async getBacktestDetail(req: Request, res: Response, next: NextFunction) {
    try {
      const user_id = (req as any).user?.id || 1;
      const { id } = req.params;

      const backtest = await BacktestResult.findOne({
        where: { id, user_id: user_id },
        include: [Trade],
      });

      if (!backtest) {
        return res.status(404).json({
          success: false,
          message: '回测不存在或无访问权限',
        });
      }

      res.json({
        success: true,
        data: {
          backtest,
          metrics: backtest.detailed_metrics || {
            initial_capital: backtest.initial_capital,
            final_capital: backtest.final_capital,
            total_return: backtest.total_return,
            annualized_return: backtest.annualized_return,
            sharpe_ratio: backtest.sharpe_ratio,
            sortino_ratio: backtest.sortino_ratio,
            max_drawdown: backtest.max_drawdown,
            win_rate: backtest.win_rate,
            profit_loss_ratio: backtest.profit_loss_ratio,
            total_trades: backtest.total_trades,
            profit_trades: backtest.profit_trades,
            loss_trades: backtest.loss_trades,
          },
          equity_curve: backtest.equity_curve || [],
          daily_returns: backtest.daily_returns || [],
          trades: backtest.trades || [],
        },
      });
    } catch (error) {
      logger.error('获取回测详情失败:', error);
      next(error);
    }
  }

  /**
   * 删除回测
   */
  async deleteBacktest(req: Request, res: Response, next: NextFunction) {
    try {
      const user_id = (req as any).user?.id || 1;
      const { id } = req.params;

      const backtest = await BacktestResult.findOne({
        where: { id, user_id: user_id },
      });

      if (!backtest) {
        return res.status(404).json({
          success: false,
          message: '回测不存在或无访问权限',
        });
      }

      // 删除关联的交易记录
      await Trade.destroy({ where: { backtest_id: id } });

      // 删除回测记录
      await backtest.destroy();

      res.json({
        success: true,
        message: '回测删除成功',
      });
    } catch (error) {
      logger.error('删除回测失败:', error);
      next(error);
    }
  }

  /**
   * 获取回测统计信息
   */
  async getBacktestStats(req: Request, res: Response, next: NextFunction) {
    try {
      const user_id = (req as any).user?.id || 1;

      const totalBacktests = await BacktestResult.count({ where: { user_id: user_id } });
      const completedBacktests = await BacktestResult.count({
        where: { user_id: user_id, status: BacktestStatus.COMPLETED },
      });
      const failedBacktests = await BacktestResult.count({
        where: { user_id: user_id, status: BacktestStatus.FAILED },
      });

      const recentBacktests = await BacktestResult.findAll({
        where: { user_id: user_id },
        attributes: ['total_return', 'annualized_return', 'sharpe_ratio', 'max_drawdown'],
        limit: 10,
        order: [['created_at', 'DESC']],
      });

      const avgReturn =
        recentBacktests.length > 0
          ? recentBacktests.reduce((sum, bt) => sum + bt.total_return, 0) / recentBacktests.length
          : 0;

      res.json({
        success: true,
        data: {
          totalBacktests,
          completedBacktests,
          failedBacktests,
          avgReturn,
          recentPerformance: recentBacktests,
        },
      });
    } catch (error) {
      logger.error('获取回测统计失败:', error);
      next(error);
    }
  }
}
