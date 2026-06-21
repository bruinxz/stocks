/**
 * US-123 [PM-010] PortfolioWorkspace 归因卡 — pure helper + META-GUARD 单测.
 *
 * 不依赖 jest / DB / 网络 / React / antd / recharts; 直接跑:
 *   cd backend && npx ts-node --transpile-only tests/services/portfolio-attribution-card-helpers.test.ts
 *
 * 跨 monorepo import frontend 的 pure helper (与 [[shadowRunHelpers]] /
 * [[dailyAttributionHelpers]] 同款), helper 不依赖 React/antd 所以 ts-node
 * 能直接吃.
 *
 * 覆盖维度:
 *   [1] 常量 sanity (颜色 / 维度顺序 / cap / 标签)
 *   [2] safeNumber / pickAttributionColor 工具函数
 *   [3] extractDimensionContribs — null / 缺字段 / 完整 6 维 / industry_contrib 聚合 / 执行成本符号反向
 *   [4] buildAttributionPieData — 全 0 / 单一非 0 / 多维度混合 / 排序稳定
 *   [5] normalizeBestWorstTrades — null / 非数组 / 缺字段 fallback / cap 3
 *   [6] buildAttributionAiSummaryFallback — 短/长截断/负值/null pct
 *   [7] buildPortfolioAttributionCardViewModel — AC 主验收 4 case:
 *       (a) report=null → hidden=true 完整空 vm
 *       (b) 完整 happy path → 6 维 pie + best/worst + AI summary
 *       (c) status=skipped → statusReason 透传 + vm 仍可渲染
 *       (d) ai_summary 空 → aiSummaryIsBackend=false + fallback 含日期/总盈亏/笔数
 *   [8] META-GUARD fs+regex:
 *       (a) portfolioWorkspaceService 含 getDailyAttributionReport export
 *       (b) PortfolioWorkspace.tsx 含 import + buildPortfolioAttributionCardViewModel + DailyAttributionReportRow type
 *       (c) PortfolioWorkspace.tsx 渲染 <BackendAttributionCard ... /> + 404 fallback Alert
 *       (d) helper 主要 export 都在
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  ATTRIBUTION_POSITIVE_COLOR,
  ATTRIBUTION_NEGATIVE_COLOR,
  ATTRIBUTION_NEUTRAL_COLOR,
  ATTRIBUTION_DIMENSION_ORDER,
  ATTRIBUTION_DIMENSION_LABEL,
  ATTRIBUTION_TOP_TRADE_LIMIT,
  ATTRIBUTION_AI_SUMMARY_MAX_CHARS,
  safeNumber,
  pickAttributionColor,
  extractDimensionContribs,
  buildAttributionPieData,
  normalizeBestWorstTrades,
  buildAttributionAiSummaryFallback,
  buildPortfolioAttributionCardViewModel,
} from '../../../frontend/src/pages/workspace/portfolioAttributionCardHelpers';
import type {
  DailyAttributionReportRow,
  AttributionBestWorstTrade,
} from '../../../frontend/src/services/portfolioWorkspaceService';

let failed = 0;
let passed = 0;

function assert(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`❌ ${name}${detail ? '  detail=' + detail : ''}`);
  }
}

function approxEqual(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) < eps;
}

function makeReport(overrides: Partial<DailyAttributionReportRow> = {}): DailyAttributionReportRow {
  return {
    id: 1,
    portfolio_id: 100,
    date: '2026-06-20',
    total_pnl: 1000,
    total_pnl_pct: 1.5,
    realized_pnl: 600,
    unrealized_delta: 400,
    trade_count: 5,
    buy_count: 2,
    sell_count: 3,
    breakdown: {
      factor_contrib: [],
      factor_contrib_total: 0,
      industry_contrib: [
        { industry: '医药', pnl: 500, pct: 0.5, trade_count: 2 },
        { industry: '消费', pnl: 200, pct: 0.2, trade_count: 1 },
      ],
      timing_contrib: 50,
      selection_contrib: 100,
      sizing_contrib: 200,
      execution_cost: 30,
      execution_cost_breakdown: null,
      residual: -80,
    },
    best_trades: [
      {
        id: 11,
        symbol: '600519',
        name: '贵州茅台',
        realized_pnl: 400,
        realized_pnl_pct: 4.0,
        amount: 10000,
        quantity: 100,
      },
    ],
    worst_trades: [
      {
        id: 22,
        symbol: '000001',
        name: '平安银行',
        realized_pnl: -200,
        realized_pnl_pct: -2.0,
        amount: 8000,
        quantity: 800,
      },
    ],
    ai_summary: '2026-06-20 总盈亏 +1000.00 元 (1.50%), 主贡献行业 医药 +500 元',
    bias_findings: [],
    recommendations: [],
    status: 'ok',
    reason: null,
    metadata: {},
    generated_at: '2026-06-20T17:00:00Z',
    source: 'cron',
    created_at: '2026-06-20T17:00:00Z',
    updated_at: '2026-06-20T17:00:00Z',
    ...overrides,
  };
}

// ---- [1] 常量 sanity ----
assert('[1.1] POSITIVE_COLOR = #3f8600', ATTRIBUTION_POSITIVE_COLOR === '#3f8600');
assert('[1.2] NEGATIVE_COLOR = #cf1322', ATTRIBUTION_NEGATIVE_COLOR === '#cf1322');
assert('[1.3] NEUTRAL_COLOR set', ATTRIBUTION_NEUTRAL_COLOR.startsWith('#'));
assert('[1.4] DIMENSION_ORDER 长度 6', ATTRIBUTION_DIMENSION_ORDER.length === 6);
assert(
  '[1.5] DIMENSION_ORDER 含 6 维 keys',
  ATTRIBUTION_DIMENSION_ORDER.includes('industry') &&
    ATTRIBUTION_DIMENSION_ORDER.includes('sizing') &&
    ATTRIBUTION_DIMENSION_ORDER.includes('selection') &&
    ATTRIBUTION_DIMENSION_ORDER.includes('timing') &&
    ATTRIBUTION_DIMENSION_ORDER.includes('factor') &&
    ATTRIBUTION_DIMENSION_ORDER.includes('execution_cost')
);
assert('[1.6] 标签全部含中文', ATTRIBUTION_DIMENSION_ORDER.every(k => ATTRIBUTION_DIMENSION_LABEL[k].length > 0));
assert('[1.7] TOP_TRADE_LIMIT = 3 (AC)', ATTRIBUTION_TOP_TRADE_LIMIT === 3);
assert(
  '[1.8] AI_SUMMARY_MAX_CHARS 与 backend 200 同源',
  ATTRIBUTION_AI_SUMMARY_MAX_CHARS === 200
);
assert(
  '[1.9] DIMENSION_ORDER frozen',
  Object.isFrozen(ATTRIBUTION_DIMENSION_ORDER) &&
    Object.isFrozen(ATTRIBUTION_DIMENSION_LABEL)
);

// ---- [2] safeNumber / pickAttributionColor ----
assert('[2.1] safeNumber 数字透传', safeNumber(42) === 42);
assert('[2.2] safeNumber null → 0', safeNumber(null) === 0);
assert('[2.3] safeNumber NaN → 0', safeNumber(NaN) === 0);
assert('[2.4] safeNumber fallback 自定义', safeNumber('xx', 99) === 99);
assert('[2.5] pickColor 正 → green', pickAttributionColor(10) === ATTRIBUTION_POSITIVE_COLOR);
assert('[2.6] pickColor 负 → red', pickAttributionColor(-10) === ATTRIBUTION_NEGATIVE_COLOR);
assert('[2.7] pickColor 0 → neutral', pickAttributionColor(0) === ATTRIBUTION_NEUTRAL_COLOR);
assert('[2.8] pickColor NaN → neutral', pickAttributionColor(NaN) === ATTRIBUTION_NEUTRAL_COLOR);

// ---- [3] extractDimensionContribs ----
const emptyContribs = extractDimensionContribs(null);
assert(
  '[3.1] null breakdown → 6 维全 0',
  ATTRIBUTION_DIMENSION_ORDER.every(k => emptyContribs[k] === 0)
);
const partialContribs = extractDimensionContribs({
  industry_contrib: [],
  timing_contrib: 5,
  selection_contrib: 10,
  sizing_contrib: 15,
  factor_contrib_total: 20,
  execution_cost: 7,
} as any);
assert('[3.2] 部分字段 — timing', partialContribs.timing === 5);
assert('[3.3] 部分字段 — selection', partialContribs.selection === 10);
assert('[3.4] 部分字段 — sizing', partialContribs.sizing === 15);
assert('[3.5] 部分字段 — factor', partialContribs.factor === 20);
assert(
  '[3.6] execution_cost 符号反转 (支出 → 负贡献)',
  partialContribs.execution_cost === -7
);
const sample = makeReport();
const fullContribs = extractDimensionContribs(sample.breakdown);
assert(
  '[3.7] industry = Σ industry_contrib.pnl (500+200=700)',
  fullContribs.industry === 700
);
assert('[3.8] sizing 透传 (200)', fullContribs.sizing === 200);
assert(
  '[3.9] execution_cost 符号反转 30 → -30',
  fullContribs.execution_cost === -30
);

// ---- [4] buildAttributionPieData ----
const allZeroPie = buildAttributionPieData({
  industry: 0,
  sizing: 0,
  selection: 0,
  timing: 0,
  factor: 0,
  execution_cost: 0,
});
assert('[4.1] 全 0 → totalAbs=0', allZeroPie.totalAbs === 0);
assert('[4.2] 全 0 → 6 slice', allZeroPie.slices.length === 6);
assert(
  '[4.3] 全 0 → 所有 slice value=0 / pctOfAbs=0',
  allZeroPie.slices.every(s => s.value === 0 && s.pctOfAbs === 0)
);
const mixedPie = buildAttributionPieData({
  industry: 700,
  sizing: 200,
  selection: 100,
  timing: 50,
  factor: 0,
  execution_cost: -30,
});
assert('[4.4] mixed totalAbs = 700+200+100+50+0+30=1080', mixedPie.totalAbs === 1080);
const industrySlice = mixedPie.slices.find(s => s.key === 'industry');
assert(
  '[4.5] industry slice value=700 absValue=700 color=green',
  industrySlice?.value === 700 &&
    industrySlice?.absValue === 700 &&
    industrySlice?.color === ATTRIBUTION_POSITIVE_COLOR
);
assert(
  '[4.6] industry pctOfAbs ≈ 700/1080',
  approxEqual(industrySlice?.pctOfAbs ?? -1, 700 / 1080)
);
const execSlice = mixedPie.slices.find(s => s.key === 'execution_cost');
assert(
  '[4.7] execution slice value=-30 → red',
  execSlice?.value === -30 && execSlice?.color === ATTRIBUTION_NEGATIVE_COLOR
);
assert(
  '[4.8] slice 顺序 = ATTRIBUTION_DIMENSION_ORDER',
  mixedPie.slices.every((s, i) => s.key === ATTRIBUTION_DIMENSION_ORDER[i])
);

// ---- [5] normalizeBestWorstTrades ----
assert('[5.1] null → []', normalizeBestWorstTrades(null).length === 0);
assert('[5.2] undefined → []', normalizeBestWorstTrades(undefined).length === 0);
assert('[5.3] 非数组 → []', normalizeBestWorstTrades('x' as any).length === 0);
const trades5: AttributionBestWorstTrade[] = Array.from({ length: 5 }, (_, i) => ({
  id: i + 1,
  symbol: `S${i}`,
  name: `Name${i}`,
  realized_pnl: 100 - i,
  realized_pnl_pct: 1.0,
  amount: 1000,
  quantity: 100,
}));
const cappedTrades = normalizeBestWorstTrades(trades5);
assert('[5.4] cap 3 (AC: top 3)', cappedTrades.length === 3);
assert(
  '[5.5] cap 保留前 3',
  cappedTrades[0].id === 1 && cappedTrades[1].id === 2 && cappedTrades[2].id === 3
);
const missingFields = normalizeBestWorstTrades([
  { symbol: 'X' } as any,
  { symbol: 'Y', realized_pnl_pct: null } as any,
]);
assert('[5.6] 缺字段 fallback id=0', missingFields[0].id === 0);
assert('[5.7] 缺字段 name=symbol', missingFields[0].name === 'X');
assert('[5.8] realized_pnl_pct=null 透传', missingFields[1].realized_pnl_pct === null);

// ---- [6] buildAttributionAiSummaryFallback ----
const shortFb = buildAttributionAiSummaryFallback('2026-06-20', 1000, 1.5, 5);
assert('[6.1] 短 fallback 含日期', shortFb.includes('2026-06-20'));
assert('[6.2] 短 fallback 含总盈亏', shortFb.includes('+1000.00'));
assert('[6.3] 短 fallback 含百分比', shortFb.includes('1.50%'));
assert('[6.4] 短 fallback 含笔数', shortFb.includes('成交 5 笔'));
const negFb = buildAttributionAiSummaryFallback('2026-06-20', -500, -1.2, 3);
assert('[6.5] 负盈亏不带 + 前缀', negFb.includes('-500.00') && !negFb.includes('+-500.00'));
const nullPctFb = buildAttributionAiSummaryFallback('2026-06-20', 100, null, 1);
assert('[6.6] null pct → "—"', nullPctFb.includes('—'));
// 不易构造超长 case (中文很短), 用人造长 date 验证截断行为
const longFb = buildAttributionAiSummaryFallback(
  '2026-06-20' + 'x'.repeat(500),
  100,
  1.0,
  1
);
assert(
  '[6.7] 超长截断到 MAX',
  Array.from(longFb).length === ATTRIBUTION_AI_SUMMARY_MAX_CHARS
);
assert('[6.8] 截断尾巴含 …', longFb.endsWith('…'));

// ---- [7] buildPortfolioAttributionCardViewModel ----
const nullVm = buildPortfolioAttributionCardViewModel(null);
assert('[7a.1] null → hidden=true', nullVm.hidden === true);
assert('[7a.2] null → date=""', nullVm.date === '');
assert('[7a.3] null → pieData=[]', nullVm.pieData.length === 0);
assert('[7a.4] null → aiSummary=""', nullVm.aiSummary === '');
assert('[7a.5] null → status=unknown', nullVm.status === 'unknown');

const happyVm = buildPortfolioAttributionCardViewModel(sample);
assert('[7b.1] happy hidden=false', happyVm.hidden === false);
assert('[7b.2] happy date 透传', happyVm.date === '2026-06-20');
assert('[7b.3] happy status=ok', happyVm.status === 'ok');
assert('[7b.4] happy statusReason=null', happyVm.statusReason === null);
assert('[7b.5] happy totalPnl=1000', happyVm.totalPnl === 1000);
assert('[7b.6] happy realizedPnl=600', happyVm.realizedPnl === 600);
assert('[7b.7] happy unrealizedDelta=400', happyVm.unrealizedDelta === 400);
assert('[7b.8] happy tradeCount=5', happyVm.tradeCount === 5);
assert(
  '[7b.9] happy pieData 6 切片',
  happyVm.pieData.length === 6
);
assert(
  '[7b.10] happy pieData industry value=700',
  happyVm.pieData.find(s => s.key === 'industry')?.value === 700
);
assert(
  '[7b.11] happy pieData execution_cost value=-30 (符号反转)',
  happyVm.pieData.find(s => s.key === 'execution_cost')?.value === -30
);
assert('[7b.12] happy residual=-80', happyVm.residual === -80);
assert('[7b.13] happy bestTrades 1 行', happyVm.bestTrades.length === 1);
assert(
  '[7b.14] happy bestTrades[0].realized_pnl=400',
  happyVm.bestTrades[0].realized_pnl === 400
);
assert('[7b.15] happy worstTrades 1 行', happyVm.worstTrades.length === 1);
assert(
  '[7b.16] happy aiSummaryIsBackend=true',
  happyVm.aiSummaryIsBackend === true
);
assert(
  '[7b.17] happy aiSummary 含医药',
  happyVm.aiSummary.includes('医药')
);
assert(
  '[7b.18] happy industryTop 2 个',
  happyVm.industryTop.length === 2
);
assert(
  '[7b.19] happy factorTop 0 个 (sample factor_contrib=[])',
  happyVm.factorTop.length === 0
);

const skippedVm = buildPortfolioAttributionCardViewModel(
  makeReport({ status: 'skipped', reason: 'no_prev_snapshot' })
);
assert('[7c.1] skipped status', skippedVm.status === 'skipped');
assert(
  '[7c.2] skipped statusReason 透传',
  skippedVm.statusReason === 'no_prev_snapshot'
);
assert('[7c.3] skipped hidden=false (仍渲染)', skippedVm.hidden === false);

const emptyAiVm = buildPortfolioAttributionCardViewModel(
  makeReport({ ai_summary: '   ' })
);
assert('[7d.1] 空 ai_summary → fallback', emptyAiVm.aiSummaryIsBackend === false);
assert(
  '[7d.2] fallback 含日期 + 总盈亏 + 笔数',
  emptyAiVm.aiSummary.includes('2026-06-20') &&
    emptyAiVm.aiSummary.includes('+1000.00') &&
    emptyAiVm.aiSummary.includes('成交 5 笔')
);

// 边界: trade_count 非数 (e.g. null) → 0 而非 NaN
const nanVm = buildPortfolioAttributionCardViewModel(
  makeReport({ trade_count: null as any, buy_count: null as any, sell_count: null as any })
);
assert(
  '[7e.1] tradeCount/buyCount/sellCount null → 0',
  nanVm.tradeCount === 0 && nanVm.buyCount === 0 && nanVm.sellCount === 0
);

// ---- [8] META-GUARD fs+regex ----
const SERVICE_PATH = join(
  __dirname,
  '../../../frontend/src/services/portfolioWorkspaceService.ts'
);
const WORKSPACE_PATH = join(
  __dirname,
  '../../../frontend/src/pages/workspace/PortfolioWorkspace.tsx'
);
const HELPER_PATH = join(
  __dirname,
  '../../../frontend/src/pages/workspace/portfolioAttributionCardHelpers.ts'
);

const serviceSrc = readFileSync(SERVICE_PATH, 'utf8');
const workspaceSrc = readFileSync(WORKSPACE_PATH, 'utf8');
const helperSrc = readFileSync(HELPER_PATH, 'utf8');

assert(
  '[8a.1] service: export getDailyAttributionReport',
  /export\s+async\s+function\s+getDailyAttributionReport/.test(serviceSrc)
);
assert(
  '[8a.2] service: 调用 /attribution/daily',
  /\/portfolio\/\$\{portfolioId\}\/attribution\/daily/.test(serviceSrc) ||
    /attribution\/daily/.test(serviceSrc)
);
assert(
  '[8a.3] service: bundled export 含 getDailyAttributionReport',
  /getDailyAttributionReport,/.test(serviceSrc) ||
    /getDailyAttributionReport,?\s*\n?\s*\}/.test(serviceSrc)
);
assert(
  '[8a.4] service: export DailyAttributionReportRow type',
  /export\s+interface\s+DailyAttributionReportRow/.test(serviceSrc)
);
assert(
  '[8a.5] service: 404 fallback null',
  /if\s*\(status\s*===\s*404\)/.test(serviceSrc) && /return\s+null;/.test(serviceSrc)
);

assert(
  '[8b.1] workspace: import portfolioAttributionCardHelpers',
  /from\s+['"]\.\/portfolioAttributionCardHelpers['"]/.test(workspaceSrc)
);
assert(
  '[8b.2] workspace: import buildPortfolioAttributionCardViewModel',
  /buildPortfolioAttributionCardViewModel/.test(workspaceSrc)
);
assert(
  '[8b.3] workspace: import DailyAttributionReportRow',
  /DailyAttributionReportRow/.test(workspaceSrc)
);
assert(
  '[8b.4] workspace: import Pie / PieChart / Cell',
  /\bPie\b/.test(workspaceSrc) && /\bPieChart\b/.test(workspaceSrc) && /\bCell\b/.test(workspaceSrc)
);

assert(
  '[8c.1] workspace: 渲染 BackendAttributionCard',
  /<BackendAttributionCard[\s>]/.test(workspaceSrc)
);
assert(
  '[8c.2] workspace: 调 portfolioWorkspaceService.getDailyAttributionReport',
  /portfolioWorkspaceService\.getDailyAttributionReport\(/.test(workspaceSrc) ||
    /\.getDailyAttributionReport\(/.test(workspaceSrc)
);
assert(
  '[8c.3] workspace: 404 fallback Alert',
  /cron\s*归因报告/.test(workspaceSrc) || /当日.+cron.+归因报告/.test(workspaceSrc)
);
assert(
  '[8c.4] workspace: DailyAttributionTab 传 portfolioId prop',
  /portfolioId=\{portfolioData/.test(workspaceSrc)
);

assert(
  '[8d.1] helper: export buildPortfolioAttributionCardViewModel',
  /export\s+function\s+buildPortfolioAttributionCardViewModel/.test(helperSrc)
);
assert(
  '[8d.2] helper: export ATTRIBUTION_DIMENSION_ORDER',
  /export\s+const\s+ATTRIBUTION_DIMENSION_ORDER/.test(helperSrc)
);
assert(
  '[8d.3] helper: export buildAttributionPieData',
  /export\s+function\s+buildAttributionPieData/.test(helperSrc)
);
assert(
  '[8d.4] helper: 不依赖 react/antd/recharts (纯函数)',
  !/from\s+['"](react|antd|recharts)['"]/.test(helperSrc)
);

// ---- 收尾 ----
console.log(`\n${passed} ok / ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
process.exit(0);
