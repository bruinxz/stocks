/**
 * integration_3_samples_hard.test.ts — US-024 [AE-011] 3 样本股 hard mode 端到端集成测试.
 *
 * 验收: 一致率 ≥ 80% — 同一组 fixtures 同时跑两条路径, 比对决策的"是否同向"一致率:
 *   路径 A: AnalysisEngineService.analyzeStock(stockCode) 直接拿 RecommendationDecision.
 *   路径 B: maybeRunHardShortCircuit(fakeDS, {mode='hard'}) 拿 HardShortCircuitResult,
 *           其中 fakeDS.analyzeStock 委托给路径 A 的 engine, 形成 "hard 不偷偷换数据" 的契约.
 *
 * 一致维度 (per stock 取 4 维, 3 × 4 = 12 比对点):
 *   [1] action 同向 — A.decision.action 经 mapActionToRecommendation 映成 B 的 5 档,
 *       与 B.recommendation 严格 ===.
 *   [2] risk_level 一致 — pickHardRiskLevel(A.decision) === B.risk_level.
 *   [3] confidence_score 一致 — round(A.overall_confidence * 100) === B.confidence_score.
 *   [4] key_points 维度一致 — A 的 5 个 legacy 维度 (fundamental/technical/capital/news/sentiment)
 *       的 "有 evidence ↔ key_points 非空" 关系应一致.
 *
 * 3 个样本股:
 *   - 600519 (sh.600519, 贵州茅台, 主板, 白马蓝筹 → bullish fixtures, 期望 action ∈ {buy, add, strong_buy}).
 *   - 000858 (sz.000858, 五粮液, 主板, 横盘震荡 → 中性 fixtures, 期望 action ∈ {hold, add, buy}).
 *   - 300750 (sz.300750, 宁德时代, 创业板, 强势上涨 + 北向 boost → bullish, 期望 buy/strong_buy).
 *
 * 与既有 integration_300750.test.ts 区别 —
 *   - 那个测 "engine 单跑一只 + 验 8 analyzer 全 ok"; 本测 "hard mode 接管后 vs raw engine 一致";
 *   - 那个只验单股 happy; 本测 3 股 12 比对点 + 一致率阈值 + 跨股 sanity (3 股 decision 都非 null).
 *
 * 不依赖 DB / 不调真实 analyzer: 全部用注入的 fake DataSource + fake analyzer 套件. 与
 * hardShortCircuit.test.ts [3] block 同款 fake DataSource pattern.
 */

import { AnalysisEngineService } from '../../../src/services/analysis-engine/AnalysisEngineService';
import type { AnalysisEngineDataSource } from '../../../src/services/analysis-engine/AnalysisEngineService';
import { FundamentalAnalyzer } from '../../../src/services/analysis-engine/analyzers/FundamentalAnalyzer';
import { TechnicalAnalyzer } from '../../../src/services/analysis-engine/analyzers/TechnicalAnalyzer';
import { CapitalAnalyzer } from '../../../src/services/analysis-engine/analyzers/CapitalAnalyzer';
import { NewsAnalyzer } from '../../../src/services/analysis-engine/analyzers/NewsAnalyzer';
import { SentimentAnalyzer } from '../../../src/services/analysis-engine/analyzers/SentimentAnalyzer';
import { IndustryRegimeAnalyzer } from '../../../src/services/analysis-engine/analyzers/IndustryRegimeAnalyzer';
import { RiskAnalyzer } from '../../../src/services/analysis-engine/analyzers/RiskAnalyzer';
import { EventAnalyzer } from '../../../src/services/analysis-engine/analyzers/EventAnalyzer';
import type { BaseAnalyzer } from '../../../src/services/analysis-engine/analyzers/BaseAnalyzer';
import type {
  AnalyzerKey,
  RecommendationDecision,
} from '../../../src/services/analysis-engine/AnalyzerTypes';
import {
  HARD_SHORT_CIRCUIT_DIMENSIONS,
  mapActionToRecommendation,
  maybeRunHardShortCircuit,
  pickHardRiskLevel,
  type HardShortCircuitDataSource,
  type HardShortCircuitResult,
} from '../../../src/services/analysis-engine/hardShortCircuit';

let pass = 0;
let fail = 0;
const failures: string[] = [];
function assert(cond: boolean, msg: string): void {
  if (cond) pass += 1;
  else {
    fail += 1;
    failures.push(msg);
    console.error(`✗ ${msg}`);
  }
}

// ---------------------------------------------------------------------------
//  Fixture builders: per stock 一个 builder, 产 (DataSource, analyzer 套件, expected hint)
// ---------------------------------------------------------------------------

interface SampleFixture {
  stockCode: string; // normalized: 'sh.600519' / 'sz.000858' / 'sz.300750'
  stockName: string;
  industry: string;
  marketSegment: 'main' | 'chinext' | 'star' | 'bj';
  ds: AnalysisEngineDataSource;
  analyzers: BaseAnalyzer[];
}

/** 主板白马蓝筹 (强势 bullish): 60 日 K 平稳上涨 + 高 ROE 因子 + 业绩超预期公告. */
function buildSample600519(): SampleFixture {
  return {
    stockCode: 'sh.600519',
    stockName: '贵州茅台',
    industry: '白酒',
    marketSegment: 'main',
    ds: {
      async loadStock() {
        return {
          code: 'sh.600519',
          name: '贵州茅台',
          industry: '白酒',
          market_segment: 'main',
        };
      },
      async loadDailyBars() {
        const bars = [];
        let p = 1700;
        for (let i = 0; i < 60; i += 1) {
          p *= 1 + 0.004; // 平稳缓慢上涨 (60 日 +27%)
          bars.push({
            time: new Date(2026, 3, i + 1).toISOString(),
            open: p,
            high: p * 1.015,
            low: p * 0.985,
            close: p,
            volume: 2_000_000,
            turnover: 3_500_000_000,
          });
        }
        return bars;
      },
      async loadRealtimeQuote() {
        return {
          price: 2160,
          bid: 2159.5,
          ask: 2160.5,
          volume: 800,
          as_of_ts: new Date().toISOString(),
        };
      },
      async loadMarketEnv() {
        return {
          market_regime: 'bull',
          market_regime_label: '牛市',
          industry: { regime: 'hot', label: '热门', relative_return_20d_pct: 8 },
        };
      },
      async loadFactorSnapshot() {
        return {
          value: 1.2,
          growth: 1.5,
          quality: 2.0,
          quality_high: 1.8,
          analyst_consensus: 1.6,
          earnings_surprise: 1.2,
          northbound: 1.4,
          money_flow: 1.0,
          insider_trade: 0.3,
          margin_flow: 0.1,
          dragon_tiger: 0.5,
          block_trade_signal: 0.2,
          fund_consensus: 1.8,
          east_money_qa: 0.9,
          concept_heat: 0.7,
          shareholder_concentration: 1.2,
          industry_momentum: 1.5,
          liquidity: 1.5,
          low_vol: 1.0,
        };
      },
    },
    analyzers: [
      new FundamentalAnalyzer({
        async loadIndustryPeerScores() {
          return [
            { stock_code: '600519', z: 2.1 },
            { stock_code: '000858', z: 0.8 },
            { stock_code: '600809', z: 0.3 },
          ];
        },
      }),
      new TechnicalAnalyzer({
        async analyze() {
          return {
            trend: 'strong_uptrend',
            support_levels: [2050, 1980],
            resistance_levels: [2200, 2280],
            buy_zone: [2100, 2160],
            sell_zone: [2200, 2240],
            confidence: 0.78,
            indicators_snapshot: {
              last_rsi: 58,
              last_macd: { dif: 12, dea: 8, hist: 4 },
              vol_ratio: 1.2,
              atr_14: 35,
            },
            summary: 'strong uptrend, healthy MA stack',
            status: 'completed',
            nlp_engine: 'fake',
            generated_at: new Date().toISOString(),
          };
        },
      }),
      new CapitalAnalyzer(),
      new NewsAnalyzer({
        async listAnnouncementsByStock() {
          return [
            { ann_date: '2026-06-15', sentiment: '正面', short_title: '一季度净利润同比 +18%' },
          ];
        },
        async listRecentNewsByStock() {
          return [{ title: '高端白酒回暖', publish_time: null, sentiment_score: 0.6 }];
        },
        async aggregateKOLForStock() {
          return [{ sentiment_score: 0.7 }];
        },
      }),
      new SentimentAnalyzer({
        async getMarketSentimentPercentile() {
          return 62;
        },
      }),
      new IndustryRegimeAnalyzer(),
      new RiskAnalyzer(),
      new EventAnalyzer({
        async filter() {
          return {
            symbol: 'sh.600519',
            action: 'allow',
            score_multiplier: 1.0,
            delay_minutes: 0,
            events: [],
            reason: 'no events',
          };
        },
      }),
    ],
  };
}

/** 主板横盘 (中性): 60 日 K 来回震荡 + 因子中性, 期望 hold/add 边缘. */
function buildSample000858(): SampleFixture {
  return {
    stockCode: 'sz.000858',
    stockName: '五粮液',
    industry: '白酒',
    marketSegment: 'main',
    ds: {
      async loadStock() {
        return {
          code: 'sz.000858',
          name: '五粮液',
          industry: '白酒',
          market_segment: 'main',
        };
      },
      async loadDailyBars() {
        const bars = [];
        const base = 160;
        for (let i = 0; i < 60; i += 1) {
          // 正弦震荡 ±5%
          const p = base + Math.sin(i * 0.4) * 8;
          bars.push({
            time: new Date(2026, 3, i + 1).toISOString(),
            open: p,
            high: p * 1.008,
            low: p * 0.992,
            close: p,
            volume: 8_000_000,
            turnover: 1_300_000_000,
          });
        }
        return bars;
      },
      async loadRealtimeQuote() {
        return {
          price: 162,
          bid: 161.95,
          ask: 162.05,
          volume: 5000,
          as_of_ts: new Date().toISOString(),
        };
      },
      async loadMarketEnv() {
        return {
          market_regime: 'sideways',
          market_regime_label: '震荡',
          industry: { regime: 'neutral', label: '中性', relative_return_20d_pct: 1 },
        };
      },
      async loadFactorSnapshot() {
        return {
          value: 0.5,
          growth: 0.4,
          quality: 0.8,
          quality_high: 0.2,
          analyst_consensus: 0.5,
          earnings_surprise: 0.1,
          northbound: 0.0,
          money_flow: -0.1,
          insider_trade: 0.0,
          margin_flow: 0.0,
          dragon_tiger: 0.0,
          block_trade_signal: 0.0,
          fund_consensus: 0.3,
          east_money_qa: 0.2,
          concept_heat: 0.0,
          shareholder_concentration: 0.5,
          industry_momentum: 0.1,
          liquidity: 0.8,
          low_vol: 0.6,
        };
      },
    },
    analyzers: [
      new FundamentalAnalyzer({
        async loadIndustryPeerScores() {
          return [
            { stock_code: '000858', z: 0.5 },
            { stock_code: '600519', z: 2.1 },
            { stock_code: '600809', z: 0.0 },
          ];
        },
      }),
      new TechnicalAnalyzer({
        async analyze() {
          return {
            trend: 'sideways',
            support_levels: [152, 148],
            resistance_levels: [168, 175],
            buy_zone: [156, 160],
            sell_zone: [166, 170],
            confidence: 0.55,
            indicators_snapshot: {
              last_rsi: 50,
              last_macd: { dif: 0.3, dea: 0.4, hist: -0.1 },
              vol_ratio: 1.0,
              atr_14: 4.5,
            },
            summary: 'sideways, neutral momentum',
            status: 'completed',
            nlp_engine: 'fake',
            generated_at: new Date().toISOString(),
          };
        },
      }),
      new CapitalAnalyzer(),
      new NewsAnalyzer({
        async listAnnouncementsByStock() {
          return [];
        },
        async listRecentNewsByStock() {
          return [{ title: '行业平稳', publish_time: null, sentiment_score: 0.0 }];
        },
        async aggregateKOLForStock() {
          return [{ sentiment_score: 0.0 }];
        },
      }),
      new SentimentAnalyzer({
        async getMarketSentimentPercentile() {
          return 48;
        },
      }),
      new IndustryRegimeAnalyzer(),
      new RiskAnalyzer(),
      new EventAnalyzer({
        async filter() {
          return {
            symbol: 'sz.000858',
            action: 'allow',
            score_multiplier: 1.0,
            delay_minutes: 0,
            events: [],
            reason: 'no events',
          };
        },
      }),
    ],
  };
}

/** 创业板强势 (bullish + 北向 boost): 与 integration_300750 同 baseline 微调. */
function buildSample300750(): SampleFixture {
  return {
    stockCode: 'sz.300750',
    stockName: '宁德时代',
    industry: '电池',
    marketSegment: 'chinext',
    ds: {
      async loadStock() {
        return {
          code: 'sz.300750',
          name: '宁德时代',
          industry: '电池',
          market_segment: 'chinext',
        };
      },
      async loadDailyBars() {
        const bars = [];
        let p = 200;
        for (let i = 0; i < 60; i += 1) {
          p *= 1 + 0.005;
          bars.push({
            time: new Date(2026, 3, i + 1).toISOString(),
            open: p,
            high: p * 1.02,
            low: p * 0.98,
            close: p,
            volume: 5_000_000,
            turnover: 1_000_000_000,
          });
        }
        return bars;
      },
      async loadRealtimeQuote() {
        return {
          price: 268,
          bid: 267.99,
          ask: 268.01,
          volume: 1000,
          as_of_ts: new Date().toISOString(),
        };
      },
      async loadMarketEnv() {
        return {
          market_regime: 'bull',
          market_regime_label: '牛市',
          industry: { regime: 'hot', label: '热门', relative_return_20d_pct: 12 },
        };
      },
      async loadFactorSnapshot() {
        return {
          value: 0.6,
          growth: 1.8,
          quality: 1.5,
          quality_high: 1.0,
          analyst_consensus: 1.3,
          earnings_surprise: 0.9,
          northbound: 1.6,
          money_flow: 1.4,
          insider_trade: 0.5,
          margin_flow: 0.3,
          dragon_tiger: 0.8,
          block_trade_signal: 0.2,
          fund_consensus: 1.1,
          east_money_qa: 1.0,
          concept_heat: 1.4,
          shareholder_concentration: 0.6,
          industry_momentum: 2.0,
          liquidity: 1.2,
          low_vol: 0.4,
        };
      },
    },
    analyzers: [
      new FundamentalAnalyzer({
        async loadIndustryPeerScores() {
          return [
            { stock_code: '300750', z: 1.5 },
            { stock_code: '300751', z: -0.2 },
            { stock_code: '300752', z: 0.4 },
          ];
        },
      }),
      new TechnicalAnalyzer({
        async analyze() {
          return {
            trend: 'strong_uptrend',
            support_levels: [240, 230],
            resistance_levels: [285, 300],
            buy_zone: [260, 270],
            sell_zone: [285, 295],
            confidence: 0.75,
            indicators_snapshot: {
              last_rsi: 62,
              last_macd: { dif: 2, dea: 1, hist: 1 },
              vol_ratio: 1.4,
              atr_14: 8,
            },
            summary: 'strong uptrend',
            status: 'completed',
            nlp_engine: 'fake',
            generated_at: new Date().toISOString(),
          };
        },
      }),
      new CapitalAnalyzer(),
      new NewsAnalyzer({
        async listAnnouncementsByStock() {
          return [
            { ann_date: '2026-06-15', sentiment: '正面', short_title: '业绩超预期' },
          ];
        },
        async listRecentNewsByStock() {
          return [{ title: '行业利好', publish_time: null, sentiment_score: 0.5 }];
        },
        async aggregateKOLForStock() {
          return [{ sentiment_score: 0.6 }];
        },
      }),
      new SentimentAnalyzer({
        async getMarketSentimentPercentile() {
          return 55;
        },
      }),
      new IndustryRegimeAnalyzer(),
      new RiskAnalyzer(),
      new EventAnalyzer({
        async filter() {
          return {
            symbol: 'sz.300750',
            action: 'boost',
            score_multiplier: 1.15,
            delay_minutes: 0,
            events: [
              {
                event_type: 'northbound_inflow',
                score_multiplier: 1.15,
                action_hint: 'boost',
                reason: '北向 5 日累计 +1.5pp',
              },
            ],
            reason: 'northbound boost',
          };
        },
      }),
    ],
  };
}

// ---------------------------------------------------------------------------
//  Per-sample runner: 跑两条路径 → 收集 4 比对点
// ---------------------------------------------------------------------------

interface ComparePoint {
  stock_code: string;
  key: string;
  pathA: unknown;
  pathB: unknown;
  consistent: boolean;
  note?: string;
}

async function runSample(fx: SampleFixture): Promise<{
  rawDecision: RecommendationDecision;
  hardResult: HardShortCircuitResult;
  comparePoints: ComparePoint[];
}> {
  // ---- 路径 A: raw engine ----
  const engine = new AnalysisEngineService(fx.ds, fx.analyzers);
  const rawDecision = await engine.analyzeStock(fx.stockCode, {
    as_of: '2026-06-18',
    user_id: 1,
  });

  // ---- 路径 B: hard mode 接管, analyzeStock 委托给 A 的 engine (验 hard 不偷换数据) ----
  const persistCalls: HardShortCircuitResult[] = [];
  const archiveCalls: Array<{ prodReportId: string; user_id?: number | null }> = [];
  const hardDS: HardShortCircuitDataSource = {
    async loadUserConfig() {
      return { mode: 'hard', enabled_analyzers: undefined, weights: undefined };
    },
    async analyzeStock(stockCode, opts) {
      // 委托给同 engine — 这是关键, 保证 hard 路径用的就是同一个 RecommendationDecision 算法
      return engine.analyzeStock(stockCode, opts);
    },
    async persistEngineReport(_decision, result) {
      persistCalls.push(result);
    },
    async archiveHardSignal(_decision, prodReportId, user_id) {
      archiveCalls.push({ prodReportId, user_id });
      return { ok: true, signal: { id: 1234 }, created: true, payload: null };
    },
  };
  const hardResult = await maybeRunHardShortCircuit(hardDS, {
    stock_code: fx.stockCode,
    user_id: 1,
    report_id: `AI-${fx.stockCode.replace(/^[a-z]+\./, '')}-hard-test`,
    metadata: { test: 'us-024-3-samples' },
    stock_name: fx.stockName,
  });

  if (!hardResult) {
    throw new Error(`[${fx.stockCode}] hard mode 返 null — 不应发生`);
  }
  // Sanity — hard path 走完了 persist + archive
  if (persistCalls.length !== 1) {
    throw new Error(`[${fx.stockCode}] expected 1 persist call, got ${persistCalls.length}`);
  }
  if (archiveCalls.length !== 1) {
    throw new Error(`[${fx.stockCode}] expected 1 archive call, got ${archiveCalls.length}`);
  }

  // ---- 4 比对点 ----
  const cmpPoints: ComparePoint[] = [];

  // [1] action 同向
  const expectedReco = mapActionToRecommendation(rawDecision.action);
  cmpPoints.push({
    stock_code: fx.stockCode,
    key: 'action',
    pathA: expectedReco,
    pathB: hardResult.recommendation,
    consistent: expectedReco === hardResult.recommendation,
    note: `raw.action=${rawDecision.action} → mapped=${expectedReco} ; hard.reco=${hardResult.recommendation}`,
  });

  // [2] risk_level
  const expectedRisk = pickHardRiskLevel(rawDecision);
  cmpPoints.push({
    stock_code: fx.stockCode,
    key: 'risk_level',
    pathA: expectedRisk,
    pathB: hardResult.risk_level,
    consistent: expectedRisk === hardResult.risk_level,
  });

  // [3] confidence_score
  const expectedConf = Number.isFinite(rawDecision.overall_confidence)
    ? Math.max(0, Math.min(100, Math.round(rawDecision.overall_confidence * 100)))
    : null;
  cmpPoints.push({
    stock_code: fx.stockCode,
    key: 'confidence_score',
    pathA: expectedConf,
    pathB: hardResult.confidence_score,
    consistent: expectedConf === hardResult.confidence_score,
  });

  // [4] key_points 维度一致 — 对 5 legacy 维度, 每维"raw 有 evidence" ↔ "hard.key_points 非空" 应一致.
  const legacyDims = HARD_SHORT_CIRCUIT_DIMENSIONS;
  let dimAgree = 0;
  for (const dim of legacyDims) {
    // raw 侧: 对应 analyzer evidence 数 > 0
    const rawAna = rawDecision.per_dimension.find(p => p.analyzer_key === (dim as AnalyzerKey));
    const rawHasEvidence = !!rawAna && Array.isArray(rawAna.evidence) && rawAna.evidence.length > 0;
    const hardHas = (hardResult.key_points[dim] || []).length > 0;
    if (rawHasEvidence === hardHas) dimAgree += 1;
  }
  cmpPoints.push({
    stock_code: fx.stockCode,
    key: 'key_points_dims',
    pathA: legacyDims.length,
    pathB: dimAgree,
    consistent: dimAgree === legacyDims.length,
    note: `${dimAgree}/${legacyDims.length} legacy dims agree`,
  });

  return { rawDecision, hardResult, comparePoints: cmpPoints };
}

// ---------------------------------------------------------------------------
//  Main
// ---------------------------------------------------------------------------

(async () => {
  const fixtures: SampleFixture[] = [
    buildSample600519(),
    buildSample000858(),
    buildSample300750(),
  ];

  const allPoints: ComparePoint[] = [];
  const perStockSummary: Array<{
    stock_code: string;
    rawAction: string;
    hardReco: string;
    rawConf: number;
    hardConf: number | null;
    rawRisk: string;
    hardRisk: string | null;
  }> = [];

  for (const fx of fixtures) {
    const { rawDecision, hardResult, comparePoints } = await runSample(fx);

    // 跨股 sanity: 决策 schema 完整
    assert(rawDecision.stock_code === fx.stockCode, `[${fx.stockCode}] raw.stock_code 透传`);
    assert(hardResult.stock_code === fx.stockCode, `[${fx.stockCode}] hard.stock_code 透传`);
    assert(rawDecision.per_dimension.length === 8, `[${fx.stockCode}] raw 跑完 8 analyzer`);
    assert(hardResult.status !== 'failed', `[${fx.stockCode}] hard status 非 failed (got ${hardResult.status})`);
    assert(
      hardResult.dimensions.length === HARD_SHORT_CIRCUIT_DIMENSIONS.length,
      `[${fx.stockCode}] hard dimensions = 5 legacy dims`
    );
    assert(
      (hardResult.metadata as any).hard_short_circuit === true,
      `[${fx.stockCode}] hard metadata.hard_short_circuit=true`
    );

    allPoints.push(...comparePoints);
    perStockSummary.push({
      stock_code: fx.stockCode,
      rawAction: rawDecision.action,
      hardReco: hardResult.recommendation,
      rawConf: rawDecision.overall_confidence,
      hardConf: hardResult.confidence_score,
      rawRisk: pickHardRiskLevel(rawDecision),
      hardRisk: hardResult.risk_level,
    });
  }

  // 一致率 ≥ 80% (AC 主验收)
  const total = allPoints.length;
  const consistent = allPoints.filter(p => p.consistent).length;
  const rate = total === 0 ? 0 : consistent / total;

  console.log('\n--- Per-stock summary ---');
  for (const s of perStockSummary) {
    console.log(
      `  ${s.stock_code}: raw.action=${s.rawAction} → hard.reco=${s.hardReco} | ` +
        `conf raw=${s.rawConf.toFixed(2)} hard=${s.hardConf} | risk raw=${s.rawRisk} hard=${s.hardRisk}`
    );
  }
  console.log('\n--- Compare points ---');
  for (const p of allPoints) {
    const sym = p.consistent ? '✓' : '✗';
    console.log(
      `  ${sym} [${p.stock_code}] ${p.key}: A=${JSON.stringify(p.pathA)} B=${JSON.stringify(
        p.pathB
      )}${p.note ? ` (${p.note})` : ''}`
    );
  }
  console.log(`\n一致率: ${consistent}/${total} = ${(rate * 100).toFixed(1)}%`);

  assert(total === 12, `expected 12 compare points (3 stocks × 4 dims), got ${total}`);
  assert(
    rate >= 0.8,
    `AC: 一致率 ≥ 80% (got ${(rate * 100).toFixed(1)}% — ${consistent}/${total})`
  );

  // 跨股 sanity: 至少 2 个 bullish stock 的 action 落在 buy/add/strong_buy
  // (600519 + 300750 均 bullish fixtures; 000858 中性允许 hold)
  const bullishCount = perStockSummary.filter(s =>
    ['buy', 'add', 'strong_buy'].includes(s.rawAction)
  ).length;
  assert(
    bullishCount >= 2,
    `bullish samples → action ∈ {buy,add,strong_buy} ≥ 2 (got ${bullishCount})`
  );

  console.log(`\n${pass} passed, ${fail} failed.`);
  if (fail > 0) {
    console.error(`FAILURES:\n${failures.map(f => '  - ' + f).join('\n')}`);
    process.exit(1);
  } else {
    process.exit(0);
  }
})();
