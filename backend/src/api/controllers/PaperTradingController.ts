import { Request, Response, NextFunction } from 'express';
import { PaperTradingPortfolio } from '../../models/PaperTradingPortfolio';
import { PaperTradingPosition } from '../../models/PaperTradingPosition';
import { PaperTradingTrade } from '../../models/PaperTradingTrade';
import { PaperTradingSnapshot } from '../../models/PaperTradingSnapshot';
import { Stock } from '../../models/Stock';
import { DataService } from '../../data/services/DataService';
import { paperTradingAutomationService } from '../../services/PaperTradingAutomationService';
import { paperTradingAttributionService } from '../../services/PaperTradingAttributionService';
import { logger } from '../../utils/logger';

export class PaperTradingController {
  private dataService: DataService;

  constructor() {
    this.dataService = new DataService();
  }

  // 获取当前用户的模拟盘及持仓
  getPortfolio = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as any).user;

      let portfolio = await PaperTradingPortfolio.findOne({
        where: { user_id: user.id },
      });

      // 如果用户没有模拟盘，自动创建一个默认的 100W 模拟盘
      if (!portfolio) {
        const username = user.nickname || user.username || 'User';
        portfolio = await PaperTradingPortfolio.create({
          user_id: user.id,
          name: `${username}的模拟盘`,
          initial_capital: 1000000,
          current_cash: 1000000,
          total_value: 1000000,
          is_active: true,
        });
      }

      const positions = await PaperTradingPosition.findAll({
        where: { portfolio_id: portfolio.id },
      });

      // 更新持仓的当前价格和浮动盈亏
      let totalMarketValue = 0;
      const updatedPositions = await Promise.all(
        positions.map(async pos => {
          try {
            const bars = await this.dataService.getDailyBars(
              pos.symbol,
              new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
              new Date()
            );
            if (bars && bars.length > 0) {
              const current_price = bars[bars.length - 1].close;
              const market_value = current_price * pos.quantity;
              const unrealized_pnl = market_value - pos.avg_cost * pos.quantity;

              // 更新数据库
              pos.current_price = current_price;
              pos.market_value = market_value;
              pos.unrealized_pnl = unrealized_pnl;
              await pos.save();
            }
            totalMarketValue += pos.market_value;
            return pos;
          } catch (e) {
            logger.error(`获取股票 ${pos.symbol} 价格失败`, e);
            totalMarketValue += pos.market_value;
            return pos;
          }
        })
      );

      // 更新总资产
      portfolio.total_value = portfolio.current_cash + totalMarketValue;
      await portfolio.save();

      res.json({
        success: true,
        data: {
          portfolio,
          positions: updatedPositions,
        },
      });
    } catch (error: any) {
      logger.error('获取模拟盘数据失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  };

  // 模拟交易下单 (买入/卖出)
  placeTrade = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as any).user;
      const { symbol, direction, quantity } = req.body;

      if (!symbol || !direction || !quantity || quantity <= 0) {
        return res.status(400).json({ success: false, message: '无效的交易参数' });
      }

      if (direction !== 'BUY' && direction !== 'SELL') {
        return res.status(400).json({ success: false, message: '交易方向必须为 BUY 或 SELL' });
      }

      const portfolio = await PaperTradingPortfolio.findOne({
        where: { user_id: user.id },
      });

      if (!portfolio) {
        return res.status(404).json({ success: false, message: '未找到模拟盘，请先刷新页面' });
      }

      // 获取当前股票价格
      const bars = await this.dataService.getDailyBars(
        symbol,
        new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
        new Date()
      );
      if (!bars || bars.length === 0) {
        return res.status(400).json({ success: false, message: '无法获取该股票的当前价格' });
      }
      const current_price = bars[bars.length - 1].close;

      const stockInfo = await Stock.findOne({ where: { symbol } });
      const stockName = stockInfo ? stockInfo.name : symbol;

      // 手续费千三，滑点千一
      const commissionRate = 0.0003;
      const slippage = 0.001;

      if (direction === 'BUY') {
        const execute_price = current_price * (1 + slippage);
        const cost = execute_price * quantity;
        const commission = cost * commissionRate;
        const totalCost = cost + commission;

        if (portfolio.current_cash < totalCost) {
          return res.status(400).json({ success: false, message: '可用资金不足' });
        }

        let position = await PaperTradingPosition.findOne({
          where: { portfolio_id: portfolio.id, symbol },
        });

        if (position) {
          const totalCostBasis = position.avg_cost * position.quantity + cost;
          position.quantity += quantity;
          position.avg_cost = totalCostBasis / position.quantity;
          position.current_price = current_price;
          position.market_value = position.quantity * current_price;
          position.unrealized_pnl = position.market_value - position.avg_cost * position.quantity;
          await position.save();
        } else {
          await PaperTradingPosition.create({
            portfolio_id: portfolio.id,
            symbol,
            name: stockName,
            quantity,
            avg_cost: execute_price,
            current_price,
            market_value: quantity * current_price,
            unrealized_pnl: quantity * current_price - cost,
          });
        }

        portfolio.current_cash -= totalCost;
        await portfolio.save();

        // 记录交易流水
        await PaperTradingTrade.create({
          portfolio_id: portfolio.id,
          symbol,
          name: stockName,
          direction: 'BUY',
          execute_price,
          quantity,
          amount: cost,
          commission,
        });
      } else if (direction === 'SELL') {
        let position = await PaperTradingPosition.findOne({
          where: { portfolio_id: portfolio.id, symbol },
        });

        if (!position || position.quantity < quantity) {
          return res.status(400).json({ success: false, message: '持仓不足，无法卖出' });
        }

        const execute_price = current_price * (1 - slippage);
        const revenue = execute_price * quantity;
        const commission = revenue * commissionRate;
        const netRevenue = revenue - commission;

        if (position.quantity === quantity) {
          await position.destroy();
        } else {
          position.quantity -= quantity;
          position.current_price = current_price;
          position.market_value = position.quantity * current_price;
          position.unrealized_pnl = position.market_value - position.avg_cost * position.quantity;
          await position.save();
        }

        portfolio.current_cash += netRevenue;
        await portfolio.save();

        // 记录交易流水
        const realized_pnl = revenue - position.avg_cost * quantity - commission;
        await PaperTradingTrade.create({
          portfolio_id: portfolio.id,
          symbol,
          name: stockName,
          direction: 'SELL',
          execute_price,
          quantity,
          amount: revenue,
          commission,
          realized_pnl,
        });
      }

      res.json({
        success: true,
        message: '交易成功',
      });
    } catch (error: any) {
      logger.error('模拟交易失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  };

  // 获取交易流水历史
  getTradeHistory = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as any).user;

      const portfolio = await PaperTradingPortfolio.findOne({
        where: { user_id: user.id },
      });

      if (!portfolio) {
        return res.status(404).json({ success: false, message: '未找到模拟盘' });
      }

      const trades = await PaperTradingTrade.findAll({
        where: { portfolio_id: portfolio.id },
        order: [['created_at', 'DESC']],
        limit: 100, // 暂定取最近100条
      });

      res.json({
        success: true,
        data: trades,
      });
    } catch (error: any) {
      logger.error('获取交易流水失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  };

  // 获取快照历史(资金曲线)
  getSnapshots = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as any).user;

      const portfolio = await PaperTradingPortfolio.findOne({
        where: { user_id: user.id },
      });

      if (!portfolio) {
        return res.status(404).json({ success: false, message: '未找到模拟盘' });
      }

      // 为了确保图表至少有一个数据点（即初始状态），如果完全没有快照，就插入一条当前状态的真实快照
      const count = await PaperTradingSnapshot.count({ where: { portfolio_id: portfolio.id } });
      if (count === 0) {
        const todayStr = new Date().toISOString().split('T')[0];
        await PaperTradingSnapshot.create({
          portfolio_id: portfolio.id,
          date: todayStr,
          total_value: Number(portfolio.total_value) || 1000000,
          current_cash: Number(portfolio.current_cash) || 1000000,
          position_value:
            (Number(portfolio.total_value) || 1000000) -
            (Number(portfolio.current_cash) || 1000000),
        });
      }

      const snapshots = await PaperTradingSnapshot.findAll({
        where: { portfolio_id: portfolio.id },
        order: [['date', 'ASC']],
      });

      res.json({
        success: true,
        data: snapshots,
      });
    } catch (error: any) {
      logger.error('获取资金曲线快照失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  };

  // 从已归档的 AI/量化推荐信号自动生成模拟盘交易
  autoTradeFromSignals = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as any).user;
      const result = await paperTradingAutomationService.autoBuyFromSignals({
        ...req.body,
        user_id: user.id,
      });

      res.json({
        success: true,
        data: result,
        message: result.dry_run
          ? `预演完成，计划交易 ${result.planned} 笔`
          : `自动跟单完成，成交 ${result.executed} 笔`,
      });
    } catch (error: any) {
      logger.error('推荐信号自动进入模拟盘失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  };

  // 刷新推荐候选、归档信号，并自动执行模拟盘跟单闭环
  autoSyncFromRecommendations = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as any).user;
      const result = await paperTradingAutomationService.runAutoSync({
        ...req.body,
        user_id: user.id,
        refresh_recommendations: req.body?.refresh_recommendations ?? true,
      });

      res.json({
        success: true,
        data: result,
        message: result.dry_run
          ? `推荐闭环预演完成，计划交易 ${result.planned} 笔`
          : `推荐闭环完成，模拟成交 ${result.executed} 笔`,
      });
    } catch (error: any) {
      logger.error('推荐候选自动归档并进入模拟盘失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  };

  // 刷新价格并写入当日资产快照
  refreshSnapshot = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as any).user;
      const portfolio = await PaperTradingPortfolio.findOne({
        where: { user_id: user.id },
      });

      if (!portfolio) {
        return res.status(404).json({ success: false, message: '未找到模拟盘' });
      }

      const snapshot = await paperTradingAutomationService.syncLatestPricesAndSnapshot(
        portfolio.id
      );

      res.json({
        success: true,
        data: snapshot,
        message: '模拟盘快照已刷新',
      });
    } catch (error: any) {
      logger.error('刷新模拟盘快照失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  };

  // 按止损/止盈/卖出信号/最长持有期检查并自动退出
  runRiskCheck = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as any).user;
      const result = await paperTradingAutomationService.runRiskCheck({
        ...req.body,
        user_id: user.id,
      });

      res.json({
        success: true,
        data: result,
        message: result.dry_run
          ? `风控预演完成，计划退出 ${result.planned} 笔`
          : `风控检查完成，模拟卖出 ${result.exited} 笔`,
      });
    } catch (error: any) {
      logger.error('模拟盘自动风控检查失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  };

  // 获取模拟盘收益归因与策略反哺结果
  getAttribution = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as any).user;
      const result = await paperTradingAttributionService.getAttribution({
        ...req.query,
        user_id: user.id,
      });

      res.json({
        success: true,
        data: result,
        message: `收益归因完成：闭环 ${result.summary.closed_count} 笔，当前持仓 ${result.summary.open_count} 只`,
      });
    } catch (error: any) {
      logger.error('获取模拟盘收益归因失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  };

  // 生成收益归因并写入飞书多维表格
  reportAttribution = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as any).user;
      const result = await paperTradingAttributionService.reportAttribution({
        ...req.body,
        user_id: user.id,
      });

      res.json({
        success: true,
        data: result,
        message: `收益归因已上报飞书：闭环 ${result.summary.closed_count} 笔，胜率 ${result.summary.win_rate}%`,
      });
    } catch (error: any) {
      logger.error('上报模拟盘收益归因失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  };
}

export const paperTradingController = new PaperTradingController();
