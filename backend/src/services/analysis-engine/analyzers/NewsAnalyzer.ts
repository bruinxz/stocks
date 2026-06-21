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
import {
  authorityWeightedSentiment,
  type KOLOpinionRecord,
  type KOLSource,
} from '../../KOLAggregatorService';

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
  async aggregateKOLForStock(stockCode) {
    try {
      // KOLAggregator 严格要求 6 位 stock_code (e.g. '300750'); analyzer ctx 通常
      // 是 'sz.300750' 形态, 必须 strip 前缀否则 aggregateForStock 直接返
      // error='Invalid stock_code format'.
      const code = toSixDigitStockCode(stockCode);
      if (!code) return [];
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { kolAggregatorService } = require('../../KOLAggregatorService');
      // dryRun: true — analyzer 只是读端, 不应触发 KOLAggregator 的 saveOpinions 落库
      // (旧实现传的不是合法 option 仍走 persist 默认路径; 修复为 dryRun=true).
      const res = await kolAggregatorService.aggregateForStock(code, { dryRun: true });
      return (res?.opinions || []).map((o: any) => ({
        kol_name: o.kol_name,
        kol_source: o.kol_source,
        opinion_date: o.opinion_date,
        opinion_summary: o.opinion_summary,
        sentiment_score:
          o.sentiment_score === null || o.sentiment_score === undefined
            ? null
            : Number(o.sentiment_score),
      }));
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

    // 3) KOL — 走 KOLAggregator 真聚合 (US-036): 5 类来源 (研报 / 财经新闻 /
    //    热门概念 / ETF 资金 / 政策) 加权汇总, 权威源 (研报 / 政策) 占主导.
    const kol = await this.source.aggregateKOLForStock(ctx.stock.code);
    if (!kol.length) {
      dataMissing.push('kol');
    } else {
      const avg = weightedAvgKOLSentiment(kol);
      if (avg === null) {
        // 全部 KOL 意见 sentiment_score=null/0 — 无信号, 与 "无 KOL 数据" 区分
        dataMissing.push('kol_sentiment_score');
      } else {
        const kolScore = Math.max(-40, Math.min(40, avg * 80));
        partials.push({ value: kolScore, weight: 0.25 });
        // 按来源分桶计数, 让 label 看清结构 ("研报 3 / 政策 1 / 新闻 6")
        const bySrc = new Map<string, number>();
        for (const r of kol) {
          const tag = formatKOLSourceLabel(r.kol_source);
          bySrc.set(tag, (bySrc.get(tag) || 0) + 1);
        }
        const srcSummary = Array.from(bySrc.entries())
          .map(([t, c]) => `${t} ${c}`)
          .join(' / ');
        evidence.push({
          label: `KOL 聚合 ${kol.length} 条 (${srcSummary}, 加权情绪 ${avg.toFixed(2)})`,
          detail: buildKOLEvidenceDetail(kol, 3),
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
