import { Request, Response, NextFunction } from 'express';
import { PaperTradingPortfolio } from '../../models/PaperTradingPortfolio';
import { PaperTradingPosition } from '../../models/PaperTradingPosition';
import { PaperTradingTrade } from '../../models/PaperTradingTrade';
import { PaperTradingSnapshot } from '../../models/PaperTradingSnapshot';
import { Stock } from '../../models/Stock';
import { DataService } from '../../data/services/DataService';
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
        where: { userId: user.id },
      });

      // 如果用户没有模拟盘，自动创建一个默认的 100W 模拟盘
      if (!portfolio) {
        const username = user.nickname || user.username || 'User';
        portfolio = await PaperTradingPortfolio.create({
          userId: user.id,
          name: `${username}的模拟盘`,
          initialCapital: 1000000,
          currentCash: 1000000,
          totalValue: 1000000,
          isActive: true,
        });
      }

      const positions = await PaperTradingPosition.findAll({
        where: { portfolioId: portfolio.id },
      });

      // 更新持仓的当前价格和浮动盈亏
      let totalMarketValue = 0;
      const updatedPositions = await Promise.all(positions.map(async (pos) => {
        try {
          const bars = await this.dataService.getDailyBars(pos.symbol, new Date(Date.now() - 7 * 24 * 60 * 60 * 1000), new Date());
          if (bars && bars.length > 0) {
            const currentPrice = bars[bars.length - 1].close;
            const marketValue = currentPrice * pos.quantity;
            const unrealizedPnl = marketValue - (pos.avgCost * pos.quantity);
            
            // 更新数据库
            pos.currentPrice = currentPrice;
            pos.marketValue = marketValue;
            pos.unrealizedPnl = unrealizedPnl;
            await pos.save();
          }
          totalMarketValue += pos.marketValue;
          return pos;
        } catch (e) {
          logger.error(`获取股票 ${pos.symbol} 价格失败`, e);
          totalMarketValue += pos.marketValue;
          return pos;
        }
      }));

      // 更新总资产
      portfolio.totalValue = portfolio.currentCash + totalMarketValue;
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
        where: { userId: user.id },
      });

      if (!portfolio) {
        return res.status(404).json({ success: false, message: '未找到模拟盘，请先刷新页面' });
      }

      // 获取当前股票价格
      const bars = await this.dataService.getDailyBars(symbol, new Date(Date.now() - 7 * 24 * 60 * 60 * 1000), new Date());
      if (!bars || bars.length === 0) {
        return res.status(400).json({ success: false, message: '无法获取该股票的当前价格' });
      }
      const currentPrice = bars[bars.length - 1].close;

      const stockInfo = await Stock.findOne({ where: { symbol } });
      const stockName = stockInfo ? stockInfo.name : symbol;

      // 手续费千三，滑点千一
      const commissionRate = 0.0003;
      const slippage = 0.001;

      if (direction === 'BUY') {
        const executePrice = currentPrice * (1 + slippage);
        const cost = executePrice * quantity;
        const commission = cost * commissionRate;
        const totalCost = cost + commission;

        if (portfolio.currentCash < totalCost) {
          return res.status(400).json({ success: false, message: '可用资金不足' });
        }

        let position = await PaperTradingPosition.findOne({
          where: { portfolioId: portfolio.id, symbol },
        });

        if (position) {
          const totalCostBasis = (position.avgCost * position.quantity) + cost;
          position.quantity += quantity;
          position.avgCost = totalCostBasis / position.quantity;
          position.currentPrice = currentPrice;
          position.marketValue = position.quantity * currentPrice;
          position.unrealizedPnl = position.marketValue - (position.avgCost * position.quantity);
          await position.save();
        } else {
          await PaperTradingPosition.create({
            portfolioId: portfolio.id,
            symbol,
            name: stockName,
            quantity,
            avgCost: executePrice,
            currentPrice,
            marketValue: quantity * currentPrice,
            unrealizedPnl: (quantity * currentPrice) - cost,
          });
        }

        portfolio.currentCash -= totalCost;
        await portfolio.save();

        // 记录交易流水
        await PaperTradingTrade.create({
          portfolioId: portfolio.id,
          symbol,
          name: stockName,
          direction: 'BUY',
          executePrice,
          quantity,
          amount: cost,
          commission,
        });

      } else if (direction === 'SELL') {
        let position = await PaperTradingPosition.findOne({
          where: { portfolioId: portfolio.id, symbol },
        });

        if (!position || position.quantity < quantity) {
          return res.status(400).json({ success: false, message: '持仓不足，无法卖出' });
        }

        const executePrice = currentPrice * (1 - slippage);
        const revenue = executePrice * quantity;
        const commission = revenue * commissionRate;
        const netRevenue = revenue - commission;

        if (position.quantity === quantity) {
          await position.destroy();
        } else {
          position.quantity -= quantity;
          position.currentPrice = currentPrice;
          position.marketValue = position.quantity * currentPrice;
          position.unrealizedPnl = position.marketValue - (position.avgCost * position.quantity);
          await position.save();
        }

        portfolio.currentCash += netRevenue;
        await portfolio.save();

        // 记录交易流水
        const realizedPnl = revenue - (position.avgCost * quantity) - commission;
        await PaperTradingTrade.create({
          portfolioId: portfolio.id,
          symbol,
          name: stockName,
          direction: 'SELL',
          executePrice,
          quantity,
          amount: revenue,
          commission,
          realizedPnl,
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
        where: { userId: user.id },
      });

      if (!portfolio) {
        return res.status(404).json({ success: false, message: '未找到模拟盘' });
      }

      const trades = await PaperTradingTrade.findAll({
        where: { portfolioId: portfolio.id },
        order: [['createdAt', 'DESC']],
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
        where: { userId: user.id },
      });

      if (!portfolio) {
        return res.status(404).json({ success: false, message: '未找到模拟盘' });
      }

      // 为了确保图表至少有一个数据点（即初始状态），如果完全没有快照，就插入一条当前状态的真实快照
      const count = await PaperTradingSnapshot.count({ where: { portfolioId: portfolio.id } });
      if (count === 0) {
        const todayStr = new Date().toISOString().split('T')[0];
        await PaperTradingSnapshot.create({
          portfolioId: portfolio.id,
          date: todayStr,
          totalValue: Number(portfolio.totalValue) || 1000000,
          currentCash: Number(portfolio.currentCash) || 1000000,
          positionValue: (Number(portfolio.totalValue) || 1000000) - (Number(portfolio.currentCash) || 1000000),
        });
      }

      const snapshots = await PaperTradingSnapshot.findAll({
        where: { portfolioId: portfolio.id },
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
}

export const paperTradingController = new PaperTradingController();
