import { Request, Response } from 'express';
import { marketSentimentIndexService } from '../../services/MarketSentimentIndexService';
import { MarketSentimentIndex } from '../../models/MarketSentimentIndex';
import { snowballHotKeywordSyncService } from '../../data/services/SnowballHotKeywordSyncService';
import { eastMoneyQATopicService } from '../../services/EastMoneyQATopicService';
import { industryQAHeatService } from '../../services/qa/IndustryQAHeatService';
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
 *
 *   US-060 东财问答 NLP 主题:
 *     - GET  /api/sentiment/qa-topics?stock_code=000001[&weeks=12]
 *            某只股票最近 N 周的投资者问答 NLP 聚合 (按 week_start × topic 分组).
 *
 *   US-121 QA-004 行业 QA 热度榜:
 *     - GET  /api/sentiment/qa-industry-heat?industry=电池[&lookback_days=7&top=10]
 *            某行业内最近 N 天最活跃的 top N 股票.
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

  /**
   * GET /api/sentiment/qa-topics?stock_code=000001[&weeks=12]
   *
   * 返回某只股票最近 N 周 (默认 26, 上限 104) 的投资者问答 NLP 聚合 (US-060).
   *
   * 每行 = (week_start, topic) 的一条聚合记录, 含:
   *   - topic              主题分类 (财务 / 产品 / 订单 / 人事 / 政策 / 其它)
   *   - mention_count      该周该 topic 的问题数
   *   - sentiment_score    该周该 topic 的平均情绪分 ∈ [-1, +1]
   *   - nlp_engine         NLP 引擎标签 (heuristic_fallback / trading_agents)
   *
   * 客户端可按 (week_start, topic) 自由分组绘热力图或趋势线.
   */
  async getQATopics(req: Request, res: Response) {
    try {
      const stockCodeRaw =
        typeof req.query.stock_code === 'string' ? req.query.stock_code.trim() : '';
      if (!stockCodeRaw) {
        res.status(400).json({ success: false, message: 'stock_code 参数必填' });
        return;
      }
      // 去掉 sh. / sz. / bj. 前缀, 6 位纯代码
      const pure = stockCodeRaw.replace(/^(sh|sz|bj)\./i, '').trim();
      if (!/^\d{6}$/.test(pure)) {
        res.status(400).json({ success: false, message: 'stock_code 必须是 6 位数字' });
        return;
      }

      let weeks = 26;
      if (req.query.weeks !== undefined) {
        const parsed = Number(req.query.weeks);
        if (Number.isFinite(parsed) && parsed > 0) {
          weeks = Math.min(104, Math.floor(parsed));
        }
      }

      const rows = await eastMoneyQATopicService.listByStock(pure, weeks);

      res.json({
        success: true,
        data: {
          stock_code: pure,
          weeks,
          count: rows.length,
          items: rows.map(r => ({
            id: r.id,
            stock_code: r.stock_code,
            stock_name: r.stock_name,
            week_start: r.week_start,
            topic: r.topic,
            mention_count: r.mention_count,
            sentiment_score: r.sentiment_score === null ? null : Number(r.sentiment_score),
            nlp_engine: r.nlp_engine,
            raw_payload: r.raw_payload,
            updated_at: r.updated_at,
          })),
        },
      });
    } catch (error: any) {
      logger.error('获取问答 NLP 主题失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  /**
   * GET /api/sentiment/qa-industry-heat?industry=电池[&lookback_days=7&top=10]
   *
   * US-121 QA-004 行业级 QA 热度榜.
   *
   * 返回某行业内最近 N 天最活跃的 top N 股票 (按 active_score = questions_count *
   * (1 + 0.5 * answer_rate) desc 排序). 默认 lookback=7d, top=10.
   *
   * Response:
   *   {
   *     industry, lookback_days, top_n, total_stocks,
   *     items: [{
   *       stock_code, stock_name, industry,
   *       questions_count_7d, answer_count_7d, answer_rate_7d,
   *       top_subtopic_7d, active_score, weeks_covered
   *     }]
   *   }
   *
   * fail-OPEN: 行业为空 / DB 故障 / 行业内无任何 stat → 返 items=[] (200 OK),
   * service 层错误以 error 字段透出 (前端按需展示降级提示).
   */
  async getIndustryQAHeat(req: Request, res: Response) {
    try {
      const industryRaw = typeof req.query.industry === 'string' ? req.query.industry.trim() : '';
      if (industryRaw === '') {
        res.status(400).json({ success: false, message: 'industry 参数必填' });
        return;
      }

      let lookbackDays: number | undefined = undefined;
      if (req.query.lookback_days !== undefined) {
        const parsed = Number(req.query.lookback_days);
        if (Number.isFinite(parsed) && parsed > 0) {
          lookbackDays = Math.floor(parsed);
        }
      }

      let top: number | undefined = undefined;
      if (req.query.top !== undefined) {
        const parsed = Number(req.query.top);
        if (Number.isFinite(parsed) && parsed > 0) {
          top = Math.floor(parsed);
        }
      }

      const result = await industryQAHeatService.getHotStocksInIndustry(industryRaw, {
        lookback_days: lookbackDays,
        top,
      });

      res.json({
        success: true,
        data: result,
      });
    } catch (error: any) {
      logger.error('获取行业 QA 热度榜失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }
}

export const sentimentController = new SentimentController();
