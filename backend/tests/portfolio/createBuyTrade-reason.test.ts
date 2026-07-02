/**
 * createBuyTrade / SELL reason 注入路径 META 测试 (AL-3, 2026-06-21)
 *
 *   cd backend && npx ts-node --transpile-only tests/portfolio/createBuyTrade-reason.test.ts
 *
 * 不接 DB — 用 fs + regex 验证 6 个写入入口都注入了 trade_reason / summary, 防止
 * 后续 refactor 把 trade_reason 写丢. 同时 import builder 跑 smoke test 验证
 * "把 signal / guard 上下文喂进去能产出合法的 reason".
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  buildTradeReasonFromSignal,
  buildTradeReasonFromRiskGuard,
  buildTradeReasonForManualOrder,
  summarizeTradeReason,
} from '../../src/portfolio/internal/tradeReasonBuilder';

let passed = 0;
let failed = 0;
function assert(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL ${name}${detail ? ' — ' + detail : ''}`);
  }
}

const ROOT = path.resolve(__dirname, '../../');

function readSrc(rel: string): string {
  return fs.readFileSync(path.resolve(ROOT, rel), 'utf8');
}

// =====================================================
// [1] PaperTradingFacade BUY + SELL 都写 trade_reason
// =====================================================
function test_facade_buy_sell_wired() {
  const src = readSrc('src/portfolio/PaperTradingFacade.ts');
  // BUY create 块
  const buyBlock = src.match(/direction:\s*'BUY'[\s\S]{0,500}trade_reason:\s*facadeResolveTradeReason/);
  assert('facade.BUY_has_trade_reason', !!buyBlock);
  // SELL create 块
  const sellBlock = src.match(/direction:\s*'SELL'[\s\S]{0,500}trade_reason:\s*facadeResolveTradeReason/);
  assert('facade.SELL_has_trade_reason', !!sellBlock);
  // facadeResolveTradeReason 函数定义存在
  assert(
    'facade.has_resolve_helper',
    /function facadeResolveTradeReason\(/.test(src)
  );
  // closePosition 透传 trade_reason
  assert(
    'facade.closePosition_passes_reason',
    /async closePosition\(options: ClosePositionOptions\)[\s\S]{0,3000}trade_reason:\s*\n?\s*options\.trade_reason/.test(
      src
    )
  );
}

// =====================================================
// [2] PaperTradingAutomationService.createBuyTrade + createSellTrade
// =====================================================
function test_automation_buy_sell_wired() {
  const src = readSrc('src/portfolio/internal/PaperTradingAutomationService.ts');
  // createBuyTrade 写 BUY trade_reason
  assert(
    'auto.createBuyTrade_has_reason',
    /direction:\s*'BUY'[\s\S]{0,400}trade_reason:\s*buildTradeReasonFromSignal/.test(src)
  );
  // createSellTrade 写 SELL trade_reason (经 exit_reason)
  assert(
    'auto.createSellTrade_has_reason',
    /direction:\s*'SELL'[\s\S]{0,400}trade_reason:\s*\(\(\)\s*=>/.test(src) &&
      /buildTradeReasonFromRiskGuard\(params\.exit_reason/.test(src)
  );
  // caller 调 createSellTrade 时传 exit_reason
  assert(
    'auto.caller_passes_exit_reason',
    /createSellTrade\(\{[\s\S]{0,800}exit_reason:\s*exitReason/.test(src)
  );
}

// =====================================================
// [3] GuardSellExecutor → facade.placeOrder 传 trade_reason
// =====================================================
function test_guard_sell_executor_wired() {
  const src = readSrc('src/portfolio/risk/GuardSellExecutor.ts');
  assert(
    'gse.imports_builder',
    /from '\.\.\/internal\/tradeReasonBuilder'/.test(src)
  );
  assert(
    'gse.placeOrder_has_reason',
    /placeOrder\(\{[\s\S]{0,500}trade_reason:\s*reason/.test(src)
  );
  assert(
    'gse.builds_from_guard',
    /buildTradeReasonFromRiskGuard\(trig\.trigger_kind/.test(src)
  );
}

// =====================================================
// [4] IndustryConcentrationGuard closePosition reason
// =====================================================
function test_industry_guard_wired() {
  const src = readSrc('src/portfolio/risk/IndustryConcentrationGuard.ts');
  assert(
    'icg.closePosition_has_reason',
    /closePosition\(\{[\s\S]{0,400}trade_reason:\s*reason/.test(src)
  );
  assert(
    'icg.uses_industry_concentration_source',
    /buildTradeReasonFromRiskGuard\(['"]industry_concentration['"]/.test(src)
  );
}

// =====================================================
// [5] RebalanceEngine executeOrder reason
// =====================================================
function test_rebalance_engine_wired() {
  const src = readSrc('src/portfolio/RebalanceEngine.ts');
  assert(
    'reb.placeOrder_has_reason',
    /placeOrder\(\{[\s\S]{0,400}trade_reason:\s*reason/.test(src)
  );
  assert(
    'reb.uses_rebalance_source',
    /buildTradeReasonFromRiskGuard\(['"]rebalance['"]/.test(src)
  );
}

// =====================================================
// [6] TodaySignalsService → placeOrder reason
// =====================================================
function test_today_signals_wired() {
  const src = readSrc('src/services/TodaySignalsService.ts');
  assert(
    'today.placeOrder_has_reason',
    /placeOrder\(\{[\s\S]{0,400}trade_reason:\s*reason/.test(src)
  );
  assert(
    'today.uses_builder',
    /buildTradeReasonFromSignal\(\{/.test(src)
  );
}

// =====================================================
// [7] Model 字段
// =====================================================
function test_model_fields() {
  const src = readSrc('src/models/PaperTradingTrade.ts');
  assert('model.has_trade_reason_jsonb', /declare trade_reason:\s*Record<string,\s*any>/.test(src));
  assert(
    'model.has_summary_text',
    /declare trade_reason_summary:\s*string \| null/.test(src)
  );
  assert(
    'model.jsonb_decorator',
    /DataType\.JSONB[\s\S]{0,200}field:\s*'trade_reason'/.test(src)
  );
}

// =====================================================
// [8] Migration 文件存在 + 字段名 + comments
// =====================================================
function test_migration_present() {
  const up = readSrc('scripts/migrations/2026-06-21-paper-trading-trade-reason.sql');
  assert(
    'mig.up_has_jsonb',
    /ADD COLUMN IF NOT EXISTS trade_reason JSONB/.test(up)
  );
  assert(
    'mig.up_has_summary',
    /ADD COLUMN IF NOT EXISTS trade_reason_summary TEXT/.test(up)
  );
  assert('mig.up_has_index', /CREATE INDEX IF NOT EXISTS idx_paper_trading_trades_reason_source/.test(up));
  const down = readSrc('scripts/migrations/2026-06-21-paper-trading-trade-reason-rollback.sql');
  assert('mig.down_drops_index', /DROP INDEX IF EXISTS idx_paper_trading_trades_reason_source/.test(down));
  assert('mig.down_drops_summary', /DROP COLUMN IF EXISTS trade_reason_summary/.test(down));
  assert('mig.down_drops_reason', /DROP COLUMN IF EXISTS trade_reason/.test(down));
}

// =====================================================
// [9] Smoke test — builder + summary 全链路
// =====================================================
function test_full_chain_smoke() {
  // BUY 链路
  const buyReason = buildTradeReasonFromSignal(
    {
      id: 100,
      strategy_key: 'etf_factor_rotation',
      confidence_score: 80,
      reasons: ['北向 +2.3 亿', 'PE 12.3 低估', 'MA20 突破'],
      market_environment: { market_regime: 'up' },
    } as any
  );
  assert('smoke.buy.source', buyReason.source === 'auto_buy_from_signals');
  assert('smoke.buy.reasons_3plus', buyReason.key_reasons.length >= 3);
  const buySummary = summarizeTradeReason(buyReason);
  assert('smoke.buy.summary_starts', buySummary.startsWith('买入:'));
  assert('smoke.buy.summary_has_3_reasons', /北向|PE|MA20/.test(buySummary));

  // SELL trailing_stop 链路
  const sellReason = buildTradeReasonFromRiskGuard('trailing_stop', {
    threshold: 7,
    actual: 8.2,
    indicator: 'drawdown_pct',
    position: { symbol: '600519', quantity: 100, avg_cost: 1700, current_price: 1560 },
  });
  const sellSummary = summarizeTradeReason(sellReason);
  assert('smoke.sell.starts', sellSummary.startsWith('卖出:'));
  assert('smoke.sell.has_threshold', sellSummary.includes('阈 7'));
  // ≥ 3 条理由 (evidence > 3)
  assert('smoke.sell.evidence_3plus', sellReason.evidence.length >= 3);

  // manual 链路
  const manualReason = buildTradeReasonForManualOrder({ reason: '看好低估反弹' });
  assert('smoke.manual.summary', summarizeTradeReason(manualReason).includes('看好低估反弹'));
}

// =====================================================
// [10] 前端类型 + 组件存在
// =====================================================
function test_frontend_artifacts() {
  const svcSrc = fs.readFileSync(
    path.resolve(ROOT, '../frontend/src/services/portfolioWorkspaceService.ts'),
    'utf8'
  );
  assert('fe.svc_has_TradeReasonPayload', /export interface TradeReasonPayload/.test(svcSrc));
  assert('fe.svc_TradeRow_has_reason', /trade_reason\?:\s*TradeReasonPayload/.test(svcSrc));

  const cellSrc = fs.readFileSync(
    path.resolve(ROOT, '../frontend/src/components/trading/TradeReasonCell.tsx'),
    'utf8'
  );
  assert('fe.cell_exists', cellSrc.length > 100);
  assert('fe.cell_default_export', /export default TradeReasonCell/.test(cellSrc));

  const wsSrc = fs.readFileSync(
    path.resolve(ROOT, '../frontend/src/pages/workspace/PortfolioWorkspace.tsx'),
    'utf8'
  );
  assert('fe.workspace_imports_cell', /import TradeReasonCell from/.test(wsSrc));
  assert('fe.workspace_uses_cell', /<TradeReasonCell\s/.test(wsSrc));

  const modalSrc = fs.readFileSync(
    path.resolve(ROOT, '../frontend/src/components/trading/AIStockAnalysisModal.tsx'),
    'utf8'
  );
  assert('fe.modal_imports_cell', /import TradeReasonCell from/.test(modalSrc));
}

// =====================================================
// runner
// =====================================================
(function main() {
  console.log('## [1] PaperTradingFacade BUY+SELL wired');
  test_facade_buy_sell_wired();

  console.log('## [2] PaperTradingAutomationService createBuy/SellTrade wired');
  test_automation_buy_sell_wired();

  console.log('## [3] GuardSellExecutor wired');
  test_guard_sell_executor_wired();

  console.log('## [4] IndustryConcentrationGuard wired');
  test_industry_guard_wired();

  console.log('## [5] RebalanceEngine wired');
  test_rebalance_engine_wired();

  console.log('## [6] TodaySignalsService wired');
  test_today_signals_wired();

  console.log('## [7] Model fields');
  test_model_fields();

  console.log('## [8] Migration present');
  test_migration_present();

  console.log('## [9] Builder smoke test');
  test_full_chain_smoke();

  console.log('## [10] Frontend artifacts');
  test_frontend_artifacts();

  console.log(`\n# summary: ${passed} ok, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
