import fs from 'fs';
import path from 'path';

let passed = 0;
let failed = 0;

function assert(name: string, condition: boolean): void {
  if (condition) passed += 1;
  else {
    failed += 1;
    console.error(`FAIL ${name}`);
  }
}

const root = path.resolve(__dirname, '../../..');
const read = (relative: string) => fs.readFileSync(path.join(root, relative), 'utf8');

const routes = read('backend/src/api/routes/ai.routes.ts');
const controller = read('backend/src/api/controllers/AIAdvisorController.ts');
const frontendService = read('frontend/src/services/aiStockAnalysisService.ts');
const modal = read('frontend/src/components/trading/AIStockAnalysisModal.tsx');
const card = read('frontend/src/components/trading/AIPriceDecisionCard.tsx');
const agentMarket = read('ai/tradingagents-app/tradingagents/agents/analysts/market_analyst.py');
const agentTrader = read('ai/tradingagents-app/tradingagents/agents/trader/trader.py');

assert('price-decision route exists', routes.includes("'/price-decision'"));
assert(
  'price-decision route authenticated',
  /'\/price-decision',[\s\S]*authController\.authenticate[\s\S]*analyzePriceDecision/.test(routes)
);
assert('controller delegates to service', controller.includes('aiPriceDecisionService.analyze'));
assert('controller clamps planned capital', controller.includes('plannedCapital <= 1_000_000_000'));
assert('frontend calls endpoint', frontendService.includes("'/ai/price-decision'"));
assert('modal uses price decision API', modal.includes('analyzePriceDecision'));
assert(
  'modal collects watching/holding state',
  modal.includes("value: 'watching'") && modal.includes("value: 'holding'")
);
assert('result renders price card', modal.includes('<AIPriceDecisionCard'));
assert('card shows buy zone', card.includes('计划买入区间'));
assert('card shows sell zone', card.includes('计划卖出区间'));
assert('card shows quote timestamp', card.includes('market.quote_time'));
assert('card carries disclaimer', card.includes('不构成投资建议'));
assert(
  'TradingAgents market analyst can call realtime quote',
  agentMarket.includes('get_realtime_quotes')
);
assert('TradingAgents trader can call realtime quote', agentTrader.includes('get_realtime_quotes'));

console.log(`\nai-price-decision-contract.test.ts: ${passed} ok / ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
