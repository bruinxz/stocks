/**
 * integration_300750.test.ts — 端到端跑 300750 一次, 用注入的 fixtures 完全脱 DB.
 *
 * 验证:
 *   - AnalysisEngineService.analyzeStock() 跑完 8 个 analyzer
 *   - DecisionAggregator 给出非 hold action (因为 fixtures 是 bullish)
 *   - per_dimension 包含 8 项 (无 reject)
 *   - data_quality good
 */

import {
  AnalysisEngineService,
} from '../../../src/services/analysis-engine/AnalysisEngineService';
import { FundamentalAnalyzer } from '../../../src/services/analysis-engine/analyzers/FundamentalAnalyzer';
import { TechnicalAnalyzer } from '../../../src/services/analysis-engine/analyzers/TechnicalAnalyzer';
import { CapitalAnalyzer } from '../../../src/services/analysis-engine/analyzers/CapitalAnalyzer';
import { NewsAnalyzer } from '../../../src/services/analysis-engine/analyzers/NewsAnalyzer';
import { SentimentAnalyzer } from '../../../src/services/analysis-engine/analyzers/SentimentAnalyzer';
import { IndustryRegimeAnalyzer } from '../../../src/services/analysis-engine/analyzers/IndustryRegimeAnalyzer';
import { RiskAnalyzer } from '../../../src/services/analysis-engine/analyzers/RiskAnalyzer';
import { EventAnalyzer } from '../../../src/services/analysis-engine/analyzers/EventAnalyzer';
import type { AnalysisEngineDataSource } from '../../../src/services/analysis-engine/AnalysisEngineService';
import type { AnalyzerKey } from '../../../src/services/analysis-engine/AnalyzerTypes';

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

const fakeDS: AnalysisEngineDataSource = {
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
      p *= 1 + 0.005; // 平稳上涨
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
};

// 8 个 fake analyzer (注入避免 require 真模型)
const analyzers = [
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
];

(async () => {
  // 注入 TechnicalAnalysisService anchors 需要 fake — service 内部还有一次直接 require 调用,
  // 这里通过传 customAnalyzers 隔离 analyzer 路径; loadTechnicalAnchors 失败时返回 {} 不影响.
  const engine = new AnalysisEngineService(fakeDS, analyzers);
  const decision = await engine.analyzeStock('sz.300750', {
    as_of: '2026-06-18',
    user_id: 1,
  });

  assert(decision.engine_variant === 'multi_dim_v1', 'engine_variant');
  assert(decision.stock_code === 'sz.300750', 'stock_code');
  assert(decision.per_dimension.length === 8, `8 analyzers ran (got ${decision.per_dimension.length})`);

  const seenKeys = new Set(decision.per_dimension.map(p => p.analyzer_key));
  const expected: AnalyzerKey[] = [
    'fundamental',
    'technical',
    'capital',
    'news',
    'sentiment',
    'industry_regime',
    'risk',
    'event',
  ];
  for (const k of expected) {
    assert(seenKeys.has(k), `analyzer ${k} present`);
  }

  // 所有 analyzer 都 no error (fake data 足够)
  const errored = decision.per_dimension.filter(d => d.error !== null);
  assert(errored.length === 0, `no analyzer errored (got ${errored.length}: ${errored.map(e => e.analyzer_key).join(',')})`);

  assert(
    decision.data_quality.level === 'good' || decision.data_quality.level === 'partial',
    `data_quality good or partial (got ${decision.data_quality.level})`
  );

  // bullish fixtures → action should be add/buy/strong_buy (not hold/sell)
  const goodActions = ['add', 'buy', 'strong_buy'];
  assert(
    goodActions.includes(decision.action),
    `bullish → action in [${goodActions.join(',')}] (got ${decision.action})`
  );

  assert(decision.overall_confidence > 0.3, `overall_confidence > 0.3 (got ${decision.overall_confidence})`);
  assert(decision.key_reasons.length > 0, 'key_reasons non-empty');
  assert(decision.suggested_position_pct > 0, `suggested_position_pct > 0 (got ${decision.suggested_position_pct})`);

  console.log(`\n${pass} passed, ${fail} failed.`);
  if (fail > 0) {
    console.error(`FAILURES:\n${failures.map(f => '  - ' + f).join('\n')}`);
    process.exit(1);
  } else {
    // Pretty print sample decision summary for posterity (PR snapshot)
    console.log('\n--- Sample decision ---');
    console.log(`action: ${decision.action}`);
    console.log(`confidence: ${decision.overall_confidence.toFixed(2)}`);
    console.log(`suggested_pct: ${decision.suggested_position_pct}`);
    console.log(`entry_zone: ${JSON.stringify(decision.entry_zone)}`);
    console.log(`key_reasons (top 5):`);
    for (const r of decision.key_reasons) console.log(`  - ${r}`);
    process.exit(0);
  }
})();
