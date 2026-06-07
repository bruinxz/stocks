import { Request, Response } from 'express';
import {
  announcementNLPService,
  SENTIMENT_VALUES,
  SentimentValue,
} from '../../services/AnnouncementNLPService';
import { logger } from '../../utils/logger';

/**
 * AnnouncementController — 公司公告 NLP 抽取相关 endpoint (US-059).
 *
 * 路由前缀：`/api/announcements`
 *
 * Endpoints:
 *   - GET /api/announcements?stock_code=000001&days=30
 *     某只股票最近 N 天的公告 NLP 抽取列表 (含 summary / sentiment / key_amounts / key_topics).
 *   - GET /api/announcements/by-date?date=YYYY-MM-DD&sentiment=正面&limit=200
 *     某交易日全市场公告 (UI: 公告流 / 全市场扫描).
 *   - POST /api/announcements/sync (admin)
 *     手动触发某日 sync (body: {date?, symbol?, extract_with_ai?, dry_run?}).
 *
 * **list + 详情分工** (US-057 范式同款): listByStock 返回轻量列表; 单条 raw_payload 留在 model
 * 但 controller serialize 时按需展开.
 */
export class AnnouncementController {
  /**
   * GET /api/announcements?stock_code=000001&days=30
   *
   * 返回某只股票最近 N 天 (默认 30, 上限 365) 的公告 NLP 抽取列表.
   *
   * Response:
   *   {
   *     stock_code, days, count,
   *     items: [{ announce_date, original_title, summary, sentiment, key_amounts_json,
   *               key_topics_json, announcement_type, url, status, nlp_engine, updated_at }]
   *   }
   */
  async listByStock(req: Request, res: Response) {
    try {
      const stockCodeRaw =
        typeof req.query.stock_code === 'string' ? req.query.stock_code.trim() : '';
      if (!stockCodeRaw) {
        res.status(400).json({ success: false, message: 'stock_code 参数必填' });
        return;
      }
      // 6 位纯代码; 去掉 sh. / sz. / 前缀
      const pure = stockCodeRaw.replace(/^(sh|sz|bj)\./i, '').trim();
      if (!/^\d{6}$/.test(pure)) {
        res.status(400).json({ success: false, message: 'stock_code 必须是 6 位数字' });
        return;
      }

      let days = 30;
      if (req.query.days !== undefined) {
        const parsed = Number(req.query.days);
        if (Number.isFinite(parsed) && parsed > 0) {
          days = Math.min(365, Math.floor(parsed));
        }
      }

      let limit = 200;
      if (req.query.limit !== undefined) {
        const parsed = Number(req.query.limit);
        if (Number.isFinite(parsed) && parsed > 0) {
          limit = Math.min(1000, Math.floor(parsed));
        }
      }

      const rows = await announcementNLPService.listByStock(pure, days, limit);

      res.json({
        success: true,
        data: {
          stock_code: pure,
          days,
          count: rows.length,
          items: rows.map(r => ({
            id: r.id,
            announce_date: r.announce_date,
            stock_code: r.stock_code,
            stock_name: r.stock_name,
            original_title: r.original_title,
            announcement_type: r.announcement_type,
            url: r.url,
            summary: r.summary,
            sentiment: r.sentiment,
            key_amounts_json: r.key_amounts_json,
            key_topics_json: r.key_topics_json,
            status: r.status,
            nlp_engine: r.nlp_engine,
            error: r.error,
            updated_at: r.updated_at,
          })),
        },
      });
    } catch (error: any) {
      logger.error('获取公告列表失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  /**
   * GET /api/announcements/by-date?date=YYYY-MM-DD[&sentiment=正面|中性|负面][&limit=200]
   *
   * 返回某交易日全市场公告列表 (按 stock_code asc).
   */
  async listByDate(req: Request, res: Response) {
    try {
      const dateRaw = typeof req.query.date === 'string' ? req.query.date.trim() : '';
      if (!dateRaw || !/^\d{4}-\d{2}-\d{2}$/.test(dateRaw)) {
        res.status(400).json({ success: false, message: 'date 参数必填且格式 YYYY-MM-DD' });
        return;
      }

      const sentimentRaw =
        typeof req.query.sentiment === 'string' ? req.query.sentiment.trim() : '';
      const sentiment: SentimentValue | undefined =
        sentimentRaw && (SENTIMENT_VALUES as readonly string[]).includes(sentimentRaw)
          ? (sentimentRaw as SentimentValue)
          : undefined;

      let limit = 200;
      if (req.query.limit !== undefined) {
        const parsed = Number(req.query.limit);
        if (Number.isFinite(parsed) && parsed > 0) {
          limit = Math.min(1000, Math.floor(parsed));
        }
      }

      const rows = await announcementNLPService.listByDate(dateRaw, sentiment, limit);

      res.json({
        success: true,
        data: {
          date: dateRaw,
          sentiment: sentiment || null,
          count: rows.length,
          items: rows.map(r => ({
            id: r.id,
            announce_date: r.announce_date,
            stock_code: r.stock_code,
            stock_name: r.stock_name,
            original_title: r.original_title,
            announcement_type: r.announcement_type,
            url: r.url,
            summary: r.summary,
            sentiment: r.sentiment,
            key_amounts_json: r.key_amounts_json,
            key_topics_json: r.key_topics_json,
            status: r.status,
            nlp_engine: r.nlp_engine,
            updated_at: r.updated_at,
          })),
        },
      });
    } catch (error: any) {
      logger.error('获取按日公告列表失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  /**
   * POST /api/announcements/sync
   *
   * 手动触发某日 sync (body: {date?, symbol?, extract_with_ai?, dry_run?}).
   * - date 默认今日 (UTC);
   * - symbol 默认 '全部';
   * - extract_with_ai 默认 false (走启发式);
   * - dry_run 默认 false.
   */
  async triggerSync(req: Request, res: Response) {
    try {
      const body = req.body || {};
      const date =
        typeof body.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.date)
          ? body.date
          : new Date().toISOString().slice(0, 10);
      const result = await announcementNLPService.syncDate(date, {
        symbol: body.symbol,
        extract_with_ai: body.extract_with_ai === true,
        dry_run: body.dry_run === true,
      });
      res.json({ success: true, data: result });
    } catch (error: any) {
      logger.error('手动触发公告同步失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }
}

export const announcementController = new AnnouncementController();
