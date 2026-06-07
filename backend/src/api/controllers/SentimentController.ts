import { Request, Response } from 'express';
import { marketSentimentIndexService } from '../../services/MarketSentimentIndexService';
import { MarketSentimentIndex } from '../../models/MarketSentimentIndex';
import { logger } from '../../utils/logger';

/**
 * SentimentController — US-057 市场情绪量化指数 endpoint。
 *
 * 路由前缀：`/api/sentiment`
 *
 * Endpoints:
 *   - GET  /api/sentiment/index?days=30        最近 N 天指数时序
 *   - GET  /api/sentiment/index/latest          最近一天指数 (含 components)
 *   - POST /api/sentiment/index/compute         手动触发当日 / 指定日计算 (admin)
 */
export class SentimentController {
  /**
   * GET /api/sentiment/index?days=30
   *
   * 返回最近 N 个交易日的市场情绪指数 (倒序),前端 UI 时序图直接绘。
   */
  async getIndexSeries(req: Request, res: Response) {
    try {
      const daysRaw = req.query.days;
      let days = 30;
      if (daysRaw !== undefined) {
        const parsed = Number(daysRaw);
        if (Number.isFinite(parsed) && parsed > 0) {
          days = Math.min(365, Math.floor(parsed));
        }
      }

      const rows = await marketSentimentIndexService.listRecentIndex(days);
      res.json({
        success: true,
        data: {
          count: rows.length,
          days,
          items: rows.map(r => ({
            trade_date: r.trade_date,
            index_value: Number(r.index_value),
            raw_score: r.raw_score === null ? null : Number(r.raw_score),
            limit_up_count: r.limit_up_count,
            limit_down_count: r.limit_down_count,
            northbound_net_buy_zscore:
              r.northbound_net_buy_zscore === null ? null : Number(r.northbound_net_buy_zscore),
            margin_net_buy_zscore:
              r.margin_net_buy_zscore === null ? null : Number(r.margin_net_buy_zscore),
            qa_heat_zscore: r.qa_heat_zscore === null ? null : Number(r.qa_heat_zscore),
            status: r.status,
            message: r.message,
            updated_at: r.updated_at,
          })),
        },
      });
    } catch (error: any) {
      logger.error('获取市场情绪指数列表失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  /**
   * GET /api/sentiment/index/latest
   *
   * 取最近一天的指数 (含 components_json 完整明细),供单股详情页 "市场温度" 副信号。
   */
  async getLatestIndex(_req: Request, res: Response) {
    try {
      const row = await MarketSentimentIndex.findOne({
        order: [['trade_date', 'DESC']],
      });
      if (!row) {
        res.json({ success: true, data: null });
        return;
      }
      res.json({
        success: true,
        data: {
          trade_date: row.trade_date,
          index_value: Number(row.index_value),
          raw_score: row.raw_score === null ? null : Number(row.raw_score),
          limit_up_count: row.limit_up_count,
          limit_down_count: row.limit_down_count,
          northbound_net_buy_zscore:
            row.northbound_net_buy_zscore === null ? null : Number(row.northbound_net_buy_zscore),
          margin_net_buy_zscore:
            row.margin_net_buy_zscore === null ? null : Number(row.margin_net_buy_zscore),
          qa_heat_zscore: row.qa_heat_zscore === null ? null : Number(row.qa_heat_zscore),
          components_json: row.components_json,
          status: row.status,
          message: row.message,
          updated_at: row.updated_at,
        },
      });
    } catch (error: any) {
      logger.error('获取最新市场情绪指数失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  /**
   * POST /api/sentiment/index/compute
   *
   * 手动触发计算并落库。Body 接受可选参数:
   *   - trade_date (YYYY-MM-DD)   默认今日
   *   - lookback_days             默认 60
   *   - sigmoid_scale             默认 30
   *   - dry_run                   默认 false; true 时只算不写
   */
  async compute(req: Request, res: Response) {
    try {
      const body = req.body || {};
      const result = await marketSentimentIndexService.computeAndPersist({
        trade_date: body.trade_date,
        lookback_days: body.lookback_days,
        min_observations: body.min_observations,
        sigmoid_scale: body.sigmoid_scale,
        dry_run: body.dry_run === true,
      });
      res.json({ success: true, data: result });
    } catch (error: any) {
      logger.error('计算市场情绪指数失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }
}

export const sentimentController = new SentimentController();
