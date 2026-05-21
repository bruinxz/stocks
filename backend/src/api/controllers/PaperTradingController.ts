import { Request, Response, NextFunction } from 'express';
import { PaperTradingPortfolio } from '../../models/PaperTradingPortfolio';
import { PaperTradingPosition } from '../../models/PaperTradingPosition';
import { PaperTradingTrade } from '../../models/PaperTradingTrade';
import { PaperTradingSnapshot } from '../../models/PaperTradingSnapshot';
import { Stock } from '../../models/Stock';
import { DataService } from '../../data/services/DataService';
import {
  DEFAULT_PAPER_TRADING_INITIAL_CAPITAL,
  paperTradingAutomationService,
} from '../../services/PaperTradingAutomationService';
import { paperTradingAttributionService } from '../../services/PaperTradingAttributionService';
import {
  AUTONOMOUS_PORTFOLIO_NAME,
  DEFAULT_AUTONOMOUS_INITIAL_CAPITAL,
  paperTradingDashboardService,
  QUANT_ONLY_PORTFOLIO_NAME,
} from '../../services/PaperTradingDashboardService';
import { paperTradingPlanService } from '../../services/PaperTradingPlanService';
import { paperTradingRiskProfileService } from '../../services/PaperTradingRiskProfileService';
import { paperTradingOrderIntentService } from '../../services/PaperTradingOrderIntentService';
import { paperTradingTuningApplyService } from '../../services/PaperTradingTuningApplyService';
import { recommendationTradeOutcomeService } from '../../services/RecommendationTradeOutcomeService';
import { logger } from '../../utils/logger';

const withAutonomousPortfolio = (payload: any = {}) => ({
  ...payload,
  portfolio_name: AUTONOMOUS_PORTFOLIO_NAME,
  initial_capital: DEFAULT_AUTONOMOUS_INITIAL_CAPITAL,
  use_autonomous_portfolio: true,
});

const toNumber = (value: any, fallback = 0): number => {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
};

const roundMoney = (value: any): number => Math.round(toNumber(value, 0) * 100) / 100;

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

      // 如果用户没有模拟盘，自动创建一个默认的 20W 模拟盘
      if (!portfolio) {
        const username = user.nickname || user.username || 'User';
        portfolio = await PaperTradingPortfolio.create({
          user_id: user.id,
          name: `${username}的模拟盘`,
          initial_capital: DEFAULT_PAPER_TRADING_INITIAL_CAPITAL,
          current_cash: DEFAULT_PAPER_TRADING_INITIAL_CAPITAL,
          total_value: DEFAULT_PAPER_TRADING_INITIAL_CAPITAL,
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
              const current_price = toNumber(
                bars[bars.length - 1].close,
                toNumber(pos.current_price)
              );
              const quantity = toNumber(pos.quantity);
              const avg_cost = toNumber(pos.avg_cost);
              const market_value = roundMoney(current_price * quantity);
              const unrealized_pnl = roundMoney(market_value - avg_cost * quantity);

              // 更新数据库
              pos.current_price = current_price;
              pos.market_value = market_value;
              pos.unrealized_pnl = unrealized_pnl;
              await pos.save();
            }
            totalMarketValue += toNumber(pos.market_value);
            return pos;
          } catch (e) {
            logger.error(`获取股票 ${pos.symbol} 价格失败`, e);
            totalMarketValue += toNumber(pos.market_value);
            return pos;
          }
        })
      );

      // 更新总资产
      portfolio.total_value = roundMoney(toNumber(portfolio.current_cash) + totalMarketValue);
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

        const position = await PaperTradingPosition.findOne({
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
        const position = await PaperTradingPosition.findOne({
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
          total_value:
            Number(portfolio.total_value) ||
            Number(portfolio.initial_capital) ||
            DEFAULT_PAPER_TRADING_INITIAL_CAPITAL,
          current_cash:
            Number(portfolio.current_cash) ||
            Number(portfolio.initial_capital) ||
            DEFAULT_PAPER_TRADING_INITIAL_CAPITAL,
          position_value:
            (Number(portfolio.total_value) ||
              Number(portfolio.initial_capital) ||
              DEFAULT_PAPER_TRADING_INITIAL_CAPITAL) -
            (Number(portfolio.current_cash) ||
              Number(portfolio.initial_capital) ||
              DEFAULT_PAPER_TRADING_INITIAL_CAPITAL),
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

  // 获取自主荐股模拟盘总览（20W 初始资金、持仓、收益曲线、推荐闭环）
  getAutonomousDashboard = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as any).user;
      const result = await paperTradingDashboardService.getAutonomousDashboard({
        ...req.query,
        user_id: user.id,
        username: user.username || user.nickname,
      } as any);
      const familyOpenCount = Number(
        result.portfolio_family_summary?.summary?.open_position_count ||
          result.summary.open_position_count ||
          0
      );

      res.json({
        success: true,
        data: result,
        message: `自主模拟盘总览已刷新：综合盘持仓 ${result.summary.open_position_count} 只，全部策略账户持仓 ${familyOpenCount} 只`,
      });
    } catch (error: any) {
      logger.error('获取自主荐股模拟盘总览失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  };

  // 获取每日推荐股票追踪页：推荐→模拟持仓→卖出结算→收益
  getRecommendationTracking = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as any).user;
      const result = await paperTradingDashboardService.getRecommendationTracking({
        ...req.query,
        user_id: user.id,
        username: user.username || user.nickname,
      } as any);

      res.json({
        success: true,
        data: result,
        message: `每日推荐追踪已刷新：信号 ${result.summary.total_signals} 条，持仓 ${result.summary.open_count} 条，闭环 ${result.summary.closed_count} 条`,
      });
    } catch (error: any) {
      logger.error('获取每日推荐追踪失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  };

  // 获取自主荐股闭环优化台：收益路径、策略晋级、片段降权/放大建议
  getAutonomousOptimization = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as any).user;
      const result = await recommendationTradeOutcomeService.getOptimizationDashboard(
        withAutonomousPortfolio({
          ...req.query,
          user_id: user.id,
          username: user.username || user.nickname,
        }) as any
      );

      res.json({
        success: true,
        data: result,
        message: `自主闭环优化台已刷新：闭环 ${result.summary.closed_count} 笔，建议评分≥${result.next_policy.recommended_min_score}`,
      });
    } catch (error: any) {
      logger.error('获取自主荐股闭环优化台失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  };

  // 自主闭环专用：全市场推荐→归档信号→模拟跟单，固定落到 20W 自主模拟盘
  runAutonomousAutoSync = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as any).user;
      const result = await paperTradingAutomationService.runAutoSync(
        withAutonomousPortfolio({
          refresh_recommendations: true,
          universe: 'market',
          style: 'balanced',
          candidate_limit: 12,
          candidate_pool_limit: 360,
          limit: 4,
          scan_limit: 80,
          min_score: 72,
          max_positions: 8,
          default_position_pct: 5,
          max_position_pct: 10,
          verify_signals: true,
          use_entry_risk_guard: true,
          use_profit_gate: true,
          use_outcome_feedback: true,
          report_to_feishu: true,
          ...req.body,
          user_id: user.id,
          username: user.username || user.nickname,
        })
      );

      const dashboard = await paperTradingDashboardService.getAutonomousDashboard({
        user_id: user.id,
        username: user.username || user.nickname,
        lookback_days: 60,
        limit: 120,
      });

      res.json({
        success: true,
        data: { execution: result, dashboard },
        message: result.dry_run
          ? `自主闭环预演完成，计划交易 ${result.planned} 笔`
          : `自主闭环完成，模拟成交 ${result.executed} 笔，跳过 ${result.skipped} 笔`,
      });
    } catch (error: any) {
      logger.error('自主闭环推荐并模拟跟单失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  };

  // 自主闭环专用：卖出信号/止损/止盈/持有期结算，固定落到 20W 自主模拟盘
  runAutonomousRiskCheck = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as any).user;
      const result = await paperTradingAutomationService.runRiskCheck(
        withAutonomousPortfolio({
          dry_run: false,
          report_to_feishu: true,
          enable_stop_loss: true,
          enable_take_profit: true,
          enable_trailing_take_profit: true,
          enable_sell_signals: true,
          use_adaptive_risk_policy: true,
          adaptive_risk_lookback_days: 180,
          adaptive_risk_min_closed_samples: 5,
          adaptive_risk_override_signal_params: false,
          default_stop_loss_pct: 7,
          default_take_profit_pct: 14,
          trailing_activation_pct: 8,
          trailing_drawdown_pct: 4,
          max_hold_days: 20,
          min_sell_signal_score: 60,
          sell_signal_source_type: 'all',
          ...req.body,
          user_id: user.id,
          username: user.username || user.nickname,
        })
      );

      const dashboard = await paperTradingDashboardService.getAutonomousDashboard({
        user_id: user.id,
        username: user.username || user.nickname,
        lookback_days: 60,
        limit: 120,
      });

      res.json({
        success: true,
        data: { execution: result, dashboard },
        message: result.dry_run
          ? `自主风控预演完成，计划退出 ${result.planned} 笔`
          : `自主风控结算完成，模拟卖出 ${result.exited} 笔`,
      });
    } catch (error: any) {
      logger.error('自主闭环风控结算失败:', error);
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

  // 获取模拟盘组合风险画像
  getRiskProfile = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as any).user;
      const result = await paperTradingRiskProfileService.getRiskProfile({
        ...req.query,
        user_id: user.id,
      });

      res.json({
        success: true,
        data: result,
        message: `组合风险画像：${result.status.label}`,
      });
    } catch (error: any) {
      logger.error('获取模拟盘组合风险画像失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  };

  // 获取模拟交易订单意图/拒单归因
  getOrderIntents = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as any).user;
      const result = await paperTradingOrderIntentService.getIntentDashboard({
        ...req.query,
        user_id: user.id,
        username: user.username || user.nickname,
      } as any);

      res.json({
        success: true,
        data: result,
        message: result.summary?.conclusion || '订单意图已刷新',
      });
    } catch (error: any) {
      logger.error('获取模拟交易订单意图失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  };

  // 获取单条模拟交易订单意图的链路钻取
  getOrderIntentTrace = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as any).user;
      const result = await paperTradingOrderIntentService.getIntentTrace(Number(req.params.id), {
        ...req.query,
        user_id: user.id,
        username: user.username || user.nickname,
      } as any);

      if (!result) {
        return res.status(404).json({ success: false, message: '未找到订单意图链路' });
      }

      res.json({
        success: true,
        data: result,
        message: result.conclusion,
      });
    } catch (error: any) {
      logger.error('获取模拟交易订单意图链路失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  };

  // 刷新订单意图后验快照，降低看板/链路反复扫日线成本
  refreshOrderIntentHindsight = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as any).user;
      const result = await paperTradingOrderIntentService.refreshHindsightSnapshots({
        ...req.body,
        user_id: user.id,
        username: user.username || user.nickname,
      } as any);

      res.json({
        success: true,
        data: result,
        message: result.message,
      });
    } catch (error: any) {
      logger.error('刷新模拟交易订单意图后验快照失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  };

  // 获取推荐信号→模拟交易→收益结果闭环看板
  getRecommendationOutcomes = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as any).user;
      const result = await recommendationTradeOutcomeService.getDashboard({
        portfolio_name: QUANT_ONLY_PORTFOLIO_NAME,
        ...req.query,
        user_id: user.id,
      });

      res.json({
        success: true,
        data: result,
        message: `推荐交易收益闭环：跟踪 ${result.summary.total_count} 笔，已闭环 ${result.summary.closed_count} 笔`,
      });
    } catch (error: any) {
      logger.error('获取推荐交易收益闭环失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  };

  // 获取单笔推荐从信号、量化/Agent、风控、模拟交易到收益的完整链路
  getRecommendationOutcomeTrace = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as any).user;
      const result = await recommendationTradeOutcomeService.getTrace(req.params.id, {
        portfolio_name: QUANT_ONLY_PORTFOLIO_NAME,
        ...req.query,
        user_id: user.id,
      });

      if (!result) {
        return res.status(404).json({ success: false, message: '未找到推荐链路详情' });
      }

      res.json({
        success: true,
        data: result,
        message: result.conclusion,
      });
    } catch (error: any) {
      logger.error('获取推荐链路详情失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  };

  // 刷新推荐信号→模拟交易→收益结果闭环
  refreshRecommendationOutcomes = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as any).user;
      const result = await recommendationTradeOutcomeService.refreshPortfolioOutcomes({
        portfolio_name: QUANT_ONLY_PORTFOLIO_NAME,
        ...req.body,
        user_id: user.id,
      });

      res.json({
        success: true,
        data: result,
        message: `收益闭环刷新完成：刷新 ${result.refreshed} 条，写入 ${result.created_or_updated} 条`,
      });
    } catch (error: any) {
      logger.error('刷新推荐交易收益闭环失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  };

  // 推荐交易收益闭环报告写入飞书
  reportRecommendationOutcomes = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as any).user;
      const result = await recommendationTradeOutcomeService.getDashboard({
        portfolio_name: QUANT_ONLY_PORTFOLIO_NAME,
        ...req.body,
        user_id: user.id,
        report_to_feishu: true,
      });

      res.json({
        success: true,
        data: result,
        message: `收益闭环已上报飞书：闭环 ${result.summary.closed_count} 笔，超额胜率 ${result.summary.excess_win_rate}%`,
      });
    } catch (error: any) {
      logger.error('上报推荐交易收益闭环失败:', error);
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

  // 生成模拟盘盘前/盘后交易计划
  getTradingPlan = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as any).user;
      const result = await paperTradingPlanService.generatePlan({
        ...req.query,
        user_id: user.id,
      });

      res.json({
        success: true,
        data: result,
        message: `交易计划生成完成：动作 ${result.summary.action_count} 条，紧急 ${result.summary.urgent_count} 条`,
      });
    } catch (error: any) {
      logger.error('生成模拟盘交易计划失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  };

  // 生成交易计划并写入飞书多维表格
  reportTradingPlan = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as any).user;
      const result = await paperTradingPlanService.generatePlan({
        ...req.body,
        user_id: user.id,
        report_to_feishu: true,
      });

      res.json({
        success: true,
        data: result,
        message: `交易计划已上报飞书：动作 ${result.summary.action_count} 条，紧急 ${result.summary.urgent_count} 条`,
      });
    } catch (error: any) {
      logger.error('上报模拟盘交易计划失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  };

  // 预览或应用订单意图稳定窗口给出的调参建议
  applyOrderIntentTuning = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = (req as any).user;
      const result = await paperTradingTuningApplyService.applyOrderIntentTuningPreview({
        ...req.body,
        user_id: user.id,
        username: user.username || user.nickname,
        operator: {
          user_id: user.id,
          username: user.username || user.nickname,
        },
      });

      res.json({
        success: true,
        data: result,
        message: result.message,
      });
    } catch (error: any) {
      logger.error('应用订单意图调参建议失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  };
}

export const paperTradingController = new PaperTradingController();
