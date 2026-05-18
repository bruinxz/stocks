import { Op } from 'sequelize';
import { Request, Response, NextFunction } from 'express';
import { DailyScreener } from '../../models/DailyScreener';
import { DailyBar } from '../../models/DailyBar';
import { Stock } from '../../models/Stock';
import { logger } from '../../utils/logger';
import { aiInvestmentSignalService } from '../../services/AIInvestmentSignalService';

export class ScreenerController {
  async getDailyScreener(req: Request, res: Response, next: NextFunction) {
    try {
      const { date, include_detail } = req.query;

      let whereClause = {};
      let limit: number | undefined = undefined;

      if (date) {
        whereClause = { date: date as string };
      } else {
        // 如果没有传日期，不再只取最新的一天，而是取全部日期的记录（前端如果需要过滤可以自己传 date 或者分页）
        // 这样用户就能看到按时间倒序排列的完整历史推演记录
        whereClause = {};
        // 限制返回的最大条数，防止数据量过大导致接口缓慢
        limit = 50;
      }

      // 列表默认不返回 detail 大字段（占超过 90% 的体积），显著提升响应速度
      // 如果前端需要（如用户点详情），可以传 ?include_detail=1
      const includeDetail = include_detail === '1' || include_detail === 'true';
      const attributes: any = includeDetail
        ? undefined
        : {
            exclude: ['detail'],
          };

      const screeners = await DailyScreener.findAll({
        where: whereClause,
        order: [
          ['created_at', 'DESC'],
          ['score', 'DESC'],
        ],
        limit: limit,
        attributes,
        raw: true,
      });

      // 优化：不再使用 N+1 查询，而是批量查询 Stock 和 DailyBar
      const symbols = screeners.map(s => s.symbol);
      const stocks = await Stock.findAll({
        where: { symbol: { [Op.in]: symbols } },
        attributes: ['id', 'symbol'],
        raw: true,
      });

      const stockIdToSymbol = new Map(stocks.map(s => [s.id, s.symbol]));
      const symbolToStockId = new Map(stocks.map(s => [s.symbol, s.id]));
      
      const stockIds = stocks.map(s => s.id);

      // MySQL/PostgreSQL 中按分组取最近 30 条比较复杂，由于这里只返回用户收藏的几只股票
      // 我们可以在内存中处理，或者对于每个 stockId 并发发起查询，这样比在 map 里逐个 await 性能更好
      
      const enrichedScreeners = await Promise.all(
        screeners.map(async (screener: any) => {
          try {
            const stockId = symbolToStockId.get(screener.symbol);
            if (stockId) {
              const bars = await DailyBar.findAll({
                where: { stock_id: stockId },
                order: [['time', 'DESC']],
                limit: 30,
                attributes: ['time', 'close'],
                raw: true,
              });
              
              bars.reverse();
              screener.recentTrend = bars;
            } else {
              screener.recentTrend = [];
            }
          } catch (e) {
            logger.error(`Failed to fetch trend for ${screener.symbol}`, e);
            screener.recentTrend = [];
          }
          return screener;
        })
      );

      // 轻量同步：列表接口不强制验证收益，避免拖慢页面；前端可调用 /api/ai/signals/sync-screeners 触发完整同步。
      if (req.query.sync_signals === 'true') {
        aiInvestmentSignalService.syncFromDailyScreeners().catch(error => {
          logger.warn(`后台同步 AI 信号失败: ${error.message}`);
        });
      }

      res.json({
        success: true,
        data: enrichedScreeners,
      });
    } catch (error: any) {
      logger.error('获取 AI 每日优选失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  /**
   * 查询单条 AI 优选详情（包含 detail 大字段）
   */
  async getDailyScreenerDetail(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const record = await DailyScreener.findByPk(id);
      if (!record) {
        return res.status(404).json({ success: false, message: '记录不存在' });
      }
      res.json({ success: true, data: record });
    } catch (error: any) {
      logger.error('获取 AI 优选详情失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }
}

export const screenerController = new ScreenerController();
