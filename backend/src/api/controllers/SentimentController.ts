import { Request, Response } from 'express';
import { marketSentimentIndexService } from '../../services/MarketSentimentIndexService';
import { MarketSentimentIndex } from '../../models/MarketSentimentIndex';
import { snowballHotKeywordSyncService } from '../../data/services/SnowballHotKeywordSyncService';
import { logger } from '../../utils/logger';

/**
 * SentimentController — 市场情绪相关 endpoint.
 *
 * 路由前缀：`/api/sentiment`
 *
 * Endpoints:
 *   US-057 市场情绪量化指数:
 *     - GET  /api/sentiment/index?days=30        最近 N 天指数时序
 *     - GET  /api/sentiment/index/latest          最近一天指数 (含 components)
 *     - POST /api/sentiment/index/compute         手动触发当日 / 指定日计算 (admin)
 *
 *   US-058 雪球热词:
 *     - GET  /api/sentiment/snowball-keywords?date=YYYY-MM-DD[&only_new=true&limit=N]
 *            某日雪球热词榜 (默认取最近一日有数据; only_new=true 只看相对前一日新进)
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

  /**
   * GET /api/sentiment/snowball-keywords?date=YYYY-MM-DD[&only_new=true&limit=N]
   *
   * 返回某交易日的雪球热词榜。date 缺省时取最近一日有数据。
   * only_new=true 时只返回相对上一日 baseline 的新进关键词。
   *
   * Response:
   *   {
   *     trade_date: 'YYYY-MM-DD',
   *     count: N,
   *     only_new: boolean,
   *     items: [{
   *       keyword, heat_score, rank, related_stocks_json, source, is_new, updated_at
   *     }]
   *   }
   */
  async getSnowballKeywords(req: Request, res: Response) {
    try {
      const dateRaw = typeof req.query.date === 'string' ? req.query.date.trim() : '';
      const onlyNewRaw = req.query.only_new;
      const onlyNew = onlyNewRaw === 'true' || onlyNewRaw === '1';
      const limitRaw = req.query.limit;
      let limit = 200;
      if (limitRaw !== undefined) {
        const parsed = Number(limitRaw);
        if (Number.isFinite(parsed) && parsed > 0) {
          limit = Math.min(1000, Math.floor(parsed));
        }
      }
      // 校验 date 格式 (YYYY-MM-DD)
      let date: string | undefined = undefined;
      if (dateRaw && /^\d{4}-\d{2}-\d{2}$/.test(dateRaw)) {
        date = dateRaw;
      }

      const rows = await snowballHotKeywordSyncService.listByDate(date, onlyNew, limit);

      res.json({
        success: true,
        data: {
          trade_date: rows.length > 0 ? rows[0].trade_date : date ?? null,
          count: rows.length,
          only_new: onlyNew,
          limit,
          items: rows.map(r => ({
            keyword: r.keyword,
            heat_score: r.heat_score,
            rank: r.rank,
            related_stocks_json: r.related_stocks_json,
            source: r.source,
            is_new: r.is_new,
            updated_at: r.updated_at,
          })),
        },
      });
    } catch (error: any) {
      logger.error('获取雪球热词榜失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }
}

export const sentimentController = new SentimentController();
