/**
 * IntradayReversalDetector 单元测试 (PR-M3 / 2026-06-29)
 *
 * 不依赖 jest; 直接跑:
 *   cd backend && npx ts-node --transpile-only tests/services/intraday-reversal-detector-service.test.ts
 *
 * 完全脱 DB — ReversalDataSource 全 stub.
 *
 * 覆盖维度:
 *   - 纯 helpers: computeRSI / computeEMA / computeTrendDirection /
 *     evaluateReversalBuy / evaluateReversalSell / evaluateStockReversal
 *   - runOnce e2e:
 *     - 空 universe → 不调任何 detector
 *     - 多 stock 命中 buy + sell → by_type 正确
 *     - bars < 30 → 跳过该 stock
 *     - 单 stock listDailyBars throw → 仅 error 记录, 其它继续
 */

import {
  IntradayReversalDetector,
  REVERSAL_SIGNAL_LABELS,
  REVERSAL_SIGNAL_TYPES,
  ReversalDailyBar,
  ReversalDataSource,
  ReversalHit,
  computeEMA,
  computeRSI,
  computeTrendDirection,
  evaluateReversalBuy,
  evaluateReversalSell,
  evaluateStockReversal,
} from '../../src/services/IntradayReversalDetector';

let ok = 0;
let fail = 0;

function assert(name: string, cond: boolean, detail = ''): void {
  if (cond) ok++;
  else {
    fail++;
    console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
  }
}

function assertEqual(name: string, got: any, want: any): void {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) ok++;
  else {
    fail++;
    console.log(`  FAIL ${name}\n    got:  ${g}\n    want: ${w}`);
  }
}

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakeDSData {
  positions?: string[];
  favorites?: string[];
  aiRecommended?: string[];
  /** symbol → 该股的 bars (asc) */
  barsBySymbol?: Record<string, ReversalDailyBar[]>;
  /** symbol → 该股查询时 throw */
  barsThrowSymbols?: Set<string>;
  names?: Record<string, string>;
}

function makeFakeDS(data: FakeDSData = {}): ReversalDataSource {
  return {
    async listPositionSymbols() {
      return data.positions || [];
    },
    async listFavoriteSymbols() {
      return data.favorites || [];
    },
    async listAIRecommendedSymbols() {
      return data.aiRecommended || [];
    },
    async listDailyBars(symbol: string) {
      if (data.barsThrowSymbols && data.barsThrowSymbols.has(symbol)) {
        throw new Error(`bars throw: ${symbol}`);
      }
      return (data.barsBySymbol && data.barsBySymbol[symbol]) || [];
    },
    async resolveStockNames(symbols: string[]) {
      const m = new Map<string, string>();
      for (const s of symbols) {
        if (data.names && data.names[s]) m.set(s, data.names[s]);
      }
      return m;
    },
  };
}

// 30 根 close 数组生成 — 给定 base + 步长 (e.g. step=1 = 单调上涨, step=-1 = 单调下跌, step=0 = 横盘)
function makeBarsAsc(closes: number[], lastChangePct?: number): ReversalDailyBar[] {
  return closes.map((c, i) => {
    const base = i === 0 ? c : closes[i - 1];
    const cp = i === 0 || base === 0 ? null : ((c - base) / base) * 100;
    return {
      time: `2026-${String(Math.floor(i / 30) + 1).padStart(2, '0')}-${String((i % 30) + 1).padStart(2, '0')}`,
      open: c,
      high: c * 1.01,
      low: c * 0.99,
      close: c,
      change_percent: i === closes.length - 1 && lastChangePct !== undefined ? lastChangePct : cp,
    };
  });
}

// ---------------------------------------------------------------------------
// [1] Constants
// ---------------------------------------------------------------------------
console.log('\n[1] Constants...');
assert('REVERSAL_SIGNAL_TYPES 2', REVERSAL_SIGNAL_TYPES.length === 2);
assert('REVERSAL_SIGNAL_LABELS 2', Object.keys(REVERSAL_SIGNAL_LABELS).length === 2);
assertEqual('label reversal_buy', REVERSAL_SIGNAL_LABELS.reversal_buy, '超跌反弹买入');
assertEqual('label reversal_sell', REVERSAL_SIGNAL_LABELS.reversal_sell, '超买回调卖出');

// ---------------------------------------------------------------------------
// [2] computeRSI — Wilder's
// ---------------------------------------------------------------------------
console.log('\n[2] computeRSI...');
assertEqual('RSI 数据不足', computeRSI([1, 2, 3]), null);
// 全涨 → RSI ≈ 100
const allUp = Array.from({ length: 20 }, (_, i) => 100 + i);
assertEqual('RSI 全涨 = 100', computeRSI(allUp), 100);
// 全跌 → RSI = 0 (avgGain=0)
const allDown = Array.from({ length: 20 }, (_, i) => 200 - i);
const rsiDown = computeRSI(allDown);
assert('RSI 全跌 ≈ 0', rsiDown !== null && rsiDown < 5);
// 振荡 → RSI ~ 50
const osc = Array.from({ length: 30 }, (_, i) => 100 + (i % 2));
const rsiOsc = computeRSI(osc);
assert('RSI 振荡 < 80 (不超买)', rsiOsc !== null && rsiOsc < 80);

// ---------------------------------------------------------------------------
// [3] computeEMA
// ---------------------------------------------------------------------------
console.log('\n[3] computeEMA...');
assertEqual('EMA 数据不足', computeEMA([1, 2], 5), null);
const ema = computeEMA([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 5);
assert('EMA ≠ null', ema !== null);
assert('EMA > 5 (跟踪近 5 个)', (ema as number) > 5);

// ---------------------------------------------------------------------------
// [4] computeTrendDirection
// ---------------------------------------------------------------------------
console.log('\n[4] computeTrendDirection...');
assertEqual('trend 数据不足', computeTrendDirection([1, 2], 10), 0);
// 单调上涨 → +1
assertEqual('trend 上涨 → +1', computeTrendDirection(allUp, 10), 1);
// 单调下跌 → -1
assertEqual('trend 下跌 → -1', computeTrendDirection(allDown, 10), -1);
// 横盘 → 0
const flat = Array.from({ length: 20 }, () => 100);
assertEqual('trend 横盘 → 0', computeTrendDirection(flat, 10), 0);

// ---------------------------------------------------------------------------
// [5] evaluateReversalBuy
// ---------------------------------------------------------------------------
console.log('\n[5] evaluateReversalBuy...');
assertEqual(
  '不跌 → 不触发',
  evaluateReversalBuy(-2, 1, 1),
  { triggered: false, confidence: 0 }
);
assertEqual(
  '跌 -4% 但周/月线都向下 → 不触发',
  evaluateReversalBuy(-4, -1, -1),
  { triggered: false, confidence: 0 }
);
assert(
  '跌 -4% 周线向上 → 触发, conf >= 55',
  evaluateReversalBuy(-4, 1, 0).triggered === true &&
    evaluateReversalBuy(-4, 1, 0).confidence >= 55
);
assert(
  '跌 -7% 周/月线都向上 → conf ≈ 95',
  evaluateReversalBuy(-7, 1, 1).confidence >= 90
);
assertEqual(
  'NaN → 不触发',
  evaluateReversalBuy(NaN, 1, 1),
  { triggered: false, confidence: 0 }
);

// ---------------------------------------------------------------------------
// [6] evaluateReversalSell
// ---------------------------------------------------------------------------
console.log('\n[6] evaluateReversalSell...');
assertEqual(
  '涨 +4% → 不触发',
  evaluateReversalSell(4, 75),
  { triggered: false, confidence: 0 }
);
assertEqual(
  '涨 +6% 但 RSI 60 → 不触发',
  evaluateReversalSell(6, 60),
  { triggered: false, confidence: 0 }
);
assertEqual(
  'RSI null → 不触发',
  evaluateReversalSell(6, null),
  { triggered: false, confidence: 0 }
);
assert(
  '涨 +7% RSI 75 → 触发',
  evaluateReversalSell(7, 75).triggered === true
);
assert(
  '涨 +9.5% RSI 85 → conf ≈ 95',
  evaluateReversalSell(9.5, 85).confidence === 95
);

// ---------------------------------------------------------------------------
// [7] evaluateStockReversal — happy
// ---------------------------------------------------------------------------
console.log('\n[7] evaluateStockReversal...');
// 数据不足
assertEqual('bars < 30 → []', evaluateStockReversal('A', null, []), []);

// 30 根, 中线趋势向上 (60 → 100), 今日跌 -5%
const closes30AscThenDip = [
  60, 62, 64, 66, 68, 70, 72, 74, 76, 78,
  80, 82, 84, 86, 88, 90, 91, 92, 93, 94,
  95, 96, 97, 98, 99, 100, 101, 102, 105, 100, // last drop -4.7%
];
const barsBuy = makeBarsAsc(closes30AscThenDip);
// 最后一根的 change_percent 用计算: (100 - 105) / 105 = -4.76%
const buyHits = evaluateStockReversal('sh.600519', '茅台', barsBuy);
assert('buy hit count >= 1', buyHits.length >= 1);
if (buyHits.length >= 1) {
  const h = buyHits.find(x => x.signal_type === 'reversal_buy');
  assert('reversal_buy 触发', !!h);
  if (h) {
    assert('weekly_trend 向上', h.weekly_trend === 1);
    assert('confidence > 0', h.confidence > 0);
  }
}

// 30 根, 长期上涨, 今日大涨 +8% (超买) — 需要 RSI > 70
const closes30Up = [
  50, 52, 54, 56, 58, 60, 62, 64, 66, 68,
  70, 72, 74, 76, 78, 80, 82, 84, 86, 88,
  90, 92, 94, 96, 98, 100, 102, 104, 105, 113.4, // last +8%
];
const barsSell = makeBarsAsc(closes30Up);
const sellHits = evaluateStockReversal('sh.600519', '茅台', barsSell);
const sellHit = sellHits.find(x => x.signal_type === 'reversal_sell');
assert('reversal_sell 触发 (长期上涨 + 今日大涨 → RSI 高)', !!sellHit);

// ---------------------------------------------------------------------------
// [8] runOnce e2e
// ---------------------------------------------------------------------------
console.log('\n[8] runOnce e2e...');

async function testEmptyUniverse(): Promise<void> {
  const ds = makeFakeDS({});
  const svc = new IntradayReversalDetector({ dataSource: ds });
  const r = await svc.runOnce();
  assert('empty — ok=true', r.ok === true);
  assertEqual('empty — scanned', r.scanned, 0);
  assertEqual('empty — hits', r.hits.length, 0);
}

async function testMultiStockBuyAndSell(): Promise<void> {
  const ds = makeFakeDS({
    barsBySymbol: {
      'sh.600519': makeBarsAsc(closes30AscThenDip), // 触发 buy
      'sh.600276': makeBarsAsc(closes30Up), // 触发 sell
    },
  });
  const svc = new IntradayReversalDetector({ dataSource: ds });
  const r = await svc.runOnce({ universe_override: ['sh.600519', 'sh.600276'] });
  assert('multi — ok', r.ok === true);
  assertEqual('multi — scanned 2', r.scanned, 2);
  assert('multi — buy >= 1', r.by_type.reversal_buy >= 1);
  assert('multi — sell >= 1', r.by_type.reversal_sell >= 1);
}

async function testInsufficientBars(): Promise<void> {
  const ds = makeFakeDS({
    barsBySymbol: {
      'sh.600519': makeBarsAsc([100, 101, 102]), // 仅 3 根 < 30
    },
  });
  const svc = new IntradayReversalDetector({ dataSource: ds });
  const r = await svc.runOnce({ universe_override: ['sh.600519'] });
  assertEqual('insufficient bars — hits 0', r.hits.length, 0);
  assert('insufficient bars — no errors (only skipped)', r.errors.length === 0);
}

async function testBarsThrow(): Promise<void> {
  const ds = makeFakeDS({
    barsBySymbol: { 'sh.600519': makeBarsAsc(closes30AscThenDip) },
    barsThrowSymbols: new Set(['sh.600000']),
  });
  const svc = new IntradayReversalDetector({ dataSource: ds });
  const r = await svc.runOnce({ universe_override: ['sh.600519', 'sh.600000'] });
  assertEqual('bars throw — scanned 2', r.scanned, 2);
  assertEqual('bars throw — errors 1', r.errors.length, 1);
  // 600519 仍应命中
  assert('bars throw — 600519 buy hit', r.by_type.reversal_buy >= 1);
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
(async () => {
  await testEmptyUniverse();
  await testMultiStockBuyAndSell();
  await testInsufficientBars();
  await testBarsThrow();

  console.log(`\n[intraday-reversal-detector] ${ok} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
  process.exit(0);
})();
