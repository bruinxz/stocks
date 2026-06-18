/**
 * NewsAnalyzer — 公告 NLP + 市场新闻 + KOL 聚合.
 *
 * 复用:
 *   - AnnouncementNLPService.listByStock(stock_code, days)
 *   - MarketNews 模型 (recent stock news)
 *   - KOLAggregatorService.aggregateForStock(stock_code) — 已聚合 sentiment_score
 *
 * 把三类来源加权: 公告 50% / news 25% / KOL 25%.
 */

import { BaseAnalyzer, RawAnalyzerResult, weightedMean } from './BaseAnalyzer';
import type { AnalyzerContext, AnalyzerKey, EvidenceItem } from '../AnalyzerTypes';

interface AnnouncementRecord {
  ann_date: string;
  sentiment: '正面' | '负面' | '中性' | null;
  short_title?: string | null;
}

interface NewsRecord {
  publish_time: string | null;
  sentiment_score: number | null;
  title: string;
}

interface KOLOpinionRecord {
  sentiment_score: number | null;
}

export interface NewsAnalyzerDataSource {
  listAnnouncementsByStock(stockCode: string, days: number): Promise<AnnouncementRecord[]>;
  listRecentNewsByStock(stockCode: string, days: number): Promise<NewsRecord[]>;
  aggregateKOLForStock(stockCode: string): Promise<KOLOpinionRecord[]>;
}

export const PRODUCTION_NEWS_ANALYZER_SOURCE: NewsAnalyzerDataSource = {
  async listAnnouncementsByStock(stockCode, days) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { announcementNLPService } = require('../../AnnouncementNLPService');
      const rows = await announcementNLPService.listByStock(stockCode, days, 200);
      return rows.map((r: any) => ({
        ann_date: r.ann_date,
        sentiment: r.sentiment,
        short_title: r.short_title,
      }));
    } catch (_e) {
      return [];
    }
  },
  async listRecentNewsByStock(stockCode, days) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { MarketNews } = require('../../../models/MarketNews');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { Op } = require('sequelize');
      const since = new Date(Date.now() - days * 24 * 3600 * 1000);
      const rows = await MarketNews.findAll({
        where: { stock_code: stockCode, publish_time: { [Op.gte]: since } },
        attributes: ['title', 'publish_time', 'sentiment_score'],
        order: [['publish_time', 'DESC']],
        limit: 100,
        raw: true,
      });
      return rows.map((r: any) => ({
        title: r.title || '',
        publish_time: r.publish_time ? new Date(r.publish_time).toISOString() : null,
        sentiment_score:
          r.sentiment_score === null || r.sentiment_score === undefined
            ? null
            : Number(r.sentiment_score),
      }));
    } catch (_e) {
      return [];
    }
  },
  async aggregateKOLForStock(stockCode) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { kolAggregatorService } = require('../../KOLAggregatorService');
      const res = await kolAggregatorService.aggregateForStock(stockCode, { persist: false });
      return (res?.opinions || []).map((o: any) => ({ sentiment_score: o.sentiment_score }));
    } catch (_e) {
      return [];
    }
  },
};

export class NewsAnalyzer extends BaseAnalyzer {
  readonly key: AnalyzerKey = 'news';

  constructor(private readonly source: NewsAnalyzerDataSource = PRODUCTION_NEWS_ANALYZER_SOURCE) {
    super();
  }

  protected requiredFields: readonly string[] = ['announcements', 'news'];

  protected async run(ctx: AnalyzerContext): Promise<RawAnalyzerResult> {
    const dataMissing: string[] = [];
    const evidence: EvidenceItem[] = [];
    const partials: Array<{ value: number | null; weight: number }> = [];

    // 1) 公告 (最近 30 天)
    const anns = await this.source.listAnnouncementsByStock(ctx.stock.code, 30);
    if (!anns.length) {
      dataMissing.push('announcements');
    } else {
      const pos = anns.filter(a => a.sentiment === '正面').length;
      const neg = anns.filter(a => a.sentiment === '负面').length;
      const net = anns.length > 0 ? (pos - neg) / anns.length : 0;
      const annScore = net * 60; // [-60, 60]
      partials.push({ value: annScore, weight: 0.5 });
      evidence.push({
        label: `公告 ${anns.length} 条 (+${pos} / -${neg})`,
        detail: anns
          .slice(0, 3)
          .map(a => `${a.ann_date}:${a.short_title?.slice(0, 30) || '-'}`)
          .join(' | '),
        metric_value: net,
        direction: annScore > 5 ? 'bullish' : annScore < -5 ? 'bearish' : 'neutral',
        weight: 0.5,
      });
    }

    // 2) 新闻 (最近 7 天)
    const news = await this.source.listRecentNewsByStock(ctx.stock.code, 7);
    if (!news.length) {
      dataMissing.push('news');
    } else {
      const scored = news
        .map(n => n.sentiment_score)
        .filter((s): s is number => s !== null && Number.isFinite(s));
      if (scored.length === 0) {
        dataMissing.push('news_sentiment_score');
      } else {
        const avg = scored.reduce((a, b) => a + b, 0) / scored.length;
        const newsScore = Math.max(-50, Math.min(50, avg * 100));
        partials.push({ value: newsScore, weight: 0.25 });
        evidence.push({
          label: `新闻 ${news.length} 条 (avg sentiment ${avg.toFixed(2)})`,
          detail: news
            .slice(0, 2)
            .map(n => n.title.slice(0, 40))
            .join(' | '),
          metric_value: avg,
          direction: avg > 0.1 ? 'bullish' : avg < -0.1 ? 'bearish' : 'neutral',
          weight: 0.25,
        });
      }
    }

    // 3) KOL
    const kol = await this.source.aggregateKOLForStock(ctx.stock.code);
    if (!kol.length) {
      dataMissing.push('kol');
    } else {
      const scored = kol
        .map(k => k.sentiment_score)
        .filter((s): s is number => s !== null && Number.isFinite(s));
      if (scored.length > 0) {
        const avg = scored.reduce((a, b) => a + b, 0) / scored.length;
        const kolScore = Math.max(-40, Math.min(40, avg * 80));
        partials.push({ value: kolScore, weight: 0.25 });
        evidence.push({
          label: `KOL ${kol.length} 条 (avg sentiment ${avg.toFixed(2)})`,
          metric_value: avg,
          direction: avg > 0.1 ? 'bullish' : avg < -0.1 ? 'bearish' : 'neutral',
          weight: 0.25,
        });
      }
    }

    const score = weightedMean(partials) ?? 0;
    const total = 3;
    const have =
      total -
      (dataMissing.includes('announcements') ? 1 : 0) -
      (dataMissing.includes('news') ? 1 : 0) -
      (dataMissing.includes('kol') ? 1 : 0);
    const confidence = have / total;

    return {
      score,
      evidence,
      data_sources: [
        { name: 'announcements_nlp', as_of: ctx.as_of, is_realtime: false },
        { name: 'market_news', as_of: ctx.as_of, is_realtime: false },
        { name: 'kol_aggregator', as_of: ctx.as_of, is_realtime: false },
      ],
      confidence,
      data_missing: dataMissing,
    };
  }
}

export const newsAnalyzer = new NewsAnalyzer();
