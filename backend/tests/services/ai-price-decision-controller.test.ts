import {
  AIAdvisorController,
  serializeAIStockAnalysisReport,
} from '../../src/api/controllers/AIAdvisorController';
import { aiPriceDecisionService } from '../../src/services/AIPriceDecisionService';

let passed = 0;
let failed = 0;

function assert(name: string, condition: boolean, detail = ''): void {
  if (condition) passed += 1;
  else {
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

function createResponse() {
  const state: { status_code: number; body: any } = { status_code: 200, body: null };
  const response = {
    status(code: number) {
      state.status_code = code;
      return response;
    },
    json(body: any) {
      state.body = body;
      return response;
    },
  };
  return { response, state };
}

function completedResult(overrides: Record<string, unknown> = {}) {
  return {
    report_id: 'AI-600519-controller',
    stock_code: 'sh.600519',
    stock_name: '贵州茅台',
    dimensions: ['technical'],
    summary: '研究摘要',
    recommendation: 'buy',
    confidence_score: 80,
    risk_level: '中',
    key_points: { technical: ['趋势向上'] },
    status: 'completed',
    task_id: null,
    target_date: '2026-07-20',
    error: null,
    generated_at: '2026-07-20T02:00:00.000Z',
    metadata: {},
    persisted: true,
    market_snapshot: { current_price: 100 },
    price_decision: { action: 'buy' },
    ...overrides,
  };
}

async function main(): Promise<void> {
  const archived = serializeAIStockAnalysisReport({
    report_id: 'AI-600519-archived',
    key_points_json: { technical: ['历史趋势向上'] },
    metadata: {
      market_snapshot: { current_price: 101.25, quote_source: 'realtime_quotes' },
      price_decision: { action: 'buy', entry_zone: [98, 100] },
    },
  });
  equal('归档报告恢复 key_points DTO', archived.key_points, {
    technical: ['历史趋势向上'],
  });
  equal('归档报告保留 key_points_json 兼容字段', archived.key_points_json, {
    technical: ['历史趋势向上'],
  });
  equal('归档报告恢复行情快照', (archived.market_snapshot as any)?.current_price, 101.25);
  equal('归档报告恢复价格计划', (archived.price_decision as any)?.action, 'buy');
  equal('归档报告标记已持久化', archived.persisted, true);

  const controller = new AIAdvisorController();
  const originalAnalyze = (aiPriceDecisionService as any).analyze;

  try {
    let serviceCalls = 0;
    (aiPriceDecisionService as any).analyze = async () => {
      serviceCalls += 1;
      return completedResult();
    };

    const missing = createResponse();
    await controller.analyzePriceDecision(
      { body: {}, user: { id: 7 } } as any,
      missing.response as any,
      (() => undefined) as any
    );
    equal('缺少 stock_code 返回 400', missing.state.status_code, 400);
    equal('缺少 stock_code 不调用 service', serviceCalls, 0);

    (controller as any).resolveTicker = async () => null;
    const unknown = createResponse();
    await controller.analyzePriceDecision(
      { body: { stock_code: '不存在股票' } } as any,
      unknown.response as any,
      (() => undefined) as any
    );
    equal('无法识别股票返回 404', unknown.state.status_code, 404);
    equal('无法识别股票不调用 service', serviceCalls, 0);

    const captured: Array<{ stock_code: string; options: Record<string, unknown> }> = [];
    (controller as any).resolveTicker = async () => 'sh.600519';
    (aiPriceDecisionService as any).analyze = async (
      stock_code: string,
      options: Record<string, unknown>
    ) => {
      captured.push({ stock_code, options });
      return completedResult();
    };

    const valid = createResponse();
    await controller.analyzePriceDecision(
      {
        body: {
          stock_code: '600519',
          dimensions: ['technical', 'invalid'],
          position_state: 'holding',
          planned_capital: 500_000,
          holding_cost: 120.5,
          refresh_quote: false,
        },
        user: { id: 23 },
      } as any,
      valid.response as any,
      (() => undefined) as any
    );
    equal('有效请求返回 success', valid.state.body?.success, true);
    equal('股票代码使用解析值', captured[0]?.stock_code, 'sh.600519');
    equal('合法计划资金透传', captured[0]?.options.planned_capital, 500_000);
    equal('合法持仓成本透传', captured[0]?.options.holding_cost, 120.5);
    equal('持仓状态透传', captured[0]?.options.position_state, 'holding');
    equal('用户 ID 透传', captured[0]?.options.user_id, 23);
    equal('可关闭行情刷新', captured[0]?.options.refresh_quote, false);
    equal('非法维度被过滤', captured[0]?.options.dimensions, ['technical']);

    const clamped = createResponse();
    await controller.analyzePriceDecision(
      {
        body: {
          stock_code: '600519',
          position_state: 'unexpected',
          planned_capital: 1_000_000_001,
          holding_cost: -1,
        },
      } as any,
      clamped.response as any,
      (() => undefined) as any
    );
    equal('越界计划资金丢弃', captured[1]?.options.planned_capital, undefined);
    equal('非法持仓成本丢弃', captured[1]?.options.holding_cost, undefined);
    equal('非法场景退回 watching', captured[1]?.options.position_state, 'watching');
    equal('行情刷新默认开启', captured[1]?.options.refresh_quote, true);

    (aiPriceDecisionService as any).analyze = async () =>
      completedResult({
        status: 'failed',
        error: 'TradingAgents timeout',
        market_snapshot: null,
        price_decision: null,
      });
    const upstreamFailed = createResponse();
    await controller.analyzePriceDecision(
      { body: { stock_code: '600519' } } as any,
      upstreamFailed.response as any,
      (() => undefined) as any
    );
    equal('TradingAgents failed 不伪装成功', upstreamFailed.state.body?.success, false);
    assert(
      'TradingAgents failed 返回可读错误',
      String(upstreamFailed.state.body?.message || '').includes('TradingAgents timeout')
    );

    (aiPriceDecisionService as any).analyze = async () =>
      completedResult({ market_snapshot: null, price_decision: null });
    const noMarket = createResponse();
    await controller.analyzePriceDecision(
      { body: { stock_code: '600519' } } as any,
      noMarket.response as any,
      (() => undefined) as any
    );
    equal('研究成功但行情缺失仍返回报告', noMarket.state.body?.success, true);
    assert(
      '行情缺失返回明确提示',
      String(noMarket.state.body?.message || '').includes('缺少可用行情')
    );
  } finally {
    (aiPriceDecisionService as any).analyze = originalAnalyze;
  }

  console.log(`\nai-price-decision-controller.test.ts: ${passed} ok / ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
