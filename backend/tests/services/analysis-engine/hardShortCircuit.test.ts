/**
 * hardShortCircuit.test.ts — US-022 [AE-003] AIAdvisorService hard 短路单测.
 *
 * 覆盖 4 大模块:
 *   [1] 常量冻结 + 5 个纯函数 helpers (mapActionToRecommendation /
 *       pickHardRiskLevel / pickAnalyzerEvidenceLabels /
 *       buildKeyPointsFromDecision / buildHardModeSummary /
 *       buildHardShortCircuitResult).
 *   [2] maybeRunHardShortCircuit 主入口 — fake DataSource 注入完整覆盖
 *       off / shadow / hard happy / hard analyzeStock throw /
 *       hard persist throw / hard archive ok=false / hard archive throw /
 *       hard dry_run 8 路径.
 *   [3] AIAdvisorService 集成 — 注入 fake AIStockAnalysisDataSource 验
 *       (a) hard 模式下 callRemoteAnalyze 0 次 + saveReport 0 次 +
 *           返 hard 模式 result (含 hard_short_circuit=true);
 *       (b) shadow / off 模式下 callRemoteAnalyze 仍调到.
 *   [4] META-GUARD fs+regex 守:
 *       (a) AIAdvisorService.ts 含 maybeRunHardShortCircuit import +
 *           调用 + return hardResult 短路 + isAsync 排除分支;
 *       (b) hardShortCircuit.ts 含 cfg.mode!=='hard'→null + analyzeStock 调 +
 *           archiveHardSignal 调 + 顶层 try/catch fail-OPEN;
 *       (c) 反向 — AIAdvisorService.ts 主入口仍含旧路径 (callRemoteAnalyze /
 *           saveReport / 末尾 shadow trigger) 防 hard 短路反而把旧路径删了.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  ANALYZER_TO_LEGACY_DIMENSION,
  HARD_SHORT_CIRCUIT_DIMENSIONS,
  buildHardModeSummary,
  buildHardShortCircuitResult,
  buildKeyPointsFromDecision,
  mapActionToRecommendation,
  maybeRunHardShortCircuit,
  pickAnalyzerEvidenceLabels,
  pickHardRiskLevel,
  type HardShortCircuitDataSource,
  type HardShortCircuitResult,
} from '../../../src/services/analysis-engine/hardShortCircuit';
import type {
  AnalyzerOutput,
  RecommendationDecision,
} from '../../../src/services/analysis-engine/AnalyzerTypes';
import type { AnalysisEngineUserConfig } from '../../../src/services/analysis-engine/ShadowDoubleRunService';
import type { ArchiveAnalysisEngineResultOutput } from '../../../src/services/analysis-engine/analysisEngineSignalArchive';
import {
  AIAdvisorService,
  type AIStockAnalysisDataSource,
  type AnalyzeSingleStockResult,
  type RemoteAnalyzePayload,
} from '../../../src/services/AIAdvisorService';

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

function makeAnalyzerOutput(overrides: Partial<AnalyzerOutput> = {}): AnalyzerOutput {
  return {
    analyzer_key: 'fundamental',
    score: 35,
    evidence: [],
    data_sources: [],
    confidence: 0.8,
    data_missing: [],
    error: null,
    elapsed_ms: 12,
    ...overrides,
  };
}

function makeDecision(overrides: Partial<RecommendationDecision> = {}): RecommendationDecision {
  return {
    action: 'buy',
    suggested_position_pct: 0.25,
    position_action: 'open',
    entry_zone: [10.5, 11.2],
    stop_loss: 9.8,
    take_profit: 13.0,
    key_reasons: ['趋势向上', 'MACD 金叉'],
    risk_warnings: ['量能未充分释放'],
    overall_confidence: 0.72,
    confidence_tier: 'high',
    per_dimension: [
      makeAnalyzerOutput({
        analyzer_key: 'fundamental',
        score: 35,
        evidence: [
          { label: 'ROE 25.3%', direction: 'bullish', weight: 0.5 },
          { label: 'PE-TTM 18.4', direction: 'bullish', weight: 0.3 },
          { label: '营收增速 18%', direction: 'bullish', weight: 0.2 },
        ],
      }),
      makeAnalyzerOutput({
        analyzer_key: 'technical',
        score: 55,
        evidence: [{ label: 'MACD 金叉', direction: 'bullish', weight: 0.6 }],
      }),
      makeAnalyzerOutput({
        analyzer_key: 'risk',
        score: -15,
        evidence: [],
      }),
      makeAnalyzerOutput({
        analyzer_key: 'capital',
        score: 40,
        evidence: [{ label: '北向连续 5 日净买入', direction: 'bullish', weight: 1.0 }],
      }),
      makeAnalyzerOutput({
        analyzer_key: 'news',
        score: 10,
        evidence: [{ label: '业绩预增公告', direction: 'bullish', weight: 1.0 }],
      }),
      makeAnalyzerOutput({
        analyzer_key: 'sentiment',
        score: 5,
        evidence: [{ label: '股吧讨论度上升', direction: 'bullish', weight: 1.0 }],
      }),
      makeAnalyzerOutput({
        analyzer_key: 'industry_regime',
        score: 30,
        evidence: [{ label: '行业景气', direction: 'bullish', weight: 1.0 }],
      }),
      makeAnalyzerOutput({
        analyzer_key: 'event',
        score: 0,
        evidence: [],
      }),
    ],
    data_quality: {
      level: 'good',
      missing_critical: [],
      missing_optional: [],
      notes: [],
      coefficient: 1.0,
    },
    engine_variant: 'multi_dim_v1',
    shadow_of_report_id: null,
    as_of: '2026-06-19',
    stock_code: 'sz.300750',
    ...overrides,
  };
}

interface FakeArchiveCall {
  decision: RecommendationDecision;
  prodReportId: string;
  user_id: number | null | undefined;
}
interface FakeAnalyzeCall {
  stockCode: string;
  opts: any;
}
interface FakeDS {
  ds: HardShortCircuitDataSource;
  cfg: AnalysisEngineUserConfig;
  analyzeCalls: FakeAnalyzeCall[];
  persistCalls: HardShortCircuitResult[];
  archiveCalls: FakeArchiveCall[];
  setCfg(cfg: AnalysisEngineUserConfig): void;
  setAnalyzeImpl(
    impl: (stockCode: string, opts: any) => Promise<RecommendationDecision>
  ): void;
  setPersistImpl(impl: (decision: RecommendationDecision, result: HardShortCircuitResult) => Promise<void>): void;
  setArchiveImpl(
    impl: (
      decision: RecommendationDecision,
      prodReportId: string,
      user_id?: number | null
    ) => Promise<ArchiveAnalysisEngineResultOutput>
  ): void;
}

function makeFakeDS(initialCfg: AnalysisEngineUserConfig = { mode: 'off' }): FakeDS {
  const state: FakeDS = {
    cfg: initialCfg,
    analyzeCalls: [],
    persistCalls: [],
    archiveCalls: [],
    setCfg(cfg) {
      state.cfg = cfg;
    },
    setAnalyzeImpl(impl) {
      (state as any).analyzeImpl = impl;
    },
    setPersistImpl(impl) {
      (state as any).persistImpl = impl;
    },
    setArchiveImpl(impl) {
      (state as any).archiveImpl = impl;
    },
    ds: {} as any,
  };
  state.ds = {
    async loadUserConfig() {
      return state.cfg;
    },
    async analyzeStock(stockCode, opts) {
      state.analyzeCalls.push({ stockCode, opts });
      if ((state as any).analyzeImpl) return (state as any).analyzeImpl(stockCode, opts);
      return makeDecision({ stock_code: stockCode });
    },
    async persistEngineReport(decision, result) {
      state.persistCalls.push(result);
      if ((state as any).persistImpl) return (state as any).persistImpl(decision, result);
    },
    async archiveHardSignal(decision, prodReportId, user_id) {
      state.archiveCalls.push({ decision, prodReportId, user_id });
      if ((state as any).archiveImpl) return (state as any).archiveImpl(decision, prodReportId, user_id);
      return { ok: true, created: true, signal: { id: 42 } as any, payload: null };
    },
  };
  return state;
}

(async () => {
  // ============ [1] 纯函数 + 常量 ============

  // [1.1] 常量冻结
  assert(Object.isFrozen(HARD_SHORT_CIRCUIT_DIMENSIONS), '[1.1] HARD_SHORT_CIRCUIT_DIMENSIONS frozen');
  assert(HARD_SHORT_CIRCUIT_DIMENSIONS.length === 5, '[1.1] 5 legacy dimensions');
  assert(
    Object.isFrozen(ANALYZER_TO_LEGACY_DIMENSION),
    '[1.1] ANALYZER_TO_LEGACY_DIMENSION frozen'
  );

  // [1.2] mapActionToRecommendation 7 → 5 全映射
  assert(mapActionToRecommendation('strong_buy') === 'strong_buy', '[1.2a] strong_buy');
  assert(mapActionToRecommendation('buy') === 'buy', '[1.2b] buy');
  assert(mapActionToRecommendation('add') === 'buy', '[1.2c] add → buy');
  assert(mapActionToRecommendation('hold') === 'hold', '[1.2d] hold');
  assert(mapActionToRecommendation('reduce') === 'sell', '[1.2e] reduce → sell');
  assert(mapActionToRecommendation('sell') === 'sell', '[1.2f] sell');
  assert(mapActionToRecommendation('strong_sell') === 'strong_sell', '[1.2g] strong_sell');

  // [1.3] pickHardRiskLevel 阈值 (-50 / -20 边界)
  const dHigh = makeDecision({
    per_dimension: [makeAnalyzerOutput({ analyzer_key: 'risk', score: -60 })],
  });
  assert(pickHardRiskLevel(dHigh) === 'high', '[1.3a] risk<-50 → high');
  const dMed = makeDecision({
    per_dimension: [makeAnalyzerOutput({ analyzer_key: 'risk', score: -30 })],
  });
  assert(pickHardRiskLevel(dMed) === 'medium', '[1.3b] -50<risk<-20 → medium');
  const dLow = makeDecision({
    per_dimension: [makeAnalyzerOutput({ analyzer_key: 'risk', score: 10 })],
  });
  assert(pickHardRiskLevel(dLow) === 'low', '[1.3c] risk>-20 → low');
  const dNoRisk = makeDecision({
    per_dimension: [makeAnalyzerOutput({ analyzer_key: 'fundamental', score: 0 })],
  });
  assert(pickHardRiskLevel(dNoRisk) === 'unknown', '[1.3d] 无 risk dimension → unknown');
  const dBoundary50 = makeDecision({
    per_dimension: [makeAnalyzerOutput({ analyzer_key: 'risk', score: -50 })],
  });
  assert(pickHardRiskLevel(dBoundary50) === 'high', '[1.3e] risk==-50 边界 → high');

  // [1.4] pickAnalyzerEvidenceLabels — sort by weight desc + top N + filter empty
  const ev = makeAnalyzerOutput({
    evidence: [
      { label: 'low-weight', direction: 'bullish', weight: 0.1 },
      { label: '', direction: 'bullish', weight: 1.0 }, // empty label filtered
      { label: 'top-weight', direction: 'bullish', weight: 0.9 },
      { label: 'mid', direction: 'bullish', weight: 0.5 },
    ],
  });
  const labels = pickAnalyzerEvidenceLabels(ev, 3);
  assert(labels[0] === 'top-weight', '[1.4a] sort by weight desc');
  assert(labels.length === 3, '[1.4b] top N (max=3, but empty filtered)');
  assert(!labels.includes(''), '[1.4c] empty label filtered');

  // [1.5] buildKeyPointsFromDecision — 5 legacy dims 都有 entry
  const decision = makeDecision();
  const kp = buildKeyPointsFromDecision(decision, HARD_SHORT_CIRCUIT_DIMENSIONS);
  assert(Array.isArray(kp.fundamental) && kp.fundamental.length > 0, '[1.5a] fundamental has labels');
  assert(Array.isArray(kp.technical) && kp.technical.length === 1, '[1.5b] technical 1 label');
  assert(Array.isArray(kp.capital), '[1.5c] capital array');
  assert(Array.isArray(kp.news), '[1.5d] news array');
  assert(Array.isArray(kp.sentiment), '[1.5e] sentiment array');
  // industry_regime / risk / event 不在 legacy 5, key_points 不含
  assert(!('industry_regime' in kp), '[1.5f] industry_regime 不在 legacy 5');
  assert(!('risk' in kp), '[1.5g] risk 不在 legacy 5');
  assert(!('event' in kp), '[1.5h] event 不在 legacy 5');

  // [1.6] buildHardModeSummary — markdown format
  const summary = buildHardModeSummary(
    'sz.300750',
    '宁德时代',
    'buy',
    72,
    'medium',
    HARD_SHORT_CIRCUIT_DIMENSIONS,
    kp
  );
  assert(summary.includes('宁德时代'), '[1.6a] summary 含 stock_name');
  assert(summary.includes('多维引擎 hard'), '[1.6b] summary 含 hard 标记');
  assert(summary.includes('买入'), '[1.6c] summary 含 buy label');
  assert(summary.includes('置信 72'), '[1.6d] summary 含 confidence');
  assert(summary.includes('风险 medium'), '[1.6e] summary 含 risk_level');

  // [1.7] buildHardShortCircuitResult — 完整字段
  const result = buildHardShortCircuitResult(decision, {
    report_id: 'AI-300750-test-0001',
    stock_code: 'sz.300750',
    stock_name: '宁德时代',
    dimensions: HARD_SHORT_CIRCUIT_DIMENSIONS,
    target_date: '2026-06-19',
    metadata: { user_id: 7 },
    now: new Date('2026-06-19T08:00:00Z'),
  });
  assert(result.recommendation === 'buy', '[1.7a] result.recommendation=buy');
  assert(result.confidence_score === 72, '[1.7b] confidence 0.72 → 72');
  assert(result.risk_level === 'low', '[1.7c] risk score=-15 → low');
  assert(result.status === 'completed', '[1.7d] all dims filled → completed');
  assert(result.persisted === false, '[1.7e] persisted=false (pure builder)');
  assert(result.task_id === null, '[1.7f] hard 模式无 task_id');
  assert((result.metadata as any).hard_short_circuit === true, '[1.7g] metadata.hard_short_circuit=true');
  assert(
    (result.metadata as any).engine_variant === 'multi_dim_v1',
    '[1.7h] metadata.engine_variant'
  );
  assert(Array.isArray((result.metadata as any).per_dimension), '[1.7i] metadata.per_dimension array');
  assert(
    (result.metadata as any).hard_short_circuit_action === 'buy',
    '[1.7j] metadata.hard_short_circuit_action'
  );

  // [1.8] data_quality=critical → status=partial
  const dCritical = makeDecision({
    data_quality: {
      level: 'critical',
      missing_critical: ['daily_bars', 'realtime_quote'],
      missing_optional: [],
      notes: [],
      coefficient: 0,
    },
  });
  const rCritical = buildHardShortCircuitResult(dCritical, {
    report_id: 'AI-test',
    stock_code: 'sz.300750',
    stock_name: null,
    dimensions: HARD_SHORT_CIRCUIT_DIMENSIONS,
    target_date: null,
    metadata: {},
    now: new Date(),
  });
  assert(rCritical.status === 'partial', '[1.8] data_quality=critical → status=partial');
  assert(rCritical.error !== null, '[1.8] partial → error 非 null');

  // ============ [2] maybeRunHardShortCircuit 主入口 8 路径 ============

  // [2.1] off mode → null
  let fake = makeFakeDS({ mode: 'off' });
  const r1 = await maybeRunHardShortCircuit(fake.ds, {
    stock_code: 'sz.300750',
    user_id: 1,
    report_id: 'r-1',
    metadata: {},
  });
  assert(r1 === null, '[2.1a] off → null');
  assert(fake.analyzeCalls.length === 0, '[2.1b] off → analyzeStock 0 次');
  assert(fake.persistCalls.length === 0, '[2.1c] off → persist 0 次');
  assert(fake.archiveCalls.length === 0, '[2.1d] off → archive 0 次');

  // [2.2] shadow mode → null (shadow 不接管, 由旧路径 + 末尾 shadow trigger 处理)
  fake = makeFakeDS({ mode: 'shadow' });
  const r2 = await maybeRunHardShortCircuit(fake.ds, {
    stock_code: 'sz.300750',
    user_id: 1,
    report_id: 'r-2',
    metadata: {},
  });
  assert(r2 === null, '[2.2a] shadow → null (不接管)');
  assert(fake.analyzeCalls.length === 0, '[2.2b] shadow → analyzeStock 0 次');

  // [2.3] hard happy path — 调全套 (analyzeStock + persist + archive) AC 主验收
  fake = makeFakeDS({ mode: 'hard' });
  const r3 = await maybeRunHardShortCircuit(fake.ds, {
    stock_code: 'sz.300750',
    user_id: 7,
    target_date: '2026-06-19',
    stock_name: '宁德时代',
    report_id: 'r-3',
    metadata: { user_id: 7, task_label: 'PaperTradingWorkspace' },
  });
  assert(r3 !== null, '[2.3a] hard → returns HardShortCircuitResult (非 null)');
  assert(fake.analyzeCalls.length === 1, '[2.3b] hard → analyzeStock 调 1 次 (AC 主验收)');
  if (fake.analyzeCalls.length === 1) {
    const c = fake.analyzeCalls[0];
    assert(c.stockCode === 'sz.300750', '[2.3c] analyzeStock 收到 stockCode');
    assert(c.opts.as_of === '2026-06-19', '[2.3d] analyzeStock 收到 as_of');
    assert(c.opts.user_id === 7, '[2.3e] analyzeStock 收到 user_id');
  }
  assert(fake.persistCalls.length === 1, '[2.3f] hard → persistEngineReport 调 1 次');
  assert(fake.archiveCalls.length === 1, '[2.3g] hard → archiveHardSignal 调 1 次');
  if (fake.archiveCalls.length === 1) {
    const a = fake.archiveCalls[0];
    assert(a.prodReportId === 'r-3', '[2.3h] archive 收到 prodReportId=r-3');
    assert(a.user_id === 7, '[2.3i] archive 收到 user_id=7');
  }
  assert(r3!.persisted === true, '[2.3j] hard happy → persisted=true');
  assert(r3!.recommendation === 'buy', '[2.3k] hard happy → recommendation=buy');
  assert((r3!.metadata as any).hard_short_circuit === true, '[2.3l] metadata.hard_short_circuit');
  assert(
    (r3!.metadata as any).archive_signal_id === 42,
    '[2.3m] metadata.archive_signal_id from archive result'
  );

  // [2.4] hard + analyzeStock throw → returns failed result, 不抛
  fake = makeFakeDS({ mode: 'hard' });
  fake.setAnalyzeImpl(async () => {
    throw new Error('engine boom');
  });
  const r4 = await maybeRunHardShortCircuit(fake.ds, {
    stock_code: 'sz.300750',
    user_id: 1,
    report_id: 'r-4',
    metadata: {},
  });
  assert(r4 !== null, '[2.4a] hard analyzeStock throw → 非 null (status=failed result)');
  assert(r4!.status === 'failed', '[2.4b] status=failed');
  assert(r4!.error?.includes('engine boom'), '[2.4c] error 含 engine boom');
  assert(r4!.persisted === false, '[2.4d] failed → 不 persist');
  assert(fake.persistCalls.length === 0, '[2.4e] failed → persist 0 次');
  assert(fake.archiveCalls.length === 0, '[2.4f] failed → archive 0 次');

  // [2.5] hard + persistEngineReport throw → 不阻塞, metadata.save_error
  fake = makeFakeDS({ mode: 'hard' });
  fake.setPersistImpl(async () => {
    throw new Error('DB outage');
  });
  const r5 = await maybeRunHardShortCircuit(fake.ds, {
    stock_code: 'sz.300750',
    user_id: 1,
    report_id: 'r-5',
    metadata: {},
  });
  assert(r5 !== null, '[2.5a] persist throw → 非 null');
  assert(r5!.persisted === false, '[2.5b] persist throw → persisted=false');
  assert(
    (r5!.metadata as any).save_error === 'DB outage',
    '[2.5c] metadata.save_error 含原错'
  );
  assert(fake.archiveCalls.length === 1, '[2.5d] persist 失败仍 archive (独立 fail-OPEN)');

  // [2.6] hard + archive ok=false (db_failure) → 不阻塞, metadata.archive_error
  fake = makeFakeDS({ mode: 'hard' });
  fake.setArchiveImpl(async () => ({
    ok: false,
    reason: 'db_failure',
    payload: null,
    error: { message: 'archive DB outage' },
  }));
  const r6 = await maybeRunHardShortCircuit(fake.ds, {
    stock_code: 'sz.300750',
    user_id: 1,
    report_id: 'r-6',
    metadata: {},
  });
  assert(r6 !== null, '[2.6a] archive ok=false → 非 null');
  assert(r6!.persisted === true, '[2.6b] persist 仍成功');
  assert(
    (r6!.metadata as any).archive_error === 'archive DB outage',
    '[2.6c] metadata.archive_error'
  );

  // [2.7] hard + archive throw → 顶层 catch 吞错, metadata.archive_error
  fake = makeFakeDS({ mode: 'hard' });
  fake.setArchiveImpl(async () => {
    throw new Error('archive helper crash');
  });
  const r7 = await maybeRunHardShortCircuit(fake.ds, {
    stock_code: 'sz.300750',
    user_id: 1,
    report_id: 'r-7',
    metadata: {},
  });
  assert(r7 !== null, '[2.7a] archive throw → 非 null (fail-OPEN)');
  assert(r7!.persisted === true, '[2.7b] persist 仍成功');
  assert(
    (r7!.metadata as any).archive_error === 'archive helper crash',
    '[2.7c] metadata.archive_error 含原错'
  );

  // [2.8] hard + dry_run=true → 不调 persist / archive, 返 result
  fake = makeFakeDS({ mode: 'hard' });
  const r8 = await maybeRunHardShortCircuit(fake.ds, {
    stock_code: 'sz.300750',
    user_id: 1,
    report_id: 'r-8',
    metadata: {},
    dry_run: true,
  });
  assert(r8 !== null, '[2.8a] dry_run → 非 null');
  assert(r8!.persisted === false, '[2.8b] dry_run → persisted=false');
  assert(fake.analyzeCalls.length === 1, '[2.8c] dry_run 仍调 analyzeStock');
  assert(fake.persistCalls.length === 0, '[2.8d] dry_run → persist 0 次');
  assert(fake.archiveCalls.length === 0, '[2.8e] dry_run → archive 0 次');

  // [2.9] loadUserConfig throw → null (fall-through 旧路径, 不阻塞)
  const dsLoadFail: HardShortCircuitDataSource = {
    async loadUserConfig() {
      throw new Error('user lookup outage');
    },
    async analyzeStock() {
      return makeDecision();
    },
    async persistEngineReport() {},
    async archiveHardSignal() {
      return { ok: true, payload: null };
    },
  };
  const r9 = await maybeRunHardShortCircuit(dsLoadFail, {
    stock_code: 'sz.300750',
    user_id: 1,
    report_id: 'r-9',
    metadata: {},
  });
  assert(r9 === null, '[2.9] loadUserConfig throw → null (fall-through)');

  // [2.10] unknown mode → null (fall-through)
  fake = makeFakeDS({ mode: 'bogus' as any });
  const r10 = await maybeRunHardShortCircuit(fake.ds, {
    stock_code: 'sz.300750',
    user_id: 1,
    report_id: 'r-10',
    metadata: {},
  });
  assert(r10 === null, '[2.10] unknown mode → null');

  // ============ [3] AIAdvisorService 集成 — 注入 fake AIStockAnalysisDataSource ============
  // 关键: hard 模式下 callRemoteAnalyze 必须 0 次. 但 AIAdvisorService 内部硬编码 require()
  // hardShortCircuit module + PRODUCTION_HARD_SHORT_CIRCUIT_DATA_SOURCE — 后者会调真
  // analysisEngineService.analyzeStock 拽起一堆 analyzer (含 require sequelize 链).
  //
  // 解法: 用 require.cache 替换 './analysis-engine/hardShortCircuit' 的导出, 让
  // service 拿到我们的 fake helper. 与 US-019 / US-018 fake DataSource 同款 "复刻 boundary
  // 语义" 思路.
  const hardModulePath = require.resolve(
    '../../../src/services/analysis-engine/hardShortCircuit'
  );
  const realHardModule = require(hardModulePath);
  let hardCallCount = 0;
  let lastHardInput: any = null;
  const fakeHardModule = {
    ...realHardModule,
    PRODUCTION_HARD_SHORT_CIRCUIT_DATA_SOURCE: {} as any, // 占位; maybeRunHardShortCircuit 直接接管
    maybeRunHardShortCircuit: async (
      _ds: HardShortCircuitDataSource,
      input: any
    ): Promise<HardShortCircuitResult | null> => {
      hardCallCount += 1;
      lastHardInput = input;
      if (input._mode === 'off') return null;
      return {
        report_id: input.report_id,
        stock_code: input.stock_code,
        stock_name: input.stock_name ?? null,
        dimensions: HARD_SHORT_CIRCUIT_DIMENSIONS.slice() as any,
        summary: '[hard mock]',
        recommendation: 'buy',
        confidence_score: 72,
        risk_level: 'low',
        key_points: { fundamental: ['mock'], technical: [], capital: [], news: [], sentiment: [] },
        status: 'completed',
        task_id: null,
        target_date: input.target_date || null,
        error: null,
        generated_at: new Date().toISOString(),
        metadata: { ...input.metadata, hard_short_circuit: true, fake_hard: true },
        persisted: true,
      };
    },
  };
  // patch require cache
  require.cache[hardModulePath] = {
    ...require.cache[hardModulePath],
    exports: fakeHardModule,
  } as any;

  try {
    // [3.1] hard 模式 — callRemoteAnalyze 必须 0 次 (AC 主验收)
    let remoteCalls = 0;
    let saveCalls = 0;
    const fakeAIDS: AIStockAnalysisDataSource = {
      async callRemoteAnalyze(_t, _td, _is): Promise<RemoteAnalyzePayload> {
        remoteCalls += 1;
        return { status: 'COMPLETED', data: { decision: '买入', confidence_score: 70 } };
      },
      async saveReport(_r: AnalyzeSingleStockResult) {
        saveCalls += 1;
      },
      async resolveStockName() {
        return '宁德时代';
      },
    };
    // hard mock: maybeRunHardShortCircuit 始终返结果 → hard 路径接管
    const svc = new AIAdvisorService(fakeAIDS);
    hardCallCount = 0;
    const out = await svc.analyzeSingleStock('sz.300750', { user_id: 7, target_date: '2026-06-19' });
    assert(hardCallCount === 1, '[3.1a] hard helper 调 1 次');
    assert(remoteCalls === 0, '[3.1b] hard 模式 callRemoteAnalyze 0 次 (AC 主验收 — 没调 TradingAgents)');
    assert(saveCalls === 0, '[3.1c] hard 模式 saveReport 0 次 (hard helper 自带 persist)');
    assert(out.recommendation === 'buy', '[3.1d] out 来自 hard helper');
    assert((out.metadata as any).hard_short_circuit === true, '[3.1e] metadata.hard_short_circuit');
    assert((out.metadata as any).fake_hard === true, '[3.1f] metadata.fake_hard (来自 mock)');
    assert(lastHardInput?.stock_code === 'sz.300750', '[3.1g] helper 收到 stock_code');
    assert(lastHardInput?.user_id === 7, '[3.1h] helper 收到 user_id');
    assert(lastHardInput?.report_id?.startsWith('AI-300750-'), '[3.1i] helper 收到 reportId');

    // [3.2] hard helper 返 null (off/shadow 模式) → fall-through 旧路径 (callRemoteAnalyze 调到)
    remoteCalls = 0;
    saveCalls = 0;
    hardCallCount = 0;
    // 覆盖 mock 让它返 null
    fakeHardModule.maybeRunHardShortCircuit = async () => {
      hardCallCount += 1;
      return null;
    };
    require.cache[hardModulePath]!.exports = fakeHardModule;
    const svc2 = new AIAdvisorService(fakeAIDS);
    const out2 = await svc2.analyzeSingleStock('sz.300750', { user_id: 7 });
    assert(hardCallCount === 1, '[3.2a] helper 仍调 1 次 (检测模式)');
    assert(remoteCalls === 1, '[3.2b] 非 hard → callRemoteAnalyze 调 1 次 (fall-through)');
    assert(saveCalls === 1, '[3.2c] 非 hard → saveReport 调 1 次');
    assert(out2.recommendation === 'buy', '[3.2d] 走旧路径 (买入 → buy)');

    // [3.3] is_async=true → 完全不调 hard helper (异步任务语义由 TradingAgents 接管)
    remoteCalls = 0;
    hardCallCount = 0;
    const svc3 = new AIAdvisorService(fakeAIDS);
    await svc3.analyzeSingleStock('sz.300750', { user_id: 7, is_async: true });
    assert(hardCallCount === 0, '[3.3a] is_async → hard helper 0 次');
    assert(remoteCalls === 1, '[3.3b] is_async → 仍调 TradingAgents');

    // [3.4] hard helper throw → 不阻塞, fall-through 旧路径
    remoteCalls = 0;
    hardCallCount = 0;
    fakeHardModule.maybeRunHardShortCircuit = async () => {
      hardCallCount += 1;
      throw new Error('hard helper crash');
    };
    require.cache[hardModulePath]!.exports = fakeHardModule;
    const svc4 = new AIAdvisorService(fakeAIDS);
    const out4 = await svc4.analyzeSingleStock('sz.300750', { user_id: 7 });
    assert(hardCallCount === 1, '[3.4a] helper 调到但 throw');
    assert(remoteCalls === 1, '[3.4b] helper throw → fall-through callRemoteAnalyze');
    assert(out4.recommendation === 'buy', '[3.4c] 旧路径正常完成');
  } finally {
    // 还原 require.cache
    require.cache[hardModulePath]!.exports = realHardModule;
  }

  // ============ [4] META-GUARD fs+regex 守 ============

  const advisorSrc = fs.readFileSync(
    path.join(__dirname, '../../../src/services/AIAdvisorService.ts'),
    'utf8'
  );
  const helperSrc = fs.readFileSync(
    path.join(__dirname, '../../../src/services/analysis-engine/hardShortCircuit.ts'),
    'utf8'
  );

  // [4.1] AIAdvisorService.ts 含 maybeRunHardShortCircuit import + 调用
  assert(
    /maybeRunHardShortCircuit/.test(advisorSrc),
    '[4.1a] AIAdvisorService 含 maybeRunHardShortCircuit 引用'
  );
  assert(
    /PRODUCTION_HARD_SHORT_CIRCUIT_DATA_SOURCE/.test(advisorSrc),
    '[4.1b] AIAdvisorService 含 PRODUCTION_HARD_SHORT_CIRCUIT_DATA_SOURCE'
  );

  // [4.2] hardResult 短路 — 含 return hardResult / if (hardResult) 模式
  assert(
    /if\s*\(\s*hardResult\s*\)/.test(advisorSrc),
    '[4.2a] 含 if (hardResult) 短路守'
  );
  assert(/return\s+hardResult/.test(advisorSrc), '[4.2b] 含 return hardResult');

  // [4.3] isAsync 排除分支 (异步走旧路径)
  assert(/if\s*\(\s*!isAsync\s*\)/.test(advisorSrc), '[4.3] 含 !isAsync 排除分支');

  // [4.4] 反向 — AIAdvisorService.ts 主入口仍含旧路径 (hard 短路不应该把旧路径删了)
  assert(
    /dataSource\.callRemoteAnalyze/.test(advisorSrc),
    '[4.4a 反向] AIAdvisorService 仍含 callRemoteAnalyze 调用 (旧 5-维度路径未被删)'
  );
  assert(
    /dataSource\.saveReport/.test(advisorSrc),
    '[4.4b 反向] AIAdvisorService 仍含 saveReport 调用 (旧路径持久化未被删)'
  );
  assert(
    /shadowDoubleRunService/.test(advisorSrc),
    '[4.4c 反向] AIAdvisorService 末尾 shadow trigger 未被删'
  );

  // [4.5] helper 含核心逻辑 — cfg.mode!=='hard' → null
  assert(
    /cfg\.mode\s*!==\s*['"]hard['"]/.test(helperSrc),
    '[4.5a] helper 含 cfg.mode!=="hard" 返 null 守'
  );

  // [4.6] helper 调 analyzeStock + archiveHardSignal + persistEngineReport
  assert(
    /source\.analyzeStock\s*\(/.test(helperSrc),
    '[4.6a] helper 调 source.analyzeStock(...)'
  );
  assert(
    /source\.persistEngineReport\s*\(/.test(helperSrc),
    '[4.6b] helper 调 source.persistEngineReport(...)'
  );
  assert(
    /source\.archiveHardSignal\s*\(/.test(helperSrc),
    '[4.6c] helper 调 source.archiveHardSignal(...)'
  );

  // [4.7] helper 含 fail-OPEN 三段 try/catch (loadUserConfig / analyzeStock / persist / archive)
  const tryCount = (helperSrc.match(/try\s*\{/g) || []).length;
  assert(tryCount >= 4, `[4.7] helper 含 ≥4 个 try block (实际 ${tryCount})`);

  // [4.8] HardShortCircuitDataSource interface 4 method
  assert(
    /interface\s+HardShortCircuitDataSource[\s\S]{0,800}archiveHardSignal/.test(helperSrc),
    '[4.8] HardShortCircuitDataSource interface 含 archiveHardSignal'
  );

  // [4.9] 反向 — helper 不静默 fallback 到 TradingAgents (hard mode 必须真接管).
  //   "callRemoteAnalyze" 可能在 jsdoc 注释里出现 (AC 描述), 但不应该出现在代码中:
  //   验证不含调用形 (callRemoteAnalyze( 或 dataSource.callRemoteAnalyze).
  assert(
    !/callRemoteAnalyze\s*\(/.test(helperSrc),
    '[4.9 反向] helper 不调用 callRemoteAnalyze (hard 模式必须真接管, 不静默回退)'
  );

  console.log(`\n${pass} passed, ${fail} failed.`);
  if (fail > 0) {
    console.error(`FAILURES:\n${failures.map(f => '  - ' + f).join('\n')}`);
    process.exit(1);
  } else {
    process.exit(0);
  }
})();
