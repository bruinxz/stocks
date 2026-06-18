/**
 * analysis-engine/analyzers.test.ts —— 8 个 analyzer 的 happy + data_missing 组合测试.
 *
 * 每个 analyzer 测:
 *   - happy: 给齐输入, 期望非 0 score / confidence > 0 / 无 error.
 *   - data_missing: 关键字段缺失, 期望 data_missing 显式列出 + confidence 下调.
 *
 * 全部用注入 fake DataSource, 零 DB 零网络.
 */

import { FundamentalAnalyzer } from '../../../src/services/analysis-engine/analyzers/FundamentalAnalyzer';
import { TechnicalAnalyzer } from '../../../src/services/analysis-engine/analyzers/TechnicalAnalyzer';
import { CapitalAnalyzer } from '../../../src/services/analysis-engine/analyzers/CapitalAnalyzer';
import { NewsAnalyzer } from '../../../src/services/analysis-engine/analyzers/NewsAnalyzer';
import { SentimentAnalyzer } from '../../../src/services/analysis-engine/analyzers/SentimentAnalyzer';
import { IndustryRegimeAnalyzer } from '../../../src/services/analysis-engine/analyzers/IndustryRegimeAnalyzer';
import { RiskAnalyzer } from '../../../src/services/analysis-engine/analyzers/RiskAnalyzer';
import { EventAnalyzer } from '../../../src/services/analysis-engine/analyzers/EventAnalyzer';
import type { AnalyzerContext } from '../../../src/services/analysis-engine/AnalyzerTypes';

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

function baseCtx(): AnalyzerContext {
  const bars = [];
  let p = 100;
  for (let i = 0; i < 60; i += 1) {
    p *= 1 + (Math.random() - 0.5) * 0.02;
    bars.push({
      time: new Date(2026, 3, i + 1).toISOString(),
      open: p,
      high: p * 1.01,
      low: p * 0.99,
      close: p,
      volume: 1_000_000,
      turnover: 100_000_000,
    });
  }
  return {
    stock: {
      code: 'sz.300750',
      name: '宁德时代',
      industry: '电池',
      market_segment: 'chinext',
    },
    as_of: '2026-06-18',
    daily_bars: bars,
    realtime_quote: {
      price: p,
      bid: p - 0.01,
      ask: p + 0.01,
      volume: 5000,
      as_of_ts: new Date().toISOString(),
    },
    market_env: {
      market_regime: 'bull',
      market_regime_label: '牛市',
      industry: { regime: 'hot', label: '热门', relative_return_20d_pct: 8 },
    },
    factor_snapshot: {
      value: 0.8,
      growth: 1.5,
      quality: 1.2,
      quality_high: 0.6,
      analyst_consensus: 1.0,
      earnings_surprise: 0.5,
      northbound: 1.4,
      money_flow: 1.1,
      insider_trade: 0.3,
      margin_flow: 0.2,
      dragon_tiger: 0.5,
      block_trade_signal: 0.1,
      fund_consensus: 0.9,
      east_money_qa: 0.7,
      concept_heat: 1.2,
      shareholder_concentration: 0.4,
      industry_momentum: 1.6,
      liquidity: 1.0,
      low_vol: 0.5,
    },
  };
}

(async () => {
  // 1. FundamentalAnalyzer happy
  const fa = new FundamentalAnalyzer({
    async loadIndustryPeerScores() {
      return [
        { stock_code: '300750', z: 0.8 },
        { stock_code: '300751', z: 0.2 },
        { stock_code: '300752', z: -0.5 },
      ];
    },
  });
  const ctx = baseCtx();
  const fundOut = await fa.analyze(ctx);
  assert(fundOut.error === null, 'fundamental happy: no error');
  assert(fundOut.confidence > 0.5, `fundamental happy: confidence > 0.5 (${fundOut.confidence})`);
  assert(Math.abs(fundOut.score) > 0, `fundamental happy: score != 0 (${fundOut.score})`);
  assert(fundOut.evidence.length > 0, 'fundamental happy: evidence non-empty');

  // 2. FundamentalAnalyzer data_missing
  const ctxMissing = baseCtx();
  ctxMissing.factor_snapshot = {};
  const fundMissing = await fa.analyze(ctxMissing);
  assert(
    fundMissing.data_missing.length >= 3,
    `fundamental missing: data_missing >= 3 (${fundMissing.data_missing.length})`
  );
  assert(fundMissing.confidence === 0, `fundamental missing: confidence=0 (${fundMissing.confidence})`);

  // 3. TechnicalAnalyzer happy
  const ta = new TechnicalAnalyzer({
    async analyze() {
      return {
        trend: 'uptrend',
        support_levels: [95],
        resistance_levels: [120],
        buy_zone: [98, 102],
        sell_zone: [118, 122],
        confidence: 0.7,
        indicators_snapshot: {
          last_rsi: 65,
          last_macd: { dif: 1, dea: 0.5, hist: 0.5 },
          vol_ratio: 1.3,
        },
        summary: 'uptrend',
        status: 'completed',
        nlp_engine: 'fake',
        generated_at: new Date().toISOString(),
      };
    },
  });
  const techOut = await ta.analyze(ctx);
  assert(techOut.error === null, 'technical happy: no error');
  assert(techOut.score > 0, `technical happy: score > 0 (${techOut.score})`);
  assert(techOut.confidence === 0.7, `technical happy: confidence=0.7 (${techOut.confidence})`);

  // 4. TechnicalAnalyzer data_missing (daily_bars < 20)
  const ctxNoBars = baseCtx();
  ctxNoBars.daily_bars = ctxNoBars.daily_bars.slice(0, 5);
  const techMissing = await ta.analyze(ctxNoBars);
  assert(
    techMissing.data_missing.includes('daily_bars'),
    'technical missing: daily_bars listed'
  );
  assert(techMissing.confidence === 0, 'technical missing: confidence=0');

  // 5. CapitalAnalyzer happy
  const ca = new CapitalAnalyzer();
  const capOut = await ca.analyze(ctx);
  assert(capOut.error === null, 'capital happy: no error');
  assert(capOut.confidence > 0.5, `capital happy: confidence > 0.5 (${capOut.confidence})`);

  // 6. CapitalAnalyzer missing
  const ctxNoCap = baseCtx();
  ctxNoCap.factor_snapshot = {};
  ctxNoCap.realtime_quote = undefined;
  const capMissing = await ca.analyze(ctxNoCap);
  assert(
    capMissing.data_missing.length >= 5,
    `capital missing: data_missing >= 5 (${capMissing.data_missing.length})`
  );
  assert(capMissing.confidence < 0.5, `capital missing: confidence < 0.5`);

  // 7. NewsAnalyzer happy
  const na = new NewsAnalyzer({
    async listAnnouncementsByStock() {
      return [
        { ann_date: '2026-06-15', sentiment: '正面', short_title: '业绩超预期' },
        { ann_date: '2026-06-10', sentiment: '正面', short_title: '签约大订单' },
        { ann_date: '2026-06-01', sentiment: '中性', short_title: '股东大会' },
      ];
    },
    async listRecentNewsByStock() {
      return [{ title: '行业利好', publish_time: null, sentiment_score: 0.6 }];
    },
    async aggregateKOLForStock() {
      return [{ sentiment_score: 0.3 }, { sentiment_score: 0.5 }];
    },
  });
  const newsOut = await na.analyze(ctx);
  assert(newsOut.error === null, 'news happy: no error');
  assert(newsOut.score > 0, `news happy: score > 0 (${newsOut.score})`);
  assert(newsOut.confidence > 0.5, 'news happy: confidence > 0.5');

  // 8. NewsAnalyzer missing
  const naEmpty = new NewsAnalyzer({
    async listAnnouncementsByStock() {
      return [];
    },
    async listRecentNewsByStock() {
      return [];
    },
    async aggregateKOLForStock() {
      return [];
    },
  });
  const newsMissing = await naEmpty.analyze(ctx);
  assert(
    newsMissing.data_missing.includes('announcements'),
    'news missing: announcements listed'
  );
  assert(newsMissing.confidence === 0, 'news missing: confidence=0');

  // 9. SentimentAnalyzer happy
  const sa = new SentimentAnalyzer({
    async getMarketSentimentPercentile() {
      return 40; // 市场略偏冷
    },
  });
  const sentOut = await sa.analyze(ctx);
  assert(sentOut.error === null, 'sentiment happy: no error');
  assert(sentOut.confidence > 0, 'sentiment happy: confidence > 0');

  // 10. SentimentAnalyzer missing
  const ctxNoSent = baseCtx();
  ctxNoSent.factor_snapshot = {};
  const saNoBase = new SentimentAnalyzer({
    async getMarketSentimentPercentile() {
      return null;
    },
  });
  const sentMissing = await saNoBase.analyze(ctxNoSent);
  assert(
    sentMissing.data_missing.includes('factor.east_money_qa'),
    'sentiment missing: east_money_qa listed'
  );
  assert(sentMissing.confidence === 0, 'sentiment missing: confidence=0');

  // 11. IndustryRegimeAnalyzer happy
  const ira = new IndustryRegimeAnalyzer();
  const indOut = await ira.analyze(ctx);
  assert(indOut.error === null, 'industry_regime happy: no error');
  assert(indOut.score > 0, `industry_regime happy: bull+hot → score > 0 (${indOut.score})`);

  // 12. IndustryRegimeAnalyzer missing
  const ctxNoEnv = baseCtx();
  ctxNoEnv.market_env = undefined;
  ctxNoEnv.factor_snapshot = {};
  const indMissing = await ira.analyze(ctxNoEnv);
  assert(indMissing.data_missing.includes('market_env'), 'industry_regime missing: market_env listed');
  assert(indMissing.confidence === 0, 'industry_regime missing: confidence=0');

  // 13. RiskAnalyzer happy (低风险股)
  const ra = new RiskAnalyzer();
  const riskOut = await ra.analyze(ctx);
  assert(riskOut.error === null, 'risk happy: no error');
  assert(riskOut.event_action !== 'veto', 'risk happy: no veto');
  assert(riskOut.score > 0, `risk happy: score > 0 (${riskOut.score})`);

  // 14. RiskAnalyzer ST 名 → veto
  const ctxSt = baseCtx();
  ctxSt.stock.name = 'ST长油';
  const riskSt = await ra.analyze(ctxSt);
  assert(riskSt.event_action === 'veto', 'risk ST: event_action=veto');
  assert(riskSt.score === -100, `risk ST: score=-100 (${riskSt.score})`);

  // 15. RiskAnalyzer 行情陈旧 → veto
  const ctxStale = baseCtx();
  ctxStale.realtime_quote = {
    ...(ctxStale.realtime_quote as any),
    as_of_ts: new Date(Date.now() - 60 * 60 * 1000).toISOString(), // 60 min ago
  };
  const riskStale = await ra.analyze(ctxStale);
  assert(riskStale.event_action === 'veto', 'risk stale: event_action=veto');

  // 16. EventAnalyzer happy (allow)
  const ea = new EventAnalyzer({
    async filter() {
      return {
        symbol: 'sz.300750',
        action: 'allow',
        score_multiplier: 1,
        delay_minutes: 0,
        events: [],
        reason: 'no events',
      };
    },
  });
  const evOut = await ea.analyze(ctx);
  assert(evOut.error === null, 'event happy: no error');
  assert(evOut.event_action === 'allow', `event happy: event_action=allow (${evOut.event_action})`);

  // 17. EventAnalyzer veto
  const eaVeto = new EventAnalyzer({
    async filter() {
      return {
        symbol: 'sz.300750',
        action: 'veto',
        score_multiplier: 0,
        delay_minutes: 0,
        events: [
          {
            event_type: 'st_warning',
            action_hint: 'veto',
            score_multiplier: 0,
            reason: 'ST',
          },
        ],
        reason: 'ST warning',
      };
    },
  });
  const evVetoOut = await eaVeto.analyze(ctx);
  assert(evVetoOut.event_action === 'veto', 'event veto: event_action=veto');
  assert(evVetoOut.score === -100, `event veto: score=-100 (${evVetoOut.score})`);

  // 18. EventAnalyzer data source failure → data_missing
  const eaErr = new EventAnalyzer({
    async filter() {
      throw new Error('event source down');
    },
  });
  const evErrOut = await eaErr.analyze(ctx);
  assert(
    evErrOut.data_missing.includes('event_intelligence'),
    'event err: data_missing includes event_intelligence'
  );
  assert(evErrOut.confidence === 0, 'event err: confidence=0');

  console.log(`\n${pass} passed, ${fail} failed.`);
  if (fail > 0) {
    console.error(`FAILURES:\n${failures.map(f => '  - ' + f).join('\n')}`);
    process.exit(1);
  } else {
    process.exit(0);
  }
})();
