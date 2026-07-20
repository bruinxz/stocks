import {
  AIPriceDecisionDataSource,
  AIPriceDecisionService,
  AIPriceMarketSnapshot,
  buildAIPriceDecisionPlan,
  calculateAIPriceIndicators,
  classifyAIPriceFreshness,
  selectAIPriceMarketSource,
} from '../../src/services/AIPriceDecisionService';
import type { AnalyzeSingleStockResult } from '../../src/services/AIAdvisorService';

let passed = 0;
let failed = 0;

function assert(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`FAIL ${name}${detail ? `: ${detail}` : ''}`);
  }
}

function equal(name: string, actual: unknown, expected: unknown): void {
  assert(
    name,
    JSON.stringify(actual) === JSON.stringify(expected),
    `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`
  );
}

function makeBars(count = 30) {
  return Array.from({ length: count }, (_, index) => {
    const close = 90 + index * 0.4;
    return {
      time: new Date(Date.UTC(2026, 5, index + 1)).toISOString(),
      open: close - 0.2,
      high: close + 1,
      low: close - 1,
      close,
    };
  });
}

function makeMarket(overrides: Partial<AIPriceMarketSnapshot> = {}): AIPriceMarketSnapshot {
  return {
    stock_code: 'sh.600519',
    stock_name: '贵州茅台',
    current_price: 102,
    change_percent: 1.2,
    previous_close: 100.8,
    day_open: 101,
    day_high: 103,
    day_low: 100.5,
    quote_time: '2026-07-20T02:00:00.000Z',
    quote_source: 'tencent',
    quote_age_minutes: 2,
    freshness: 'live',
    refresh_error: null,
    recent_bars: makeBars(),
    ...overrides,
  };
}

function makeAnalysis(overrides: Partial<AnalyzeSingleStockResult> = {}): AnalyzeSingleStockResult {
  return {
    report_id: 'AI-600519-test',
    stock_code: 'sh.600519',
    stock_name: '贵州茅台',
    dimensions: ['fundamental', 'technical', 'capital', 'news', 'sentiment'],
    summary: 'TradingAgents summary',
    recommendation: 'buy',
    confidence_score: 82,
    risk_level: '中',
    key_points: { technical: ['趋势向上'] },
    status: 'completed',
    task_id: 'task-1',
    target_date: '2026-07-20',
    error: null,
    generated_at: '2026-07-20T02:01:00.000Z',
    metadata: { task_label: 'test' },
    persisted: true,
    ...overrides,
  };
}

async function testFreshness(): Promise<void> {
  const now = new Date('2026-07-20T02:20:00.000Z');
  equal(
    '20 分钟内 live',
    classifyAIPriceFreshness('2026-07-20T02:05:00.000Z', now).freshness,
    'live'
  );
  equal(
    '同日超过 20 分钟 same_day',
    classifyAIPriceFreshness('2026-07-20T01:00:00.000Z', now).freshness,
    'same_day'
  );
  equal(
    '96 小时内 previous_close',
    classifyAIPriceFreshness('2026-07-17T07:00:00.000Z', now).freshness,
    'previous_close'
  );
  equal(
    '超过 96 小时 stale',
    classifyAIPriceFreshness('2026-07-10T07:00:00.000Z', now).freshness,
    'stale'
  );
}

async function testMarketSourceSelection(): Promise<void> {
  const now = new Date('2026-07-20T03:00:00.000Z');
  const quoteTime = '2026-07-20T02:59:00.000Z';
  const barTime = '2026-07-18T07:00:00.000Z';
  const stockTime = '2026-07-17T08:00:00.000Z';

  equal(
    '有效实时行情整组使用 quote 来源',
    selectAIPriceMarketSource({
      quote_price: 102.5,
      quote_time: quoteTime,
      quote_source: 'tencent',
      bar_price: 101,
      bar_time: barTime,
      stock_price: 99,
      stock_updated_at: stockTime,
      now,
    }),
    {
      current_price: 102.5,
      quote_time: quoteTime,
      quote_source: 'tencent',
      using_quote: true,
    }
  );

  equal(
    '无效 quote 回退日线且不保留 quote 时间来源',
    selectAIPriceMarketSource({
      quote_price: 0,
      quote_time: quoteTime,
      quote_source: 'tencent',
      bar_price: 101,
      bar_time: barTime,
      stock_price: 99,
      stock_updated_at: stockTime,
      now,
    }),
    {
      current_price: 101,
      quote_time: barTime,
      quote_source: 'daily_bar',
      using_quote: false,
    }
  );

  equal(
    '无 quote 和 bar 时回退股票快照',
    selectAIPriceMarketSource({
      quote_price: null,
      bar_price: -1,
      stock_price: 99,
      stock_updated_at: stockTime,
      now,
    }),
    {
      current_price: 99,
      quote_time: stockTime,
      quote_source: 'stock_snapshot',
      using_quote: false,
    }
  );

  equal(
    '所有价格无效时返回 null',
    selectAIPriceMarketSource({
      quote_price: 'bad',
      bar_price: 0,
      stock_price: null,
      now,
    }),
    null
  );

  equal(
    '无效来源时间安全回退到 now',
    selectAIPriceMarketSource({
      quote_price: null,
      bar_price: 101,
      bar_time: 'not-a-date',
      stock_price: 99,
      stock_updated_at: stockTime,
      now,
    })?.quote_time,
    now.toISOString()
  );
}

async function testIndicators(): Promise<void> {
  const indicators = calculateAIPriceIndicators(makeMarket());
  equal('使用 30 根有效 bars', indicators.bars_used, 30);
  assert('ATR 有效且为正', indicators.atr_14 > 0);
  assert('20 日支撑低于现价', (indicators.support_20 || 0) < 102);
  assert('20 日压力高于现价', (indicators.resistance_20 || 0) > 102);
  assert('20 日均线存在', indicators.sma_20 !== null);
  assert('20 日波动率存在', indicators.volatility_20 !== null);

  const fallback = calculateAIPriceIndicators(makeMarket({ recent_bars: [], change_percent: 3 }));
  equal('无 bars 时 bars_used=0', fallback.bars_used, 0);
  assert('无 bars 仍有保守 ATR fallback', fallback.atr_14 >= 2);
  equal('无 bars 无支撑', fallback.support_20, null);
}

async function testBuyPlan(): Promise<void> {
  const plan = buildAIPriceDecisionPlan({
    recommendation: 'buy',
    confidence_score: 82,
    risk_level: '中',
    market: makeMarket(),
    position_state: 'watching',
    planned_capital: 200_000,
  });
  equal('买入 action', plan.action, 'buy');
  equal('未持仓 position_action=open', plan.position_action, 'open');
  assert('买入区间存在', Array.isArray(plan.entry_zone));
  assert('买入区间不追高', (plan.entry_zone?.[1] || 0) <= plan.current_price);
  assert('止损低于买入区间', (plan.stop_loss || 0) < (plan.entry_zone?.[0] || 0));
  assert('卖出区间高于现价', plan.sell_zone[0] > plan.current_price);
  assert('风险收益比有效', (plan.risk_reward_ratio || 0) > 0);
  assert(
    '仓位上限在 1%-15%',
    (plan.suggested_position_pct || 0) >= 0.01 && (plan.suggested_position_pct || 0) <= 0.15
  );
  assert('整手数量为 100 的倍数', (plan.suggested_shares || 0) % 100 === 0);
  equal('模型版本', plan.model, 'tradingagents_price_v1');
}

async function testHoldingSellPlan(): Promise<void> {
  const plan = buildAIPriceDecisionPlan({
    recommendation: 'strong_sell',
    confidence_score: 90,
    risk_level: '高',
    market: makeMarket(),
    position_state: 'holding',
    holding_cost: 90,
  });
  equal('卖出 action', plan.action, 'strong_sell');
  equal('持仓卖出 position_action=close', plan.position_action, 'close');
  equal('卖出不返回买入区间', plan.entry_zone, null);
  equal('卖出不返回建议仓位', plan.suggested_position_pct, null);
  assert('卖出区间围绕现价', plan.sell_zone[0] <= plan.current_price);
  assert('成本浮盈为正', (plan.holding_pnl_pct || 0) > 0);
  assert(
    '高风险提示存在',
    plan.risk_warnings.some(item => item.includes('高风险'))
  );
}

async function testDegradedPlan(): Promise<void> {
  const plan = buildAIPriceDecisionPlan({
    recommendation: 'unknown',
    confidence_score: null,
    risk_level: null,
    market: makeMarket({ freshness: 'stale', recent_bars: makeBars(5) }),
  });
  equal('未知方向 unknown', plan.action, 'unknown');
  equal('过期+历史不足不可执行', plan.execution_ready, false);
  assert(
    '过期提示存在',
    plan.risk_warnings.some(item => item.includes('行情已过期'))
  );
  assert(
    '历史不足提示存在',
    plan.risk_warnings.some(item => item.includes('5 根'))
  );
}

async function testRiskAdjustedPosition(): Promise<void> {
  const base = buildAIPriceDecisionPlan({
    recommendation: 'buy',
    confidence_score: 85,
    risk_level: '中',
    market: makeMarket(),
    planned_capital: 500_000,
  });
  const volatileBars = Array.from({ length: 30 }, (_, index) => {
    const close = index % 2 === 0 ? 88 : 112;
    return {
      time: new Date(Date.UTC(2026, 5, index + 1)).toISOString(),
      open: close,
      high: close + 3,
      low: close - 3,
      close,
    };
  });
  const reduced = buildAIPriceDecisionPlan({
    recommendation: 'buy',
    confidence_score: 85,
    risk_level: '高',
    market: makeMarket({ recent_bars: volatileBars }),
    planned_capital: 500_000,
  });
  assert(
    '高风险高波动会降低仓位',
    (reduced.suggested_position_pct || 1) < (base.suggested_position_pct || 0)
  );
  assert(
    '高波动提示存在',
    reduced.risk_warnings.some(item => item.includes('波动率较高'))
  );
  assert(
    '高风险提示存在于降仓计划',
    reduced.risk_warnings.some(item => item.includes('仓位上限已折半'))
  );
}

async function testService(): Promise<void> {
  const enriched: Array<{ report_id: string; metadata: Record<string, unknown> }> = [];
  const dataSource: AIPriceDecisionDataSource = {
    async loadMarketSnapshot(_stockCode, options) {
      equal('默认刷新 quote', options.refresh_quote, true);
      return makeMarket();
    },
    async enrichReport(report_id, metadata) {
      enriched.push({ report_id, metadata });
    },
  };
  const analysisService = {
    async analyzeSingleStock() {
      return makeAnalysis();
    },
  };
  const service = new AIPriceDecisionService(analysisService as any, dataSource);
  const result = await service.analyze('sh.600519', {
    position_state: 'watching',
    planned_capital: 100_000,
  });
  assert('service 返回行情', result.market_snapshot?.current_price === 102);
  assert('service 返回 price_decision', result.price_decision !== null);
  equal('service metadata action', result.metadata.action, 'buy');
  equal('service metadata current_price', result.metadata.current_price, 102);
  equal('service 追加归档一次', enriched.length, 1);
  equal('service 追加正确 report_id', enriched[0].report_id, result.report_id);
  assert('归档不包含 recent_bars', !JSON.stringify(enriched[0].metadata).includes('recent_bars'));

  const failedService = new AIPriceDecisionService(
    {
      async analyzeSingleStock() {
        return makeAnalysis({ status: 'failed', persisted: true });
      },
    } as any,
    dataSource
  );
  const failedResult = await failedService.analyze('sh.600519');
  equal('AI failed 不生成价格计划', failedResult.price_decision, null);
}

async function main(): Promise<void> {
  await testMarketSourceSelection();
  await testFreshness();
  await testIndicators();
  await testBuyPlan();
  await testHoldingSellPlan();
  await testDegradedPlan();
  await testRiskAdjustedPosition();
  await testService();
  console.log(`\nai-price-decision-service.test.ts: ${passed} ok / ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
