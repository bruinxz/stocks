import { Request, Response } from 'express';
import {
  PortfolioReturnSimulator,
  PortfolioSimulationConfig,
} from '../../portfolio/PortfolioReturnSimulator';
import { logger } from '../../utils/logger';

export class PortfolioController {
  private simulator: PortfolioReturnSimulator;

  constructor() {
    this.simulator = new PortfolioReturnSimulator();

    // 绑定方法以确保正确的this上下文
    this.simulatePortfolio = this.simulatePortfolio.bind(this);
    this.getSimulationHistory = this.getSimulationHistory.bind(this);
    this.getSimulationDetail = this.getSimulationDetail.bind(this);
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
        initialCapital: req.body.initialCapital,
        allocationStrategy: req.body.allocationStrategy,
      });
      const userId = (req as any).user?.id || 1; // 暂时使用默认用户ID
      const {
        name,
        description,
        symbols,
        buyDate,
        days,
        initialCapital = 100000,
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

      if (initialCapital <= 0) {
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
        symbols,
        buyDate: new Date(buyDate),
        days: parseInt(days, 10),
        initialCapital: parseFloat(initialCapital),
        allocationStrategy,
        includeDividends,
        reinvest,
      };

      logger.info('Starting portfolio simulation', {
        userId,
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
              initialCapital: config.initialCapital,
              allocationStrategy: config.allocationStrategy,
            },
            summary: result.summary,
            performanceMetrics: result.performanceMetrics,
            // 简化返回数据，避免响应过大
            dailyReturns: result.dailyReturns.map(r => ({
              date: r.date,
              totalValue: r.totalValue,
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
              finalValue: sr.dailyReturns[sr.dailyReturns.length - 1]?.value || 0,
              totalReturn: sr.dailyReturns[sr.dailyReturns.length - 1]?.cumulativeReturn * 100 || 0,
            })),
          },
        },
      };

      // TODO: 保存模拟结果到数据库（可选）

      res.status(200).json(response);
    } catch (error: any) {
      logger.error('投资组合收益模拟失败:', error);

      // 提供更友好的错误信息
      let errorMessage = '模拟失败';
      if (error.message.includes('股票') && error.message.includes('不存在')) {
        errorMessage = error.message;
      } else if (error.message.includes('没有买入日数据')) {
        errorMessage = '部分股票在买入日期没有数据';
      } else if (error.message.includes('买入价格无效')) {
        errorMessage = '部分股票买入价格无效';
      }

      res.status(400).json({
        success: false,
        message: errorMessage,
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
      const { page = '1', limit = '20' } = req.query;

      // TODO: 从数据库获取历史记录
      // 暂时返回空列表
      res.json({
        success: true,
        data: {
          simulations: [],
          pagination: {
            total: 0,
            page: parseInt(page as string, 10),
            limit: parseInt(limit as string, 10),
            totalPages: 0,
          },
        },
      });
    } catch (error) {
      logger.error('获取模拟历史失败:', error);
      res.status(500).json({
        success: false,
        message: '获取推荐配置失败',
      });
    }
  }

  /**
   * 获取模拟详情
   * GET /api/portfolio/:id
   */
  async getSimulationDetail(req: Request, res: Response) {
    try {
      // const { id } = req.params;

      // TODO: 从数据库获取模拟详情
      // 暂时返回404
      res.status(404).json({
        success: false,
        message: '模拟记录不存在',
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

      // TODO: 验证股票是否存在并获取基本信息
      // 暂时返回简化响应
      const validatedStocks = symbols.map((symbol: string) => ({
        symbol,
        exists: true, // 暂时假设都存在
        name: symbol, // 实际应从数据库获取
        market: symbol.startsWith('sh.') ? 'SH' : symbol.startsWith('sz.') ? 'SZ' : 'Unknown',
      }));

      res.json({
        success: true,
        data: {
          stocks: validatedStocks,
          validCount: validatedStocks.length,
          invalidCount: 0,
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
        initialCapital: 100000,
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
}
