/**
 * TechnicalAnalysisService 单元测试 (US-061 AI 大模型技术面 K 线解读)
 *
 * 不依赖 jest; node 直接跑:
 *   cd backend && npx ts-node --transpile-only tests/services/technical-analysis-service.test.ts
 *
 * 完全脱离 DB / Python 子进程 / TradingAgents 远端: 注入 fake TechnicalAnalysisDataSource +
 * monkey-patch TechnicalAnalysisReport Sequelize Model 静态方法成内存 store.
 *
 * 覆盖维度:
 *   - 常量冻结校验 (TREND_LABELS / NLP_ENGINES);
 *   - 纯函数:
 *     - normalizeLookbackDays (默认 / clamp 上下限 / 非有限 / 浮点);
 *     - clampConfidence (0-100 / 负数 / 超 100 / null / NaN);
 *     - extractLastValues (N=1 / N=3 / NaN 过滤 / 空数组);
 *     - normalizeTrend (英文 / 中文 / 大小写 / 未识别);
 *     - normalizePriceArray (升序/降序 / NaN 过滤 / 重复去重 / max);
 *     - normalizePriceZone (低 ≤ 高 / 非数字 → [] / 长度 < 2 → []);
 *     - parseRemoteAnalysis (success / FAILED / 缺 data / 0-1 浮点 confidence / 0-100);
 *     - buildIndicatorContext (bars 充足 / bars 不足 RSI / bars 不足 MACD / 空数组);
 *     - buildHeuristicFallback (MACD+布林 → uptrend / downtrend / sideways / 缺数据兜底);
 *     - formatSummary (有/无 stock_name / AI summary 直接 prefix / 空 summary);
 *     - formatHeuristicSummary;
 *     - isCacheActive (TTL 未过 / 已过);
 *     - cacheRowToResult (DECIMAL Number 包装 / JSONB 数组兜底);
 *   - service.analyze() e2e:
 *     - cache hit (24h 内同 stock+lookback) → from_cache=true 不调远端;
 *     - cache miss → 调远端 → 写新行;
 *     - force_refresh=true → 跳过 cache 强制刷新;
 *     - dry_run=true → 不写表 (persisted=false);
 *     - K 线不足 → status='failed';
 *     - 远端 FAILED → 启发式 fallback (status='partial');
 *     - 远端 throw → 双重防御 catch + fallback;
 *     - saveReport throws → fail-OPEN (返回结果 + persisted=false);
 *     - findActiveCache throws → 不阻塞, 继续生成新报告;
 *   - service.refresh() = force_refresh=true 别名;
 *   - service.findActiveCache() = 读端 (无副作用).
 */

import {
  TechnicalAnalysisService,
  TechnicalAnalysisDataSource,
  TechnicalAnalysisResult,
  RemoteTechnicalAnalysisPayload,
  OHLCVBar,
  IndicatorContext,
  TREND_LABELS,
  NLP_ENGINES,
  DEFAULT_LOOKBACK_DAYS,
  MIN_LOOKBACK_DAYS,
  MAX_LOOKBACK_DAYS,
  CACHE_TTL_MS,
  normalizeLookbackDays,
  clampConfidence,
  extractLastValues,
  normalizeTrend,
  normalizePriceArray,
  normalizePriceZone,
  parseRemoteAnalysis,
  buildIndicatorContext,
  buildHeuristicFallback,
  formatSummary,
  formatHeuristicSummary,
  isCacheActive,
  cacheRowToResult,
  _emaTail,
  _smaTail,
  TrendLabel,
} from '../../src/services/TechnicalAnalysisService';
import { TechnicalAnalysisReport } from '../../src/models/TechnicalAnalysisReport';

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
  assert(
    name,
    ok,
    `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`
  );
}

// ---------------------------------------------------------------------------
// In-memory backing-store for TechnicalAnalysisReport model static method stubs
// ---------------------------------------------------------------------------

interface FakeReportRow {
  id?: number;
  stock_code: string;
  stock_name?: string | null;
  lookback_days: number;
  trend: string;
  support_levels: number[];
  resistance_levels: number[];
  buy_zone: number[];
  sell_zone: number[];
  summary?: string | null;
  confidence?: number | null;
  status: string;
  nlp_engine?: string | null;
  indicators_snapshot?: Record<string, unknown>;
  error?: string | null;
  generated_at: Date;
  expires_at: Date;
  metadata?: Record<string, unknown>;
}

let store: FakeReportRow[] = [];
let nextId = 1;

function resetStore(): void {
  store = [];
  nextId = 1;
}

function installModelStubs(): void {
  (TechnicalAnalysisReport as any).create = async (
    record: FakeReportRow,
    _opts?: unknown
  ): Promise<FakeReportRow> => {
    const merged: FakeReportRow = { ...record, id: nextId++ };
    store.push(merged);
    return merged;
  };

  (TechnicalAnalysisReport as any).findOne = async (options: any): Promise<FakeReportRow | null> => {
    let candidates = [...store];
    const sc = options?.where?.stock_code;
    if (typeof sc === 'string') {
      candidates = candidates.filter(s => s.stock_code === sc);
    }
    const lb = options?.where?.lookback_days;
    if (typeof lb === 'number') {
      candidates = candidates.filter(s => s.lookback_days === lb);
    }
    const ea = options?.where?.expires_at;
    if (ea && typeof ea === 'object') {
      const syms = Object.getOwnPropertySymbols(ea);
      for (const sym of syms) {
        const symStr = sym.toString();
        const v = ea[sym];
        if (symStr.includes('gte')) {
          candidates = candidates.filter(s => s.expires_at.getTime() >= v.getTime());
        } else if (symStr.includes('lte')) {
          candidates = candidates.filter(s => s.expires_at.getTime() <= v.getTime());
        } else if (symStr.includes('lt')) {
          candidates = candidates.filter(s => s.expires_at.getTime() < v.getTime());
        } else if (symStr.includes('gt')) {
          candidates = candidates.filter(s => s.expires_at.getTime() > v.getTime());
        }
      }
    }
    if (options?.order) {
      for (const ord of options.order.slice().reverse()) {
        const [field, dir] = ord;
        candidates.sort((a: any, b: any) => {
          const av = a[field];
          const bv = b[field];
          const aTime = av instanceof Date ? av.getTime() : av;
          const bTime = bv instanceof Date ? bv.getTime() : bv;
          if (aTime === bTime) return 0;
          return dir === 'DESC' ? (aTime < bTime ? 1 : -1) : aTime < bTime ? -1 : 1;
        });
      }
    }
    return candidates[0] || null;
  };
}

// ---------------------------------------------------------------------------
// Fake DataSource
// ---------------------------------------------------------------------------

interface FakeDSState {
  bars: OHLCVBar[];
  stockName?: string | null;
  remotePayload?: RemoteTechnicalAnalysisPayload;
  remoteShouldThrow?: boolean;
  saveShouldThrow?: boolean;
  findCacheShouldThrow?: boolean;
  cachedRow?: TechnicalAnalysisReport | null;
  remoteCalls: Array<{ stockCode: string; lookbackDays: number }>;
  saveCalls: TechnicalAnalysisResult[];
}

function makeFakeDS(state: FakeDSState): TechnicalAnalysisDataSource {
  return {
    async loadBars(_stockCode: string, _lookbackDays: number) {
      return state.bars;
    },
    async resolveStockName(_stockCode: string) {
      return state.stockName === undefined ? '测试股票' : state.stockName;
    },
    async callRemoteAnalyze(stockCode: string, _ctx, lookbackDays: number) {
      state.remoteCalls.push({ stockCode, lookbackDays });
      if (state.remoteShouldThrow) throw new Error('fake remote outage');
      return (
        state.remotePayload || {
          status: 'COMPLETED',
          data: {
            trend: 'uptrend',
            support_levels: [9.5, 9.0],
            resistance_levels: [11.0, 11.5],
            buy_zone: [9.4, 9.6],
            sell_zone: [10.9, 11.1],
            summary: 'AI 解读: 上升趋势',
            confidence: 75,
          },
        }
      );
    },
    async findActiveCache(_stockCode, _lookbackDays, _now) {
      if (state.findCacheShouldThrow) throw new Error('fake cache outage');
      return state.cachedRow || null;
    },
    async saveReport(record: TechnicalAnalysisResult) {
      if (state.saveShouldThrow) throw new Error('fake save outage');
      state.saveCalls.push(record);
    },
  };
}

// ---------------------------------------------------------------------------
// Synthetic OHLCV fixture
// ---------------------------------------------------------------------------

/**
 * 生成 N 根连续 K 线 (从 start_price 等比累积 dailyDriftPct + noise).
 * - drift > 0 → 上升趋势; drift < 0 → 下降; drift=0 + noise → 震荡.
 */
function makeBars(
  n: number,
  startPrice = 10,
  dailyDriftPct = 0,
  noiseSeed = 0
): OHLCVBar[] {
  const bars: OHLCVBar[] = [];
  let close = startPrice;
  const baseTime = new Date('2026-01-01T00:00:00Z').getTime();
  // deterministic LCG for noise
  let seed = noiseSeed + 1;
  const rng = () => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };
  for (let i = 0; i < n; i++) {
    const drift = (close * dailyDriftPct) / 100;
    const noise = (rng() - 0.5) * close * 0.01;
    const nextClose = close + drift + noise;
    const open = close;
    const high = Math.max(open, nextClose) + Math.abs(noise) * 0.5;
    const low = Math.min(open, nextClose) - Math.abs(noise) * 0.5;
    bars.push({
      time: new Date(baseTime + i * 86400000),
      open,
      high,
      low,
      close: nextClose,
      volume: 1_000_000 + Math.round(rng() * 100_000),
    });
    close = nextClose;
  }
  return bars;
}

// ---------------------------------------------------------------------------
// 1. Constants
// ---------------------------------------------------------------------------

console.log('=== Constants ===');
assert('TREND_LABELS 冻结', Object.isFrozen(TREND_LABELS));
assert('NLP_ENGINES 冻结', Object.isFrozen(NLP_ENGINES));
assertEqual('DEFAULT_LOOKBACK_DAYS', DEFAULT_LOOKBACK_DAYS, 60);
assertEqual('MIN_LOOKBACK_DAYS', MIN_LOOKBACK_DAYS, 20);
assertEqual('MAX_LOOKBACK_DAYS', MAX_LOOKBACK_DAYS, 250);
assertEqual('CACHE_TTL_MS', CACHE_TTL_MS, 24 * 60 * 60 * 1000);
assertEqual('TREND uptrend', TREND_LABELS.UPTREND, 'uptrend');
assertEqual('TREND downtrend', TREND_LABELS.DOWNTREND, 'downtrend');
assertEqual('TREND sideways', TREND_LABELS.SIDEWAYS, 'sideways');
assertEqual('TREND unknown', TREND_LABELS.UNKNOWN, 'unknown');
assertEqual('NLP trading_agents', NLP_ENGINES.TRADING_AGENTS, 'trading_agents');
assertEqual('NLP heuristic', NLP_ENGINES.HEURISTIC, 'heuristic_fallback');

// ---------------------------------------------------------------------------
// 2. normalizeLookbackDays
// ---------------------------------------------------------------------------

console.log('=== normalizeLookbackDays ===');
assertEqual('default for undefined', normalizeLookbackDays(undefined), 60);
assertEqual('default for null', normalizeLookbackDays(null), 60);
assertEqual('default for NaN', normalizeLookbackDays(NaN), 60);
assertEqual('default for 0', normalizeLookbackDays(0), 60);
assertEqual('default for negative', normalizeLookbackDays(-5), 60);
assertEqual('default for < MIN (10)', normalizeLookbackDays(10), 60);
assertEqual('MIN exact (20)', normalizeLookbackDays(20), 20);
assertEqual('mid (90)', normalizeLookbackDays(90), 90);
assertEqual('MAX exact (250)', normalizeLookbackDays(250), 250);
assertEqual('clamp at MAX (500)', normalizeLookbackDays(500), 250);
assertEqual('floor float (60.7)', normalizeLookbackDays(60.7), 60);
assertEqual('string "30"', normalizeLookbackDays('30'), 30);

// ---------------------------------------------------------------------------
// 3. clampConfidence
// ---------------------------------------------------------------------------

console.log('=== clampConfidence ===');
assertEqual('null', clampConfidence(null), null);
assertEqual('undefined', clampConfidence(undefined), null);
assertEqual('NaN', clampConfidence(NaN), null);
assertEqual('Infinity', clampConfidence(Infinity), null);
assertEqual('negative', clampConfidence(-10), 0);
assertEqual('over 100', clampConfidence(150), 100);
assertEqual('valid 75', clampConfidence(75), 75);
assertEqual('exact 0', clampConfidence(0), 0);
assertEqual('exact 100', clampConfidence(100), 100);

// ---------------------------------------------------------------------------
// 4. extractLastValues
// ---------------------------------------------------------------------------

console.log('=== extractLastValues ===');
assertEqual('empty', extractLastValues([], 1), []);
assertEqual('N=0', extractLastValues([1, 2, 3], 0), []);
assertEqual('N=1', extractLastValues([1, 2, 3], 1), [3]);
assertEqual('N=3', extractLastValues([1, 2, 3, 4, 5], 3), [3, 4, 5]);
assertEqual('NaN 过滤', extractLastValues([NaN, 1, Infinity, 2, 3], 2), [2, 3]);
assertEqual('N > length', extractLastValues([1, 2], 5), [1, 2]);

// ---------------------------------------------------------------------------
// 5. normalizeTrend
// ---------------------------------------------------------------------------

console.log('=== normalizeTrend ===');
assertEqual('null', normalizeTrend(null), 'unknown');
assertEqual('空字符串', normalizeTrend(''), 'unknown');
assertEqual('英文 uptrend', normalizeTrend('UPTREND'), 'uptrend');
assertEqual('英文 bull', normalizeTrend('Bull market'), 'uptrend');
assertEqual('英文 downtrend', normalizeTrend('downtrend'), 'downtrend');
assertEqual('英文 sideways', normalizeTrend('Sideways range'), 'sideways');
assertEqual('英文 breakout', normalizeTrend('Breakout above'), 'breakout');
assertEqual('英文 reversal', normalizeTrend('reversal'), 'reversal');
assertEqual('中文 上升', normalizeTrend('上升'), 'uptrend');
assertEqual('中文 下跌', normalizeTrend('下跌'), 'downtrend');
assertEqual('中文 震荡', normalizeTrend('震荡整理'), 'sideways');
assertEqual('中文 突破', normalizeTrend('放量突破'), 'breakout');
assertEqual('中文 反转', normalizeTrend('反转向上'), 'reversal');
assertEqual('未知 xxx', normalizeTrend('xyz'), 'unknown');

// ---------------------------------------------------------------------------
// 6. normalizePriceArray
// ---------------------------------------------------------------------------

console.log('=== normalizePriceArray ===');
assertEqual('null → []', normalizePriceArray(null, { ascending: true }), []);
assertEqual('空 → []', normalizePriceArray([], { ascending: true }), []);
assertEqual(
  '升序',
  normalizePriceArray([3, 1, 2], { ascending: true }),
  [1, 2, 3]
);
assertEqual(
  '降序',
  normalizePriceArray([1, 3, 2], { ascending: false }),
  [3, 2, 1]
);
assertEqual(
  '过滤 NaN/负',
  normalizePriceArray([1, NaN, -2, 3, Infinity], { ascending: true }),
  [1, 3]
);
assertEqual(
  '去重',
  normalizePriceArray([10, 10, 11], { ascending: true }),
  [10, 11]
);
assertEqual(
  'max=2',
  normalizePriceArray([1, 2, 3, 4, 5], { ascending: true, max: 2 }),
  [1, 2]
);
assertEqual(
  'round 2 decimals',
  normalizePriceArray([1.234, 5.678], { ascending: true }),
  [1.23, 5.68]
);

// ---------------------------------------------------------------------------
// 7. normalizePriceZone
// ---------------------------------------------------------------------------

console.log('=== normalizePriceZone ===');
assertEqual('null → []', normalizePriceZone(null), []);
assertEqual('空 → []', normalizePriceZone([]), []);
assertEqual('单元素 → []', normalizePriceZone([5]), []);
assertEqual('正常 low<high', normalizePriceZone([9, 11]), [9, 11]);
assertEqual('颠倒 → 自动 sort', normalizePriceZone([11, 9]), [9, 11]);
assertEqual('NaN → []', normalizePriceZone([NaN, 10]), []);
assertEqual('负数 → []', normalizePriceZone([-1, 10]), []);
assertEqual('round 2 decimals', normalizePriceZone([1.234, 5.678]), [1.23, 5.68]);

// ---------------------------------------------------------------------------
// 8. parseRemoteAnalysis
// ---------------------------------------------------------------------------

console.log('=== parseRemoteAnalysis ===');
{
  const ok = parseRemoteAnalysis({
    status: 'COMPLETED',
    data: {
      trend: 'uptrend',
      support_levels: [9.5, 9.0],
      resistance_levels: [11.0, 11.5],
      buy_zone: [9.4, 9.6],
      sell_zone: [10.9, 11.1],
      summary: 'AI 解读',
      confidence: 75,
    },
  });
  assert('success not null', ok !== null);
  if (ok) {
    assertEqual('trend', ok.trend, 'uptrend');
    assertEqual('support 降序', ok.support_levels, [9.5, 9]);
    assertEqual('resistance 升序', ok.resistance_levels, [11, 11.5]);
    assertEqual('buy_zone', ok.buy_zone, [9.4, 9.6]);
    assertEqual('sell_zone', ok.sell_zone, [10.9, 11.1]);
    assertEqual('summary', ok.summary, 'AI 解读');
    assertEqual('confidence', ok.confidence, 75);
  }
}

{
  // FAILED status
  const failed = parseRemoteAnalysis({ status: 'FAILED', data: { error: 'oops' } });
  assertEqual('FAILED → null', failed, null);
}

{
  // 无 data
  const noData = parseRemoteAnalysis({ status: 'COMPLETED' });
  assertEqual('no data → null', noData, null);
}

{
  // 0-1 浮点 confidence 自动转
  const conv = parseRemoteAnalysis({
    status: 'COMPLETED',
    data: { trend: 'uptrend', confidence: 0.85 },
  });
  assert('conv not null', conv !== null);
  if (conv) {
    assertEqual('0.85 → 85', conv.confidence, 85);
  }
}

{
  // confidence_score fallback
  const cs = parseRemoteAnalysis({
    status: 'COMPLETED',
    data: { trend: 'uptrend', confidence_score: 60 },
  });
  assert('cs not null', cs !== null);
  if (cs) {
    assertEqual('confidence_score → 60', cs.confidence, 60);
  }
}

{
  // 缺所有 confidence → null
  const noConf = parseRemoteAnalysis({
    status: 'COMPLETED',
    data: { trend: 'sideways' },
  });
  assert('noConf not null', noConf !== null);
  if (noConf) {
    assertEqual('no conf → null', noConf.confidence, null);
    assertEqual('default trend sideways', noConf.trend, 'sideways');
    assertEqual('default supports []', noConf.support_levels, []);
  }
}

// ---------------------------------------------------------------------------
// 9. buildIndicatorContext
// ---------------------------------------------------------------------------

console.log('=== buildIndicatorContext ===');
{
  const ctx = buildIndicatorContext([]);
  assertEqual('empty bars - last_close', ctx.last_close, 0);
  assertEqual('empty bars - rsi null', ctx.last_rsi, null);
  assertEqual('empty bars - macd null', ctx.last_macd, null);
  assertEqual('empty bars - bbands null', ctx.last_bbands, null);
  assertEqual('empty bars - vol_ratio null', ctx.vol_ratio, null);
}

{
  // 10 根 — 不足 RSI(14) / MACD(35) / 布林(20)
  const bars = makeBars(10, 10, 0);
  const ctx = buildIndicatorContext(bars);
  assert('10 bars - last_close > 0', ctx.last_close > 0);
  assertEqual('10 bars - rsi null', ctx.last_rsi, null);
  assertEqual('10 bars - macd null', ctx.last_macd, null);
  assertEqual('10 bars - bbands null', ctx.last_bbands, null);
  // vol_ratio 需要 >= 6 bars
  assert('10 bars - vol_ratio not null', ctx.vol_ratio !== null);
  assert('momentum_pct present', ctx.momentum_pct !== null);
}

{
  // 25 根 — 够布林 不够 MACD/RSI
  const bars = makeBars(25, 10, 1);
  const ctx = buildIndicatorContext(bars);
  assert('25 bars - bbands present', ctx.last_bbands !== null);
  assert('25 bars - rsi present (15+)', ctx.last_rsi !== null);
  assertEqual('25 bars - macd null (< 35)', ctx.last_macd, null);
}

{
  // 60 根 — 够全部
  const bars = makeBars(60, 10, 1);
  const ctx = buildIndicatorContext(bars);
  assert('60 bars - rsi present', ctx.last_rsi !== null);
  assert('60 bars - macd present', ctx.last_macd !== null);
  assert('60 bars - bbands present', ctx.last_bbands !== null);
  assert('60 bars - vol_ratio present', ctx.vol_ratio !== null);
  assert('60 bars - recent_high > recent_low', ctx.recent_high > ctx.recent_low);
  assert('60 bars - last_close > 0', ctx.last_close > 0);
  if (ctx.last_macd) {
    assert(
      '60 bars - macd dif finite',
      Number.isFinite(ctx.last_macd.dif) && Number.isFinite(ctx.last_macd.dea) && Number.isFinite(ctx.last_macd.hist)
    );
  }
  if (ctx.last_bbands) {
    assert(
      '60 bars - bbands upper > middle > lower',
      ctx.last_bbands.upper > ctx.last_bbands.middle && ctx.last_bbands.middle > ctx.last_bbands.lower
    );
  }
}

// ---------------------------------------------------------------------------
// 10. buildHeuristicFallback
// ---------------------------------------------------------------------------

console.log('=== buildHeuristicFallback ===');
{
  // 上升 ctx
  const bars = makeBars(60, 10, 1); // drift +1% 每日, 强力上升
  const ctx = buildIndicatorContext(bars);
  const fb = buildHeuristicFallback(ctx);
  assertEqual('uptrend - trend', fb.trend, 'uptrend');
  assert('uptrend - confidence=50', fb.confidence === 50);
  assert('uptrend - supports non-empty', fb.support_levels.length > 0);
  assert('uptrend - resistance non-empty', fb.resistance_levels.length > 0);
  assert('uptrend - buy_zone length=2', fb.buy_zone.length === 2);
  assert('uptrend - sell_zone length=2', fb.sell_zone.length === 2);
  assert('uptrend - summary 含 上升', fb.summary.includes('上升'));
}

{
  // 下降 ctx
  const bars = makeBars(60, 20, -1); // drift -1% 每日
  const ctx = buildIndicatorContext(bars);
  const fb = buildHeuristicFallback(ctx);
  assertEqual('downtrend - trend', fb.trend, 'downtrend');
  assert('downtrend - summary 含 下降', fb.summary.includes('下降'));
}

{
  // 震荡 ctx
  const bars = makeBars(60, 10, 0); // 无 drift
  const ctx = buildIndicatorContext(bars);
  const fb = buildHeuristicFallback(ctx);
  // 0 drift 多半判 sideways (有可能 noise 让 MACD 微正或微负)
  assert(
    'sideways or modest',
    fb.trend === 'sideways' || fb.trend === 'uptrend' || fb.trend === 'downtrend'
  );
}

{
  // 数据不足 ctx (无 MACD 无布林)
  const bars = makeBars(8, 10, 0);
  const ctx = buildIndicatorContext(bars);
  const fb = buildHeuristicFallback(ctx);
  assert('low data - has summary', fb.summary.length > 0);
  assert('low data - confidence=50', fb.confidence === 50);
}

// ---------------------------------------------------------------------------
// 11. formatSummary / formatHeuristicSummary
// ---------------------------------------------------------------------------

console.log('=== formatSummary ===');
{
  const s = formatSummary('sh.600519', '贵州茅台', '正文内容', 'uptrend', 80);
  assert('with name in header', s.includes('贵州茅台'));
  assert('with stock_code', s.includes('sh.600519'));
  assert('with confidence 80', s.includes('80'));
  assert('with trend label 上升', s.includes('上升'));
  assert('with body', s.includes('正文内容'));
}
{
  const s = formatSummary('sz.000001', null, '', 'sideways', null);
  assert('no name no body', s.includes('sz.000001') && s.includes('未返回详细总览'));
}
{
  const s = formatSummary('x', 'X', '**【AI 已格式化】**\n- ok', 'uptrend', 80);
  assertEqual('AI 已格式化 直接返回', s, '**【AI 已格式化】**\n- ok');
}

{
  const bars = makeBars(60, 10, 1);
  const ctx = buildIndicatorContext(bars);
  const sum = formatHeuristicSummary(ctx, 'uptrend', [9.5], [11.0]);
  assert('heuristic summary - 含 启发式兜底', sum.includes('启发式兜底'));
  assert('heuristic summary - 含 支撑位', sum.includes('支撑位'));
  assert('heuristic summary - 含 压力位', sum.includes('压力位'));
}

// ---------------------------------------------------------------------------
// 12. isCacheActive / cacheRowToResult
// ---------------------------------------------------------------------------

console.log('=== isCacheActive / cacheRowToResult ===');
{
  const now = new Date('2026-06-08T00:00:00Z');
  const active = {
    expires_at: new Date('2026-06-08T01:00:00Z'),
  } as any as TechnicalAnalysisReport;
  assert('active = true', isCacheActive(active, now) === true);

  const expired = {
    expires_at: new Date('2026-06-07T23:00:00Z'),
  } as any as TechnicalAnalysisReport;
  assert('expired = false', isCacheActive(expired, now) === false);

  assert('null row = false', isCacheActive(null as any, now) === false);
}

{
  const row = {
    stock_code: 'sh.600519',
    stock_name: '贵州茅台',
    lookback_days: 60,
    trend: 'uptrend',
    support_levels: [9.5, 9],
    resistance_levels: [11, 11.5],
    buy_zone: ['9.4', '9.6'], // string 来自 PostgreSQL JSONB 协议
    sell_zone: [10.9, 11.1],
    summary: 'cached summary',
    confidence: '85.00', // DECIMAL 来自 DB 是 string
    status: 'completed',
    nlp_engine: 'trading_agents',
    indicators_snapshot: { last_close: 10 },
    error: null,
    generated_at: new Date('2026-06-08T00:00:00Z'),
    expires_at: new Date('2026-06-09T00:00:00Z'),
    metadata: { foo: 'bar' },
  } as any as TechnicalAnalysisReport;
  const r = cacheRowToResult(row);
  assertEqual('from_cache=true', r.from_cache, true);
  assertEqual('persisted=true', r.persisted, true);
  assertEqual('confidence as Number', r.confidence, 85);
  // buy_zone strings → numbers via Number() wrapper
  assertEqual('buy_zone Number wrap', r.buy_zone, [9.4, 9.6]);
  assertEqual('trend', r.trend, 'uptrend');
  assertEqual('summary', r.summary, 'cached summary');
}

// ---------------------------------------------------------------------------
// 13. _emaTail / _smaTail
// ---------------------------------------------------------------------------

console.log('=== _emaTail / _smaTail ===');
assertEqual('ema empty insufficient', _emaTail([1, 2], 14), null);
assertEqual('sma empty insufficient', _smaTail([1, 2], 14), null);
{
  const closes = [1, 2, 3, 4, 5];
  const sma3 = _smaTail(closes, 3);
  assert('sma 5 with period 3', sma3 !== null && sma3 === 4);
}

// ---------------------------------------------------------------------------
// 14. service.analyze e2e
// ---------------------------------------------------------------------------

async function testServiceE2E(): Promise<void> {
  console.log('=== service.analyze e2e ===');
  installModelStubs();

  // (1) Happy path: cache miss + 远端成功 → completed
  resetStore();
  {
    const bars = makeBars(60, 10, 1);
    const state: FakeDSState = { bars, remoteCalls: [], saveCalls: [] };
    const svc = new TechnicalAnalysisService(makeFakeDS(state));
    const result = await svc.analyze('sh.600519', 60);
    assertEqual('happy - status completed', result.status, 'completed');
    assertEqual('happy - trend uptrend', result.trend, 'uptrend');
    assertEqual('happy - from_cache=false', result.from_cache, false);
    assertEqual('happy - persisted=true', result.persisted, true);
    assertEqual('happy - engine trading_agents', result.nlp_engine, 'trading_agents');
    assert('happy - support_levels non-empty', result.support_levels.length > 0);
    assert('happy - confidence > 0', (result.confidence ?? 0) > 0);
    assertEqual('happy - 1 remote call', state.remoteCalls.length, 1);
    assertEqual('happy - 1 save call', state.saveCalls.length, 1);
  }

  // (2) Cache hit → from_cache=true, no remote call
  resetStore();
  {
    const bars = makeBars(60, 10, 1);
    const cachedRow = {
      stock_code: 'sh.600519',
      stock_name: '贵州茅台',
      lookback_days: 60,
      trend: 'uptrend',
      support_levels: [9.5],
      resistance_levels: [11.0],
      buy_zone: [9.4, 9.6],
      sell_zone: [10.9, 11.1],
      summary: 'cached',
      confidence: 75,
      status: 'completed',
      nlp_engine: 'trading_agents',
      indicators_snapshot: {},
      error: null,
      generated_at: new Date('2026-06-08T00:00:00Z'),
      expires_at: new Date('2030-01-01T00:00:00Z'),
      metadata: {},
    } as any as TechnicalAnalysisReport;
    const state: FakeDSState = {
      bars,
      cachedRow,
      remoteCalls: [],
      saveCalls: [],
    };
    const svc = new TechnicalAnalysisService(makeFakeDS(state));
    const result = await svc.analyze('sh.600519', 60);
    assertEqual('cache hit - from_cache=true', result.from_cache, true);
    assertEqual('cache hit - persisted=true', result.persisted, true);
    assertEqual('cache hit - 0 remote', state.remoteCalls.length, 0);
    assertEqual('cache hit - 0 save', state.saveCalls.length, 0);
    assertEqual('cache hit - summary preserved', result.summary, 'cached');
  }

  // (3) force_refresh=true → 跳过 cache 重新生成
  resetStore();
  {
    const bars = makeBars(60, 10, 1);
    const cachedRow = {
      stock_code: 'sh.600519',
      stock_name: null,
      lookback_days: 60,
      trend: 'uptrend',
      support_levels: [],
      resistance_levels: [],
      buy_zone: [],
      sell_zone: [],
      summary: 'old',
      confidence: 50,
      status: 'completed',
      nlp_engine: 'trading_agents',
      indicators_snapshot: {},
      error: null,
      generated_at: new Date('2026-06-08T00:00:00Z'),
      expires_at: new Date('2030-01-01T00:00:00Z'),
      metadata: {},
    } as any as TechnicalAnalysisReport;
    const state: FakeDSState = {
      bars,
      cachedRow,
      remoteCalls: [],
      saveCalls: [],
    };
    const svc = new TechnicalAnalysisService(makeFakeDS(state));
    const result = await svc.analyze('sh.600519', 60, { force_refresh: true });
    assertEqual('force_refresh - from_cache=false', result.from_cache, false);
    assertEqual('force_refresh - 1 remote', state.remoteCalls.length, 1);
  }

  // (4) dry_run=true → 不写表 (persisted=false)
  resetStore();
  {
    const bars = makeBars(60, 10, 1);
    const state: FakeDSState = { bars, remoteCalls: [], saveCalls: [] };
    const svc = new TechnicalAnalysisService(makeFakeDS(state));
    const result = await svc.analyze('sh.600519', 60, { dry_run: true });
    assertEqual('dry_run - persisted=false', result.persisted, false);
    assertEqual('dry_run - 0 save', state.saveCalls.length, 0);
  }

  // (5) K 线不足 → failed
  resetStore();
  {
    const bars = makeBars(10, 10, 0); // 不足 20
    const state: FakeDSState = { bars, remoteCalls: [], saveCalls: [] };
    const svc = new TechnicalAnalysisService(makeFakeDS(state));
    const result = await svc.analyze('sh.600519', 60);
    assertEqual('insufficient - status failed', result.status, 'failed');
    assertEqual('insufficient - trend unknown', result.trend, 'unknown');
    assert('insufficient - error present', (result.error ?? '').includes('K 线数据不足'));
    assertEqual('insufficient - 0 remote (skipped)', state.remoteCalls.length, 0);
    assertEqual('insufficient - 1 save (still write failed)', state.saveCalls.length, 1);
  }

  // (6) 远端 FAILED → 启发式 fallback (status=partial)
  resetStore();
  {
    const bars = makeBars(60, 10, 1);
    const state: FakeDSState = {
      bars,
      remotePayload: { status: 'FAILED', data: { error: 'oops' } },
      remoteCalls: [],
      saveCalls: [],
    };
    const svc = new TechnicalAnalysisService(makeFakeDS(state));
    const result = await svc.analyze('sh.600519', 60);
    assertEqual('remote FAILED - status partial', result.status, 'partial');
    assertEqual('remote FAILED - engine heuristic', result.nlp_engine, 'heuristic_fallback');
    assertEqual('remote FAILED - confidence=50', result.confidence, 50);
    assert('remote FAILED - error contains oops', (result.error ?? '').includes('oops'));
    assert('remote FAILED - summary 含 启发式', result.summary.includes('启发式'));
    assertEqual('remote FAILED - 1 save', state.saveCalls.length, 1);
  }

  // (7) 远端 throws → 双重防御 catch + fallback
  resetStore();
  {
    const bars = makeBars(60, 10, 1);
    const state: FakeDSState = {
      bars,
      remoteShouldThrow: true,
      remoteCalls: [],
      saveCalls: [],
    };
    const svc = new TechnicalAnalysisService(makeFakeDS(state));
    const result = await svc.analyze('sh.600519', 60);
    assertEqual('remote throw - status partial', result.status, 'partial');
    assertEqual('remote throw - engine heuristic', result.nlp_engine, 'heuristic_fallback');
    assert('remote throw - error contains outage', (result.error ?? '').includes('outage'));
  }

  // (8) saveReport throws → fail-OPEN (返回结果 + persisted=false)
  resetStore();
  {
    const bars = makeBars(60, 10, 1);
    const state: FakeDSState = {
      bars,
      saveShouldThrow: true,
      remoteCalls: [],
      saveCalls: [],
    };
    const svc = new TechnicalAnalysisService(makeFakeDS(state));
    const result = await svc.analyze('sh.600519', 60);
    // 不抛
    assertEqual('save throw - status completed (AI ok)', result.status, 'completed');
    assertEqual('save throw - persisted=false', result.persisted, false);
    assert(
      'save throw - metadata.persist_error set',
      typeof (result.metadata as any).persist_error === 'string'
    );
  }

  // (9) findActiveCache throws → 不阻塞, 继续生成
  resetStore();
  {
    const bars = makeBars(60, 10, 1);
    const state: FakeDSState = {
      bars,
      findCacheShouldThrow: true,
      remoteCalls: [],
      saveCalls: [],
    };
    const svc = new TechnicalAnalysisService(makeFakeDS(state));
    const result = await svc.analyze('sh.600519', 60);
    assertEqual('cache throw - still completed', result.status, 'completed');
    assertEqual('cache throw - 1 remote (proceeded)', state.remoteCalls.length, 1);
  }

  // (10) refresh = force_refresh=true 别名
  resetStore();
  {
    const bars = makeBars(60, 10, 1);
    const cachedRow = {
      stock_code: 'sh.600519',
      stock_name: null,
      lookback_days: 60,
      trend: 'uptrend',
      support_levels: [],
      resistance_levels: [],
      buy_zone: [],
      sell_zone: [],
      summary: 'old',
      confidence: 50,
      status: 'completed',
      nlp_engine: 'trading_agents',
      indicators_snapshot: {},
      error: null,
      generated_at: new Date('2026-06-08T00:00:00Z'),
      expires_at: new Date('2030-01-01T00:00:00Z'),
      metadata: {},
    } as any as TechnicalAnalysisReport;
    const state: FakeDSState = { bars, cachedRow, remoteCalls: [], saveCalls: [] };
    const svc = new TechnicalAnalysisService(makeFakeDS(state));
    const result = await svc.refresh('sh.600519', 60);
    assertEqual('refresh - 1 remote', state.remoteCalls.length, 1);
    assertEqual('refresh - not from cache', result.from_cache, false);
  }

  // (11) findActiveCache 读端 (无副作用) — cache hit 返回结果
  resetStore();
  {
    const cachedRow = {
      stock_code: 'sh.600519',
      stock_name: null,
      lookback_days: 60,
      trend: 'uptrend',
      support_levels: [],
      resistance_levels: [],
      buy_zone: [],
      sell_zone: [],
      summary: '只读',
      confidence: 70,
      status: 'completed',
      nlp_engine: 'trading_agents',
      indicators_snapshot: {},
      error: null,
      generated_at: new Date('2026-06-08T00:00:00Z'),
      expires_at: new Date('2030-01-01T00:00:00Z'),
      metadata: {},
    } as any as TechnicalAnalysisReport;
    const state: FakeDSState = { bars: [], cachedRow, remoteCalls: [], saveCalls: [] };
    const svc = new TechnicalAnalysisService(makeFakeDS(state));
    const result = await svc.findActiveCache('sh.600519', 60);
    assert('findActiveCache - hit not null', result !== null);
    if (result) {
      assertEqual('findActiveCache - from_cache=true', result.from_cache, true);
      assertEqual('findActiveCache - summary preserved', result.summary, '只读');
    }
    assertEqual('findActiveCache - 0 remote (read-only)', state.remoteCalls.length, 0);
  }

  // (12) findActiveCache miss → null
  {
    const state: FakeDSState = {
      bars: [],
      cachedRow: null,
      remoteCalls: [],
      saveCalls: [],
    };
    const svc = new TechnicalAnalysisService(makeFakeDS(state));
    const result = await svc.findActiveCache('sh.600519', 60);
    assertEqual('findActiveCache - miss returns null', result, null);
  }
}

// ---------------------------------------------------------------------------
// 15. parseRemoteAnalysis cleanup tests
// ---------------------------------------------------------------------------

console.log('=== parseRemoteAnalysis edge cases ===');
{
  // confidence overflow > 1 但 < 100 (e.g. 95) 不应当二次 *100
  const r = parseRemoteAnalysis({
    status: 'COMPLETED',
    data: { trend: 'uptrend', confidence: 95 },
  });
  assert('95 → 95 (not scaled)', r !== null && r.confidence === 95);
}
{
  // confidence overflow > 100 → clamp 100
  const r = parseRemoteAnalysis({
    status: 'COMPLETED',
    data: { trend: 'uptrend', confidence: 150 },
  });
  assert('150 → 100 clamped', r !== null && r.confidence === 100);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  await testServiceE2E();

  console.log(`\n=== Summary ===`);
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  if (failed > 0) {
    process.exit(1);
  } else {
    console.log('All tests passed ✅');
    process.exit(0);
  }
}

main().catch(err => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
