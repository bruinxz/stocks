import { Request, Response } from 'express';
import {
  PortfolioReturnSimulator,
  PortfolioSimulationConfig,
} from '../../portfolio/PortfolioReturnSimulator';
import { logger } from '../../utils/logger';
import { PortfolioSimulation } from '../../models/PortfolioSimulation';
import { Stock } from '../../models/Stock';
import { Op } from 'sequelize';
import { normalizeSymbol } from '../../utils/stockSymbol';
import { industryConcentrationGuard } from '../../portfolio/risk/IndustryConcentrationGuard';
import { portfolioCorrelationService } from '../../services/PortfolioCorrelationService';
import { exposureCoachService } from '../../services/ExposureCoachService';
import { PaperTradingPortfolio } from '../../models/PaperTradingPortfolio';

export class PortfolioController {
  private simulator: PortfolioReturnSimulator;

  constructor() {
    this.simulator = new PortfolioReturnSimulator();

    // 绑定方法以确保正确的this上下文
    this.simulatePortfolio = this.simulatePortfolio.bind(this);
    this.getSimulationHistory = this.getSimulationHistory.bind(this);
    this.getSimulationDetail = this.getSimulationDetail.bind(this);
    this.rebalanceIndustry = this.rebalanceIndustry.bind(this);
  }

  /**
   * 运行投资组合收益模拟
   * POST /api/portfolio/simulate
   */
  async simulatePortfolio(req: Request, res: Response) {
    try {
      logger.info('收到投资组合模拟请求 - 完整body:', JSON.stringify(req.body));
      logger.info('收到投资组合模拟请求详情:', {
        body: req.body,
        symbols: req.body.symbols,
        buyDate: req.body.buyDate,
        days: req.body.days,
        initial_capital: req.body.initial_capital,
        allocationStrategy: req.body.allocationStrategy,
      });
      const user_id = (req as any).user?.id || 1; // 暂时使用默认用户ID
      const {
        name,
        description,
        symbols,
        buyDate,
        days,
        initial_capital = 100000,
        allocationStrategy = 'equal',
        includeDividends = false,
        reinvest = false,
      } = req.body;

      // 参数验证
      if (!symbols || !Array.isArray(symbols) || symbols.length === 0) {
        return res.status(400).json({
          success: false,
          message: '请指定至少一只股票',
        });
      }

      if (!buyDate) {
        return res.status(400).json({
          success: false,
          message: '买入日期不能为空',
        });
      }

      if (!days || days <= 0) {
        return res.status(400).json({
          success: false,
          message: '持有天数必须大于0',
        });
      }

      if (initial_capital <= 0) {
        return res.status(400).json({
          success: false,
          message: '初始资金必须大于0',
        });
      }

      // 检查股票数量限制
      if (symbols.length > 10) {
        return res.status(400).json({
          success: false,
          message: '最多支持10只股票',
        });
      }

      // 准备配置
      const config: PortfolioSimulationConfig = {
        symbols: symbols.map((symbol: string) => normalizeSymbol(symbol)),
        buyDate: new Date(buyDate),
        days: parseInt(days, 10),
        initial_capital: parseFloat(initial_capital),
        allocationStrategy,
        includeDividends,
        reinvest,
      };

      logger.info('Starting portfolio simulation', {
        user_id,
        symbols: config.symbols,
        buyDate: config.buyDate,
        days: config.days,
      });

      // 运行模拟
      const result = await this.simulator.simulate(config);

      // 构建响应
      const response = {
        success: true,
        message: '投资组合收益模拟完成',
        data: {
          simulation: {
            config: {
              symbols: config.symbols,
              buyDate: config.buyDate,
              days: config.days,
              initial_capital: config.initial_capital,
              allocationStrategy: config.allocationStrategy,
            },
            summary: result.summary,
            performanceMetrics: result.performanceMetrics,
            // 简化返回数据，避免响应过大
            daily_returns: result.daily_returns.map(r => ({
              date: r.date,
              total_value: r.total_value,
              dailyReturn: r.dailyReturn * 100, // 转换为百分比
              cumulativeReturn: r.cumulativeReturn * 100, // 转换为百分比
            })),
            stockReturns: result.stockReturns.map(sr => ({
              symbol: sr.symbol,
              name: sr.name,
              buyPrice: sr.buyPrice,
              allocationAmount: sr.allocationAmount,
              shares: sr.shares,
              // 只返回最后一天的收益
              finalValue: sr.daily_returns[sr.daily_returns.length - 1]?.value || 0,
              total_return:
                sr.daily_returns[sr.daily_returns.length - 1]?.cumulativeReturn * 100 || 0,
            })),
          },
        },
      };

      const simulationName =
        name ||
        `${config.symbols.length}股组合 ${new Date().toLocaleDateString('zh-CN', {
          timeZone: 'Asia/Shanghai',
        })}`;

      await PortfolioSimulation.create({
        user_id,
        name: simulationName,
        description,
        symbols: config.symbols,
        buy_date: config.buyDate,
        days: config.days,
        initial_capital: config.initial_capital,
        allocation_strategy: config.allocationStrategy,
        final_capital: result.summary.final_capital,
        total_return: result.summary.total_return,
        annualized_return: result.summary.annualized_return,
        config: response.data.simulation.config,
        summary: response.data.simulation.summary,
        performance_metrics: response.data.simulation.performanceMetrics,
        daily_returns: response.data.simulation.daily_returns,
        stock_returns: response.data.simulation.stockReturns,
      });

      res.status(200).json(response);
    } catch (error: any) {
      logger.error('投资组合收益模拟失败:', error);

      // 提供更友好的错误信息
      let error_message = '模拟失败';
      if (error.message.includes('股票') && error.message.includes('不存在')) {
        error_message = error.message;
      } else if (error.message.includes('没有买入日数据')) {
        error_message = '部分股票在买入日期没有数据';
      } else if (error.message.includes('买入价格无效')) {
        error_message = '部分股票买入价格无效';
      }

      res.status(400).json({
        success: false,
        message: error_message,
        error: process.env.NODE_ENV === 'development' ? error.message : undefined,
      });
    }
  }

  /**
   * 获取模拟历史记录
   * GET /api/portfolio/history
   */
  async getSimulationHistory(req: Request, res: Response) {
    try {
      const user_id = (req as any).user?.id || 1;
      const { page = '1', limit = '20', start_date, end_date } = req.query;
      const pageNum = parseInt(page as string, 10);
      const limitNum = parseInt(limit as string, 10);
      const offset = (pageNum - 1) * limitNum;

      const where: any = { user_id };
      if (start_date || end_date) {
        where.created_at = {};
        if (start_date) {
          where.created_at[Op.gte] = new Date(start_date as string);
        }
        if (end_date) {
          const endDate = new Date(end_date as string);
          endDate.setHours(23, 59, 59, 999);
          where.created_at[Op.lte] = endDate;
        }
      }

      const { rows, count } = await PortfolioSimulation.findAndCountAll({
        where,
        order: [['created_at', 'DESC']],
        limit: limitNum,
        offset,
      });

      res.json({
        success: true,
        data: {
          simulations: rows,
          pagination: {
            total: count,
            page: pageNum,
            limit: limitNum,
            totalPages: Math.ceil(count / limitNum),
          },
        },
      });
    } catch (error) {
      logger.error('获取模拟历史失败:', error);
      res.status(500).json({
        success: false,
        message: '获取模拟历史失败',
      });
    }
  }

  /**
   * 获取模拟详情
   * GET /api/portfolio/:id
   */
  async getSimulationDetail(req: Request, res: Response) {
    try {
      const user_id = (req as any).user?.id || 1;
      const { id } = req.params;

      const simulation = await PortfolioSimulation.findOne({
        where: { id, user_id },
      });

      if (!simulation) {
        return res.status(404).json({
          success: false,
          message: '模拟记录不存在',
        });
      }

      res.json({
        success: true,
        data: {
          simulation,
        },
      });
    } catch (error) {
      logger.error('获取模拟详情失败:', error);
      res.status(500).json({
        success: false,
        message: '获取模拟详情失败',
      });
    }
  }

  /**
   * 批量验证股票
   * POST /api/portfolio/validate-stocks
   */
  async validateStocks(req: Request, res: Response) {
    try {
      const { symbols } = req.body;

      if (!symbols || !Array.isArray(symbols) || symbols.length === 0) {
        return res.status(400).json({
          success: false,
          message: '请指定要验证的股票列表',
        });
      }

      const normalizedSymbols = symbols.map((symbol: string) => normalizeSymbol(symbol));
      const existingStocks = await Stock.findAll({
        where: {
          symbol: {
            [Op.in]: normalizedSymbols,
          },
        },
        attributes: ['symbol', 'name', 'market'],
      });

      const stockMap = new Map(existingStocks.map(stock => [stock.symbol, stock]));
      const validatedStocks = normalizedSymbols.map(symbol => {
        const stock = stockMap.get(symbol);
        return {
          symbol,
          exists: !!stock,
          name: stock?.name || symbol,
          market:
            stock?.market ||
            (symbol.startsWith('sh.') ? 'SH' : symbol.startsWith('sz.') ? 'SZ' : 'BJ'),
        };
      });

      res.json({
        success: true,
        data: {
          stocks: validatedStocks,
          validCount: validatedStocks.filter(stock => stock.exists).length,
          invalidCount: validatedStocks.filter(stock => !stock.exists).length,
        },
      });
    } catch (error) {
      logger.error('验证股票失败:', error);
      res.status(500).json({
        success: false,
        message: '验证股票失败',
      });
    }
  }

  /**
   * 获取推荐配置
   * GET /api/portfolio/recommended-config
   */
  async getRecommendedConfig(req: Request, res: Response) {
    try {
      // 返回推荐的默认配置
      const recommendedConfig = {
        symbols: ['sh.600000', 'sz.000001', 'sh.600036'],
        buyDate: new Date(new Date().setDate(new Date().getDate() - 30))
          .toISOString()
          .split('T')[0],
        days: 30,
        initial_capital: 100000,
        allocationStrategy: 'equal',
        maxStocks: 10,
        minDays: 1,
        maxDays: 365 * 5, // 5年
        minCapital: 1000,
        maxCapital: 10000000,
      };

      res.json({
        success: true,
        data: {
          recommendedConfig,
          popularCombinations: [
            {
              name: '银行股组合',
              symbols: ['sh.600000', 'sh.601398', 'sz.000001'],
              description: '稳健的银行股投资组合',
            },
            {
              name: '消费龙头',
              symbols: ['sh.600519', 'sz.000858', 'sz.002415'],
              description: '消费行业龙头企业',
            },
            {
              name: '科技成长',
              symbols: ['sz.300750', 'sz.000063', 'sz.002415'],
              description: '科技成长型股票',
            },
          ],
        },
      });
    } catch (error) {
      logger.error('获取推荐配置失败:', error);
      res.status(500).json({
        success: false,
        message: '获取推荐配置失败',
      });
    }
  }

  /**
   * 行业再平衡一键操作 (US-052)
   * POST /api/portfolio/rebalance-industry
   *
   * 找到当前最严重的超 alert_pct 阈值（默认 35%）的行业，按行业内涨幅
   * DESC 排序自动卖出 1-2 只，直到行业占比 < rebalance_target_pct（默认
   * 30%）或挑光 max_sell_count。
   *
   * Body 字段：
   *   - portfolio_id?: number  — 兼容字段，目前一个 user 一个 portfolio，
   *     guard 通过 user_id 自动定位；传与不传都行（兼容 AC 描述）。
   *   - dry_run?: boolean      — true = 仅返回 plan 不下单（默认 false）；
   *
   * 走 IndustryConcentrationGuard.rebalanceIndustry — 内部调
   * paperTradingFacade.closePosition，保持 facade 7-method 收敛 + 不绕开
   * DrawdownCircuitBreaker 等 pre-trade guard。
   */
  async rebalanceIndustry(req: Request, res: Response) {
    try {
      const user_id = (req as any).user?.id;
      if (!user_id) {
        return res.status(401).json({ success: false, message: '未登录' });
      }
      const dryRun = req.body?.dry_run === true;
      const result = await industryConcentrationGuard.rebalanceIndustry({
        user_id,
        dry_run: dryRun,
      });
      res.json({
        success: true,
        data: result,
        message: result.message,
      });
    } catch (error: any) {
      logger.error('行业再平衡失败:', error);
      const statusCode = Number.isFinite(error?.statusCode) ? Number(error.statusCode) : 500;
      res.status(statusCode).json({
        success: false,
        message: error?.message || '行业再平衡失败',
      });
    }
  }

  /**
   * GET /api/portfolio/correlation
   * Phase 6: 持仓 N×N 相关性热力图 + 高相关 cluster 警告
   *
   * Query: ?portfolio_id=N&lookback_days=60&cluster_threshold=0.7
   * 如果不传 portfolio_id, 自动用 user 的第一个 portfolio。
   */
  async getCorrelation(req: Request, res: Response) {
    try {
      const user_id = (req as any).user?.id;
      if (!user_id) {
        return res.status(401).json({ success: false, message: '未登录' });
      }
      let portfolioId = req.query.portfolio_id
        ? parseInt(String(req.query.portfolio_id), 10)
        : undefined;
      // 不传则查 user 的第一个 portfolio
      if (!Number.isFinite(portfolioId)) {
        const first = await PaperTradingPortfolio.findOne({
          where: { user_id },
          attributes: ['id'],
          order: [['id', 'ASC']],
        });
        if (!first) {
          return res.status(404).json({ success: false, message: '无 portfolio' });
        }
        portfolioId = first.id;
      }
      const lookbackDays = req.query.lookback_days
        ? parseInt(String(req.query.lookback_days), 10)
        : 60;
      const clusterThreshold = req.query.cluster_threshold
        ? Number(req.query.cluster_threshold)
        : 0.7;

      const report = await portfolioCorrelationService.getReport(portfolioId as number, {
        lookback_days: lookbackDays,
        cluster_threshold: clusterThreshold,
      });
      if (!report) {
        return res.status(404).json({ success: false, message: 'portfolio 不存在' });
      }
      // 权限检查: report 的 user_id 必须等于请求 user
      if (report.user_id !== user_id) {
        return res.status(403).json({ success: false, message: '无权访问' });
      }
      res.json({ success: true, data: report });
    } catch (error: any) {
      logger.error('获取持仓相关性失败:', error);
      res.status(500).json({
        success: false,
        message: error?.message || '获取持仓相关性失败',
      });
    }
  }

  /**
   * GET /api/portfolio/exposure
   * Phase 8: 4 维 exposure (gross / net / leverage / β) + warnings
   *
   * Query: ?portfolio_id=N (不传则用 user 第一个 portfolio)
   */
  async getExposure(req: Request, res: Response) {
    try {
      const user_id = (req as any).user?.id;
      if (!user_id) {
        return res.status(401).json({ success: false, message: '未登录' });
      }
      let portfolioId = req.query.portfolio_id
        ? parseInt(String(req.query.portfolio_id), 10)
        : undefined;
      if (!Number.isFinite(portfolioId)) {
        const first = await PaperTradingPortfolio.findOne({
          where: { user_id },
          attributes: ['id'],
          order: [['id', 'ASC']],
        });
        if (!first) {
          return res.status(404).json({ success: false, message: '无 portfolio' });
        }
        portfolioId = first.id;
      }
      const report = await exposureCoachService.getReport(portfolioId as number);
      if (!report) {
        return res.status(404).json({ success: false, message: 'portfolio 不存在' });
      }
      if (report.user_id !== user_id) {
        return res.status(403).json({ success: false, message: '无权访问' });
      }
      res.json({ success: true, data: report });
    } catch (error: any) {
      logger.error('获取 exposure 失败:', error);
      res.status(500).json({
        success: false,
        message: error?.message || '获取 exposure 失败',
      });
    }
  }

  /**
   * GET /api/portfolio/behavior-bias
   * Phase 8: 4 种行为偏差诊断 (追涨/过度交易/套牢/落袋为安过早) + health_score
   *
   * Query: ?lookback_days=90
   */
  async getBehaviorBias(req: Request, res: Response) {
    try {
      const user_id = (req as any).user?.id;
      if (!user_id) {
        return res.status(401).json({ success: false, message: '未登录' });
      }
      const lookbackDays = req.query.lookback_days
        ? Math.max(7, Math.min(365, parseInt(String(req.query.lookback_days), 10)))
        : 90;
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { behaviorBiasDetector } = require('../../services/BehaviorBiasDetector');
      const report = await behaviorBiasDetector.getReport(user_id, lookbackDays);
      res.json({ success: true, data: report });
    } catch (error: any) {
      logger.error('获取 behavior bias 失败:', error);
      res.status(500).json({
        success: false,
        message: error?.message || '获取 behavior bias 失败',
      });
    }
  }
}
