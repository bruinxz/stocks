/**
 * MarketJudgmentService 单元测试 (US-040 / FE-001)
 *
 * 不依赖 jest; 直接跑:
 *   cd backend && npx ts-node --transpile-only tests/services/market-judgment-service.test.ts
 *
 * 完全脱离 DB/网络: 注入 fake MarketJudgmentDataSource.
 *
 * 覆盖维度:
 *   [1] 常量冻结 (SUGGESTED_POSITION_BY_REGIME / OVERNIGHT_FOREIGN_SYMBOLS / 各 ATR 阈值);
 *   [2] pure helpers:
 *     - normalizeTodayIso (合法日期透传 / 非法日期取今天);
 *     - pickSuggestedPositionPct (6 regime 基础值 / ATR 高/极高/无 调整 / 边界 clamp);
 *     - buildSuggestedPositionLabel (4 档分界);
 *     - buildSuggestedPositionReason (基础短语 / ATR 短语含 / 不含);
 *     - summarizeOvernightForeign (空 / 全涨 / 全跌 / 分化 / 含 NaN 不污染);
 *     - buildBrief (≤MAX_BRIEF_LEN 截断 / 5 case 短语);
 *     - resolveStatus (ok/partial/failed 4 case);
 *     - parseSinaOverseasLine (4 字段 happy / 缺字段 / 非数字 / 不匹配);
 *   [3] evaluateMarketJudgment e2e (fake DataSource):
 *     - happy bull regime + 全涨外盘 → status=ok + 建议重仓 + brief 含 '普涨';
 *     - bear regime + 全跌外盘 → 谨慎/空仓 + brief 含 '普跌';
 *     - foreign throw → components.overnight_foreign.error 非 null + regime 仍 ok → partial;
 *     - regime throw → regime.error 非 null + 外盘 ok → partial + fallback regime=unknown;
 *     - 双 throw → status=failed;
 *     - skip_overnight_foreign=true → components.overnight_foreign.error 非 null + foreign=[];
 *     - skip_regime=true → regime=unknown + components.regime.error 非 null;
 *     - ATR 5.5% 极高波动 + bull → 85% - 10% = 75% + reason 含 '极高波动';
 *     - ATR 3.5% 高波动 + range → 55% - 5% = 50%;
 *   [4] AC: 卡片 UI 必需字段都返 (regime, regime_label, suggested_position_pct, brief, overnight_foreign);
 *   [5] PRODUCTION_MARKET_JUDGMENT_DATA_SOURCE singleton smoke (不真发网络, 仅校验 shape);
 *   [6] META-GUARD fs+regex:
 *     - MarketJudgmentService.ts: pure helpers 全 export + SUGGESTED_POSITION_BY_REGIME Object.freeze
 *     - TodayController.ts: 必须 import marketJudgmentService + 注册 getMarketJudgment
 *     - today.routes.ts: 必须含 '/market-judgment' route 字符串
 *   [7] service.getTodayJudgment 顶层 catch fail-OPEN — 注入 fake source 强制 throw, service 仍返
 *     完整 shape (status=failed).
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  // 常量
  SUGGESTED_POSITION_BY_REGIME,
  HIGH_ATR_PCT,
  EXTREME_ATR_PCT,
  HIGH_ATR_DOWNSHIFT,
  EXTREME_ATR_DOWNSHIFT,
  OVERNIGHT_FOREIGN_SYMBOLS,
  MAX_BRIEF_LEN,
  BENCHMARK_SYMBOL,
  // pure helpers
  normalizeTodayIso,
  pickSuggestedPositionPct,
  buildSuggestedPositionLabel,
  buildSuggestedPositionReason,
  summarizeOvernightForeign,
  buildBrief,
  resolveStatus,
  parseSinaOverseasLine,
  // main entries
  evaluateMarketJudgment,
  createProductionMarketJudgmentDataSource,
  PRODUCTION_MARKET_JUDGMENT_DATA_SOURCE,
  marketJudgmentService,
  // types
  MarketJudgmentDataSource,
  OvernightForeignQuote,
} from '../../src/services/MarketJudgmentService';
import { MarketEnvironmentSnapshot } from '../../src/services/MarketEnvironmentService';

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

function assertEqual<T>(name: string, actual: T, expected: T): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  assert(name, ok, `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
}

function assertClose(name: string, actual: number, expected: number, eps = 0.001): void {
  const ok = Math.abs(actual - expected) < eps;
  assert(name, ok, `actual=${actual} expected~=${expected}`);
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function makeSnapshot(
  overrides: Partial<MarketEnvironmentSnapshot> = {}
): MarketEnvironmentSnapshot {
  return {
    as_of: '2026-06-19',
    market_regime: 'bull',
    market_regime_label: '趋势强势',
    benchmark_code: BENCHMARK_SYMBOL,
    benchmark_name: '沪深300',
    benchmark_return_5d_pct: 1.0,
    benchmark_return_20d_pct: 4.5,
    benchmark_return_60d_pct: 9.0,
    benchmark_drawdown_60d_pct: -2.0,
    benchmark_price_vs_ma20_pct: 2.5,
    benchmark_price_vs_ma60_pct: 4.0,
    benchmark_atr_14d: 35.0,
    benchmark_atr_14d_pct: 1.2,
    breadth: {
      sample_count: 100,
      up_20d_ratio: 0.65,
      above_ma20_ratio: 0.7,
      strong_industry_count: 12,
      weak_industry_count: 5,
    },
    ...overrides,
  };
}

function makeQuote(symbol: string, change_pct: number, name = symbol): OvernightForeignQuote {
  return {
    symbol,
    name,
    current: 100,
    change: change_pct,
    change_pct,
  };
}

function makeFakeSource(opts: {
  snap?: MarketEnvironmentSnapshot | null;
  snapThrow?: Error;
  foreign?: OvernightForeignQuote[];
  foreignThrow?: Error;
}): MarketJudgmentDataSource {
  return {
    async loadMarketEnvironment(): Promise<MarketEnvironmentSnapshot | null> {
      if (opts.snapThrow) throw opts.snapThrow;
      return opts.snap ?? null;
    },
    async fetchOvernightForeign(): Promise<OvernightForeignQuote[]> {
      if (opts.foreignThrow) throw opts.foreignThrow;
      return opts.foreign ?? [];
    },
  };
}

// ---------------------------------------------------------------------------
// [1] 常量冻结
// ---------------------------------------------------------------------------

function testConstantsFrozen(): void {
  // SUGGESTED_POSITION_BY_REGIME — 6 regime 必须全在 + Object.freeze
  const regimes: Array<MarketEnvironmentSnapshot['market_regime']> = [
    'bull',
    'rebound',
    'range',
    'unknown',
    'bear',
    'stress',
  ];
  for (const r of regimes) {
    assert(`SUGGESTED_POSITION_BY_REGIME 含 ${r}`, r in SUGGESTED_POSITION_BY_REGIME);
  }
  assertEqual('SUGGESTED_POSITION_BY_REGIME.bull = 0.85', SUGGESTED_POSITION_BY_REGIME.bull, 0.85);
  assertEqual('SUGGESTED_POSITION_BY_REGIME.bear = 0.25', SUGGESTED_POSITION_BY_REGIME.bear, 0.25);
  assertEqual(
    'SUGGESTED_POSITION_BY_REGIME.stress = 0.10',
    SUGGESTED_POSITION_BY_REGIME.stress,
    0.1
  );
  assertEqual(
    'SUGGESTED_POSITION_BY_REGIME.unknown = 0.45',
    SUGGESTED_POSITION_BY_REGIME.unknown,
    0.45
  );
  let mutationBlocked = false;
  try {
    (SUGGESTED_POSITION_BY_REGIME as any).bull = 0.99;
    mutationBlocked = SUGGESTED_POSITION_BY_REGIME.bull === 0.85;
  } catch {
    mutationBlocked = true;
  }
  assert('SUGGESTED_POSITION_BY_REGIME Object.freeze 拒变更', mutationBlocked);

  // ATR 阈值合理 sanity
  assert('EXTREME_ATR_PCT > HIGH_ATR_PCT', EXTREME_ATR_PCT > HIGH_ATR_PCT);
  assert('EXTREME_ATR_DOWNSHIFT > HIGH_ATR_DOWNSHIFT', EXTREME_ATR_DOWNSHIFT > HIGH_ATR_DOWNSHIFT);

  // OVERNIGHT_FOREIGN_SYMBOLS — 4 个固定顺序
  assertEqual('OVERNIGHT_FOREIGN_SYMBOLS 4 个', OVERNIGHT_FOREIGN_SYMBOLS.length, 4);
  assertEqual('OVERNIGHT_FOREIGN_SYMBOLS[0] = int_hangseng', OVERNIGHT_FOREIGN_SYMBOLS[0], 'int_hangseng');
  assertEqual('OVERNIGHT_FOREIGN_SYMBOLS[1] = int_nasdaq', OVERNIGHT_FOREIGN_SYMBOLS[1], 'int_nasdaq');
  assertEqual('OVERNIGHT_FOREIGN_SYMBOLS[2] = int_sp500', OVERNIGHT_FOREIGN_SYMBOLS[2], 'int_sp500');
  assertEqual('OVERNIGHT_FOREIGN_SYMBOLS[3] = int_dji', OVERNIGHT_FOREIGN_SYMBOLS[3], 'int_dji');

  assert('MAX_BRIEF_LEN > 0', MAX_BRIEF_LEN > 0);
  assertEqual('BENCHMARK_SYMBOL = sh.000300', BENCHMARK_SYMBOL, 'sh.000300');
}

// ---------------------------------------------------------------------------
// [2] pure helpers
// ---------------------------------------------------------------------------

function testNormalizeTodayIso(): void {
  assertEqual('合法 YYYY-MM-DD 透传', normalizeTodayIso('2026-06-19'), '2026-06-19');
  const today = normalizeTodayIso();
  assert('缺省返今天形态 YYYY-MM-DD', /^\d{4}-\d{2}-\d{2}$/.test(today));
  const fromBad = normalizeTodayIso('not-a-date');
  assert('非法字符串返今天形态', /^\d{4}-\d{2}-\d{2}$/.test(fromBad));
}

function testPickSuggestedPositionPct(): void {
  // 6 regime 基础值 (ATR 缺/正常):
  assertEqual('bull base = 0.85', pickSuggestedPositionPct('bull', 1.0), 0.85);
  assertEqual('rebound base = 0.65', pickSuggestedPositionPct('rebound', 1.0), 0.65);
  assertEqual('range base = 0.55', pickSuggestedPositionPct('range', 1.0), 0.55);
  assertEqual('unknown base = 0.45', pickSuggestedPositionPct('unknown', 1.0), 0.45);
  assertEqual('bear base = 0.25', pickSuggestedPositionPct('bear', 1.0), 0.25);
  assertEqual('stress base = 0.10', pickSuggestedPositionPct('stress', 1.0), 0.1);
  // ATR 阈值边界:
  assertClose('bull + 高 ATR 3.0% → 0.85 - 0.05', pickSuggestedPositionPct('bull', 3.0), 0.8);
  assertClose('bull + 极高 ATR 5.0% → 0.85 - 0.10', pickSuggestedPositionPct('bull', 5.0), 0.75);
  assertClose('bull + ATR 2.99% (不触发) = 0.85', pickSuggestedPositionPct('bull', 2.99), 0.85);
  assertClose(
    'bull + ATR 4.99% 触发 high 但非 extreme = 0.80',
    pickSuggestedPositionPct('bull', 4.99),
    0.8
  );
  // ATR null/undefined/NaN → 不调整
  assertEqual('bull + ATR null = 0.85', pickSuggestedPositionPct('bull', null), 0.85);
  assertEqual('bull + ATR undefined = 0.85', pickSuggestedPositionPct('bull', undefined), 0.85);
  assertEqual('bull + ATR NaN = 0.85', pickSuggestedPositionPct('bull', NaN), 0.85);
  // clamp 边界 (理论场景: stress 0.1 - 0.10 = 0)
  assertEqual('stress + extreme ATR → clamp 0', pickSuggestedPositionPct('stress', 6.0), 0);
  // 未知 regime fallback unknown
  assertEqual(
    '未知 regime fallback unknown 0.45',
    pickSuggestedPositionPct('hyperbull' as any, 0.5),
    0.45
  );
}

function testBuildSuggestedPositionLabel(): void {
  assertEqual('0.90 → 重仓', buildSuggestedPositionLabel(0.9), '重仓');
  assertEqual('0.70 → 重仓 (边界)', buildSuggestedPositionLabel(0.7), '重仓');
  assertEqual('0.69 → 中等', buildSuggestedPositionLabel(0.69), '中等');
  assertEqual('0.40 → 中等 (边界)', buildSuggestedPositionLabel(0.4), '中等');
  assertEqual('0.39 → 谨慎', buildSuggestedPositionLabel(0.39), '谨慎');
  assertEqual('0.10 → 谨慎 (边界)', buildSuggestedPositionLabel(0.1), '谨慎');
  assertEqual('0.05 → 空仓观望', buildSuggestedPositionLabel(0.05), '空仓观望');
  assertEqual('NaN → 未知', buildSuggestedPositionLabel(NaN), '未知');
}

function testBuildSuggestedPositionReason(): void {
  const r1 = buildSuggestedPositionReason('bull', '趋势强势', 0.85, 0.85, 1.0);
  assert('reason 含 "趋势强势 基础 85%"', r1.includes('趋势强势 基础 85%'));
  assert('reason 含 "最终建议 85%"', r1.includes('最终建议 85%'));
  assert('reason 不含 "高波动" (ATR 1.0%)', !r1.includes('高波动'));
  const r2 = buildSuggestedPositionReason('bull', '趋势强势', 0.85, 0.8, 3.5);
  assert('reason ATR 3.5% 含 "高波动"', r2.includes('高波动'));
  assert('reason ATR 3.5% 含 "-5%"', r2.includes('-5%'));
  const r3 = buildSuggestedPositionReason('bull', '趋势强势', 0.85, 0.75, 5.5);
  assert('reason ATR 5.5% 含 "极高波动"', r3.includes('极高波动'));
  assert('reason ATR 5.5% 含 "-10%"', r3.includes('-10%'));
  // 未知 regime fallback
  const r4 = buildSuggestedPositionReason(undefined, '未知环境', 0.45, 0.45, null);
  assert('reason undefined regime fallback 基础 45%', r4.includes('未知环境 基础 45%'));
}

function testSummarizeOvernightForeign(): void {
  assertEqual(
    '空数组 → 全 0',
    summarizeOvernightForeign([]),
    { count: 0, positive: 0, negative: 0, avg_change_pct: 0 }
  );
  const allUp = summarizeOvernightForeign([
    makeQuote('a', 1.0),
    makeQuote('b', 0.5),
    makeQuote('c', 2.0),
  ]);
  assertEqual('全涨 count', allUp.count, 3);
  assertEqual('全涨 positive', allUp.positive, 3);
  assertEqual('全涨 negative', allUp.negative, 0);
  assertClose('全涨 avg', allUp.avg_change_pct, 1.17, 0.01);
  const allDown = summarizeOvernightForeign([
    makeQuote('a', -1.0),
    makeQuote('b', -2.5),
  ]);
  assertEqual('全跌 negative=2', allDown.negative, 2);
  assertClose('全跌 avg', allDown.avg_change_pct, -1.75, 0.01);
  const mixed = summarizeOvernightForeign([
    makeQuote('a', 1.0),
    makeQuote('b', -2.0),
    makeQuote('c', 0),
  ]);
  assertEqual('分化 positive=1', mixed.positive, 1);
  assertEqual('分化 negative=1', mixed.negative, 1);
  assertClose('分化 avg', mixed.avg_change_pct, -0.33, 0.01);
  // NaN 不污染 (count 仍是 array length, avg 折算时 sum 不加 NaN)
  const withNaN = summarizeOvernightForeign([makeQuote('a', NaN), makeQuote('b', 1.0)]);
  assertEqual('NaN 不计 positive', withNaN.positive, 1);
  assertEqual('NaN 不计 negative', withNaN.negative, 0);
}

function testBuildBrief(): void {
  const allUp = buildBrief({
    regimeLabel: '趋势强势',
    overnight: { count: 4, positive: 4, negative: 0, avg_change_pct: 0.85 },
    overnightAvailable: true,
    suggestedPositionPct: 0.85,
    suggestedPositionLabel: '重仓',
  });
  assert('普涨 brief 含 "外盘普涨"', allUp.includes('外盘普涨'));
  assert('普涨 brief 含 "+0.85%"', allUp.includes('+0.85%'));
  assert('普涨 brief 含 regime "趋势强势"', allUp.includes('趋势强势'));
  assert('普涨 brief 含 "建议重仓 85%"', allUp.includes('建议重仓 85%'));

  const allDown = buildBrief({
    regimeLabel: '下行弱势',
    overnight: { count: 4, positive: 0, negative: 4, avg_change_pct: -1.2 },
    overnightAvailable: true,
    suggestedPositionPct: 0.25,
    suggestedPositionLabel: '谨慎',
  });
  assert('普跌 brief 含 "外盘普跌"', allDown.includes('外盘普跌'));
  assert('普跌 brief 含 "-1.20%"', allDown.includes('-1.20%'));

  const split = buildBrief({
    regimeLabel: '震荡均衡',
    overnight: { count: 4, positive: 2, negative: 2, avg_change_pct: 0 },
    overnightAvailable: true,
    suggestedPositionPct: 0.55,
    suggestedPositionLabel: '中等',
  });
  assert('分化 brief 含 "分化"', split.includes('分化'));

  const noData = buildBrief({
    regimeLabel: '未知环境',
    overnight: { count: 0, positive: 0, negative: 0, avg_change_pct: 0 },
    overnightAvailable: false,
    suggestedPositionPct: 0.45,
    suggestedPositionLabel: '中等',
  });
  assert('无外盘数据 brief 含 "数据缺失"', noData.includes('数据缺失'));

  // 截断: 构造一个超长 regime label
  const longLabel = '长'.repeat(MAX_BRIEF_LEN + 50);
  const truncated = buildBrief({
    regimeLabel: longLabel,
    overnight: { count: 4, positive: 4, negative: 0, avg_change_pct: 0.5 },
    overnightAvailable: true,
    suggestedPositionPct: 0.85,
    suggestedPositionLabel: '重仓',
  });
  assert('超长 brief 长度 ≤ MAX_BRIEF_LEN', truncated.length <= MAX_BRIEF_LEN);
  assert('超长 brief 结尾 "…"', truncated.endsWith('…'));
}

function testResolveStatus(): void {
  assertEqual(
    '都 ok → ok',
    resolveStatus({ regime: { error: null }, overnight_foreign: { error: null } }),
    'ok'
  );
  assertEqual(
    'regime 错 → partial',
    resolveStatus({ regime: { error: 'x' }, overnight_foreign: { error: null } }),
    'partial'
  );
  assertEqual(
    'foreign 错 → partial',
    resolveStatus({ regime: { error: null }, overnight_foreign: { error: 'y' } }),
    'partial'
  );
  assertEqual(
    '双错 → failed',
    resolveStatus({ regime: { error: 'x' }, overnight_foreign: { error: 'y' } }),
    'failed'
  );
}

function testParseSinaOverseasLine(): void {
  const line = 'var hq_str_int_hangseng="恒生指数,23924.81,-387.35,-1.59";';
  const q = parseSinaOverseasLine(line);
  assert('parse happy 不为 null', q !== null);
  if (q) {
    assertEqual('parse name', q.name, '恒生指数');
    assertEqual('parse symbol', q.symbol, 'int_hangseng');
    assertClose('parse current', q.current, 23924.81, 0.01);
    assertClose('parse change', q.change, -387.35, 0.01);
    assertClose('parse change_pct', q.change_pct, -1.59, 0.01);
  }
  // 不匹配 regex
  assertEqual('随机字符串 parse → null', parseSinaOverseasLine('random'), null);
  // 缺字段
  assertEqual(
    '仅 2 字段 parse → null',
    parseSinaOverseasLine('var hq_str_int_x="a,1.0";'),
    null
  );
  // 非数字 current
  assertEqual(
    'current 非数字 parse → null',
    parseSinaOverseasLine('var hq_str_int_y="名,NaN,1,1";'),
    null
  );
  // 空名
  assertEqual(
    '空名 parse → null',
    parseSinaOverseasLine('var hq_str_int_z=",1.0,0.1,0.2";'),
    null
  );
}

// ---------------------------------------------------------------------------
// [3] evaluateMarketJudgment e2e (fake DataSource)
// ---------------------------------------------------------------------------

async function testEvaluateHappyBull(): Promise<void> {
  const source = makeFakeSource({
    snap: makeSnapshot({ market_regime: 'bull', market_regime_label: '趋势强势' }),
    foreign: [
      makeQuote('int_hangseng', 1.2, '恒生指数'),
      makeQuote('int_nasdaq', 0.8, '纳斯达克'),
      makeQuote('int_sp500', 0.5, '标普指数'),
      makeQuote('int_dji', 0.3, '道琼斯'),
    ],
  });
  const r = await evaluateMarketJudgment(source);
  assertEqual('bull happy regime', r.regime, 'bull');
  assertEqual('bull happy regime_label', r.regime_label, '趋势强势');
  assertEqual('bull happy suggested_pct', r.suggested_position_pct, 0.85);
  assertEqual('bull happy label', r.suggested_position_label, '重仓');
  assertEqual('bull happy status', r.status, 'ok');
  assert('bull happy brief 含 "普涨"', r.brief.includes('普涨'));
  assert('bull happy brief 含 "建议重仓 85%"', r.brief.includes('建议重仓 85%'));
  assertEqual('bull happy foreign count', r.overnight_foreign.length, 4);
}

async function testEvaluateBear(): Promise<void> {
  const source = makeFakeSource({
    snap: makeSnapshot({
      market_regime: 'bear',
      market_regime_label: '下行弱势',
      benchmark_atr_14d_pct: 2.5,
    }),
    foreign: [
      makeQuote('int_hangseng', -2.0),
      makeQuote('int_nasdaq', -1.5),
      makeQuote('int_sp500', -1.2),
      makeQuote('int_dji', -1.0),
    ],
  });
  const r = await evaluateMarketJudgment(source);
  assertEqual('bear regime', r.regime, 'bear');
  assertEqual('bear suggested_pct = 0.25 (ATR 2.5% 未触发)', r.suggested_position_pct, 0.25);
  assertEqual('bear label = 谨慎', r.suggested_position_label, '谨慎');
  assert('bear brief 含 "普跌"', r.brief.includes('普跌'));
  assert('bear brief 含 "下行弱势"', r.brief.includes('下行弱势'));
}

async function testEvaluateForeignFailPartial(): Promise<void> {
  const source = makeFakeSource({
    snap: makeSnapshot({ market_regime: 'range', market_regime_label: '震荡均衡' }),
    foreignThrow: new Error('sina 502'),
  });
  const r = await evaluateMarketJudgment(source);
  assertEqual('foreign throw status', r.status, 'partial');
  assertEqual('foreign throw foreign=[]', r.overnight_foreign.length, 0);
  assert(
    'foreign throw components.overnight_foreign.error 非 null',
    r.components.overnight_foreign.error !== null
  );
  assertEqual('foreign throw regime.error null', r.components.regime.error, null);
  assertEqual('foreign throw regime still range', r.regime, 'range');
  assert('foreign throw brief 含 "数据缺失"', r.brief.includes('数据缺失'));
}

async function testEvaluateRegimeFailPartial(): Promise<void> {
  const source = makeFakeSource({
    snapThrow: new Error('DB timeout'),
    foreign: [makeQuote('int_hangseng', 1.0)],
  });
  const r = await evaluateMarketJudgment(source);
  assertEqual('regime throw status', r.status, 'partial');
  assertEqual('regime throw fallback regime', r.regime, 'unknown');
  assertEqual('regime throw fallback regime_label', r.regime_label, '未知环境');
  assertEqual('regime throw fallback pct = 0.45', r.suggested_position_pct, 0.45);
  assert('regime throw components.regime.error 非 null', r.components.regime.error !== null);
  assertEqual('regime throw foreign 不受影响 count=1', r.overnight_foreign.length, 1);
}

async function testEvaluateBothFailFailed(): Promise<void> {
  const source = makeFakeSource({
    snapThrow: new Error('DB down'),
    foreignThrow: new Error('sina dead'),
  });
  const r = await evaluateMarketJudgment(source);
  assertEqual('双 throw status', r.status, 'failed');
  assert('双 throw regime.error 非 null', r.components.regime.error !== null);
  assert('双 throw foreign.error 非 null', r.components.overnight_foreign.error !== null);
  // 仍返完整 shape, 不应抛
}

async function testEvaluateSkipFlags(): Promise<void> {
  const source = makeFakeSource({
    snap: makeSnapshot({ market_regime: 'bull', market_regime_label: '趋势强势' }),
    foreign: [makeQuote('int_hangseng', 1.0)],
  });
  const r1 = await evaluateMarketJudgment(source, { skip_overnight_foreign: true });
  assertEqual('skip_overnight_foreign foreign=[]', r1.overnight_foreign.length, 0);
  assert(
    'skip_overnight_foreign components.overnight_foreign.error 非 null',
    r1.components.overnight_foreign.error !== null
  );
  assertEqual('skip_overnight_foreign regime 仍 bull', r1.regime, 'bull');

  const r2 = await evaluateMarketJudgment(source, { skip_regime: true });
  assertEqual('skip_regime regime fallback unknown', r2.regime, 'unknown');
  assert('skip_regime components.regime.error 非 null', r2.components.regime.error !== null);
  assertEqual('skip_regime foreign 不受影响', r2.overnight_foreign.length, 1);
}

async function testEvaluateAtrDownshift(): Promise<void> {
  // bull + ATR 5.5% → 0.85 - 0.10 = 0.75
  const source1 = makeFakeSource({
    snap: makeSnapshot({
      market_regime: 'bull',
      market_regime_label: '趋势强势',
      benchmark_atr_14d_pct: 5.5,
    }),
    foreign: [makeQuote('int_hangseng', 0.5)],
  });
  const r1 = await evaluateMarketJudgment(source1);
  assertEqual('bull + 极高 ATR 5.5% → 0.75', r1.suggested_position_pct, 0.75);
  assert('reason 含 "极高波动"', r1.suggested_position_reason.includes('极高波动'));

  // range + ATR 3.5% → 0.55 - 0.05 = 0.50
  const source2 = makeFakeSource({
    snap: makeSnapshot({
      market_regime: 'range',
      market_regime_label: '震荡均衡',
      benchmark_atr_14d_pct: 3.5,
    }),
    foreign: [makeQuote('int_hangseng', 0.0)],
  });
  const r2 = await evaluateMarketJudgment(source2);
  assertClose('range + 高 ATR 3.5% → 0.50', r2.suggested_position_pct, 0.5, 0.001);
  assert('range reason 含 "高波动"', r2.suggested_position_reason.includes('高波动'));
}

// ---------------------------------------------------------------------------
// [4] AC: 卡片 UI 必需字段
// ---------------------------------------------------------------------------

async function testCardShapeAC(): Promise<void> {
  const source = makeFakeSource({
    snap: makeSnapshot(),
    foreign: [makeQuote('int_hangseng', 0.5)],
  });
  const r = await evaluateMarketJudgment(source);
  // AC: UI 必需字段
  const required = [
    'trade_date',
    'regime',
    'regime_label',
    'benchmark_code',
    'suggested_position_pct',
    'suggested_position_label',
    'suggested_position_reason',
    'overnight_foreign',
    'overnight_summary',
    'brief',
    'status',
    'message',
    'components',
  ];
  for (const k of required) {
    assert(`AC: card shape 含 ${k}`, k in r);
  }
  assert('AC: brief 长度 ≤ MAX_BRIEF_LEN', r.brief.length <= MAX_BRIEF_LEN);
  assert('AC: trade_date YYYY-MM-DD', /^\d{4}-\d{2}-\d{2}$/.test(r.trade_date));
  assert(
    'AC: suggested_position_pct ∈ [0,1]',
    r.suggested_position_pct >= 0 && r.suggested_position_pct <= 1
  );
}

// ---------------------------------------------------------------------------
// [5] PRODUCTION singleton smoke
// ---------------------------------------------------------------------------

function testProductionDataSourceSmoke(): void {
  assert(
    'PRODUCTION_MARKET_JUDGMENT_DATA_SOURCE.loadMarketEnvironment 是函数',
    typeof PRODUCTION_MARKET_JUDGMENT_DATA_SOURCE.loadMarketEnvironment === 'function'
  );
  assert(
    'PRODUCTION_MARKET_JUDGMENT_DATA_SOURCE.fetchOvernightForeign 是函数',
    typeof PRODUCTION_MARKET_JUDGMENT_DATA_SOURCE.fetchOvernightForeign === 'function'
  );
  const fresh = createProductionMarketJudgmentDataSource();
  assert(
    'createProductionMarketJudgmentDataSource 返新对象',
    fresh !== PRODUCTION_MARKET_JUDGMENT_DATA_SOURCE
  );
  assert('marketJudgmentService.getTodayJudgment 是函数', typeof marketJudgmentService.getTodayJudgment === 'function');
}

// ---------------------------------------------------------------------------
// [6] META-GUARD fs+regex
// ---------------------------------------------------------------------------

function testMetaGuard(): void {
  const root = join(__dirname, '..', '..', 'src');
  const serviceSrc = readFileSync(join(root, 'services', 'MarketJudgmentService.ts'), 'utf-8');
  // 关键 export 含
  const exports = [
    'export const SUGGESTED_POSITION_BY_REGIME',
    'export const OVERNIGHT_FOREIGN_SYMBOLS',
    'export function pickSuggestedPositionPct',
    'export function buildSuggestedPositionLabel',
    'export function buildSuggestedPositionReason',
    'export function summarizeOvernightForeign',
    'export function buildBrief',
    'export function resolveStatus',
    'export function parseSinaOverseasLine',
    'export async function evaluateMarketJudgment',
  ];
  for (const e of exports) {
    assert(`META: MarketJudgmentService 含 "${e}"`, serviceSrc.includes(e));
  }
  // Object.freeze 在 SUGGESTED_POSITION_BY_REGIME / OVERNIGHT_FOREIGN_SYMBOLS
  assert(
    'META: SUGGESTED_POSITION_BY_REGIME 用 Object.freeze',
    /SUGGESTED_POSITION_BY_REGIME[\s\S]{0,100}Object\.freeze/.test(serviceSrc)
  );
  assert(
    'META: OVERNIGHT_FOREIGN_SYMBOLS 用 Object.freeze',
    /OVERNIGHT_FOREIGN_SYMBOLS[\s\S]{0,80}Object\.freeze/.test(serviceSrc)
  );

  // controller 接入
  const controllerSrc = readFileSync(
    join(root, 'api', 'controllers', 'TodayController.ts'),
    'utf-8'
  );
  assert(
    'META: TodayController import marketJudgmentService',
    controllerSrc.includes("from '../../services/MarketJudgmentService'") ||
      controllerSrc.includes('from "../../services/MarketJudgmentService"')
  );
  assert(
    'META: TodayController 含 async getMarketJudgment',
    /async\s+getMarketJudgment\s*\(/.test(controllerSrc)
  );
  assert(
    'META: TodayController 调用 marketJudgmentService.getTodayJudgment',
    controllerSrc.includes('marketJudgmentService.getTodayJudgment')
  );

  // route 接入
  const routeSrc = readFileSync(join(root, 'api', 'routes', 'today.routes.ts'), 'utf-8');
  assert("META: today.routes.ts 含 '/market-judgment' 路径", routeSrc.includes('/market-judgment'));
  assert(
    'META: today.routes.ts 调 getMarketJudgment.bind',
    routeSrc.includes('getMarketJudgment.bind')
  );
}

// ---------------------------------------------------------------------------
// [7] service.getTodayJudgment 顶层 catch fail-OPEN
// ---------------------------------------------------------------------------

async function testServiceTopLevelCatch(): Promise<void> {
  // 模拟生产 DataSource 的 loadMarketEnvironment / fetchOvernightForeign 抛非 Error
  // 然后 evaluateMarketJudgment 内部已经吞了; 服务顶层 catch 主要兜 helper 编程错误.
  // 这里直接调 service.getTodayJudgment 走 PRODUCTION_MARKET_JUDGMENT_DATA_SOURCE,
  // 在 ts-node DB-less 环境下 marketEnvironmentService 真调会 throw — 我们期望
  // service 仍返 shape (status 至少 partial 或 failed), 不抛.
  const r = await marketJudgmentService.getTodayJudgment({ skip_overnight_foreign: true });
  assert('service.getTodayJudgment 不抛', !!r);
  assert('service 返完整 shape: trade_date', typeof r.trade_date === 'string');
  assert('service 返完整 shape: status', ['ok', 'partial', 'failed'].includes(r.status));
  assert('service 返完整 shape: components', !!r.components);
  // DB-less 环境下 regime 必失败, 外盘被 skip → status 至少 partial
  assert("DB-less + skip_overnight_foreign → status != 'ok'", r.status !== 'ok');
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  testConstantsFrozen();
  testNormalizeTodayIso();
  testPickSuggestedPositionPct();
  testBuildSuggestedPositionLabel();
  testBuildSuggestedPositionReason();
  testSummarizeOvernightForeign();
  testBuildBrief();
  testResolveStatus();
  testParseSinaOverseasLine();
  await testEvaluateHappyBull();
  await testEvaluateBear();
  await testEvaluateForeignFailPartial();
  await testEvaluateRegimeFailPartial();
  await testEvaluateBothFailFailed();
  await testEvaluateSkipFlags();
  await testEvaluateAtrDownshift();
  await testCardShapeAC();
  testProductionDataSourceSmoke();
  testMetaGuard();
  await testServiceTopLevelCatch();

  console.log(`\n${passed} ok / ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

void main();
