import { Request, Response, NextFunction } from 'express';
import { Op } from 'sequelize';
import { BacktestResult, BacktestStatus } from '../../models/BacktestResult';
import { Trade } from '../../models/Trade';
import { User } from '../../models/User';
import { BacktestEngine, BacktestConfig } from '../../backtest/engine/BacktestEngine';
import { DataService } from '../../data/services/DataService';
import { MovingAverageCrossoverStrategy } from '../../backtest/strategies/MovingAverageCrossoverStrategy';
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
      const userId = (req as any).user?.id || 1;
      const {
        name,
        description,
        symbols,
        startDate,
        endDate,
        initialCapital,
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
        // 可以扩展其他策略类型
        default:
          return res.status(400).json({
            success: false,
            message: '不支持的策略类型',
          });
      }

      // 创建回测配置
      const config: BacktestConfig = {
        startDate: new Date(startDate),
        endDate: new Date(endDate),
        initialCapital: parseFloat(initialCapital),
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
        userId,
        name,
        description,
        strategyConfig: {
          strategyType,
          strategyParams,
          symbols: config.symbols,
          slippage,
          commissionRate,
          frequency,
        },
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
        profitTrades: result.metrics.profitTrades || 0,
        lossTrades: result.metrics.lossTrades || 0,
        status: BacktestStatus.COMPLETED,
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
      const userId = (req as any).user?.id || 1;
      const {
        page = '1',
        limit = '20',
        status,
        startDate,
        endDate,
      } = req.query;

      const pageNum = parseInt(page as string, 10);
      const limitNum = parseInt(limit as string, 10);
      const offset = (pageNum - 1) * limitNum;

      const where: any = { userId };

      if (status) {
        where.status = status;
      }

      if (startDate) {
        where.createdAt = { ...where.createdAt, [Op.gte]: new Date(startDate as string) };
      }

      if (endDate) {
        where.createdAt = { ...where.createdAt, [Op.lte]: new Date(endDate as string) };
      }

      const { count, rows } = await BacktestResult.findAndCountAll({
        where,
        limit: limitNum,
        offset,
        order: [['createdAt', 'DESC']],
        include: [
          {
            model: Trade,
            attributes: ['id', 'direction', 'pnl', 'entryDate', 'exitDate'],
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
      const userId = (req as any).user?.id || 1;
      const { id } = req.params;

      const backtest = await BacktestResult.findOne({
        where: { id, userId },
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
        data: { backtest },
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
      const userId = (req as any).user?.id || 1;
      const { id } = req.params;

      const backtest = await BacktestResult.findOne({
        where: { id, userId },
      });

      if (!backtest) {
        return res.status(404).json({
          success: false,
          message: '回测不存在或无访问权限',
        });
      }

      // 删除关联的交易记录
      await Trade.destroy({ where: { backtestId: id } });

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
      const userId = (req as any).user?.id || 1;

      const totalBacktests = await BacktestResult.count({ where: { userId } });
      const completedBacktests = await BacktestResult.count({
        where: { userId, status: BacktestStatus.COMPLETED },
      });
      const failedBacktests = await BacktestResult.count({
        where: { userId, status: BacktestStatus.FAILED },
      });

      const recentBacktests = await BacktestResult.findAll({
        where: { userId },
        attributes: ['totalReturn', 'annualizedReturn', 'sharpeRatio', 'maxDrawdown'],
        limit: 10,
        order: [['createdAt', 'DESC']],
      });

      const avgReturn = recentBacktests.length > 0
        ? recentBacktests.reduce((sum, bt) => sum + bt.totalReturn, 0) / recentBacktests.length
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