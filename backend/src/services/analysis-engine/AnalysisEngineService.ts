/**
 * AnalysisEngineService — 多维分析引擎主编排器.
 *
 * Phase 1: Context Build (Stock / DailyBar / RealtimeQuote / FactorScores / MarketEnv).
 * Phase 2: Parallel Analyzers via Promise.allSettled (一个 analyzer 失败不阻塞其他).
 * Phase 3: DecisionAggregator.
 * Phase 4: Persist (caller 决定; service 本身只返回 RecommendationDecision +
 *           AIInvestmentSignal-compatible 形态).
 *
 * 注意: 本 service 仅"分析 + 返回结构化决策". 落 AIStockAnalysisReport / AIInvestmentSignal
 * 由 caller (ShadowDoubleRunService / 未来 hard mode) 决定, 以便 dry-run / 测试不依赖 DB.
 *
 * AR-1 (2026-06-21): 强制在文件顶部 `import '../../config/database'` 触发
 * sequelize 单例 + addModels 副作用; 否则 cold-path caller (CLI / 直跑脚本 /
 * worker thread) 直接 `require('AnalysisEngineService')` 后 lazy `require('models/X')`
 * 时 X 未 addModels → `"X" needs to be added to a Sequelize instance`. 见
 * config/database.ts 注释.
 */

import { ensureModelsRegistered } from '../../config/database';
import { logger } from '../../utils/logger';
import { normalizeSymbol } from '../../utils/stockSymbol';
import { evaluateDataQuality } from './DataQualityVerdict';
import { decisionAggregator } from './DecisionAggregator';
import type {
  AnalyzerContext,
  AnalyzerOutput,
  MarketSegment,
  RecommendationDecision,
} from './AnalyzerTypes';

import { fundamentalAnalyzer } from './analyzers/FundamentalAnalyzer';
import { technicalAnalyzer } from './analyzers/TechnicalAnalyzer';
import { capitalAnalyzer } from './analyzers/CapitalAnalyzer';
import { newsAnalyzer } from './analyzers/NewsAnalyzer';
import { sentimentAnalyzer } from './analyzers/SentimentAnalyzer';
import { industryRegimeAnalyzer } from './analyzers/IndustryRegimeAnalyzer';
import { riskAnalyzer } from './analyzers/RiskAnalyzer';
import { eventAnalyzer } from './analyzers/EventAnalyzer';

import type { BaseAnalyzer } from './analyzers/BaseAnalyzer';

export interface AnalysisEngineDataSource {
  /** 加载 Stock + 派生 market_segment + industry. */
  loadStock(stockCode: string): Promise<{
    code: string;
    name: string | null;
    industry: string | null;
    market_segment: MarketSegment;
  } | null>;
  /** 加载 daily_bars (升序, 最多 N 根, 截止 asOf 收盘后). */
  loadDailyBars(
    stockCode: string,
    asOf: string,
    limit: number
  ): Promise<AnalyzerContext['daily_bars']>;
  /** 加载 realtime_quote (可选, 实时). */
  loadRealtimeQuote(stockCode: string): Promise<AnalyzerContext['realtime_quote'] | null>;
  /** 加载 market_env (可选, 复用 MarketEnvironmentService). */
  loadMarketEnv(stockCode: string, asOf: string): Promise<unknown | null>;
  /** 加载 factor_snapshot (factor_name → z_score). */
  loadFactorSnapshot(stockCode: string, asOf: string): Promise<Record<string, number | null>>;
}

export const PRODUCTION_ANALYSIS_ENGINE_DATA_SOURCE: AnalysisEngineDataSource = {
  async loadStock(stockCode) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { Stock } = require('../../models/Stock');
      const s = await Stock.findOne({ where: { symbol: stockCode } });
      if (!s) return null;
      return {
        code: stockCode,
        name: s.name || null,
        industry: s.industry || null,
        market_segment: inferMarketSegmentFromSymbol(stockCode),
      };
    } catch (_e) {
      return null;
    }
  },
  async loadDailyBars(stockCode, asOf, limit) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { Stock } = require('../../models/Stock');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { DailyBar } = require('../../models/DailyBar');
      const s = await Stock.findOne({ where: { symbol: stockCode }, attributes: ['id'] });
      if (!s) return [];
      const end = new Date(`${asOf}T23:59:59.999Z`);
      const bars = await DailyBar.findAll({
        where: {
          stock_id: s.id,
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          time: { [require('sequelize').Op.lte]: end },
        },
        attributes: ['time', 'open', 'high', 'low', 'close', 'volume', 'turnover'],
        order: [['time', 'DESC']],
        limit,
        raw: true,
      });
      return bars
        .map((b: any) => ({
          time: typeof b.time === 'string' ? b.time : new Date(b.time).toISOString(),
          open: Number(b.open),
          high: Number(b.high),
          low: Number(b.low),
          close: Number(b.close),
          volume: Number(b.volume),
          turnover: b.turnover === null || b.turnover === undefined ? null : Number(b.turnover),
        }))
        .reverse();
    } catch (_e) {
      return [];
    }
  },
  async loadRealtimeQuote(stockCode) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { RealtimeQuote } = require('../../models/RealtimeQuote');
      // Batch AM (2026-06-21): RealtimeQuote schema 用 symbol (不是 stock_code) +
      // current_price (不是 price) + raw_payload (bid/ask 在里面). 旧 loader 用错列名,
      // findOne 永远返 null → CapitalAnalyzer spread 评分全废 + RiskAnalyzer 行情陈旧度
      // veto 触发失效. 修正后 ETag check 走真实最新价 + 真盘口 bid1/ask1 (若 raw_payload 有).
      const row: any = await RealtimeQuote.findOne({
        where: { symbol: stockCode },
        order: [['updated_at', 'DESC']],
        raw: true,
      });
      if (row) {
        // 从 raw_payload 抽 bid1/ask1 (腾讯/新浪源会带)
        let bid: number | null = null;
        let ask: number | null = null;
        if (row.raw_payload && typeof row.raw_payload === 'object') {
          const p = row.raw_payload;
          const b1 = p.bid1_price ?? p.bid1 ?? p.bid ?? null;
          const a1 = p.ask1_price ?? p.ask1 ?? p.ask ?? null;
          bid = b1 === null || b1 === undefined ? null : Number(b1);
          ask = a1 === null || a1 === undefined ? null : Number(a1);
        }
        return {
          price: Number(row.current_price),
          bid: bid,
          ask: ask,
          volume: row.volume === null || row.volume === undefined ? null : Number(row.volume),
          as_of_ts:
            typeof row.updated_at === 'string'
              ? row.updated_at
              : new Date(row.updated_at).toISOString(),
        };
      }
      // Batch BA-7 (2026-06-22): RT 没数据 fallback 用最新 daily_bar.close
      // 真因: A 股 ~5500 只票, RT sync 偶发 1-3% 票漏 (AKShare 单 API 偶尔失败).
      // 这些票之前完全没 quote → CapitalAnalyzer / TechnicalAnalyzer 部分功能失效.
      // 用 daily_bar 兜底虽然不是实时, 但保证 analyzer 有 price 输入, RiskAnalyzer
      // staleness check 会标记 'stale_from_daily_bar' 让 caller 知道这是兜底.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { Stock } = require('../../models/Stock');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { DailyBar } = require('../../models/DailyBar');
      const s = await Stock.findOne({ where: { symbol: stockCode }, attributes: ['id'] });
      if (!s) return null;
      const latestBar: any = await DailyBar.findOne({
        where: { stock_id: s.id },
        order: [['time', 'DESC']],
        attributes: ['time', 'close', 'volume'],
        raw: true,
      });
      if (!latestBar) return null;
      return {
        price: Number(latestBar.close),
        bid: null,
        ask: null,
        volume: latestBar.volume === null ? null : Number(latestBar.volume),
        as_of_ts: typeof latestBar.time === 'string'
          ? latestBar.time
          : new Date(latestBar.time).toISOString(),
      };
    } catch (_e) {
      return null;
    }
  },
  async loadMarketEnv(stockCode, asOf) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { marketEnvironmentService } = require('../MarketEnvironmentService');
      return await marketEnvironmentService.getEnvironmentForStock(stockCode, { as_of: asOf });
    } catch (_e) {
      return null;
    }
  },
  async loadFactorSnapshot(stockCode, asOf) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { FactorScore } = require('../../models/FactorScore');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { stripSuffix } = require('../../quant/factors/library/_helpers');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { Op } = require('sequelize');
      const code = stripSuffix(stockCode);
      // Batch AM (2026-06-21): 不再严格匹配 trade_date = asOf, 改取"最近一日 ≤ asOf".
      // 原因: factor_scores 工作日才有 (cron 17:30 跑), 节假日 / 周末 / 数据延迟
      // 都会让严格 = 匹配返 0 行 → 整个 fundamental/capital/sentiment/risk 维度坍缩.
      // FactorPipeline 自己也是按"今日 (asOf) 写入", 所以 ≤ asOf 自然取到最新一份.
      //
      // BA-B (用户清单 #10): 必须同时读 raw_value 才能区分"真有信号 z=0" vs "缺数据
      // 被中性补全 z=0". FactorPipeline 对该股票 factor.compute() 没返回值时写
      // raw_value=NULL + z_score=0 + percentile=0.5 (FactorPipeline.ts:252-254);
      // 不读 raw_value 的话, AnalysisEngine 收到 z=0 会把"无数据"当"中性信号" 喂给
      // analyzer (e.g. FundamentalAnalyzer 把 6 个因子全当成有数据加权), 让缺研报
      // 的小盘股得到"分析师一致预期=中性"的虚假 evidence. 这里显式: raw_value=NULL
      // → out[factor]=null, analyzer 才能正确走 data_missing 路径.
      const rows = await FactorScore.findAll({
        where: { trade_date: { [Op.lte]: asOf }, stock_code: code },
        attributes: ['factor_name', 'z_score', 'raw_value', 'trade_date'],
        order: [['trade_date', 'DESC']],
        limit: 200, // 22 factor × 7 日窗口足够
        raw: true,
      });
      const out: Record<string, number | null> = {};
      // 每个 factor_name 取最新一日 (rows 已按 trade_date DESC)
      for (const r of rows) {
        if (out[r.factor_name] !== undefined) continue;
        // raw_value=NULL → 该股票该因子 compute() 缺数据被中性补全; 显式置 null 让
        // analyzer 走 data_missing 路径 (而非把 z=0 当成"中性有信号").
        if (r.raw_value === null || r.raw_value === undefined) {
          out[r.factor_name] = null;
          continue;
        }
        const z = r.z_score === null || r.z_score === undefined ? null : Number(r.z_score);
        out[r.factor_name] = z;
      }
      return out;
    } catch (_e) {
      return {};
    }
  },
};

export function inferMarketSegmentFromSymbol(symbol: string): MarketSegment {
  const clean = (symbol || '').replace(/[a-zA-Z.]/g, '');
  if (!clean) return 'main';
  const head = clean[0];
  if (head === '3') return 'chinext';
  if (head === '6') {
    if (clean.startsWith('688')) return 'star';
    return 'main';
  }
  if (head === '0') return 'main';
  if (head === '8' || head === '4' || head === '9') return 'bj';
  return 'main';
}

export interface AnalyzeStockOptions {
  as_of?: string;
  user_id?: number;
  has_open_position?: boolean;
  shadow_of_report_id?: string | null;
  /** 自定义 analyzer list (默认 8 个全跑) */
  enabled_analyzers?: Array<BaseAnalyzer['key']>;
  weights?: Record<string, number>;
}

export class AnalysisEngineService {
  private allAnalyzers: BaseAnalyzer[];

  constructor(
    private readonly dataSource: AnalysisEngineDataSource = PRODUCTION_ANALYSIS_ENGINE_DATA_SOURCE,
    customAnalyzers?: BaseAnalyzer[]
  ) {
    this.allAnalyzers = customAnalyzers || [
      fundamentalAnalyzer,
      technicalAnalyzer,
      capitalAnalyzer,
      newsAnalyzer,
      sentimentAnalyzer,
      industryRegimeAnalyzer,
      riskAnalyzer,
      eventAnalyzer,
    ];
  }

  async analyzeStock(
    stockCode: string,
    options: AnalyzeStockOptions = {}
  ): Promise<RecommendationDecision> {
    // AR-1: cold-path caller (CLI / 测试 / worker) 第一次访问模型前确保 addModels 已跑.
    // 主进程 boot 时已注册, 二次调用本函数即为 no-op (一次 Object.keys 检查).
    ensureModelsRegistered();
    const normalized = normalizeSymbol(stockCode) || stockCode;
    // Batch BA-17 (2026-06-22): bug 清单 #17 — 时区错位修复
    // 原: new Date().toISOString().slice(0,10) 用 UTC. UTC 08:00 = Asia/Shanghai 16:00,
    // 当 UTC 23:30 (≈ 北京 07:30) 时 toISOString 已经是次日, 但北京时间还是今天,
    // 导致 factor_scores 查询查到次日 (0 行) 整个 fundamental 维度坍缩.
    // 与 portfolio/internal/PaperTradingAutomationService.ts:994 同款 moment().tz('Asia/Shanghai').
    const asOf = options.as_of || (() => {
      const d = new Date();
      // Asia/Shanghai = UTC+8
      const sh = new Date(d.getTime() + 8 * 60 * 60 * 1000);
      return sh.toISOString().slice(0, 10);
    })();

    // Phase 1: Context Build
    const [stock, daily_bars, realtime_quote, market_env, factor_snapshot] = await Promise.all([
      this.dataSource.loadStock(normalized),
      this.dataSource.loadDailyBars(normalized, asOf, 120),
      this.dataSource.loadRealtimeQuote(normalized),
      this.dataSource.loadMarketEnv(normalized, asOf),
      this.dataSource.loadFactorSnapshot(normalized, asOf),
    ]);

    const stockInfo = stock || {
      code: normalized,
      name: null,
      industry: null,
      market_segment: inferMarketSegmentFromSymbol(normalized),
    };

    const ctx: AnalyzerContext = {
      stock: stockInfo,
      as_of: asOf,
      daily_bars,
      realtime_quote: realtime_quote ?? undefined,
      market_env: market_env ?? undefined,
      factor_snapshot: factor_snapshot || {},
      user_profile: options.user_id ? { user_id: options.user_id } : undefined,
    };

    const dq = evaluateDataQuality(ctx);

    // Phase 2: Parallel analyzers
    const enabledKeys = options.enabled_analyzers;
    const enabled = enabledKeys
      ? this.allAnalyzers.filter(a => enabledKeys.includes(a.key))
      : this.allAnalyzers;

    const settled = await Promise.allSettled(enabled.map(a => a.analyze(ctx)));
    const analyzerOutputs: AnalyzerOutput[] = settled.map((s, i) => {
      if (s.status === 'fulfilled') return s.value;
      const a = enabled[i];
      logger.warn(`[analysis-engine] analyzer ${a.key} rejected: ${s.reason?.message || s.reason}`);
      return {
        analyzer_key: a.key,
        score: 0,
        evidence: [],
        data_sources: [],
        confidence: 0,
        data_missing: [],
        error: { code: 'REJECTED', message: String(s.reason?.message || s.reason) },
        elapsed_ms: 0,
      };
    });

    // 取 TechnicalAnalyzer 的扩展 anchors (从其 internal source; 此处简化: 不再次调 service,
    // 而是从 evidence 反推 — TechnicalAnalyzer 已把 buy_zone/support 等放在 indicators_snapshot,
    // 但 evidence 列表不携带; 留给 v1: 直接调 dataSource 一次抓 anchors).
    const technicalAnchors = await this.loadTechnicalAnchors(normalized, daily_bars.length);

    // Phase 3: Aggregator
    const decision = decisionAggregator.aggregate(
      {
        stock_code: normalized,
        as_of: asOf,
        analyzers: analyzerOutputs,
        data_quality: dq,
        current_price: realtime_quote?.price ?? daily_bars[daily_bars.length - 1]?.close ?? null,
        has_open_position: options.has_open_position === true,
        market_segment: stockInfo.market_segment,
        // is_st 简单基于 name 包含 ST
        is_st: stockInfo.name ? /ST/i.test(stockInfo.name) : false,
        technical_anchors: technicalAnchors,
        weights: options.weights as any,
        user_id: options.user_id ?? null,
      },
      { shadow_of_report_id: options.shadow_of_report_id || null }
    );

    // Batch AW (2026-06-22): 异步附加 TradingAgents narrative — 作为"叙事补充", 不影响决策
    // 用 Promise.race 给 6s timeout, TA 慢/挂不阻塞引擎主流程返回.
    // 传 decision 让 fallback 能基于 evidence 自动生成中文叙述 (TA 服务下线时仍有内容显示)
    decision.tradingagents_narrative = await this.maybeLoadTradingAgentsNarrative(normalized, asOf, decision);

    return decision;
  }

  /**
   * 调用 TradingAgents 拿研报式 5 维度 narrative.
   * 直接 HTTP POST 避开 AIAdvisorService — 后者会再触发 hard short-circuit 形成循环.
   * 失败 / timeout 返 null, 不让 decision 主路径挂.
   *
   * Batch AW (2026-06-22): TA 外部服务 47.93.224.109:8000 实测 connection refused (服务下线).
   * 加 `decision` 参数后, 失败时走本地 fallback — 用 analyzer evidence 自动拼中文叙述.
   */
  private async maybeLoadTradingAgentsNarrative(
    stockCode: string,
    _asOf: string,
    decision?: RecommendationDecision
  ): Promise<RecommendationDecision['tradingagents_narrative']> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const axios = require('axios');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { TRADING_AGENTS_BASE_URL } = require('../../config/externalServices');
      const TA_TIMEOUT_MS = 5000;
      const url = `${TRADING_AGENTS_BASE_URL}/api/analyze`;
      const payload = { ticker: stockCode, dimensions: ['fundamental', 'technical', 'capital', 'news', 'sentiment'] };
      const res: any = await Promise.race([
        axios.post(url, payload, { timeout: TA_TIMEOUT_MS }),
        new Promise(resolve => setTimeout(() => resolve(null), TA_TIMEOUT_MS + 500)),
      ]);
      if (res && res.data) {
        const data = res.data || {};
        const rawText: string | undefined = data.report || data.text || data.analysis ||
          (typeof data === 'string' ? data : undefined);
        const seg = (label: string): string | undefined => {
          if (!rawText) return undefined;
          const re = new RegExp(`(?:^|\\n)[\\s#]*(?:\\*\\*)?${label}(?:\\*\\*)?[\\s::：]*(?:\\n+)([\\s\\S]+?)(?=\\n[\\s#]*(?:\\*\\*)?(?:基本面|技术面|资金面|新闻|消息面|情绪面|总结|结论)|$)`,
            'i');
          const m = rawText.match(re);
          return m ? m[1].trim().substring(0, 1200) : undefined;
        };
        return {
          fundamental: data.fundamental || seg('基本面'),
          technical: data.technical || seg('技术面'),
          capital: data.capital || seg('资金面'),
          news: data.news || seg('新闻面') || seg('消息面'),
          sentiment: data.sentiment || seg('情绪面'),
          raw_text: rawText ? rawText.substring(0, 4000) : undefined,
          source: 'tradingagents',
          generated_at: new Date().toISOString(),
        };
      }
    } catch (e: any) {
      logger.warn(`[analysis-engine] TradingAgents narrative HTTP 失败 (${stockCode}): ${e?.message ?? e}`);
    }

    // Fallback: TA 不可用 (服务下线 / timeout / 网络), 用本地 analyzer evidence 拼中文叙述给前端
    if (!decision) return null;
    try {
      const dimMap = new Map(decision.per_dimension.map(d => [d.analyzer_key, d]));
      const renderDim = (key: string, label: string): string | undefined => {
        const dim = dimMap.get(key as any);
        if (!dim || !dim.evidence || dim.evidence.length === 0) return undefined;
        const realEv = dim.evidence.filter(
          (ev: any) => ev.label && !ev.label.includes('z=0.00')
        );
        if (realEv.length === 0) return undefined;
        const lines = realEv.slice(0, 4).map((ev: any) => {
          const arrow = ev.direction === 'bullish' ? '✓' : ev.direction === 'bearish' ? '✗' : '·';
          return `${arrow} ${ev.label}${ev.detail ? ` — ${String(ev.detail).substring(0, 80).replace(/\n/g, ' ')}` : ''}`;
        });
        const score = dim.score?.toFixed(1) ?? '—';
        const conf = dim.confidence !== undefined ? `${(dim.confidence * 100).toFixed(0)}%` : '—';
        return `**${label}** (评分 ${score} / 置信 ${conf})\n\n${lines.join('\n')}`;
      };
      const fundamental = renderDim('fundamental', '基本面');
      const technical = renderDim('technical', '技术面');
      const capital = renderDim('capital', '资金面');
      const news = renderDim('news', '消息面');
      const sentiment = renderDim('sentiment', '情绪面');
      if (!fundamental && !technical && !capital && !news && !sentiment) return null;
      return {
        fundamental,
        technical,
        capital,
        news,
        sentiment,
        raw_text: `TradingAgents 外部服务暂不可用 (TA 服务在 ${process.env.TRADING_AGENTS_URL || 'http://47.93.224.109:8000'} 连接失败), 以下叙述基于本地新引擎 evidence 自动生成.`,
        source: 'tradingagents',
        generated_at: new Date().toISOString(),
      };
    } catch (e: any) {
      logger.warn(`[analysis-engine] narrative fallback 失败 (${stockCode}): ${e?.message ?? e}`);
      return null;
    }
  }

  /**
   * 单独再调一次 TechnicalAnalysisService.analyze 以拿到 anchors.
   * 实际生产可优化为复用 Phase 2 调用结果 (TechnicalAnalyzer 缓存 result),
   * 目前先简单调一次保证 anchors 一致性.
   */
  private async loadTechnicalAnchors(
    stockCode: string,
    barsLen: number
  ): Promise<{
    buy_zone?: [number, number] | null;
    sell_zone?: [number, number] | null;
    support_levels?: number[];
    resistance_levels?: number[];
    atr?: number | null;
  }> {
    if (barsLen < 20) return {};
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { technicalAnalysisService } = require('../TechnicalAnalysisService');
      const res = await technicalAnalysisService.analyze(stockCode, Math.min(120, barsLen), {});
      return {
        buy_zone:
          Array.isArray(res.buy_zone) && res.buy_zone.length === 2
            ? [Number(res.buy_zone[0]), Number(res.buy_zone[1])]
            : null,
        sell_zone:
          Array.isArray(res.sell_zone) && res.sell_zone.length === 2
            ? [Number(res.sell_zone[0]), Number(res.sell_zone[1])]
            : null,
        support_levels: Array.isArray(res.support_levels) ? res.support_levels.map(Number) : [],
        resistance_levels: Array.isArray(res.resistance_levels)
          ? res.resistance_levels.map(Number)
          : [],
        atr:
          res.indicators_snapshot && Number.isFinite(Number(res.indicators_snapshot.atr_14))
            ? Number(res.indicators_snapshot.atr_14)
            : null,
      };
    } catch (_e) {
      return {};
    }
  }
}

export const analysisEngineService = new AnalysisEngineService();
