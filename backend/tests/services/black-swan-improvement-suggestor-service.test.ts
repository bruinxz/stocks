/**
 * BlackSwanImprovementSuggestorService 单元测试 (US-105 [PR-016]).
 *
 * 跑法:
 *   cd backend && npx ts-node --transpile-only \
 *     tests/services/black-swan-improvement-suggestor-service.test.ts
 *
 * 覆盖维度 (与 PR-013/014/015 测试形态对偶):
 *   [1] 常量 / 类型 frozen 守
 *   [2] safeNum / clampPriority / countHighSeverity / countWatchdogTriggers / findBaseline
 *   [3] detectDetectionShortfall — 4 档边界 (>=1 not trigger / =0 trigger / null tl /
 *                                  symbol/eventType 文案)
 *   [4] detectResponseShortfall — high<阈值 / watchdog>0 / 命中 / priority 公式
 *   [5] detectExecutionShortfall — 无 baseline / 无 zero / gap<阈值 / 命中 / priority 公式
 *   [6] detectRiskControlShortfall — dd<阈值 / 命中 / priority 公式
 *   [7] sortByPriority / pickTopFindings — 排序 + 稳定 + cap 边界
 *   [8] buildImprovementSuggestions — sources_used / 4 detector 合并 /
 *                                     detector throw fail-OPEN /
 *                                     non-positive cap fallback
 *   [9] appendSectionFilled / decidePostmortemStatus — 累加 + 4 段全升 ok
 *   [10] runBlackSwanImprovementSuggestorService e2e (fake runner):
 *        (a) loadCandidates throw → success=false + error
 *        (b) loadCandidates ok=false → success=false + error
 *        (c) 无 candidates → success=true + 0
 *        (d) dry_run=true → 不调 updateReport
 *        (e) section.suggestions=[] → skipped (无可挖掘信号)
 *        (f) updateReport ok=false → failed +1
 *        (g) updateReport throw → failed +1
 *        (h) 全成功路径 — sections_filled 累加 + partial / ok 升级 +
 *                       payload 仅含约定 5 列 (反向 META-GUARD 不擦其它段)
 *        (i) event_id / lookback_hours / top_findings_cap 透传
 *        (j) metadata 透传 + suggestor_version 覆盖 + generated_at 覆盖
 *   [11] PRODUCTION runner smoke — 工厂返对象 + singleton + 脱 DB 不抛
 *   [12] META-GUARD: cron registry + SchedulerService dispatch + service jsdoc 标记
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  ALL_POSTMORTEM_SECTIONS,
  BLACK_SWAN_IMPROVEMENT_DEFAULT_LOOKBACK_HOURS,
  BLACK_SWAN_IMPROVEMENT_DEFAULT_TOP_FINDINGS_CAP,
  BLACK_SWAN_IMPROVEMENT_RECOMMENDED_CRON,
  BLACK_SWAN_IMPROVEMENT_SUGGESTOR_VERSION,
  BuildImprovementSuggestionsInput,
  DETECTION_LOW_ALERT_THRESHOLD,
  EXECUTION_PNL_GAP_THRESHOLD,
  IMPROVEMENT_CATEGORIES,
  ImprovementCategory,
  ImprovementReportUpdateRow,
  ImprovementSuggestion,
  PartialPostmortemSnapshot,
  PostmortemSectionsSnapshot,
  RESPONSE_HIGH_ALERT_THRESHOLD,
  RISK_CONTROL_DRAWDOWN_THRESHOLD,
  SuggestorRunner,
  appendSectionFilled,
  buildImprovementSuggestions,
  clampPriority,
  countHighSeverity,
  countWatchdogTriggers,
  createProductionSuggestorRunner,
  decidePostmortemStatus,
  detectDetectionShortfall,
  detectExecutionShortfall,
  detectResponseShortfall,
  detectRiskControlShortfall,
  findBaseline,
  getProductionSuggestorRunner,
  pickTopFindings,
  runBlackSwanImprovementSuggestorService,
  safeNum,
  sortByPriority,
} from '../../src/services/BlackSwanImprovementSuggestorService';

let passed = 0;
let failed = 0;

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

// ============================================================================
// Fakes
// ============================================================================

function mkSections(overrides: Partial<PostmortemSectionsSnapshot> = {}): PostmortemSectionsSnapshot {
  return {
    event_summary: {
      event_type: 'ST',
      severity: 'high',
      scope: 'symbol',
      symbol: '600519',
      detected_at: '2026-06-10T03:30:00Z',
      duration_minutes: 60,
      linked_risk_alert_ids: [1, 2],
    },
    counterfactual_baselines: {
      baselines: [
        { type: 'hold', pnl: -10000, pnl_pct: -0.10, max_drawdown: -0.12 },
        { type: 'zero', pnl: 0, pnl_pct: 0, max_drawdown: 0 },
        { type: 'plan', pnl: -5000, pnl_pct: -0.05, max_drawdown: -0.06 },
        { type: 'perfect', pnl: 8000, pnl_pct: 0.08, max_drawdown: -0.01 },
      ],
      actual: { pnl: -8000, pnl_pct: -0.08, max_drawdown: -0.15 },
    },
    event_timeline: {
      timeline: [
        { ts: '2026-06-09T01:00:00Z', type: 'risk_alert', severity: 'high' },
      ],
      alert_count_by_level: { low: 0, medium: 0, high: 1, critical: 0 },
    },
    ...overrides,
  };
}

function mkInput(
  overrides: Partial<BuildImprovementSuggestionsInput> = {}
): BuildImprovementSuggestionsInput {
  return {
    event_detected_at: new Date('2026-06-10T03:30:00Z'),
    black_swan_event_id: 11,
    sections: mkSections(),
    ...overrides,
  };
}

function mkPartial(
  overrides: Partial<PartialPostmortemSnapshot> = {}
): PartialPostmortemSnapshot {
  return {
    id: 100,
    black_swan_event_id: 11,
    event_detected_at: new Date('2026-06-10T03:30:00Z'),
    current_metadata: {
      sections_filled: ['event_summary', 'counterfactual_baselines', 'event_timeline'],
    },
    current_status: 'partial',
    sections: mkSections(),
    ...overrides,
  };
}

interface FakeRunnerState {
  loadCalls: Array<{ asOf: Date; lookback_hours: number; event_id?: number }>;
  updateCalls: ImprovementReportUpdateRow[];
  loadResult:
    | { ok: true; candidates: PartialPostmortemSnapshot[] }
    | { ok: false; error: string };
  loadShouldThrow?: Error;
  updateResults: Array<{ ok: true } | { ok: false; error: string } | Error>;
}

function makeFakeRunner(overrides: Partial<FakeRunnerState> = {}): {
  runner: SuggestorRunner;
  state: FakeRunnerState;
} {
  const state: FakeRunnerState = {
    loadCalls: [],
    updateCalls: [],
    loadResult: { ok: true, candidates: [] },
    updateResults: [],
    ...overrides,
  };
  const runner: SuggestorRunner = {
    async loadCandidates(input) {
      state.loadCalls.push(input);
      if (state.loadShouldThrow) throw state.loadShouldThrow;
      return state.loadResult;
    },
    async updateReport(row) {
      state.updateCalls.push(row);
      const idx = state.updateCalls.length - 1;
      const r =
        idx < state.updateResults.length ? state.updateResults[idx] : { ok: true as const };
      if (r instanceof Error) throw r;
      return r;
    },
  };
  return { runner, state };
}

// ============================================================================
// [1] 常量 / 类型 frozen 守
// ============================================================================
console.log('\n[1] 常量 / 类型 frozen 守');
{
  assertEqual('1.1 IMPROVEMENT_CATEGORIES.length=4', IMPROVEMENT_CATEGORIES.length, 4);
  const cats: ImprovementCategory[] = ['detection', 'response', 'execution', 'risk_control'];
  for (let i = 0; i < cats.length; i++) {
    assertEqual(`1.2.${i} 类别顺序 ${cats[i]}`, IMPROVEMENT_CATEGORIES[i], cats[i]);
  }
  assert('1.3 IMPROVEMENT_CATEGORIES frozen', Object.isFrozen(IMPROVEMENT_CATEGORIES));
  assertEqual('1.4 ALL_POSTMORTEM_SECTIONS.length=4', ALL_POSTMORTEM_SECTIONS.length, 4);
  assert('1.5 ALL_POSTMORTEM_SECTIONS frozen', Object.isFrozen(ALL_POSTMORTEM_SECTIONS));
  assertEqual('1.6 RECOMMENDED_CRON=43,13', BLACK_SWAN_IMPROVEMENT_RECOMMENDED_CRON, '43,13 * * * *');
  assertEqual('1.7 DEFAULT_LOOKBACK_HOURS=24', BLACK_SWAN_IMPROVEMENT_DEFAULT_LOOKBACK_HOURS, 24);
  assertEqual('1.8 DEFAULT_TOP_FINDINGS_CAP=5', BLACK_SWAN_IMPROVEMENT_DEFAULT_TOP_FINDINGS_CAP, 5);
  assertEqual('1.9 SUGGESTOR_VERSION=PR-016/v1', BLACK_SWAN_IMPROVEMENT_SUGGESTOR_VERSION, 'PR-016/v1');
  assertEqual('1.10 DETECTION_LOW_ALERT_THRESHOLD=1', DETECTION_LOW_ALERT_THRESHOLD, 1);
  assertEqual('1.11 RESPONSE_HIGH_ALERT_THRESHOLD=2', RESPONSE_HIGH_ALERT_THRESHOLD, 2);
  assertEqual('1.12 EXECUTION_PNL_GAP_THRESHOLD=0.03', EXECUTION_PNL_GAP_THRESHOLD, 0.03);
  assertEqual('1.13 RISK_CONTROL_DRAWDOWN_THRESHOLD=0.1', RISK_CONTROL_DRAWDOWN_THRESHOLD, 0.1);
}

// ============================================================================
// [2] safeNum / clampPriority / countHighSeverity / countWatchdogTriggers / findBaseline
// ============================================================================
console.log('\n[2] 基础 helpers');
{
  // safeNum
  assertEqual('2.1 safeNum(5)', safeNum(5), 5);
  assertEqual('2.2 safeNum("3.14")', safeNum('3.14'), 3.14);
  assertEqual('2.3 safeNum(null) default 0', safeNum(null), 0);
  assertEqual('2.4 safeNum(undefined, 7)', safeNum(undefined, 7), 7);
  assertEqual('2.5 safeNum(NaN, 9)', safeNum(NaN, 9), 9);
  assertEqual('2.6 safeNum(Infinity, 0)', safeNum(Infinity, 0), 0);
  assertEqual('2.7 safeNum("abc", 1)', safeNum('abc', 1), 1);

  // clampPriority
  assertEqual('2.8 clampPriority(50)', clampPriority(50), 50);
  assertEqual('2.9 clampPriority(-10) → 0', clampPriority(-10), 0);
  assertEqual('2.10 clampPriority(150) → 100', clampPriority(150), 100);
  assertEqual('2.11 clampPriority(50.7) → 51', clampPriority(50.7), 51);
  assertEqual('2.12 clampPriority(NaN) → 0', clampPriority(NaN), 0);
  assertEqual('2.13 clampPriority(0)', clampPriority(0), 0);
  assertEqual('2.14 clampPriority(100)', clampPriority(100), 100);

  // countHighSeverity
  assertEqual(
    '2.15 countHighSeverity 正常',
    countHighSeverity({ low: 1, medium: 2, high: 3, critical: 4 } as any),
    7
  );
  assertEqual('2.16 countHighSeverity 空', countHighSeverity({} as any), 0);
  assertEqual('2.17 countHighSeverity null', countHighSeverity(null as any), 0);
  assertEqual('2.18 countHighSeverity 仅 high', countHighSeverity({ high: 5 } as any), 5);

  // countWatchdogTriggers
  assertEqual('2.19 countWatchdogTriggers 空', countWatchdogTriggers([]), 0);
  assertEqual('2.20 countWatchdogTriggers undefined', countWatchdogTriggers(undefined as any), 0);
  assertEqual(
    '2.21 countWatchdogTriggers 混',
    countWatchdogTriggers([
      { ts: 't1', type: 'risk_alert' },
      { ts: 't2', type: 'watchdog_trigger' },
      { ts: 't3', type: 'watchdog_trigger' },
      { ts: 't4', type: 'news' },
    ]),
    2
  );

  // findBaseline
  const bls = [
    { type: 'hold' as const, pnl_pct: -0.10, max_drawdown: -0.12 },
    { type: 'zero' as const, pnl_pct: 0, max_drawdown: 0 },
  ];
  const zero = findBaseline(bls, 'zero');
  assert('2.22 findBaseline zero 命中', zero !== null);
  assertEqual('2.23 findBaseline zero.pnl_pct', zero?.pnl_pct, 0);
  assertEqual('2.24 findBaseline plan 缺失 → null', findBaseline(bls, 'plan'), null);
  assertEqual('2.25 findBaseline 空数组 → null', findBaseline([], 'zero'), null);
  assertEqual(
    '2.26 findBaseline undefined → null',
    findBaseline(undefined as any, 'zero'),
    null
  );
  // 兜底: pnl_pct 缺省走 safeNum
  const noPct = findBaseline([{ type: 'zero' as const } as any], 'zero');
  assertEqual('2.27 findBaseline pnl_pct 缺省 0', noPct?.pnl_pct, 0);
}

// ============================================================================
// [3] detectDetectionShortfall
// ============================================================================
console.log('\n[3] detectDetectionShortfall');
{
  // 3.1 timeline null → null (无法判定)
  assertEqual(
    '3.1 timeline null → null',
    detectDetectionShortfall(mkInput({ sections: mkSections({ event_timeline: null }) })),
    null
  );

  // 3.2 high >= 阈值 1 → 不命中
  const noTrig = detectDetectionShortfall(
    mkInput({
      sections: mkSections({
        event_timeline: {
          timeline: [],
          alert_count_by_level: { low: 0, medium: 0, high: 1, critical: 0 },
        },
      }),
    })
  );
  assertEqual('3.2 high>=1 → null', noTrig, null);

  // 3.3 high+critical=0 → 命中
  const hit = detectDetectionShortfall(
    mkInput({
      sections: mkSections({
        event_timeline: {
          timeline: [],
          alert_count_by_level: { low: 5, medium: 0, high: 0, critical: 0 },
        },
      }),
    })
  );
  assert('3.3 命中 → 非 null', hit !== null);
  assertEqual('3.4 category=detection', hit?.category, 'detection');
  assertEqual('3.5 key=late_or_missing_detection', hit?.key, 'late_or_missing_detection');
  assertEqual('3.6 template_id', hit?.template_id, 'detection.v1.late_or_missing_detection');
  assertEqual('3.7 action.type=review_alert_threshold', hit?.action?.type, 'review_alert_threshold');
  // priority: 50 + (1-0)*25 = 75
  assertEqual('3.8 priority=75', hit?.priority, 75);
  // 文案含 event_type + symbol
  assert('3.9 title 含 event_type', hit!.title.includes('ST'));
  assert('3.10 title 含 symbol', hit!.title.includes('600519'));
  // evidence
  assertEqual('3.11 evidence sample_event_ids', hit?.evidence.sample_event_ids, [11]);
  assertEqual(
    '3.12 evidence metric.high_critical_alert_count',
    (hit?.evidence.metric as any)?.high_critical_alert_count,
    0
  );

  // 3.13 critical 1 也算 high → 不命中
  const critHit = detectDetectionShortfall(
    mkInput({
      sections: mkSections({
        event_timeline: {
          timeline: [],
          alert_count_by_level: { low: 0, medium: 0, high: 0, critical: 1 },
        },
      }),
    })
  );
  assertEqual('3.13 critical 1 → null', critHit, null);

  // 3.14 event_summary 缺 → 默认 'unknown'
  const noES = detectDetectionShortfall(
    mkInput({
      sections: {
        event_timeline: {
          timeline: [],
          alert_count_by_level: { low: 0, medium: 0, high: 0, critical: 0 },
        },
      },
    })
  );
  assert('3.14 title 含 unknown', noES!.title.includes('unknown'));
}

// ============================================================================
// [4] detectResponseShortfall
// ============================================================================
console.log('\n[4] detectResponseShortfall');
{
  // 4.1 timeline null → null
  assertEqual(
    '4.1 timeline null → null',
    detectResponseShortfall(mkInput({ sections: mkSections({ event_timeline: null }) })),
    null
  );

  // 4.2 high < 阈值 2 → 不命中
  const lowAlert = detectResponseShortfall(
    mkInput({
      sections: mkSections({
        event_timeline: {
          timeline: [],
          alert_count_by_level: { low: 0, medium: 0, high: 1, critical: 0 },
        },
      }),
    })
  );
  assertEqual('4.2 high<2 → null', lowAlert, null);

  // 4.3 high >= 阈值 但 watchdog>0 → 不命中
  const hasWatchdog = detectResponseShortfall(
    mkInput({
      sections: mkSections({
        event_timeline: {
          timeline: [
            { ts: 't1', type: 'watchdog_trigger', severity: 'high' },
          ],
          alert_count_by_level: { low: 0, medium: 0, high: 3, critical: 0 },
        },
      }),
    })
  );
  assertEqual('4.3 watchdog>0 → null', hasWatchdog, null);

  // 4.4 命中 (high=3, watchdog=0)
  const hit = detectResponseShortfall(
    mkInput({
      sections: mkSections({
        event_timeline: {
          timeline: [
            { ts: 't1', type: 'risk_alert', severity: 'high' },
          ],
          alert_count_by_level: { low: 0, medium: 0, high: 3, critical: 0 },
        },
      }),
    })
  );
  assert('4.4 命中', hit !== null);
  assertEqual('4.5 category', hit?.category, 'response');
  assertEqual('4.6 key', hit?.key, 'alert_without_watchdog_trigger');
  // priority: 55 + min(40, 3*5) = 55+15 = 70
  assertEqual('4.7 priority=70', hit?.priority, 70);
  assertEqual('4.8 action.type=open_workspace_tab', hit?.action?.type, 'open_workspace_tab');
  assertEqual('4.9 action.payload.tab=risk-alerts', (hit?.action?.payload as any)?.tab, 'risk-alerts');

  // 4.10 priority cap: high=20 → 55 + min(40, 100) = 95
  const cap = detectResponseShortfall(
    mkInput({
      sections: mkSections({
        event_timeline: {
          timeline: [],
          alert_count_by_level: { low: 0, medium: 0, high: 20, critical: 0 },
        },
      }),
    })
  );
  assertEqual('4.10 priority=95 cap', cap?.priority, 95);
}

// ============================================================================
// [5] detectExecutionShortfall
// ============================================================================
console.log('\n[5] detectExecutionShortfall');
{
  // 5.1 counterfactual_baselines null → null
  assertEqual(
    '5.1 cb null → null',
    detectExecutionShortfall(mkInput({ sections: mkSections({ counterfactual_baselines: null }) })),
    null
  );

  // 5.2 无 zero baseline → null
  const noZero = detectExecutionShortfall(
    mkInput({
      sections: mkSections({
        counterfactual_baselines: {
          baselines: [{ type: 'hold', pnl_pct: -0.10, max_drawdown: -0.12 }],
          actual: { pnl_pct: -0.08 },
        },
      }),
    })
  );
  assertEqual('5.2 无 zero → null', noZero, null);

  // 5.3 无 actual → null
  const noActual = detectExecutionShortfall(
    mkInput({
      sections: mkSections({
        counterfactual_baselines: {
          baselines: [{ type: 'zero', pnl_pct: 0, max_drawdown: 0 }],
        },
      }),
    })
  );
  assertEqual('5.3 无 actual → null', noActual, null);

  // 5.4 gap < 阈值 0.03 → null (gap = 0 - (-0.02) = 0.02)
  const small = detectExecutionShortfall(
    mkInput({
      sections: mkSections({
        counterfactual_baselines: {
          baselines: [{ type: 'zero', pnl_pct: 0, max_drawdown: 0 }],
          actual: { pnl_pct: -0.02 },
        },
      }),
    })
  );
  assertEqual('5.4 gap<阈值 → null', small, null);

  // 5.5 命中 (gap = 0 - (-0.08) = 0.08)
  const hit = detectExecutionShortfall(mkInput());
  assert('5.5 命中', hit !== null);
  assertEqual('5.6 category', hit?.category, 'execution');
  assertEqual('5.7 key', hit?.key, 'failed_to_cut_losses');
  // priority: 60 + min(35, 0.08*1000=80) = 60+35 = 95
  assertEqual('5.8 priority=95', hit?.priority, 95);
  assertEqual('5.9 action.type=open_workspace_tab', hit?.action?.type, 'open_workspace_tab');
  assertEqual('5.10 action.payload.tab=executions', (hit?.action?.payload as any)?.tab, 'executions');

  // 5.11 边界 gap = 0.03 恰好 → 命中, priority = 60 + min(35, 30) = 60+30 = 90
  const edge = detectExecutionShortfall(
    mkInput({
      sections: mkSections({
        counterfactual_baselines: {
          baselines: [{ type: 'zero', pnl_pct: 0, max_drawdown: 0 }],
          actual: { pnl_pct: -0.03 },
        },
      }),
    })
  );
  assert('5.11 边界命中', edge !== null);
  assertEqual('5.12 边界 priority=90', edge?.priority, 90);
}

// ============================================================================
// [6] detectRiskControlShortfall
// ============================================================================
console.log('\n[6] detectRiskControlShortfall');
{
  // 6.1 cb null → null
  assertEqual(
    '6.1 cb null → null',
    detectRiskControlShortfall(mkInput({ sections: mkSections({ counterfactual_baselines: null }) })),
    null
  );

  // 6.2 dd < 阈值 0.1 → null
  const small = detectRiskControlShortfall(
    mkInput({
      sections: mkSections({
        counterfactual_baselines: {
          actual: { max_drawdown: -0.05 },
        },
      }),
    })
  );
  assertEqual('6.2 dd<阈值 → null', small, null);

  // 6.3 命中 (dd = 0.15)
  const hit = detectRiskControlShortfall(mkInput());
  assert('6.3 命中', hit !== null);
  assertEqual('6.4 category', hit?.category, 'risk_control');
  assertEqual('6.5 key', hit?.key, 'drawdown_exceeds_threshold');
  // priority: 65 + min(30, 0.15*200=30) = 65+30 = 95
  assertEqual('6.6 priority=95', hit?.priority, 95);
  assertEqual('6.7 action.type=tune_risk_param', hit?.action?.type, 'tune_risk_param');

  // 6.8 边界 dd = 0.10 恰好 → 命中, priority = 65 + min(30, 20) = 65+20 = 85
  const edge = detectRiskControlShortfall(
    mkInput({
      sections: mkSections({
        counterfactual_baselines: {
          actual: { max_drawdown: -0.10 },
        },
      }),
    })
  );
  assert('6.8 边界命中', edge !== null);
  assertEqual('6.9 边界 priority=85', edge?.priority, 85);

  // 6.10 max_drawdown 正数也按 abs 处理
  const absHit = detectRiskControlShortfall(
    mkInput({
      sections: mkSections({
        counterfactual_baselines: {
          actual: { max_drawdown: 0.15 },
        },
      }),
    })
  );
  assert('6.10 abs 命中', absHit !== null);
}

// ============================================================================
// [7] sortByPriority / pickTopFindings
// ============================================================================
console.log('\n[7] sortByPriority / pickTopFindings');
{
  const mk = (
    cat: ImprovementCategory,
    p: number,
    key = 'k'
  ): ImprovementSuggestion => ({
    category: cat,
    key,
    title: `${cat}-${p}`,
    body: '',
    priority: p,
    template_id: 't',
    evidence: {},
  });

  // 7.1 priority desc
  const sorted = sortByPriority([mk('detection', 50), mk('execution', 80), mk('response', 65)]);
  assertEqual(
    '7.1 priority desc',
    sorted.map(s => s.priority),
    [80, 65, 50]
  );

  // 7.2 不 mutate 输入
  const input = [mk('detection', 50), mk('execution', 80)];
  const orig = JSON.stringify(input);
  sortByPriority(input);
  assertEqual('7.2 不 mutate', JSON.stringify(input), orig);

  // 7.3 priority 相同 → category 字典序
  const sameP = sortByPriority([mk('response', 70), mk('detection', 70), mk('execution', 70)]);
  assertEqual(
    '7.3 priority 同 → category 字典序',
    sameP.map(s => s.category),
    ['detection', 'execution', 'response']
  );

  // 7.4 pickTopFindings cap=2
  const top2 = pickTopFindings(
    [mk('detection', 50), mk('execution', 80), mk('response', 65)],
    2
  );
  assertEqual('7.4a top2.length=2', top2.length, 2);
  assertEqual('7.4b top2 priorities', top2.map(s => s.priority), [80, 65]);

  // 7.5 cap=0 → []
  assertEqual('7.5 cap=0', pickTopFindings([mk('detection', 50)], 0), []);

  // 7.6 cap=负 → []
  assertEqual('7.6 cap=-1', pickTopFindings([mk('detection', 50)], -1), []);

  // 7.7 cap >= len → 全返
  const all = pickTopFindings([mk('detection', 50), mk('execution', 80)], 10);
  assertEqual('7.7 cap>=len', all.length, 2);

  // 7.8 空数组
  assertEqual('7.8 空', pickTopFindings([], 5), []);
}

// ============================================================================
// [8] buildImprovementSuggestions
// ============================================================================
console.log('\n[8] buildImprovementSuggestions');
{
  // 8.1 全空 sections → sources_used=[]
  const empty = buildImprovementSuggestions({
    event_detected_at: new Date('2026-06-10T03:30:00Z'),
    black_swan_event_id: 1,
    sections: {},
  });
  assertEqual('8.1a suggestions=[]', empty.suggestions, []);
  assertEqual('8.1b top_findings=[]', empty.top_findings, []);
  assertEqual('8.1c sources_used=[]', empty.meta.sources_used, []);
  assertEqual('8.1d suggestions_total=0', empty.meta.suggestions_total, 0);
  assertEqual('8.1e suggestor_version', empty.suggestor_version, BLACK_SWAN_IMPROVEMENT_SUGGESTOR_VERSION);
  assertEqual(
    '8.1f event_detected_at ISO',
    empty.meta.event_detected_at,
    '2026-06-10T03:30:00.000Z'
  );

  // 8.2 sources_used 三段全
  const full = buildImprovementSuggestions(mkInput());
  assertEqual('8.2 sources_used 三段', full.meta.sources_used.sort(), [
    'counterfactual_baselines',
    'event_summary',
    'event_timeline',
  ]);

  // 8.3 4 detector 同时命中 (mkInput defaults: high=1 → detection 不命中,
  // 但 response 也不命中 because high<2; 命中 execution + risk_control)
  assert('8.3 至少命中 2 类', full.suggestions.length >= 2);

  // 8.4 全 4 类命中构造 — 0 alert + 业绩失控 + 高 dd
  const allHit = buildImprovementSuggestions(
    mkInput({
      sections: mkSections({
        event_timeline: {
          timeline: [],
          alert_count_by_level: { low: 0, medium: 0, high: 0, critical: 0 },
        },
      }),
    })
  );
  // detection 命中 (high=0), execution 命中 (gap=0.08), risk_control 命中 (dd=0.15)
  // response 不命中 (high<阈值)
  const cats = allHit.suggestions.map(s => s.category).sort();
  assertEqual('8.4 命中 3 类 (detection/execution/risk_control)', cats, [
    'detection',
    'execution',
    'risk_control',
  ]);

  // 8.5 真 4 类齐 — high=3 命中 detection 假, response 命中 (high>=2, no watchdog)
  const fourHit = buildImprovementSuggestions(
    mkInput({
      sections: mkSections({
        event_timeline: {
          timeline: [
            { ts: 't1', type: 'risk_alert', severity: 'high' },
          ],
          alert_count_by_level: { low: 0, medium: 0, high: 3, critical: 0 },
        },
      }),
    })
  );
  // detection 不命中 (high=3>=1), response 命中, execution 命中, risk_control 命中
  const cats4 = fourHit.suggestions.map(s => s.category).sort();
  assertEqual('8.5 命中 3 类 (response/execution/risk_control)', cats4, [
    'execution',
    'response',
    'risk_control',
  ]);

  // 8.6 top_findings cap=5 default
  assertEqual('8.6 top_findings cap', fourHit.meta.top_findings_cap, 5);
  assert('8.6b top_findings 与 suggestions 等长 (≤5)', fourHit.top_findings.length === fourHit.suggestions.length);

  // 8.7 top_findings_cap=2 截断
  const cap2 = buildImprovementSuggestions(mkInput({ top_findings_cap: 2 }));
  assert('8.7a top_findings.length=2', cap2.top_findings.length <= 2);
  assertEqual('8.7b cap=2', cap2.meta.top_findings_cap, 2);

  // 8.8 non-positive cap fallback → default 5
  const negCap = buildImprovementSuggestions(mkInput({ top_findings_cap: -3 }));
  assertEqual('8.8 negative cap fallback default', negCap.meta.top_findings_cap, 5);

  // 8.9 0 cap fallback
  const zeroCap = buildImprovementSuggestions(mkInput({ top_findings_cap: 0 }));
  assertEqual('8.9 0 cap fallback', zeroCap.meta.top_findings_cap, 5);

  // 8.10 top_findings 按 priority desc 排
  const sorted = fourHit.top_findings;
  for (let i = 1; i < sorted.length; i++) {
    assert(
      `8.10.${i} top_findings sorted by priority desc`,
      sorted[i - 1].priority >= sorted[i].priority
    );
  }
}

// ============================================================================
// [9] appendSectionFilled / decidePostmortemStatus
// ============================================================================
console.log('\n[9] appendSectionFilled / decidePostmortemStatus');
{
  // 9.1 空 metadata → 仅本段
  const r1 = appendSectionFilled({}, 'improvement_suggestions');
  assertEqual('9.1 sections_filled', r1.sections_filled, ['improvement_suggestions']);

  // 9.2 已有 3 段 → 累加 4 段
  const r2 = appendSectionFilled(
    { sections_filled: ['event_summary', 'counterfactual_baselines', 'event_timeline'] },
    'improvement_suggestions'
  );
  assertEqual('9.2 sections_filled 4 段', r2.sections_filled.sort(), [
    'counterfactual_baselines',
    'event_summary',
    'event_timeline',
    'improvement_suggestions',
  ]);

  // 9.3 重复不重复
  const r3 = appendSectionFilled(
    { sections_filled: ['improvement_suggestions'] },
    'improvement_suggestions'
  );
  assertEqual('9.3 不重复', r3.sections_filled, ['improvement_suggestions']);

  // 9.4 merged_metadata 保留其它 key
  const r4 = appendSectionFilled(
    { sections_filled: [], extra: 'kept' },
    'improvement_suggestions'
  );
  assertEqual('9.4 extra 保留', (r4.merged_metadata as any).extra, 'kept');

  // 9.5 损坏 sections_filled (非数组) → 兜底空
  const r5 = appendSectionFilled(
    { sections_filled: 'broken' as any },
    'improvement_suggestions'
  );
  assertEqual('9.5 损坏 → 仅本段', r5.sections_filled, ['improvement_suggestions']);

  // 9.6 非 string 元素过滤
  const r6 = appendSectionFilled(
    { sections_filled: ['event_summary', 123, null, 'event_timeline'] as any },
    'improvement_suggestions'
  );
  assertEqual('9.6 过滤非 string', r6.sections_filled.sort(), [
    'event_summary',
    'event_timeline',
    'improvement_suggestions',
  ]);

  // 9.7 decidePostmortemStatus — 全 4 段 → ok
  const ok = decidePostmortemStatus([
    'event_summary',
    'counterfactual_baselines',
    'event_timeline',
    'improvement_suggestions',
  ]);
  assertEqual('9.7a status=ok', ok.status, 'ok');
  assertEqual('9.7b reason=null', ok.reason, null);

  // 9.8 部分 → partial + reason 含 pending
  const partial = decidePostmortemStatus(['event_summary']);
  assertEqual('9.8a status=partial', partial.status, 'partial');
  assert('9.8b reason 含 pending_sections', partial.reason!.includes('pending_sections'));
  assert('9.8c reason 含缺失段名', partial.reason!.includes('counterfactual_baselines'));

  // 9.9 空 → partial
  const noneFilled = decidePostmortemStatus([]);
  assertEqual('9.9 空 → partial', noneFilled.status, 'partial');
}

// ============================================================================
// [10] runBlackSwanImprovementSuggestorService e2e
// ============================================================================
async function run10(): Promise<void> {
  console.log('\n[10] runBlackSwanImprovementSuggestorService e2e');

  // (a) loadCandidates throw
  {
    const { runner } = makeFakeRunner({ loadShouldThrow: new Error('boom') });
    const r = await runBlackSwanImprovementSuggestorService(runner, {});
    assertEqual('10a.1 success=false', r.success, false);
    assert('10a.2 error 含 boom', r.error!.includes('boom'));
    assertEqual('10a.3 candidates_total=0', r.candidates_total, 0);
  }

  // (b) loadCandidates ok=false
  {
    const { runner } = makeFakeRunner({
      loadResult: { ok: false, error: 'db_offline' },
    });
    const r = await runBlackSwanImprovementSuggestorService(runner, {});
    assertEqual('10b.1 success=false', r.success, false);
    assert('10b.2 error 含 db_offline', r.error!.includes('db_offline'));
  }

  // (c) 无 candidates
  {
    const { runner, state } = makeFakeRunner({ loadResult: { ok: true, candidates: [] } });
    const r = await runBlackSwanImprovementSuggestorService(runner, {});
    assertEqual('10c.1 success=true', r.success, true);
    assertEqual('10c.2 candidates_total=0', r.candidates_total, 0);
    assertEqual('10c.3 updateCalls=0', state.updateCalls.length, 0);
  }

  // (d) dry_run=true → 不调 updateReport
  {
    const { runner, state } = makeFakeRunner({
      loadResult: { ok: true, candidates: [mkPartial()] },
    });
    const r = await runBlackSwanImprovementSuggestorService(runner, { dry_run: true });
    assertEqual('10d.1 success=true', r.success, true);
    assertEqual('10d.2 dry_run=true', r.dry_run, true);
    assertEqual('10d.3 candidates_total=1', r.candidates_total, 1);
    assertEqual('10d.4 updateCalls=0 (dry)', state.updateCalls.length, 0);
  }

  // (e) section.suggestions=[] → skipped
  {
    // 构造一份全空数据 — 所有 4 detector 都不命中
    const noSig = mkPartial({
      sections: {
        event_summary: { event_type: 'ST' },
        counterfactual_baselines: {
          baselines: [{ type: 'zero', pnl_pct: 0, max_drawdown: 0 }],
          actual: { pnl_pct: 0, max_drawdown: 0 },
        },
        event_timeline: {
          timeline: [],
          alert_count_by_level: { low: 0, medium: 0, high: 1, critical: 0 },
        },
      },
    });
    const { runner, state } = makeFakeRunner({
      loadResult: { ok: true, candidates: [noSig] },
    });
    const r = await runBlackSwanImprovementSuggestorService(runner, {});
    assertEqual('10e.1 success=true', r.success, true);
    assertEqual('10e.2 reports_skipped=1', r.reports_skipped, 1);
    assertEqual('10e.3 reports_updated=0', r.reports_updated, 0);
    assertEqual('10e.4 updateCalls=0', state.updateCalls.length, 0);
  }

  // (f) updateReport ok=false
  {
    const { runner } = makeFakeRunner({
      loadResult: { ok: true, candidates: [mkPartial()] },
      updateResults: [{ ok: false, error: 'pg_explode' }],
    });
    const r = await runBlackSwanImprovementSuggestorService(runner, {});
    assertEqual('10f.1 success=true', r.success, true);
    assertEqual('10f.2 reports_failed=1', r.reports_failed, 1);
    assertEqual('10f.3 reports_updated=0', r.reports_updated, 0);
  }

  // (g) updateReport throw
  {
    const { runner } = makeFakeRunner({
      loadResult: { ok: true, candidates: [mkPartial()] },
      updateResults: [new Error('sequelize_blow')],
    });
    const r = await runBlackSwanImprovementSuggestorService(runner, {});
    assertEqual('10g.1 success=true', r.success, true);
    assertEqual('10g.2 reports_failed=1', r.reports_failed, 1);
  }

  // (h) 全成功 — 2 候选 (1 partial + 1 完成 4 段升 ok)
  {
    const cand1 = mkPartial({
      id: 100,
      current_metadata: { sections_filled: ['event_summary'] },
    });
    const cand2 = mkPartial({
      id: 200,
      current_metadata: {
        sections_filled: ['event_summary', 'counterfactual_baselines', 'event_timeline'],
      },
    });
    const { runner, state } = makeFakeRunner({
      loadResult: { ok: true, candidates: [cand1, cand2] },
    });
    const r = await runBlackSwanImprovementSuggestorService(runner, {});
    assertEqual('10h.1 success=true', r.success, true);
    assertEqual('10h.2 candidates_total=2', r.candidates_total, 2);
    assertEqual('10h.3 reports_updated=2', r.reports_updated, 2);
    assertEqual('10h.4 reports_failed=0', r.reports_failed, 0);
    assertEqual('10h.5 reports_skipped=0', r.reports_skipped, 0);
    assertEqual('10h.6 updateCalls.length=2', state.updateCalls.length, 2);

    // 行 1 (id=100): 1 段 + 本段 → 2/4 段 → partial
    const row1 = state.updateCalls[0];
    assertEqual('10h.7a id 透传', row1.id, 100);
    assertEqual('10h.7b status=partial', row1.status, 'partial');
    assert('10h.7c reason 含 pending', row1.reason!.includes('pending_sections'));
    assertEqual(
      '10h.7d sections_filled 2 段',
      (row1.metadata as any).sections_filled.sort(),
      ['event_summary', 'improvement_suggestions']
    );
    assertEqual(
      '10h.7e suggestor_version 强制',
      (row1.metadata as any).suggestor_version,
      BLACK_SWAN_IMPROVEMENT_SUGGESTOR_VERSION
    );
    assert(
      '10h.7f improvement_suggestions_filled_at_iso 已写',
      typeof (row1.metadata as any).improvement_suggestions_filled_at_iso === 'string'
    );

    // 行 2 (id=200): 4 段全 → ok
    const row2 = state.updateCalls[1];
    assertEqual('10h.8a id 透传', row2.id, 200);
    assertEqual('10h.8b status=ok (4/4)', row2.status, 'ok');
    assertEqual('10h.8c reason=null', row2.reason, null);
    assertEqual(
      '10h.8d sections_filled 4 段',
      (row2.metadata as any).sections_filled.sort(),
      ['counterfactual_baselines', 'event_summary', 'event_timeline', 'improvement_suggestions']
    );

    // payload 仅含约定 5 列 — 不出现其它 JSONB 段
    assert('10h.9a row1 不含 event_summary key', !('event_summary' in row1));
    assert('10h.9b row1 不含 counterfactual_baselines key', !('counterfactual_baselines' in row1));
    assert('10h.9c row1 不含 event_timeline key', !('event_timeline' in row1));
    assert('10h.9d row1 含 improvement_suggestions', 'improvement_suggestions' in row1);
    assert('10h.9e row1 含 metadata', 'metadata' in row1);
    assert('10h.9f row1 含 status', 'status' in row1);
    assert('10h.9g row1 含 reason', 'reason' in row1);
    assert('10h.9h row1 含 generated_at', 'generated_at' in row1);
  }

  // (i) event_id + lookback_hours + top_findings_cap 透传
  {
    const { runner, state } = makeFakeRunner({ loadResult: { ok: true, candidates: [] } });
    await runBlackSwanImprovementSuggestorService(runner, {
      event_id: 42,
      lookback_hours: 72,
      top_findings_cap: 3,
    });
    assertEqual('10i.1 loadCalls.length=1', state.loadCalls.length, 1);
    assertEqual('10i.2 event_id 透传', state.loadCalls[0].event_id, 42);
    assertEqual('10i.3 lookback_hours 透传', state.loadCalls[0].lookback_hours, 72);

    // 默认值
    const { runner: r2, state: s2 } = makeFakeRunner({ loadResult: { ok: true, candidates: [] } });
    await runBlackSwanImprovementSuggestorService(r2, {});
    assertEqual(
      '10i.4 lookback_hours 默认',
      s2.loadCalls[0].lookback_hours,
      BLACK_SWAN_IMPROVEMENT_DEFAULT_LOOKBACK_HOURS
    );

    // 非法 lookback_hours fallback
    const { runner: r3, state: s3 } = makeFakeRunner({ loadResult: { ok: true, candidates: [] } });
    await runBlackSwanImprovementSuggestorService(r3, { lookback_hours: -10 });
    assertEqual(
      '10i.5 非法 lookback_hours fallback',
      s3.loadCalls[0].lookback_hours,
      BLACK_SWAN_IMPROVEMENT_DEFAULT_LOOKBACK_HOURS
    );

    // top_findings_cap 透传到 section
    const { runner: r4, state: s4 } = makeFakeRunner({
      loadResult: { ok: true, candidates: [mkPartial()] },
    });
    await runBlackSwanImprovementSuggestorService(r4, { top_findings_cap: 2 });
    assertEqual(
      '10i.6 top_findings_cap 进 section',
      s4.updateCalls[0].improvement_suggestions.meta.top_findings_cap,
      2
    );
  }

  // (j) metadata 透传 + suggestor_version 覆盖 + generated_at 覆盖
  {
    const { runner, state } = makeFakeRunner({
      loadResult: { ok: true, candidates: [mkPartial()] },
    });
    const customAt = new Date('2026-07-01T12:00:00Z');
    await runBlackSwanImprovementSuggestorService(runner, {
      metadata: { cron_run_id: 999, suggestor_version: 'should_be_overridden' },
      generated_at: customAt,
    });
    const md = state.updateCalls[0].metadata as any;
    assertEqual('10j.1 cron_run_id 透传', md.cron_run_id, 999);
    // suggestor_version 由 service 强制覆盖
    assertEqual(
      '10j.2 suggestor_version service 强制',
      md.suggestor_version,
      BLACK_SWAN_IMPROVEMENT_SUGGESTOR_VERSION
    );
    // generated_at 覆盖
    assertEqual(
      '10j.3 generated_at 覆盖',
      state.updateCalls[0].generated_at.toISOString(),
      customAt.toISOString()
    );
  }
}

// ============================================================================
// [11] PRODUCTION runner smoke
// ============================================================================
async function run11(): Promise<void> {
  console.log('\n[11] PRODUCTION runner smoke');
  const r = createProductionSuggestorRunner();
  assert('11.1 createProductionSuggestorRunner 返对象', typeof r === 'object' && r !== null);
  assert('11.2 含 loadCandidates', typeof r.loadCandidates === 'function');
  assert('11.3 含 updateReport', typeof r.updateReport === 'function');
  // singleton
  const s1 = getProductionSuggestorRunner();
  const s2 = getProductionSuggestorRunner();
  assert('11.4 singleton 同一实例', s1 === s2);
  // loadCandidates 脱 DB → 返 ok:true/false (永不抛)
  const lc = await s1.loadCandidates({ asOf: new Date(), lookback_hours: 24 });
  assert(
    '11.5 loadCandidates 脱 DB 永不抛',
    typeof lc === 'object' && 'ok' in lc
  );
  // updateReport 脱 DB → 返 ok:true/false (永不抛)
  const ur = await s1.updateReport({
    id: 1,
    improvement_suggestions: {
      suggestions: [],
      top_findings: [],
      suggestor_version: BLACK_SWAN_IMPROVEMENT_SUGGESTOR_VERSION,
      meta: {
        event_detected_at: new Date().toISOString(),
        sources_used: [],
        suggestions_total: 0,
        top_findings_cap: 5,
      },
    },
    metadata: {},
    status: 'partial',
    reason: null,
    generated_at: new Date(),
  });
  assert('11.6 updateReport 脱 DB → 永不抛', typeof ur === 'object' && 'ok' in ur);
}

// ============================================================================
// [12] META-GUARD — 源文件正则扫
// ============================================================================
console.log('\n[12] META-GUARD');
{
  const ROOT = join(__dirname, '../..');
  const SCHEDULER_SRC = readFileSync(join(ROOT, 'src/services/SchedulerService.ts'), 'utf8');
  const SERVICE_SRC = readFileSync(
    join(ROOT, 'src/services/BlackSwanImprovementSuggestorService.ts'),
    'utf8'
  );
  const REGISTRY_SRC = readFileSync(join(ROOT, 'src/constants/cronRegistry.ts'), 'utf8');

  // 12.1 cronRegistry 含 BLACK_SWAN_IMPROVEMENT
  assert(
    '12.1 cronRegistry 含 BLACK_SWAN_IMPROVEMENT',
    REGISTRY_SRC.includes("type: 'BLACK_SWAN_IMPROVEMENT'")
  );
  // 12.2 recommendedCron 与常量一致
  assert(
    '12.2 cronRegistry recommendedCron 一致',
    REGISTRY_SRC.includes(`recommendedCron: '${BLACK_SWAN_IMPROVEMENT_RECOMMENDED_CRON}'`)
  );
  // 12.3 与 BLACK_SWAN_TIMELINE 错峰 (33,3 vs 43,13)
  assert(
    '12.3 错峰 BLACK_SWAN_TIMELINE',
    REGISTRY_SRC.includes("recommendedCron: '33,3 * * * *'") &&
      REGISTRY_SRC.includes("recommendedCron: '43,13 * * * *'")
  );
  // 12.4 SchedulerService 含 dispatch 分支
  assert(
    '12.4 SchedulerService dispatch 分支',
    SCHEDULER_SRC.includes("task.type === 'BLACK_SWAN_IMPROVEMENT'")
  );
  // 12.5 SchedulerService lazy-require
  assert(
    '12.5 SchedulerService lazy-require',
    SCHEDULER_SRC.includes('runBlackSwanImprovementSuggestorService') &&
      SCHEDULER_SRC.includes("require('./BlackSwanImprovementSuggestorService')")
  );
  // 12.6 SchedulerService 透传 4 参数
  assert(
    '12.6 SchedulerService 透传 4 参数',
    /dry_run:\s*dryRunImpr/.test(SCHEDULER_SRC) &&
      /event_id:\s*eventIdImpr/.test(SCHEDULER_SRC) &&
      /lookback_hours:/.test(SCHEDULER_SRC) &&
      /top_findings_cap:/.test(SCHEDULER_SRC)
  );
  // 12.7 Service jsdoc 含 US-105 / PR-016
  assert(
    '12.7 Service jsdoc 含 US-105/PR-016',
    SERVICE_SRC.includes('US-105') && SERVICE_SRC.includes('PR-016')
  );
  // 12.8 Service jsdoc 含 4 类短板
  assert(
    '12.8 Service jsdoc 含 4 类短板',
    SERVICE_SRC.includes('detection') &&
      SERVICE_SRC.includes('response') &&
      SERVICE_SRC.includes('execution') &&
      SERVICE_SRC.includes('risk_control')
  );
  // 12.9 Service 标 fail-OPEN
  assert('12.9 Service 标 fail-OPEN', SERVICE_SRC.includes('fail-OPEN'));
  // 12.10 Service 标 idempotent + sections_filled
  assert(
    '12.10 Service 标 idempotent + sections_filled',
    SERVICE_SRC.includes('idempotent') && SERVICE_SRC.includes('sections_filled')
  );
  // 12.11 Service 标与 PR-013/014/015 段间分工
  assert(
    '12.11 Service 标 PR-013/014/015 分工',
    SERVICE_SRC.includes('PR-013') &&
      SERVICE_SRC.includes('PR-014') &&
      SERVICE_SRC.includes('PR-015')
  );
  // 12.12 Service 标"不擦其它段"
  assert(
    '12.12 Service 标不擦其它 JSONB 段',
    /不动它们|不擦/.test(SERVICE_SRC)
  );
  // 12.13 Service 标与 BLACK_SWAN_TIMELINE 错峰
  assert(
    '12.13 Service 标错峰 BLACK_SWAN_TIMELINE',
    SERVICE_SRC.includes('BLACK_SWAN_TIMELINE') && SERVICE_SRC.includes('错峰')
  );
  // 12.14 ALL_POSTMORTEM_SECTIONS 4 段
  assertEqual('12.14 ALL_POSTMORTEM_SECTIONS.length=4', ALL_POSTMORTEM_SECTIONS.length, 4);
  // 12.15 4 段最后一段是 improvement_suggestions
  assertEqual(
    '12.15 最后一段=improvement_suggestions',
    ALL_POSTMORTEM_SECTIONS[ALL_POSTMORTEM_SECTIONS.length - 1],
    'improvement_suggestions'
  );
  // 12.16 反向 META-GUARD — Service 主入口 row 构造段不含其它 3 段 JSONB key
  //       (防 refactor 把占位字段误塞回 payload 擦其它段)
  const rowConstructMatch = SERVICE_SRC.match(
    /const\s+row:\s*ImprovementReportUpdateRow\s*=\s*\{[\s\S]*?\};/
  );
  assert('12.16a 找到 row 构造段', !!rowConstructMatch);
  if (rowConstructMatch) {
    const block = rowConstructMatch[0];
    assert(
      '12.16b row 不含 event_summary:',
      !/\bevent_summary\s*:/.test(block)
    );
    assert(
      '12.16c row 不含 counterfactual_baselines:',
      !/\bcounterfactual_baselines\s*:/.test(block)
    );
    assert(
      '12.16d row 不含 event_timeline:',
      !/\bevent_timeline\s*:/.test(block)
    );
    assert(
      '12.16e row 含 improvement_suggestions:',
      /\bimprovement_suggestions\s*:/.test(block)
    );
  }
}

// ============================================================================
// Async wrapper
// ============================================================================
(async () => {
  await run10();
  await run11();

  console.log(`\n[BlackSwanImprovementSuggestorService] ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})().catch(err => {
  console.error('test crashed:', err);
  process.exit(1);
});
