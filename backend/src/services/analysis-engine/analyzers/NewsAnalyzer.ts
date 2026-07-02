/**
 * NewsAnalyzer — 公告 NLP + 市场新闻 + KOL 聚合.
 *
 * 复用:
 *   - AnnouncementNLPService.listByStock(stock_code, days)
 *   - MarketNews 模型 (recent stock news)
 *   - KOLAggregatorService.aggregateForStock(stock_code) — 已聚合 sentiment_score
 *
 * 把三类来源加权: 公告 50% / news 25% / KOL 25%.
 *
 * US-036 [KOL-004] — KOL 段已切到 KOLAggregator 真聚合产物 (research_report /
 * east_money_news / xq_hot_concept / etf_flow / policy_doc 五类):
 *   - KOL avg 用 authorityWeightedSentiment 加权 (券商研报 / 政策权重高于热搜 / 新闻);
 *   - evidence top 3 显式带 kol_name + source tag, 让前端 "他人在看" 直接复用;
 *   - stock_code 自动 strip 交易所前缀 (sz./sh./bj.) — KOLAggregator 严格要求 6 位.
 */

import { BaseAnalyzer, RawAnalyzerResult, weightedMean } from './BaseAnalyzer';
import type { AnalyzerContext, AnalyzerKey, EvidenceItem } from '../AnalyzerTypes';
// 批5: KOL 情绪源已下线 — 原从 KOLAggregatorService 导入的类型/权重内联到本文件,
// 让 NewsAnalyzer 的 KOL 相关导出类型/helper 仍可独立编译 (analyze 已不再消费 KOL).
export type KOLSource =
  | 'research_report'
  | 'east_money_news'
  | 'xq_hot_concept'
  | 'etf_flow'
  | 'policy_doc';

export interface KOLOpinionRecord {
  stock_code: string;
  kol_name: string;
  opinion_date: string;
  kol_source: KOLSource;
  opinion_summary: string;
  sentiment_score: number | null;
  url: string | null;
  raw_payload: Record<string, unknown>;
}

const SOURCE_AUTHORITY: Readonly<Record<string, number>> = Object.freeze({
  research_report: 0.6,
  east_money_news: 0.3,
  xq_hot_concept: 0.4,
  kol: 0.4,
  etf_flow: 0.5,
  policy_doc: 0.8,
});
const SOURCE_AUTHORITY_DEFAULT = 0.3;

export function authorityWeightedSentiment(rec: KOLOpinionRecord): number {
  const s = rec.sentiment_score;
  const absS = s !== null && Number.isFinite(s) ? Math.abs(s as number) : 0;
  const auth =
    (rec.kol_source && SOURCE_AUTHORITY[rec.kol_source]) ?? SOURCE_AUTHORITY_DEFAULT;
  return absS * (typeof auth === 'number' ? auth : SOURCE_AUTHORITY_DEFAULT);
}

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

/**
 * NewsAnalyzer 对 KOL 段的视图 — 完整 KOLOpinionRecord 的子集.
 *
 * 必带 kol_name + kol_source 让 evidence detail 输出 "kol_name (source_tag)" 形态;
 * sentiment_score 是必备 (无明确观点的兜底也会写 0, 不应漏字段). opinion_date 可选
 * 仅用于 evidence 排序参考, 不参与计算.
 */
export type NewsAnalyzerKOLRecord = Pick<
  KOLOpinionRecord,
  'kol_name' | 'kol_source' | 'sentiment_score'
> &
  Partial<Pick<KOLOpinionRecord, 'opinion_date' | 'opinion_summary'>>;

export interface NewsAnalyzerDataSource {
  listAnnouncementsByStock(stockCode: string, days: number): Promise<AnnouncementRecord[]>;
  listRecentNewsByStock(stockCode: string, days: number): Promise<NewsRecord[]>;
  /** 已加权 + 已 dedupe 的聚合产物 (KOLAggregator.aggregateForStock 直出形状) */
  aggregateKOLForStock(stockCode: string): Promise<NewsAnalyzerKOLRecord[]>;
}

/** 'sz.300750' / 'SH600000' / '300750' 统一返 6 位纯数字; 形态非法返 null. */
export function toSixDigitStockCode(rawCode: string): string | null {
  const stripped = String(rawCode || '')
    .trim()
    .replace(/^[a-zA-Z]+\.?/, '');
  return /^\d{6}$/.test(stripped) ? stripped : null;
}

/**
 * KOL_SOURCE_LABEL — kol_source enum → 中文 evidence tag.
 *
 * 与 KOLOpinion model comment / KOLAggregatorService.KOL_SOURCES 同源.
 * 未识别 source fallback 到 'KOL' 通用标签 — 不抛错避免 evidence 段崩.
 */
export const KOL_SOURCE_LABEL: Readonly<Record<KOLSource, string>> = Object.freeze({
  research_report: '研报',
  east_money_news: '财经新闻',
  xq_hot_concept: '热门概念',
  etf_flow: 'ETF 资金',
  policy_doc: '政策',
});

export function formatKOLSourceLabel(source: string | null | undefined): string {
  if (!source) return 'KOL';
  return (KOL_SOURCE_LABEL as Record<string, string>)[source] || 'KOL';
}

/**
 * 把 N 条 KOLOpinionRecord 聚成 [-1, 1] 区间的加权平均情绪分.
 *
 * 权重 = authorityWeightedSentiment(rec) = |sentiment_score| × SOURCE_AUTHORITY[kol_source].
 * 强观点 + 权威源 (研报 / 政策) 自然占主导, 中性 0 分意见不占分母.
 *
 * 返 null = 全部样本 sentiment_score=null 或全 0 (=完全无信号, 调用方应入 data_missing).
 */
export function weightedAvgKOLSentiment(records: NewsAnalyzerKOLRecord[]): number | null {
  let sumW = 0;
  let sumV = 0;
  for (const rec of records) {
    const s = rec.sentiment_score;
    if (s === null || !Number.isFinite(s)) continue;
    const w = authorityWeightedSentiment({
      stock_code: '',
      kol_name: rec.kol_name,
      opinion_date: rec.opinion_date || '',
      kol_source: rec.kol_source,
      opinion_summary: rec.opinion_summary || '',
      sentiment_score: s,
      url: null,
      raw_payload: {},
    });
    if (w <= 0) continue;
    sumW += w;
    sumV += s * w;
  }
  return sumW > 0 ? sumV / sumW : null;
}

/**
 * 取按 authorityWeightedSentiment 排序 top N 的 KOL 意见, 输出形如
 * `[研报] 中信证券:+0.80 | [政策] 国务院:+0.70 | [财经新闻] 财联社:-0.40`.
 *
 * 用 .slice() 复制后再排, 不污染上游数组顺序 (KOLAggregator 已 dedupe + 按 opinion_date desc 排).
 */
export function buildKOLEvidenceDetail(records: NewsAnalyzerKOLRecord[], topN = 3): string {
  // 排序 key = authorityWeightedSentiment = |sentiment| × SOURCE_AUTHORITY[kol_source]
  // 与 dedupeAndSort / weightedAvgKOLSentiment 同源, 让 evidence top N 与加权平均
  // 的"信号主导项"完全一致 (研报 + 政策 自然排前).
  const scoreOf = (r: NewsAnalyzerKOLRecord): number =>
    authorityWeightedSentiment({
      stock_code: '',
      kol_name: r.kol_name,
      opinion_date: r.opinion_date || '',
      kol_source: r.kol_source,
      opinion_summary: r.opinion_summary || '',
      sentiment_score: r.sentiment_score,
      url: null,
      raw_payload: {},
    });
  return records
    .slice()
    .sort((a, b) => scoreOf(b) - scoreOf(a))
    .slice(0, topN)
    .map(r => {
      const tag = formatKOLSourceLabel(r.kol_source);
      const name = (r.kol_name || '匿名').slice(0, 24);
      const sRaw = r.sentiment_score;
      const s = sRaw !== null && Number.isFinite(sRaw) ? sRaw : 0;
      const sign = s >= 0 ? '+' : '';
      return `[${tag}] ${name}:${sign}${s.toFixed(2)}`;
    })
    .join(' | ');
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
  async aggregateKOLForStock(_stockCode) {
    // 批5: KOL 情绪源已下线 — 恒返空数组 (KOLAggregatorService 已删除).
    return [];
  },
};

export class NewsAnalyzer extends BaseAnalyzer {
  readonly key: AnalyzerKey = 'news';

  constructor(private readonly source: NewsAnalyzerDataSource = PRODUCTION_NEWS_ANALYZER_SOURCE) {
    super();
  }

  // 批5: KOL 情绪源已下线 — News 维度回退到 公告(2/3) + 新闻(1/3) 两源加权.
  // 不再硬性要求任一源全到, conf = 到位源数 / 2 反映真实可用度.
  protected requiredFields: readonly string[] = [];

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
      // 批5: 公告权重 2/3 (原 0.5, KOL 下线后重新归一; weightedMean 按到位权重归一).
      partials.push({ value: annScore, weight: 2 });
      evidence.push({
        label: `公告 ${anns.length} 条 (+${pos} / -${neg})`,
        detail: anns
          .slice(0, 3)
          .map(a => `${a.ann_date}:${a.short_title?.slice(0, 30) || '-'}`)
          .join(' | '),
        metric_value: net,
        direction: annScore > 5 ? 'bullish' : annScore < -5 ? 'bearish' : 'neutral',
        weight: 2,
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
        // 批5: 新闻权重 1/3 (原 0.25, KOL 下线后重新归一).
        partials.push({ value: newsScore, weight: 1 });
        evidence.push({
          label: `新闻 ${news.length} 条 (avg sentiment ${avg.toFixed(2)})`,
          detail: news
            .slice(0, 2)
            .map(n => n.title.slice(0, 40))
            .join(' | '),
          metric_value: avg,
          direction: avg > 0.1 ? 'bullish' : avg < -0.1 ? 'bearish' : 'neutral',
          weight: 1,
        });
      }
    }

    // 批5: KOL 情绪源已下线 — 原 KOL 加权子源整段移除, 仅保留 公告 + 新闻 两源.

    const score = weightedMean(partials) ?? 0;
    const total = 2;
    const have =
      total -
      (dataMissing.includes('announcements') ? 1 : 0) -
      (dataMissing.includes('news') ? 1 : 0);
    const confidence = have / total;

    return {
      score,
      evidence,
      data_sources: [
        { name: 'announcements_nlp', as_of: ctx.as_of, is_realtime: false },
        { name: 'market_news', as_of: ctx.as_of, is_realtime: false },
      ],
      confidence,
      data_missing: dataMissing,
    };
  }
}

export const newsAnalyzer = new NewsAnalyzer();
