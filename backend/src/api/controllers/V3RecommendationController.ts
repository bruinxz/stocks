/**
 * V3RecommendationController — 抖音风 v3 推荐卡片后端 (CA-1).
 *
 * 2 个端点 mount 在 `/api/today/v3-*`:
 *
 *   GET /api/today/v3-recommendations?limit=N&date=YYYY-MM-DD
 *     - 返回今日 (或指定日期) v3 推荐 top N (默认 3, max 10).
 *     - 数据源: AIInvestmentSignal where source_type='analysis_engine' & 当日 & decision IN (buy/strong_buy).
 *     - 拼接: 基础 (Stock) + 实时 KPI (RealtimeQuote / 最新 DailyBar) + 振幅 + 20d 累计涨跌 +
 *       20d sparkline + 4 维评分 (aggregateToV3Dimensions) + 3 高亮标签 (buildHighlightTags) +
 *       一句话推荐理由 + decision 原 payload (entry_zone / stop_loss / take_profit / ...).
 *     - 弹性扩展: N=3 但若 #4-5 confidence 与 #3 项 gap < 0.05 则扩到 5.
 *     - 同时返回 funnel stats (scanned / candidate / selected / as_of).
 *
 *   GET /api/today/v3-funnel?date=YYYY-MM-DD
 *     - 仅返漏斗统计, 给顶部条用. 轻量, 不拉个股明细.
 *
 * 失败兜底原则 (与 TodayCommandCenterService / TodaySignalsService 同款):
 *   - 单只 stock 拼接失败 (无 daily_bar / 无 RT 行情 / Stock 缺失) → 仅 logger.warn,
 *     该股 fallback 部分字段 null, 仍出现在返回数组中 (不阻塞整体响应).
 *   - 顶层 catch 仅防 framework 异常, service 内的 query 失败已 fail-OPEN.
 *
 * 注意:
 *   - 不破坏前端契约: 新增端点, 不动 /api/today/signals 等现有端点.
 *   - 不写库 / 不修改 AIInvestmentSignal / 不创建新表. 漏斗 stats 全部从 AIInvestmentSignal 反推.
 *   - 不接 TradingAgents / shadow / hard 短路 — 只是把 analysis_engine 既有 archive 翻成 v3 视图.
 */

import { Response } from 'express';
import { Op } from 'sequelize';
import moment from 'moment-timezone';
import { AuthenticatedRequest } from '../../middlewares/auth';
import { logger } from '../../utils/logger';
import { AIInvestmentSignal, AISignalSourceType } from '../../models/AIInvestmentSignal';
import { Stock } from '../../models/Stock';
import { DailyBar } from '../../models/DailyBar';
import { RealtimeQuote } from '../../models/RealtimeQuote';
import {
  aggregateToV3Dimensions,
  buildHighlightTags,
  pickV3ConfidenceTier,
  type V3DimensionScore,
} from '../../services/analysis-engine/v3CardHelpers';

// ---------------------------------------------------------------------------
//  常量
// ---------------------------------------------------------------------------

/** 默认推荐条数 */
const DEFAULT_RECOMMEND_LIMIT = 3;

/** 最大推荐条数 (用户传 limit 超过此值会被 clamp) */
const MAX_RECOMMEND_LIMIT = 10;

/** 弹性扩展: 若 #4-5 项 confidence 与 #3 项 gap 小于此值, 则扩到 5 */
const ELASTIC_CONFIDENCE_GAP = 0.05;

/** Sparkline + 累计涨跌窗口 */
const SPARKLINE_DAYS = 20;

/**
 * "买入类" decision — funnel `selected` 计数 + recommendations 过滤口径都用这套.
 * 与 [[AISignalDecision]] 枚举对齐: BUY / STRONG_BUY (analysis_engine 把 'add' 也归到 BUY).
 */
const BUY_DECISIONS: ReadonlyArray<string> = Object.freeze(['buy', 'strong_buy']);

/**
 * 当日 candidate 候选信号来源 (funnel 中段). analysis_engine + quant_recommendation +
 * tradingagents 三种"AI 生成"的归一为 candidate; daily_screener 只是规则引擎不算.
 */
const CANDIDATE_SOURCE_TYPES: ReadonlyArray<string> = Object.freeze([
  AISignalSourceType.ANALYSIS_ENGINE,
  'quant_recommendation',
  'tradingagents',
]);

// ---------------------------------------------------------------------------
//  helpers
// ---------------------------------------------------------------------------

function todayInShanghai(): string {
  return moment().tz('Asia/Shanghai').format('YYYY-MM-DD');
}

function clampLimit(raw: any): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_RECOMMEND_LIMIT;
  return Math.min(Math.floor(n), MAX_RECOMMEND_LIMIT);
}

function parseDate(raw: any): string {
  if (typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  return todayInShanghai();
}

/**
 * 应用"弹性扩展": 默认 baseN, 但若 #(baseN) 与 #(baseN+1)... 的 confidence_score gap < threshold,
 * 持续往后扩到 maxN. 让"分数相近的并列项"不被硬截断.
 */
export function applyElasticLimit(
  rows: AIInvestmentSignal[],
  baseN: number,
  maxN: number,
  gap: number = ELASTIC_CONFIDENCE_GAP
): AIInvestmentSignal[] {
  if (rows.length <= baseN) return rows;
  const out = rows.slice(0, baseN);
  const lastConf = Number(out[out.length - 1]?.confidence_score ?? 0);
  for (let i = baseN; i < rows.length && out.length < maxN; i++) {
    const c = Number(rows[i]?.confidence_score ?? 0);
    if (!Number.isFinite(c)) break;
    if (lastConf - c > gap * 100) break; // confidence_score 是 0-100 标度
    out.push(rows[i]);
  }
  return out;
}

interface PerDimensionLike {
  analyzer_key: string;
  score: number;
  confidence: number;
  evidence?: Array<{ label: string; direction: string }>;
}

/**
 * 从 archive metadata.per_dimension_summary 或 detail.per_dimension 拿回 8 维 summary.
 * archive 时写了精简版 (analyzer_key+score+confidence), evidence 在 detail JSON 里 (无 evidence).
 * 标签生成需要 evidence label 关键词, 所以同时尝试解析 detail.per_dimension.
 */
export function extractPerDimension(signal: AIInvestmentSignal): PerDimensionLike[] {
  const out: PerDimensionLike[] = [];
  const metadataSummary = (signal.metadata as any)?.per_dimension_summary;
  if (Array.isArray(metadataSummary)) {
    for (const item of metadataSummary) {
      if (item && typeof item.analyzer_key === 'string') {
        out.push({
          analyzer_key: String(item.analyzer_key),
          score: Number(item.score) || 0,
          confidence: Number(item.confidence) || 0,
          evidence: [],
        });
      }
    }
  }
  // 从 detail JSON 拿 evidence (label / direction) 合并进去
  if (signal.detail) {
    try {
      const parsed = JSON.parse(String(signal.detail));
      const detailDims = parsed?.per_dimension;
      if (Array.isArray(detailDims)) {
        for (const d of detailDims) {
          if (!d || typeof d.analyzer_key !== 'string') continue;
          const existing = out.find(x => x.analyzer_key === d.analyzer_key);
          const evs = Array.isArray(d.evidence)
            ? d.evidence
                .filter((e: any) => e && typeof e.label === 'string')
                .map((e: any) => ({
                  label: String(e.label),
                  direction: String(e.direction || 'neutral'),
                }))
            : [];
          if (existing) {
            existing.evidence = evs;
          } else {
            out.push({
              analyzer_key: String(d.analyzer_key),
              score: Number(d.score) || 0,
              confidence: Number(d.confidence) || 0,
              evidence: evs,
            });
          }
        }
      }
    } catch {
      // detail 不是合法 JSON → ignore, summary 仍生效
    }
  }
  return out;
}

interface SparklinePoint {
  date: string;
  close: number;
}

/**
 * 算 20d 累计涨跌 + sparkline 点数组. bars 已按时间升序.
 * 返回 null 表示数据不够 (少于 2 个点).
 */
export function buildPriceWindow(
  bars: Array<{ time: Date; close: number }>
): { cumulative_change_pct: number; sparkline: SparklinePoint[] } | null {
  if (!Array.isArray(bars) || bars.length < 2) return null;
  const window = bars.slice(-SPARKLINE_DAYS);
  const first = Number(window[0]?.close);
  const last = Number(window[window.length - 1]?.close);
  if (!Number.isFinite(first) || !Number.isFinite(last) || first <= 0) return null;
  const cumPct = ((last - first) / first) * 100;
  const sparkline: SparklinePoint[] = window.map(b => ({
    date:
      b.time instanceof Date
        ? b.time.toISOString().slice(0, 10)
        : String(b.time).slice(0, 10),
    close: Number(b.close) || 0,
  }));
  return { cumulative_change_pct: Math.round(cumPct * 100) / 100, sparkline };
}

/**
 * 算今日振幅 (%) = (today.high - today.low) / prev_close × 100. 缺数据返 null.
 */
export function computeAmplitude(
  bars: Array<{ high?: number; low?: number; close?: number }>
): number | null {
  if (!Array.isArray(bars) || bars.length < 2) return null;
  const today = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  const hi = Number(today?.high);
  const lo = Number(today?.low);
  const prevClose = Number(prev?.close);
  if (!Number.isFinite(hi) || !Number.isFinite(lo) || !Number.isFinite(prevClose) || prevClose <= 0) {
    return null;
  }
  return Math.round(((hi - lo) / prevClose) * 100 * 100) / 100;
}

// ---------------------------------------------------------------------------
//  Controller
// ---------------------------------------------------------------------------

class V3RecommendationController {
  /**
   * GET /api/today/v3-recommendations?limit=N&date=YYYY-MM-DD
   */
  async getRecommendations(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const date = parseDate(req.query.date);
      const requested = clampLimit(req.query.limit);
      const baseN = Math.min(requested, DEFAULT_RECOMMEND_LIMIT);
      // 拉 50 条候选, 应用弹性扩展后再切 top N
      const candidateRows = await AIInvestmentSignal.findAll({
        where: {
          source_type: AISignalSourceType.ANALYSIS_ENGINE,
          signal_date: date,
          normalized_decision: { [Op.in]: BUY_DECISIONS as string[] },
        },
        order: [
          ['confidence_score', 'DESC'],
          ['created_at', 'DESC'],
        ],
        limit: 50,
      });

      // 应用弹性扩展; 用户显式 limit > 3 则按 limit 截断 (不再弹性), 反之走 elastic 到 5.
      let selected: AIInvestmentSignal[];
      if (requested > DEFAULT_RECOMMEND_LIMIT) {
        selected = candidateRows.slice(0, requested);
      } else {
        const maxElastic = Math.min(5, MAX_RECOMMEND_LIMIT);
        selected = applyElasticLimit(candidateRows, baseN, maxElastic, ELASTIC_CONFIDENCE_GAP);
      }

      const recommendations = await Promise.all(
        selected.map(signal => this.enrichSignal(signal).catch(err => {
          logger.warn(`v3-recommendations enrich failed for ${signal.symbol}: ${err?.message ?? err}`);
          return this.minimalSignalView(signal);
        }))
      );

      const funnel = await this.queryFunnel(date).catch(err => {
        logger.warn(`v3-recommendations funnel query failed: ${err?.message ?? err}`);
        return { scanned: 0, candidate: 0, selected: 0, as_of: date };
      });

      res.json({
        success: true,
        data: {
          as_of: date,
          recommendations,
          funnel,
        },
      });
    } catch (error: any) {
      logger.error('获取 v3 推荐失败:', error);
      res.status((error as any)?.statusCode || 500).json({
        success: false,
        message: error?.message || '获取 v3 推荐失败',
      });
    }
  }

  /**
   * GET /api/today/v3-funnel?date=YYYY-MM-DD
   */
  async getFunnelStats(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const date = parseDate(req.query.date);
      const data = await this.queryFunnel(date);
      res.json({ success: true, data });
    } catch (error: any) {
      logger.error('获取 v3 漏斗失败:', error);
      res.status((error as any)?.statusCode || 500).json({
        success: false,
        message: error?.message || '获取 v3 漏斗失败',
      });
    }
  }

  // ---------------------------------------------------------------------------
  //  internal
  // ---------------------------------------------------------------------------

  private async queryFunnel(date: string): Promise<{
    scanned: number;
    candidate: number;
    selected: number;
    as_of: string;
  }> {
    // scanned: 大致用 Stock 表里 type='stock' 总数 (上市状态), 与 Daily Screener universe 同口径.
    const scanned = await Stock.count({
      where: {
        is_listed: true,
        type: { [Op.in]: ['stock', null as any] }, // null 兼容老数据
      },
    }).catch(() => 0);

    const candidate = await AIInvestmentSignal.count({
      where: {
        signal_date: date,
        source_type: { [Op.in]: CANDIDATE_SOURCE_TYPES as string[] },
      },
    }).catch(() => 0);

    const selected = await AIInvestmentSignal.count({
      where: {
        signal_date: date,
        source_type: { [Op.in]: CANDIDATE_SOURCE_TYPES as string[] },
        normalized_decision: { [Op.in]: BUY_DECISIONS as string[] },
      },
    }).catch(() => 0);

    return { scanned, candidate, selected, as_of: date };
  }

  /**
   * 把单条 archive signal 翻成 v3 卡片视图. 任一子查询失败 fall-back 部分字段 null.
   */
  private async enrichSignal(signal: AIInvestmentSignal): Promise<Record<string, unknown>> {
    const symbol = String(signal.symbol);
    const stock = await Stock.findOne({ where: { symbol } }).catch(() => null);
    const stockId = stock?.id ?? null;

    // 拉 20d + 1 天 daily_bars (升序), 算 amplitude / sparkline / 累计涨跌
    let bars: DailyBar[] = [];
    if (stockId !== null) {
      bars = await DailyBar.findAll({
        where: { stock_id: stockId },
        order: [['time', 'DESC']],
        limit: SPARKLINE_DAYS + 5,
      })
        .then(rows => rows.slice().reverse())
        .catch(() => []);
    }

    const priceWindow = buildPriceWindow(
      bars.map(b => ({ time: b.time, close: Number(b.close) }))
    );
    const amplitude = computeAmplitude(
      bars.map(b => ({
        high: Number(b.high),
        low: Number(b.low),
        close: Number(b.close),
      }))
    );

    // 实时行情 (preferred) → fallback 最新 daily_bar
    const rtRow: any = await RealtimeQuote.findOne({
      where: { symbol },
      order: [['quote_time', 'DESC']],
      raw: true,
    }).catch(() => null);

    const lastBar = bars.length > 0 ? bars[bars.length - 1] : null;
    const currentPrice =
      rtRow && Number.isFinite(Number(rtRow.current_price))
        ? Number(rtRow.current_price)
        : lastBar
          ? Number(lastBar.close)
          : null;
    const changePct =
      rtRow && Number.isFinite(Number(rtRow.change_percent))
        ? Number(rtRow.change_percent)
        : lastBar && lastBar.change_percent !== undefined
          ? Number(lastBar.change_percent)
          : null;
    const turnoverRate =
      lastBar && lastBar.turnover_rate !== undefined
        ? Number(lastBar.turnover_rate)
        : stock && stock.turnover_rate !== undefined
          ? Number(stock.turnover_rate)
          : null;

    // 4 维聚合
    const perDim = extractPerDimension(signal);
    const dimensions: V3DimensionScore[] = aggregateToV3Dimensions(perDim);
    const v3Tier = pickV3ConfidenceTier(dimensions);

    // 高亮标签
    const tags = buildHighlightTags(
      {
        circulating_market_cap: stock?.circulating_market_cap ?? null,
        total_market_cap: stock?.total_market_cap ?? null,
      },
      perDim,
      3
    );

    // 推荐理由: detail.key_reasons[0..1] 拼接, 缺则 rationale 字段
    let recommendReason = '';
    try {
      if (signal.detail) {
        const parsed = JSON.parse(String(signal.detail));
        const keyReasons = Array.isArray(parsed?.key_reasons) ? parsed.key_reasons : [];
        recommendReason = keyReasons.slice(0, 2).filter(Boolean).join(' / ');
      }
    } catch {
      // ignore
    }
    if (!recommendReason && signal.rationale) recommendReason = String(signal.rationale).slice(0, 120);

    const metadata: any = signal.metadata ?? {};
    return {
      symbol,
      name: signal.name ?? stock?.name ?? null,
      industry: stock?.industry ?? null,
      circulating_market_cap: stock?.circulating_market_cap ?? null,
      total_market_cap: stock?.total_market_cap ?? null,
      current_price: currentPrice,
      change_pct: changePct,
      turnover_rate: turnoverRate,
      amplitude_pct: amplitude,
      cumulative_change_pct_20d: priceWindow?.cumulative_change_pct ?? null,
      sparkline: priceWindow?.sparkline ?? [],
      dimensions,
      confidence_tier: v3Tier,
      overall_confidence:
        typeof metadata?.overall_confidence === 'number' ? metadata.overall_confidence : null,
      highlight_tags: tags,
      recommend_reason: recommendReason || null,
      decision: {
        action: signal.decision,
        normalized_decision: signal.normalized_decision,
        confidence_score: signal.confidence_score ?? null,
        risk_level: signal.risk_level ?? null,
        entry_zone: metadata?.entry_zone ?? null,
        stop_loss: metadata?.stop_loss ?? null,
        take_profit: metadata?.take_profit ?? null,
        suggested_position_pct: metadata?.suggested_position_pct ?? null,
        position_action: metadata?.position_action ?? null,
        confidence_tier_engine: metadata?.confidence_tier ?? null,
        risk_warnings: Array.isArray(metadata?.risk_warnings) ? metadata.risk_warnings : [],
      },
      signal_id: signal.id,
      signal_date: signal.signal_date,
    };
  }

  /**
   * enrich 失败兜底视图 — 至少返 symbol + decision + 不挂前端布局.
   */
  private minimalSignalView(signal: AIInvestmentSignal): Record<string, unknown> {
    return {
      symbol: String(signal.symbol),
      name: signal.name ?? null,
      industry: null,
      circulating_market_cap: null,
      total_market_cap: null,
      current_price: null,
      change_pct: null,
      turnover_rate: null,
      amplitude_pct: null,
      cumulative_change_pct_20d: null,
      sparkline: [],
      dimensions: aggregateToV3Dimensions([]),
      confidence_tier: 'low' as const,
      overall_confidence: null,
      highlight_tags: [],
      recommend_reason: signal.rationale ?? null,
      decision: {
        action: signal.decision,
        normalized_decision: signal.normalized_decision,
        confidence_score: signal.confidence_score ?? null,
        risk_level: signal.risk_level ?? null,
        entry_zone: null,
        stop_loss: null,
        take_profit: null,
        suggested_position_pct: null,
        position_action: null,
        confidence_tier_engine: null,
        risk_warnings: [],
      },
      signal_id: signal.id,
      signal_date: signal.signal_date,
      enrich_failed: true,
    };
  }
}

export const v3RecommendationController = new V3RecommendationController();
