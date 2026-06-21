/**
 * analysisEngineSignalArchive.test.ts — US-020 [AE-001] 单测.
 *
 * 覆盖 4 模块:
 *   [1] 纯函数 helpers (action→decision / source_id / payload builder / merge)
 *   [2] archiveAnalysisEngineResult 主入口 — fake DataSource 注入完整覆盖
 *       findOrCreate + update + dry_run + invalid_input + db_failure 5 路径
 *   [3] AIInvestmentSignalService 集成 — service.archiveAnalysisEngineResult
 *       薄 wrapper 委托 helper, 行为契约一致
 *   [4] META-GUARD fs+regex 守 helper 落地:
 *       - AISignalSourceType.ANALYSIS_ENGINE='analysis_engine' 已加
 *       - PaperTradingDashboardService / PaperTradingAttributionService
 *         源类型标签表已含 ANALYSIS_ENGINE 一行 (下游 UI 不再 fallback 到
 *         "未知来源")
 *       - service 委托 helper 不重复实现 (反向 META-GUARD)
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  ANALYSIS_ENGINE_PRESERVED_METADATA_KEYS,
  archiveAnalysisEngineResult,
  buildAnalysisEngineSignalPayload,
  buildAnalysisEngineSourceId,
  mapRecommendationActionToDecision,
  mergeAnalysisEnginePayload,
  pickAnalysisEngineRiskLevel,
  type AnalysisEngineArchiveDataSource,
  type AnalysisEngineSignalPayload,
} from '../../../src/services/analysis-engine/analysisEngineSignalArchive';
import {
  AISignalDecision,
  AISignalSourceType,
} from '../../../src/models/AIInvestmentSignal';
import type { RecommendationDecision } from '../../../src/services/analysis-engine/AnalyzerTypes';

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

function makeDecision(overrides: Partial<RecommendationDecision> = {}): RecommendationDecision {
  return {
    action: 'buy',
    suggested_position_pct: 0.25,
    entry_zone: [10.5, 11.2],
    stop_loss: 9.8,
    take_profit: 13.0,
    key_reasons: ['趋势向上', 'MACD 金叉', '资金净流入', '同行业 PE 25 分位'],
    risk_warnings: ['量能未充分释放'],
    overall_confidence: 0.72,
    confidence_tier: 'high',
    per_dimension: [
      {
        analyzer_key: 'fundamental',
        score: 35,
        evidence: [],
        data_sources: [],
        confidence: 0.8,
        data_missing: [],
        error: null,
        elapsed_ms: 12,
      },
      {
        analyzer_key: 'technical',
        score: 55,
        evidence: [],
        data_sources: [],
        confidence: 0.9,
        data_missing: [],
        error: null,
        elapsed_ms: 8,
      },
      {
        analyzer_key: 'risk',
        score: -15,
        evidence: [],
        data_sources: [],
        confidence: 0.85,
        data_missing: [],
        error: null,
        elapsed_ms: 5,
      },
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

(async () => {
  // ============ [1] 纯函数 helpers ============

  // [1a] mapRecommendationActionToDecision — 7 action 全覆盖
  assert(
    mapRecommendationActionToDecision('strong_buy') === AISignalDecision.STRONG_BUY,
    'strong_buy → STRONG_BUY'
  );
  assert(mapRecommendationActionToDecision('buy') === AISignalDecision.BUY, 'buy → BUY');
  assert(
    mapRecommendationActionToDecision('add') === AISignalDecision.BUY,
    'add (加仓) → BUY (走 BUY 流程)'
  );
  assert(mapRecommendationActionToDecision('hold') === AISignalDecision.HOLD, 'hold → HOLD');
  assert(
    mapRecommendationActionToDecision('reduce') === AISignalDecision.SELL,
    'reduce (减仓) → SELL (走 SELL 流程)'
  );
  assert(mapRecommendationActionToDecision('sell') === AISignalDecision.SELL, 'sell → SELL');
  assert(
    mapRecommendationActionToDecision('strong_sell') === AISignalDecision.STRONG_SELL,
    'strong_sell → STRONG_SELL'
  );

  // [1b] buildAnalysisEngineSourceId
  assert(
    buildAnalysisEngineSourceId({ stock_code: 'sz.300750', as_of: '2026-06-19' }) ===
      'sz.300750_2026-06-19',
    'source_id 默认 symbol_as_of'
  );
  assert(
    buildAnalysisEngineSourceId({
      stock_code: 'sz.300750',
      as_of: '2026-06-19',
      loop_run_id: 'loop_42',
    }) === 'sz.300750_2026-06-19_loop_42',
    'source_id 带 loop_run_id 后缀'
  );
  let threw = false;
  try {
    buildAnalysisEngineSourceId({ stock_code: '', as_of: '2026-06-19' });
  } catch (e: any) {
    threw = /required/i.test(String(e?.message));
  }
  assert(threw, '空 stock_code 抛 required (fail-LOUD)');

  // [1c] pickAnalysisEngineRiskLevel — risk score 边界
  assert(
    pickAnalysisEngineRiskLevel(makeDecision({ per_dimension: [] })) === 'unknown',
    '无 risk dim → unknown'
  );
  const lowRisk = makeDecision();
  // risk score = -15 → low
  assert(pickAnalysisEngineRiskLevel(lowRisk) === 'low', 'risk=-15 → low');
  const mediumRisk = makeDecision({
    per_dimension: [
      {
        analyzer_key: 'risk',
        score: -30,
        evidence: [],
        data_sources: [],
        confidence: 1,
        data_missing: [],
        error: null,
        elapsed_ms: 0,
      },
    ],
  });
  assert(pickAnalysisEngineRiskLevel(mediumRisk) === 'medium', 'risk=-30 → medium');
  const highRisk = makeDecision({
    per_dimension: [
      {
        analyzer_key: 'risk',
        score: -70,
        evidence: [],
        data_sources: [],
        confidence: 1,
        data_missing: [],
        error: null,
        elapsed_ms: 0,
      },
    ],
  });
  assert(pickAnalysisEngineRiskLevel(highRisk) === 'high', 'risk=-70 → high');

  // [1d] buildAnalysisEngineSignalPayload — 基础字段
  const payload1 = buildAnalysisEngineSignalPayload({
    decision: makeDecision(),
    stock_name: '宁德时代',
    loop_run_id: 'run-1',
    shadow_of_report_id: 'prod-rep-1',
  });
  assert(
    payload1.source_type === AISignalSourceType.ANALYSIS_ENGINE,
    'payload.source_type = analysis_engine'
  );
  assert(
    payload1.source_type === 'analysis_engine',
    'source_type 字符串值 = analysis_engine (向下游 paper-trading 暴露的契约值)'
  );
  assert(payload1.source_id === 'sz.300750_2026-06-19_run-1', 'payload.source_id 含 loop_run_id');
  assert(payload1.symbol === 'sz.300750', 'payload.symbol');
  assert(payload1.name === '宁德时代', 'payload.name');
  assert(payload1.signal_date === '2026-06-19', 'payload.signal_date');
  assert(payload1.normalized_decision === AISignalDecision.BUY, 'normalized = BUY');
  assert(payload1.decision === 'buy', 'decision 原文 = buy');
  assert(payload1.confidence_score === 72, 'confidence 0.72 → 72');
  assert(payload1.risk_level === 'low', 'risk_level = low');
  assert(/趋势向上/.test(payload1.rationale), 'rationale 含 key_reasons');
  assert(payload1.current_price === 10.5, 'current_price 取 entry_zone[0]');
  const detailObj = JSON.parse(payload1.detail);
  assert(Array.isArray(detailObj.per_dimension), 'detail.per_dimension 是数组');
  assert(detailObj.per_dimension.length === 3, 'detail.per_dimension 含 3 dim');
  assert(detailObj.engine_variant === 'multi_dim_v1', 'detail.engine_variant');
  assert(
    payload1.metadata.engine_variant === 'multi_dim_v1',
    'metadata.engine_variant 透传'
  );
  assert(
    payload1.metadata.shadow_of_report_id === 'prod-rep-1',
    'metadata.shadow_of_report_id 透传'
  );
  assert(payload1.metadata.loop_run_id === 'run-1', 'metadata.loop_run_id 透传');
  assert(
    Array.isArray((payload1.metadata as any).per_dimension_summary) &&
      (payload1.metadata as any).per_dimension_summary.length === 3,
    'metadata.per_dimension_summary 3 dim'
  );

  // [1d-2] extra_metadata 透传
  const payload2 = buildAnalysisEngineSignalPayload({
    decision: makeDecision(),
    extra_metadata: { trace_id: 'abc-123', task_label: '尾盘扫单' },
  });
  assert(payload2.metadata.trace_id === 'abc-123', 'extra_metadata.trace_id 透传');
  assert(payload2.metadata.task_label === '尾盘扫单', 'extra_metadata.task_label 透传');

  // [1d-3] confidence 边界 (0 / 1 / NaN / >1)
  const payloadConfZero = buildAnalysisEngineSignalPayload({
    decision: makeDecision({ overall_confidence: 0 }),
  });
  assert(payloadConfZero.confidence_score === 0, 'confidence 0 → 0');
  const payloadConfOne = buildAnalysisEngineSignalPayload({
    decision: makeDecision({ overall_confidence: 1 }),
  });
  assert(payloadConfOne.confidence_score === 100, 'confidence 1 → 100');
  const payloadConfNaN = buildAnalysisEngineSignalPayload({
    decision: makeDecision({ overall_confidence: NaN }),
  });
  assert(payloadConfNaN.confidence_score === null, 'confidence NaN → null');
  const payloadConfHigh = buildAnalysisEngineSignalPayload({
    decision: makeDecision({ overall_confidence: 1.5 }),
  });
  assert(payloadConfHigh.confidence_score === 100, 'confidence >1 clamp 100');

  // [1d-4] 缺 stock_code 抛
  let payloadThrow = false;
  try {
    buildAnalysisEngineSignalPayload({ decision: makeDecision({ stock_code: '' }) });
  } catch (e: any) {
    payloadThrow = /required/i.test(String(e?.message));
  }
  assert(payloadThrow, '缺 stock_code 抛');

  // [1d-5] 缺 key_reasons → fallback rationale 含 [analysis_engine]
  const payloadNoReasons = buildAnalysisEngineSignalPayload({
    decision: makeDecision({ key_reasons: [], overall_confidence: 0.5 }),
  });
  assert(
    /\[analysis_engine\]/.test(payloadNoReasons.rationale) &&
      /action=buy/.test(payloadNoReasons.rationale) &&
      /confidence=0\.50/.test(payloadNoReasons.rationale),
    'rationale fallback 含 action/confidence'
  );

  // [1e] mergeAnalysisEnginePayload — 保留 paper_trading / paper_trading_by_portfolio
  const newPayload = buildAnalysisEngineSignalPayload({ decision: makeDecision() });
  const existingMeta = {
    paper_trading: { last_trade_id: 999, last_status: 'filled' },
    paper_trading_by_portfolio: { '1': { qty: 100 } },
    engine_variant: 'old_v0', // 应该被新 payload 覆盖
  };
  const merged = mergeAnalysisEnginePayload(existingMeta, newPayload);
  assert(
    (merged.metadata.paper_trading as any).last_trade_id === 999,
    'paper_trading 保留'
  );
  assert(
    (merged.metadata.paper_trading_by_portfolio as any)['1'].qty === 100,
    'paper_trading_by_portfolio 保留'
  );
  assert(
    merged.metadata.engine_variant === 'multi_dim_v1',
    '其它 key 被新 payload 覆盖 (engine_variant 从 old_v0 → multi_dim_v1)'
  );
  // 不传 existing metadata
  const merged2 = mergeAnalysisEnginePayload(null, newPayload);
  assert(merged2.metadata.engine_variant === 'multi_dim_v1', 'null metadata 不破');

  // [1f] ANALYSIS_ENGINE_PRESERVED_METADATA_KEYS 冻结
  assert(Object.isFrozen(ANALYSIS_ENGINE_PRESERVED_METADATA_KEYS), 'preserved keys 已 freeze');
  assert(
    ANALYSIS_ENGINE_PRESERVED_METADATA_KEYS.includes('paper_trading') &&
      ANALYSIS_ENGINE_PRESERVED_METADATA_KEYS.includes('paper_trading_by_portfolio'),
    'preserved keys 含 paper_trading + paper_trading_by_portfolio'
  );

  // ============ [2] archiveAnalysisEngineResult 主入口 ============

  // fake DataSource — Map-backed 复刻 Sequelize findOrCreate + update 语义
  interface FakeRecord {
    source_type: string;
    source_id: string;
    metadata: Record<string, unknown>;
    [key: string]: unknown;
  }
  function makeFakeSource(opts: {
    findError?: Error;
    updateError?: Error;
  } = {}): { source: AnalysisEngineArchiveDataSource; store: Map<string, FakeRecord> } {
    const store = new Map<string, FakeRecord>();
    const source: AnalysisEngineArchiveDataSource = {
      async findOrCreateSignal(where, defaults) {
        if (opts.findError) throw opts.findError;
        const key = `${where.source_type}|${where.source_id}`;
        const existing = store.get(key);
        if (existing) return [existing as any, false];
        const created: FakeRecord = { ...(defaults as any) };
        store.set(key, created);
        return [created as any, true];
      },
      async updateSignal(record, payload) {
        if (opts.updateError) throw opts.updateError;
        const key = `${(record as any).source_type}|${(record as any).source_id}`;
        const merged: FakeRecord = { ...(record as any), ...(payload as any) };
        store.set(key, merged);
        return merged as any;
      },
    };
    return { source, store };
  }

  // [2a] happy path — 第一次入库 created=true
  {
    const { source, store } = makeFakeSource();
    const out = await archiveAnalysisEngineResult(source, {
      decision: makeDecision(),
      stock_name: '宁德时代',
    });
    assert(out.ok === true, '[2a] happy ok=true');
    assert(out.created === true, '[2a] happy created=true');
    assert(out.reason === undefined, '[2a] happy 无 reason');
    assert(out.signal !== null && out.signal !== undefined, '[2a] happy signal 非空');
    assert(store.size === 1, '[2a] store 写 1 条');
    const row = Array.from(store.values())[0];
    assert(row.source_type === 'analysis_engine', '[2a] row.source_type');
    assert(row.source_id === 'sz.300750_2026-06-19', '[2a] row.source_id');
    assert((row.metadata as any).engine_variant === 'multi_dim_v1', '[2a] row.metadata 落');
  }

  // [2b] 二次入库 → update path, metadata 合并保留 paper_trading
  {
    const { source, store } = makeFakeSource();
    // 预填一条带 paper_trading metadata 的记录 (模拟 PaperTradingFacade 回写后)
    const key = `analysis_engine|sz.300750_2026-06-19`;
    store.set(key, {
      source_type: 'analysis_engine',
      source_id: 'sz.300750_2026-06-19',
      metadata: {
        paper_trading: { last_trade_id: 777 },
        paper_trading_by_portfolio: { '1': { qty: 500 } },
        engine_variant: 'old_v0',
      },
    });
    const out = await archiveAnalysisEngineResult(source, {
      decision: makeDecision({ overall_confidence: 0.85 }),
    });
    assert(out.ok === true, '[2b] update ok=true');
    assert(out.created === false, '[2b] update created=false');
    const row = store.get(key)!;
    assert(
      (row.metadata as any).paper_trading?.last_trade_id === 777,
      '[2b] paper_trading 保留 (last_trade_id=777)'
    );
    assert(
      (row.metadata as any).paper_trading_by_portfolio?.['1']?.qty === 500,
      '[2b] paper_trading_by_portfolio 保留 (qty=500)'
    );
    assert(
      (row.metadata as any).engine_variant === 'multi_dim_v1',
      '[2b] 其它 metadata 被新 payload 覆盖 (engine_variant)'
    );
    assert(
      (row as any).confidence_score === 85,
      '[2b] confidence_score 字段被 update (0.85 → 85)'
    );
  }

  // [2c] dry_run → 不调 DataSource
  {
    let findCalled = 0;
    const source: AnalysisEngineArchiveDataSource = {
      async findOrCreateSignal() {
        findCalled += 1;
        return [{} as any, true];
      },
      async updateSignal(r) {
        return r;
      },
    };
    const out = await archiveAnalysisEngineResult(source, {
      decision: makeDecision(),
      dry_run: true,
    });
    assert(out.ok === false, '[2c] dry_run ok=false');
    assert(out.reason === 'dry_run', '[2c] dry_run reason');
    assert(out.payload !== null, '[2c] dry_run 仍返 payload (UI 预览用)');
    assert(out.signal === null, '[2c] dry_run signal=null');
    assert(findCalled === 0, '[2c] dry_run 不调 DataSource');
  }

  // [2d] invalid_input — decision 缺 stock_code → ok=false, 不抛
  {
    const { source } = makeFakeSource();
    const out = await archiveAnalysisEngineResult(source, {
      decision: makeDecision({ stock_code: '' }),
    });
    assert(out.ok === false, '[2d] invalid_input ok=false');
    assert(out.reason === 'invalid_input', '[2d] invalid_input reason');
    assert(out.payload === null, '[2d] invalid_input payload=null');
    assert(/required/i.test(out.error?.message || ''), '[2d] invalid_input error.message');
  }

  // [2e] db_failure — findOrCreateSignal throw → ok=false, 不抛
  {
    const { source } = makeFakeSource({ findError: new Error('DB unavailable') });
    const out = await archiveAnalysisEngineResult(source, { decision: makeDecision() });
    assert(out.ok === false, '[2e] db_failure ok=false');
    assert(out.reason === 'db_failure', '[2e] db_failure reason');
    assert(/DB unavailable/.test(out.error?.message || ''), '[2e] db_failure error.message 透传');
    assert(out.payload !== null, '[2e] db_failure 仍返 payload 便于排查');
  }

  // [2f] update 阶段 throw → ok=false reason='db_failure'
  {
    const { source, store } = makeFakeSource({ updateError: new Error('row locked') });
    store.set('analysis_engine|sz.300750_2026-06-19', {
      source_type: 'analysis_engine',
      source_id: 'sz.300750_2026-06-19',
      metadata: { paper_trading: { x: 1 } },
    });
    const out = await archiveAnalysisEngineResult(source, { decision: makeDecision() });
    assert(out.ok === false, '[2f] update fail ok=false');
    assert(out.reason === 'db_failure', '[2f] update fail reason');
    assert(/row locked/.test(out.error?.message || ''), '[2f] update fail error.message 透传');
  }

  // [2g] 多个 RecommendationAction → 落到 normalized_decision 正确
  {
    const cases: Array<[RecommendationDecision['action'], AISignalDecision]> = [
      ['strong_buy', AISignalDecision.STRONG_BUY],
      ['buy', AISignalDecision.BUY],
      ['add', AISignalDecision.BUY],
      ['hold', AISignalDecision.HOLD],
      ['reduce', AISignalDecision.SELL],
      ['sell', AISignalDecision.SELL],
      ['strong_sell', AISignalDecision.STRONG_SELL],
    ];
    for (const [action, expected] of cases) {
      const { source, store } = makeFakeSource();
      const out = await archiveAnalysisEngineResult(source, {
        decision: makeDecision({ action, stock_code: `sz.${action}`, as_of: '2026-06-19' }),
      });
      assert(
        out.ok && (store.get(`analysis_engine|sz.${action}_2026-06-19`)!.normalized_decision === expected),
        `[2g] action=${action} → normalized=${expected}`
      );
    }
  }

  // ============ [3] AIInvestmentSignalService 集成 ============
  // 不实例化 service (会 import sequelize 拽 DB), 改用 fs+regex 守 service 委托:
  //   1) 含 import { archiveAnalysisEngineResult, ... } from './analysis-engine/...'
  //   2) 含 async archiveAnalysisEngineResult(input, source = ...): ... { return archiveAnalysisEngineResult(source, input); }
  //   3) 反向: service 不再 inline 拼 source_type='analysis_engine' (除经由 import)
  {
    const svcPath = path.resolve(
      __dirname,
      '../../../src/services/AIInvestmentSignalService.ts'
    );
    const svcSrc = fs.readFileSync(svcPath, 'utf8');
    assert(
      /from\s+['"]\.\/analysis-engine\/analysisEngineSignalArchive['"]/.test(svcSrc),
      '[3.1] service import 自 analysis-engine/analysisEngineSignalArchive'
    );
    assert(
      /\barchiveAnalysisEngineResult\b/.test(svcSrc),
      '[3.2] service 含 archiveAnalysisEngineResult 标识符'
    );
    assert(
      /async\s+archiveAnalysisEngineResult\s*\(/.test(svcSrc),
      '[3.3] service 含 async archiveAnalysisEngineResult method'
    );
    assert(
      /createProductionAnalysisEngineArchiveDataSource/.test(svcSrc),
      '[3.4] service 用 production DataSource 工厂作 default arg'
    );
    // 反向: service 不应该有 inline 的 'analysis_engine' 字面量
    // (不计 import 那行 / jsdoc 文档)
    const analysisEngineLiterals = svcSrc.match(/['"]analysis_engine['"]/g) || [];
    assert(
      analysisEngineLiterals.length === 0,
      `[3.5] service 不再 inline 'analysis_engine' 字面量 (实测 ${analysisEngineLiterals.length} 处)`
    );
  }

  // ============ [4] META-GUARD ============

  // [4a] AISignalSourceType 含 ANALYSIS_ENGINE='analysis_engine'
  {
    const modelPath = path.resolve(__dirname, '../../../src/models/AIInvestmentSignal.ts');
    const modelSrc = fs.readFileSync(modelPath, 'utf8');
    assert(
      /ANALYSIS_ENGINE\s*=\s*['"]analysis_engine['"]/.test(modelSrc),
      '[4a.1] AISignalSourceType.ANALYSIS_ENGINE 已加'
    );
    assert(
      AISignalSourceType.ANALYSIS_ENGINE === 'analysis_engine',
      '[4a.2] enum 值正确 (= "analysis_engine")'
    );
  }

  // [4b] PaperTradingDashboardService 含 ANALYSIS_ENGINE label
  {
    const p = path.resolve(
      __dirname,
      '../../../src/portfolio/internal/PaperTradingDashboardService.ts'
    );
    const src = fs.readFileSync(p, 'utf8');
    assert(
      /AISignalSourceType\.ANALYSIS_ENGINE/.test(src),
      '[4b] PaperTradingDashboardService 含 AISignalSourceType.ANALYSIS_ENGINE'
    );
  }

  // [4c] PaperTradingAttributionService 含 ANALYSIS_ENGINE label
  {
    const p = path.resolve(
      __dirname,
      '../../../src/portfolio/internal/PaperTradingAttributionService.ts'
    );
    const src = fs.readFileSync(p, 'utf8');
    assert(
      /AISignalSourceType\.ANALYSIS_ENGINE/.test(src),
      '[4c] PaperTradingAttributionService 含 AISignalSourceType.ANALYSIS_ENGINE'
    );
  }

  // [4d] helper 自身常量 + ANALYSIS_ENGINE_PRESERVED_METADATA_KEYS 单事实源
  {
    const p = path.resolve(
      __dirname,
      '../../../src/services/analysis-engine/analysisEngineSignalArchive.ts'
    );
    const src = fs.readFileSync(p, 'utf8');
    assert(
      /ANALYSIS_ENGINE_PRESERVED_METADATA_KEYS/.test(src),
      '[4d.1] helper 含 PRESERVED_METADATA_KEYS 常量'
    );
    assert(
      /Object\.freeze\(/.test(src),
      '[4d.2] helper 用 Object.freeze 保护常量'
    );
    assert(
      /AISignalSourceType\.ANALYSIS_ENGINE/.test(src),
      '[4d.3] helper 用 enum 而非 inline 字面量 "analysis_engine"'
    );
    // 反向: 主入口必须含 dry_run 短路 + try/catch 包 findOrCreate
    assert(
      /input\.dry_run/.test(src),
      '[4d.4] helper 主入口含 dry_run 短路'
    );
    assert(
      /reason:\s*['"]db_failure['"]/.test(src),
      '[4d.5] helper 主入口含 db_failure 兜底'
    );
    assert(
      /reason:\s*['"]invalid_input['"]/.test(src),
      '[4d.6] helper 主入口含 invalid_input 兜底'
    );
  }

  console.log(`\n${pass} passed, ${fail} failed.`);
  if (fail > 0) {
    console.error(`FAILURES:\n${failures.map(f => '  - ' + f).join('\n')}`);
    process.exit(1);
  } else {
    process.exit(0);
  }
})();
