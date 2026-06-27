/**
 * IntradayOpportunityWatcher 单元测试 (CE-B)
 *
 * 跑法:
 *   cd backend && npx ts-node --transpile-only tests/services/intraday-opportunity-watcher.test.ts
 *
 * 完全脱 DB / 网络 / 飞书 webhook —— WatcherDataSource / universe / engine / pusher 全 stub.
 *
 * 覆盖维度:
 *   - 10 类 detector: 每个 happy + 不命中 (20+ case)
 *   - 纯 helper: isHighLimitSymbol / compute5dVolumeRatio / mapDecisionAction / mapRiskLevel
 *   - buildRuleContextFromSnapshot 缺字段返 null
 *   - scan() e2e: 命中数 / 推送数 / dedup / dry_run / final_score 阈值 / 同股多规则
 */

import {
  IntradayOpportunityWatcher,
  WatcherDataSource,
  WatcherSymbolSnapshot,
  RuleContext,
  RuleBar,
  TRIGGER_RULE_IDS,
  TRIGGER_RULE_LABELS,
  DETECTOR_MAP,
  detectBreakout60dHigh,
  detectBreakout20dHigh,
  detectVolumeSpike,
  detectRapidRise,
  detectRapidFallStabilize,
  detectGapUpBreakout,
  detectNorthboundInflowSurge,
  detectLimitUpFirstBoard,
  detectDragonTigerFirstBoard,
  detectVolumePriceConfirmation,
  isHighLimitSymbol,
  compute5dVolumeRatio,
  mapDecisionAction,
  mapRiskLevel,
  buildRuleContextFromSnapshot,
  buildPusherInputFromHit,
} from '../../src/services/IntradayOpportunityWatcher';
import type { IntradayUniverseService } from '../../src/services/IntradayUniverseService';
import type { AnalysisEngineService } from '../../src/services/analysis-engine/AnalysisEngineService';
import type { RecommendationDecision } from '../../src/services/analysis-engine/AnalyzerTypes';
import type {
  IntradayOpportunityPusher,
  OpportunityInput,
  PushOptions,
  PushResult,
} from '../../src/services/IntradayOpportunityPusher';

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
// Fixtures
// ---------------------------------------------------------------------------

function makeBars(opts: {
  count: number;
  baseClose?: number;
  baseVolume?: number;
  /** 1.0 → 每根递增 1%; -1.0 → 每根 -1% */
  pctStep?: number;
  /** 是否给所有 bar 同 high (用于测 breakout) */
  highOverride?: number;
}): RuleBar[] {
  const count = opts.count;
  const base = opts.baseClose ?? 100;
  const baseVol = opts.baseVolume ?? 1_000_000;
  const step = opts.pctStep ?? 0;
  const bars: RuleBar[] = [];
  let close = base;
  for (let i = 0; i < count; i++) {
    const prev = close;
    close = prev * (1 + step / 100);
    bars.push({
      time: new Date(Date.UTC(2026, 5, 1 + i)),
      open: prev,
      high: opts.highOverride ?? Math.max(prev, close) * 1.005,
      low: Math.min(prev, close) * 0.995,
      close,
      volume: baseVol,
      change_percent: step,
    });
  }
  return bars;
}

function makeCtx(overrides: Partial<RuleContext> = {}): RuleContext {
  return {
    symbol: 'sh.600519',
    name: '贵州茅台',
    industry: '白酒',
    market_segment: 'main',
    current_price: 200,
    change_pct: 3.0,
    current_volume: 2_000_000,
    bid: 199.95,
    ask: 200.05,
    bars: makeBars({ count: 60, baseClose: 100, pctStep: 0.5, highOverride: 150 }),
    northbound_delta_5d: null,
    limit_up_yesterday: false,
    ...overrides,
  };
}

function makeDecision(overrides: Partial<RecommendationDecision> = {}): RecommendationDecision {
  return {
    action: 'buy',
    suggested_position_pct: 8.5,
    position_action: 'open',
    entry_zone: [195, 200],
    stop_loss: 190,
    take_profit: 220,
    key_reasons: ['基本面强劲', '技术面突破'],
    risk_warnings: [],
    overall_confidence: 0.72,
    confidence_tier: 'high',
    per_dimension: [],
    data_quality: { level: 'good', missing_critical: [], missing_optional: [], confidence_multiplier: 1 } as any,
    engine_variant: 'multi_dim_v1',
    shadow_of_report_id: null,
    as_of: '2026-06-26',
    stock_code: 'sh.600519',
    ...overrides,
  };
}

class FakeUniverse {
  constructor(public readonly symbols: string[]) {}
  async resolveUniverse(): Promise<string[]> {
    return [...this.symbols];
  }
}

class FakeEngine {
  public calls: string[] = [];
  constructor(
    private map: Map<string, RecommendationDecision> | RecommendationDecision = makeDecision()
  ) {}
  async analyzeStock(symbol: string): Promise<RecommendationDecision> {
    this.calls.push(symbol);
    if (this.map instanceof Map) {
      return this.map.get(symbol) ?? makeDecision({ overall_confidence: 0.5 });
    }
    return this.map;
  }
}

class FakePusher {
  public calls: Array<{ input: OpportunityInput; options: PushOptions }> = [];
  constructor(
    private response: PushResult = {
      ok: true,
      pushed_groups: [{ group: 'business' as any, status: 'sent' as any, ok: true }],
      dedup_signature: 'sig',
    }
  ) {}
  async push(input: OpportunityInput, options: PushOptions = {}): Promise<PushResult> {
    this.calls.push({ input, options });
    return this.response;
  }
}

class FakeDS implements WatcherDataSource {
  constructor(
    public snapshots: WatcherSymbolSnapshot[],
    public limitUpYesterday: string[] = []
  ) {}
  async loadSnapshotsForSymbols(symbols: string[]): Promise<WatcherSymbolSnapshot[]> {
    return this.snapshots.filter(s => symbols.includes(s.symbol));
  }
  async loadYesterdayLimitUpSet(): Promise<Set<string>> {
    return new Set(this.limitUpYesterday);
  }
}

function snapFromCtx(ctx: RuleContext): WatcherSymbolSnapshot {
  return {
    symbol: ctx.symbol,
    name: ctx.name,
    industry: ctx.industry,
    market_segment: ctx.market_segment,
    current_price: ctx.current_price,
    change_pct: ctx.change_pct,
    current_volume: ctx.current_volume,
    bid: ctx.bid,
    ask: ctx.ask,
    bars: ctx.bars,
    northbound_delta_5d: ctx.northbound_delta_5d ?? null,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

(async () => {
  // ==========================================================================
  console.log('\n[1] 常量冻结 / 形态校验');
  assertEqual('10 类 rule', TRIGGER_RULE_IDS.length, 10);
  assertEqual('label map 10 条', Object.keys(TRIGGER_RULE_LABELS).length, 10);
  assertEqual('DETECTOR_MAP 10 条', Object.keys(DETECTOR_MAP).length, 10);

  // ==========================================================================
  console.log('\n[2] isHighLimitSymbol');
  assertEqual('sz.300750 → true', isHighLimitSymbol('sz.300750'), true);
  assertEqual('sh.688981 → true', isHighLimitSymbol('sh.688981'), true);
  assertEqual('bj.830799 → true', isHighLimitSymbol('bj.830799'), true);
  assertEqual('sh.600519 → false', isHighLimitSymbol('sh.600519'), false);
  assertEqual('sz.000001 → false', isHighLimitSymbol('sz.000001'), false);
  assertEqual('empty → false', isHighLimitSymbol(''), false);

  // ==========================================================================
  console.log('\n[3] compute5dVolumeRatio');
  {
    const ctx = makeCtx({ current_volume: 2_000_000 });
    const r = compute5dVolumeRatio(ctx);
    assert('正常 ratio = 2', r !== null && Math.abs(r! - 2) < 0.01, `r=${r}`);
  }
  {
    const ctx = makeCtx({ bars: makeBars({ count: 4 }) });
    assertEqual('< 5 根 bar → null', compute5dVolumeRatio(ctx), null);
  }
  {
    const ctx = makeCtx({ current_volume: 0 });
    assertEqual('current_volume=0 → null', compute5dVolumeRatio(ctx), null);
  }

  // ==========================================================================
  console.log('\n[4] detectBreakout60dHigh');
  {
    const ctx = makeCtx({
      current_price: 151,
      change_pct: 5,
      bars: makeBars({ count: 60, highOverride: 150 }),
    });
    const hit = detectBreakout60dHigh(ctx);
    assert('突破命中', !!hit && hit.rule_id === 'breakout_60d_high');
    assert('score > 70', !!hit && hit.raw_score >= 70);
  }
  {
    const ctx = makeCtx({
      current_price: 149,
      bars: makeBars({ count: 60, highOverride: 150 }),
    });
    assertEqual('未突破 → null', detectBreakout60dHigh(ctx), null);
  }
  {
    const ctx = makeCtx({ bars: makeBars({ count: 30 }) });
    assertEqual('< 60 bars → null', detectBreakout60dHigh(ctx), null);
  }

  // ==========================================================================
  console.log('\n[5] detectBreakout20dHigh');
  {
    // 60d max=200, 20d max=150, current=160 → 20d 命中, 60d 未命中
    const bars: RuleBar[] = makeBars({ count: 60, highOverride: 200 }).map((b, i) => ({
      ...b,
      high: i < 40 ? 200 : 150,
    }));
    const ctx = makeCtx({ current_price: 160, change_pct: 3, bars });
    const hit = detectBreakout20dHigh(ctx);
    assert('20d 突破命中, 60d 不命中', !!hit && hit.rule_id === 'breakout_20d_high');
  }
  {
    // current > 60d high → 20d 规则跳过 (留给 60d)
    const ctx = makeCtx({
      current_price: 210,
      bars: makeBars({ count: 60, highOverride: 200 }),
    });
    assertEqual('current > 60d high → 20d null', detectBreakout20dHigh(ctx), null);
  }

  // ==========================================================================
  console.log('\n[6] detectVolumeSpike');
  {
    const ctx = makeCtx({
      change_pct: 2,
      current_volume: 2_500_000,
      bars: makeBars({ count: 60, baseVolume: 1_000_000 }),
    });
    const hit = detectVolumeSpike(ctx);
    assert('量比 2.5 + 涨 2 → 命中', !!hit && hit.rule_id === 'volume_spike');
  }
  {
    const ctx = makeCtx({ change_pct: 2, current_volume: 1_500_000 }); // ratio 1.5
    assertEqual('量比 1.5 → null', detectVolumeSpike(ctx), null);
  }
  {
    const ctx = makeCtx({ change_pct: 0.5, current_volume: 3_000_000 }); // ratio 3 but涨幅 0.5
    assertEqual('涨幅不足 → null', detectVolumeSpike(ctx), null);
  }

  // ==========================================================================
  console.log('\n[7] detectRapidRise');
  {
    const ctx = makeCtx({ change_pct: 6, current_volume: 1_500_000 });
    const hit = detectRapidRise(ctx);
    assert('+6% + 量比 1.5 → 命中', !!hit && hit.rule_id === 'rapid_rise');
  }
  {
    const ctx = makeCtx({ change_pct: 4, current_volume: 2_000_000 });
    assertEqual('+4% < 5% → null', detectRapidRise(ctx), null);
  }
  {
    const ctx = makeCtx({ change_pct: 6, current_volume: 1_100_000 }); // ratio 1.1
    assertEqual('量比 1.1 < 1.2 → null', detectRapidRise(ctx), null);
  }

  // ==========================================================================
  console.log('\n[8] detectRapidFallStabilize');
  {
    // 近 5 日累计 -10% (每日 -2%)
    const bars = makeBars({ count: 60, pctStep: -2 });
    const ctx = makeCtx({
      bars,
      change_pct: 0.5,
      current_volume: 1_200_000,
    });
    const hit = detectRapidFallStabilize(ctx);
    assert('5d -10% + 当日企稳 → 命中', !!hit && hit.rule_id === 'rapid_fall_stabilize');
  }
  {
    // 近 5 日累计仅 -5% → 不命中
    const bars = makeBars({ count: 60, pctStep: -1 });
    const ctx = makeCtx({ bars, change_pct: 0.5, current_volume: 1_200_000 });
    assertEqual('5d -5% → null', detectRapidFallStabilize(ctx), null);
  }

  // ==========================================================================
  console.log('\n[9] detectGapUpBreakout');
  {
    // prev close=100, prev high=102, current=106 → gap 6% + 突破前高
    const bars = makeBars({ count: 5 });
    bars[bars.length - 1].close = 100;
    bars[bars.length - 1].high = 102;
    const ctx = makeCtx({ current_price: 106, bars });
    const hit = detectGapUpBreakout(ctx);
    assert('高开 6% + 突破前高 → 命中', !!hit && hit.rule_id === 'gap_up_breakout');
  }
  {
    const bars = makeBars({ count: 5 });
    bars[bars.length - 1].close = 100;
    bars[bars.length - 1].high = 102;
    const ctx = makeCtx({ current_price: 101, bars });
    assertEqual('高开 1% → null', detectGapUpBreakout(ctx), null);
  }

  // ==========================================================================
  console.log('\n[10] detectNorthboundInflowSurge');
  {
    const ctx = makeCtx({ northbound_delta_5d: 7, change_pct: 1.5 });
    const hit = detectNorthboundInflowSurge(ctx);
    assert('+7% delta + 涨 → 命中', !!hit && hit.rule_id === 'northbound_inflow_surge');
  }
  {
    const ctx = makeCtx({ northbound_delta_5d: 3, change_pct: 1.5 });
    assertEqual('delta 3 < 5 → null', detectNorthboundInflowSurge(ctx), null);
  }
  {
    const ctx = makeCtx({ northbound_delta_5d: 7, change_pct: -1 });
    assertEqual('change_pct < 0 → null', detectNorthboundInflowSurge(ctx), null);
  }
  {
    const ctx = makeCtx({ northbound_delta_5d: null });
    assertEqual('delta null → null', detectNorthboundInflowSurge(ctx), null);
  }

  // ==========================================================================
  console.log('\n[11] detectLimitUpFirstBoard');
  {
    const ctx = makeCtx({ symbol: 'sh.600519', change_pct: 9.5, limit_up_yesterday: false });
    const hit = detectLimitUpFirstBoard(ctx);
    assert('主板 9.5% 首板 → 命中', !!hit && hit.rule_id === 'limit_up_first_board');
  }
  {
    const ctx = makeCtx({ symbol: 'sz.300750', change_pct: 12, limit_up_yesterday: false });
    assertEqual('创业板 12% < 19% → null', detectLimitUpFirstBoard(ctx), null);
  }
  {
    const ctx = makeCtx({ symbol: 'sz.300750', change_pct: 19.5, limit_up_yesterday: false });
    const hit = detectLimitUpFirstBoard(ctx);
    assert('创业板 19.5% 首板 → 命中', !!hit && hit.rule_id === 'limit_up_first_board');
  }
  {
    const ctx = makeCtx({ change_pct: 9.5, limit_up_yesterday: true });
    assertEqual('昨日已涨停 → null', detectLimitUpFirstBoard(ctx), null);
  }

  // ==========================================================================
  console.log('\n[12] detectDragonTigerFirstBoard');
  {
    const ctx = makeCtx({ change_pct: 3, limit_up_yesterday: true });
    const hit = detectDragonTigerFirstBoard(ctx);
    assert('昨涨停 + 今 +3% → 命中', !!hit && hit.rule_id === 'dragon_tiger_first_board');
  }
  {
    const ctx = makeCtx({ change_pct: 3, limit_up_yesterday: false });
    assertEqual('昨未涨停 → null', detectDragonTigerFirstBoard(ctx), null);
  }
  {
    const ctx = makeCtx({ change_pct: 1.5, limit_up_yesterday: true });
    assertEqual('涨 1.5% < 2% → null', detectDragonTigerFirstBoard(ctx), null);
  }

  // ==========================================================================
  console.log('\n[13] detectVolumePriceConfirmation');
  {
    // 最后 3 根: 累计 +6%, volume 严格递增
    const bars = makeBars({ count: 10, pctStep: 2.5 });
    bars[bars.length - 3].volume = 1_000_000;
    bars[bars.length - 2].volume = 1_500_000;
    bars[bars.length - 1].volume = 2_000_000;
    const ctx = makeCtx({ bars, change_pct: 2.5 });
    const hit = detectVolumePriceConfirmation(ctx);
    assert('3d +7.5% + 量递增 → 命中', !!hit && hit.rule_id === 'volume_price_confirmation');
  }
  {
    // volume 不递增
    const bars = makeBars({ count: 10, pctStep: 2.5 });
    bars[bars.length - 3].volume = 1_000_000;
    bars[bars.length - 2].volume = 2_000_000;
    bars[bars.length - 1].volume = 1_500_000;
    const ctx = makeCtx({ bars, change_pct: 2.5 });
    assertEqual('量不递增 → null', detectVolumePriceConfirmation(ctx), null);
  }
  {
    const bars = makeBars({ count: 10, pctStep: 1 });
    const ctx = makeCtx({ bars, change_pct: 1 }); // 3d ~3%
    assertEqual('3d 3% < 5% → null', detectVolumePriceConfirmation(ctx), null);
  }

  // ==========================================================================
  console.log('\n[14] mapDecisionAction / mapRiskLevel');
  assertEqual('buy → buy', mapDecisionAction('buy'), 'buy');
  assertEqual('strong_buy → strong_buy', mapDecisionAction('strong_buy'), 'strong_buy');
  assertEqual('sell → hold (fallback)', mapDecisionAction('sell'), 'hold');
  assertEqual('null → hold', mapDecisionAction(null), 'hold');
  {
    const d = makeDecision({ confidence_tier: 'low', risk_warnings: [] });
    assertEqual('low tier → high risk', mapRiskLevel(d), 'high');
  }
  {
    const d = makeDecision({ confidence_tier: 'medium', risk_warnings: [] });
    assertEqual('medium tier → medium', mapRiskLevel(d), 'medium');
  }
  {
    const d = makeDecision({
      confidence_tier: 'high',
      risk_warnings: ['a', 'b', 'c', 'd'],
    });
    assertEqual('4 warnings → high', mapRiskLevel(d), 'high');
  }
  {
    const d = makeDecision({ confidence_tier: 'high', risk_warnings: [] });
    assertEqual('high tier + 0 warn → low', mapRiskLevel(d), 'low');
  }

  // ==========================================================================
  console.log('\n[15] buildRuleContextFromSnapshot');
  {
    const ctx0 = makeCtx();
    const snap = snapFromCtx(ctx0);
    const out = buildRuleContextFromSnapshot(snap, new Set(['sh.600519']));
    assert('合法 snap → ctx', !!out && out.symbol === 'sh.600519');
    assertEqual('limit_up_yesterday 注入', out!.limit_up_yesterday, true);
  }
  {
    const snap = { ...snapFromCtx(makeCtx()), current_price: null };
    assertEqual('current_price null → ctx null', buildRuleContextFromSnapshot(snap, new Set()), null);
  }

  // ==========================================================================
  console.log('\n[16] buildPusherInputFromHit');
  {
    const ctx = makeCtx({ current_volume: 2_000_000 });
    const hit = {
      rule_id: 'breakout_60d_high' as const,
      rule_label: TRIGGER_RULE_LABELS.breakout_60d_high,
      raw_score: 85,
      reasons: ['现价突破', '量比放大'],
    };
    const decision = makeDecision({ overall_confidence: 0.72 });
    const input = buildPusherInputFromHit(ctx, hit, decision, new Date('2026-06-26T01:30:00Z'));
    assertEqual('trigger_rule 透传', input.trigger_rule, 'breakout_60d_high');
    assertEqual('confidence_score = 72', input.decision.confidence_score, 72);
    assertEqual('volume_ratio 计算', Number(input.volume_ratio).toFixed(2), '2.00');
    assert('reasons 合并', input.reasons.length === 3);
  }

  // ==========================================================================
  console.log('\n[17] scan() e2e — 3 symbols: 1 breakout + 1 volume_spike + 1 miss');
  {
    const ctxBreak = makeCtx({
      symbol: 'sh.600519',
      current_price: 160,
      change_pct: 5,
      bars: makeBars({ count: 60, highOverride: 150 }),
    });
    const ctxVol = makeCtx({
      symbol: 'sh.600036',
      current_price: 105,
      change_pct: 2.5,
      current_volume: 3_000_000,
      bars: makeBars({ count: 60, baseVolume: 1_000_000, highOverride: 999 }),
    });
    const ctxMiss = makeCtx({
      symbol: 'sz.000001',
      current_price: 10,
      change_pct: 0.2,
      current_volume: 1_000_000,
      bars: makeBars({ count: 60, highOverride: 999 }),
    });
    const ds = new FakeDS([snapFromCtx(ctxBreak), snapFromCtx(ctxVol), snapFromCtx(ctxMiss)]);
    const universe = new FakeUniverse(['sh.600519', 'sh.600036', 'sz.000001']);
    const engine = new FakeEngine(makeDecision({ overall_confidence: 0.72 }));
    const pusher = new FakePusher();
    const watcher = new IntradayOpportunityWatcher({
      dataSource: ds,
      universeService: universe as unknown as IntradayUniverseService,
      analysisEngine: engine as unknown as AnalysisEngineService,
      pusher: pusher as unknown as IntradayOpportunityPusher,
    });
    const res = await watcher.scan();
    assertEqual('scanned_count=3', res.scanned_count, 3);
    assertEqual('hit_count=2', res.hit_count, 2);
    assertEqual('pushed_count=2', res.pushed_count, 2);
    assertEqual('errors=0', res.errors.length, 0);
    assertEqual('engine.analyzeStock called 2 次', engine.calls.length, 2);
    assertEqual('pusher.push called 2 次', pusher.calls.length, 2);
  }

  // ==========================================================================
  console.log('\n[18] scan() — final_score < min 不推');
  {
    const ctx = makeCtx({
      symbol: 'sh.600519',
      current_price: 160,
      change_pct: 5,
      bars: makeBars({ count: 60, highOverride: 150 }),
    });
    const ds = new FakeDS([snapFromCtx(ctx)]);
    const universe = new FakeUniverse(['sh.600519']);
    const engine = new FakeEngine(makeDecision({ overall_confidence: 0.4 })); // → 40
    const pusher = new FakePusher();
    const watcher = new IntradayOpportunityWatcher({
      dataSource: ds,
      universeService: universe as any,
      analysisEngine: engine as any,
      pusher: pusher as any,
    });
    const res = await watcher.scan({ min_final_score: 65 });
    assertEqual('hit_count=1', res.hit_count, 1);
    assertEqual('pushed_count=0', res.pushed_count, 0);
    assertEqual('skipped_count=1', res.skipped_count, 1);
    assertEqual('pusher 未被调', pusher.calls.length, 0);
    assert(
      'push_skipped_reason 含 below_min',
      !!res.hits[0].push_skipped_reason && res.hits[0].push_skipped_reason.includes('below_min')
    );
  }

  // ==========================================================================
  console.log('\n[19] scan() — 同股多规则取最高 raw_score');
  {
    // 突破 60 日高 (~80) + 量比 (~70) → 60d 命中保留
    const ctx = makeCtx({
      symbol: 'sh.600519',
      current_price: 160,
      change_pct: 5,
      current_volume: 3_000_000,
      bars: makeBars({ count: 60, baseVolume: 1_000_000, highOverride: 150 }),
    });
    const ds = new FakeDS([snapFromCtx(ctx)]);
    const universe = new FakeUniverse(['sh.600519']);
    const engine = new FakeEngine(makeDecision({ overall_confidence: 0.72 }));
    const pusher = new FakePusher();
    const watcher = new IntradayOpportunityWatcher({
      dataSource: ds,
      universeService: universe as any,
      analysisEngine: engine as any,
      pusher: pusher as any,
    });
    // 限定 rules 排除 gap_up_breakout (本测试构造的 bars 大幅高于近期, gap 会
    // 抢戏); 只在 breakout / volume_spike 之间做 dedup 比较.
    const res = await watcher.scan({ rules: ['breakout_60d_high', 'volume_spike'] });
    assertEqual('hit_count=1 (同股 dedup)', res.hit_count, 1);
    assertEqual('采用 breakout_60d_high', res.hits[0].trigger_rule, 'breakout_60d_high');
    assertEqual('pushed=1', res.pushed_count, 1);
  }

  // ==========================================================================
  console.log('\n[20] scan() — dry_run 透传给 pusher');
  {
    const ctx = makeCtx({
      symbol: 'sh.600519',
      current_price: 160,
      change_pct: 5,
      bars: makeBars({ count: 60, highOverride: 150 }),
    });
    const ds = new FakeDS([snapFromCtx(ctx)]);
    const universe = new FakeUniverse(['sh.600519']);
    const engine = new FakeEngine(makeDecision({ overall_confidence: 0.72 }));
    const pusher = new FakePusher({
      ok: true,
      pushed_groups: [{ group: 'business' as any, status: 'dry_run' as any, ok: true }],
      skipped_reason: 'dry_run',
      dedup_signature: 'sig',
    });
    const watcher = new IntradayOpportunityWatcher({
      dataSource: ds,
      universeService: universe as any,
      analysisEngine: engine as any,
      pusher: pusher as any,
    });
    const res = await watcher.scan({ dry_run: true });
    assertEqual('pusher.dry_run 透传', pusher.calls[0].options.dry_run, true);
    // dry_run 返 ok=true 但 skipped_reason=dry_run → pushed=false
    assertEqual('pushed_count=0 (dry_run 不算真推)', res.pushed_count, 0);
  }

  // ==========================================================================
  console.log('\n[21] scan() — analyzeStock 抛错 fail-OPEN 写 errors[] 不阻塞');
  {
    const ctxA = makeCtx({
      symbol: 'sh.600519',
      current_price: 160,
      change_pct: 5,
      bars: makeBars({ count: 60, highOverride: 150 }),
    });
    const ctxB = makeCtx({
      symbol: 'sh.600036',
      current_price: 160,
      change_pct: 5,
      bars: makeBars({ count: 60, highOverride: 150 }),
    });
    const ds = new FakeDS([snapFromCtx(ctxA), snapFromCtx(ctxB)]);
    const universe = new FakeUniverse(['sh.600519', 'sh.600036']);
    const engine = {
      calls: [] as string[],
      async analyzeStock(symbol: string) {
        this.calls.push(symbol);
        if (symbol === 'sh.600519') throw new Error('boom');
        return makeDecision({ overall_confidence: 0.72 });
      },
    };
    const pusher = new FakePusher();
    const watcher = new IntradayOpportunityWatcher({
      dataSource: ds,
      universeService: universe as any,
      analysisEngine: engine as any,
      pusher: pusher as any,
    });
    const res = await watcher.scan();
    assertEqual('errors[] 含 600519', res.errors[0]?.symbol, 'sh.600519');
    assertEqual('600036 仍被推', res.pushed_count, 1);
  }

  // ==========================================================================
  console.log('\n[22] scan() — universe 空 直接返');
  {
    const ds = new FakeDS([]);
    const universe = new FakeUniverse([]);
    const engine = new FakeEngine();
    const pusher = new FakePusher();
    const watcher = new IntradayOpportunityWatcher({
      dataSource: ds,
      universeService: universe as any,
      analysisEngine: engine as any,
      pusher: pusher as any,
    });
    const res = await watcher.scan();
    assertEqual('scanned=0', res.scanned_count, 0);
    assertEqual('hits=0', res.hit_count, 0);
    assertEqual('engine 未调', engine.calls.length, 0);
  }

  // ==========================================================================
  console.log('\n[23] scan() — rules 子集仅跑指定规则');
  {
    const ctx = makeCtx({
      symbol: 'sh.600519',
      current_price: 160,
      change_pct: 5,
      bars: makeBars({ count: 60, highOverride: 150 }),
    });
    const ds = new FakeDS([snapFromCtx(ctx)]);
    const universe = new FakeUniverse(['sh.600519']);
    const engine = new FakeEngine();
    const pusher = new FakePusher();
    const watcher = new IntradayOpportunityWatcher({
      dataSource: ds,
      universeService: universe as any,
      analysisEngine: engine as any,
      pusher: pusher as any,
    });
    // 只跑 volume_spike → 不命中 (current_volume 没设异常)
    const res = await watcher.scan({ rules: ['volume_spike'] });
    assertEqual('volume_spike 不命中 → hit_count=0', res.hit_count, 0);
  }

  // ==========================================================================
  console.log('\n[24] scan() — target_groups + user_ids 透传');
  {
    const ctx = makeCtx({
      symbol: 'sh.600519',
      current_price: 160,
      change_pct: 5,
      bars: makeBars({ count: 60, highOverride: 150 }),
    });
    const ds = new FakeDS([snapFromCtx(ctx)]);
    const universe = new FakeUniverse(['sh.600519']);
    const engine = new FakeEngine(makeDecision({ overall_confidence: 0.72 }));
    const pusher = new FakePusher();
    const watcher = new IntradayOpportunityWatcher({
      dataSource: ds,
      universeService: universe as any,
      analysisEngine: engine as any,
      pusher: pusher as any,
    });
    await watcher.scan({ target_groups: ['business', 'ops'] as any, user_ids: [1, 2] });
    assertEqual('target_groups 透传', pusher.calls[0].options.target_groups, ['business', 'ops']);
    assertEqual('user_ids 透传', pusher.calls[0].options.user_ids, [1, 2]);
  }

  // ==========================================================================
  console.log('\n========================================');
  console.log(`intraday-opportunity-watcher: ${ok} ok / ${fail} failed`);
  console.log('========================================');
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  console.error('FATAL', e);
  process.exit(1);
});
