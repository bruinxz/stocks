/**
 * US-052 [FE-013] LabWorkspace OverfitMetrics 显示 单元测试.
 *
 * 不依赖 jest / DB / 网络 / React; 直接跑:
 *   cd backend && npx ts-node --transpile-only tests/services/overfit-metrics-helpers.test.ts
 *
 * import 自 frontend/src/pages/workspace/overfitMetricsHelpers.ts (pure helpers, 无 antd/react,
 * ts-node 直接吃). 跨 monorepo 同款 [[shadow-run-helpers.test]] / [[quarterly-retrain.test]] /
 * US-049/047/043.
 *
 * 覆盖维度:
 *   [1] 阈值常量 sanity + frozen + 单调
 *   [2] classifyDsrLevel 三档边界 + null/NaN
 *   [3] classifyPboLevel 三档边界 + null/NaN
 *   [4] deriveOverfitVerdict — PASS / FAIL / INSUFFICIENT 全分支
 *   [5] extractOverfitMetric — null / wf_summary / deflated_sharpe / verdict hint 优先
 *   [6] HEALTH_LEVEL_COLOR / VERDICT_COLOR / VERDICT_LABEL 完整 + frozen
 *   [7] evaluatePromotionReadiness — ready / 样本不足 / pass-rate 不足 / PBO critical / null
 *   [8] buildOverfitMetricsViewModel — happy + null + 排序 + 均值
 *   [9] formatRatio / formatPercent 边界
 *  [10] META-GUARD: LabWorkspace.tsx import + tabs 含 key + activeKey 分支; tab 组件 import helper;
 *       helper 主要 export
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  DSR_PASS_THRESHOLD,
  DSR_DEGRADED_MIN,
  PBO_FAIL_THRESHOLD,
  PBO_DEGRADED_MIN,
  PROMOTE_MIN_RUNS,
  DEFAULT_RUNS_LIMIT,
  HEALTH_LEVEL_COLOR,
  HEALTH_LEVEL_LABEL,
  VERDICT_COLOR,
  VERDICT_LABEL,
  classifyDsrLevel,
  classifyPboLevel,
  deriveOverfitVerdict,
  extractOverfitMetric,
  evaluatePromotionReadiness,
  buildOverfitMetricsViewModel,
  formatRatio,
  formatPercent,
  OptimizationRunLike,
  OverfitMetricRow,
} from '../../../frontend/src/pages/workspace/overfitMetricsHelpers';

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

// ---- [1] 阈值常量 sanity -----------------------------------------------------
{
  assert('[1.1] DSR_PASS_THRESHOLD > DSR_DEGRADED_MIN', DSR_PASS_THRESHOLD > DSR_DEGRADED_MIN);
  assert('[1.2] DSR_PASS_THRESHOLD ∈ (0,1]', DSR_PASS_THRESHOLD > 0 && DSR_PASS_THRESHOLD <= 1);
  assert('[1.3] DSR_DEGRADED_MIN ∈ (0,1]', DSR_DEGRADED_MIN > 0 && DSR_DEGRADED_MIN <= 1);
  assert('[1.4] PBO_FAIL_THRESHOLD > PBO_DEGRADED_MIN', PBO_FAIL_THRESHOLD > PBO_DEGRADED_MIN);
  assert('[1.5] PBO_FAIL_THRESHOLD ∈ (0,1]', PBO_FAIL_THRESHOLD > 0 && PBO_FAIL_THRESHOLD <= 1);
  assert('[1.6] PBO_DEGRADED_MIN ∈ (0,1]', PBO_DEGRADED_MIN > 0 && PBO_DEGRADED_MIN <= 1);
  assert('[1.7] PROMOTE_MIN_RUNS >= 1', PROMOTE_MIN_RUNS >= 1);
  assert('[1.8] DEFAULT_RUNS_LIMIT >= 10', DEFAULT_RUNS_LIMIT >= 10);
  assert('[1.9] HEALTH_LEVEL_COLOR frozen', Object.isFrozen(HEALTH_LEVEL_COLOR));
  assert('[1.10] HEALTH_LEVEL_LABEL frozen', Object.isFrozen(HEALTH_LEVEL_LABEL));
  assert('[1.11] VERDICT_COLOR frozen', Object.isFrozen(VERDICT_COLOR));
  assert('[1.12] VERDICT_LABEL frozen', Object.isFrozen(VERDICT_LABEL));
  // 与 backend OverfitMetrics.ts 同源 (任何调动这里必须同步 backend)
  assert('[1.13] DSR_PASS_THRESHOLD = 0.95 (与 backend 同源)', DSR_PASS_THRESHOLD === 0.95);
  assert('[1.14] PBO_FAIL_THRESHOLD = 0.5 (与 backend 同源)', PBO_FAIL_THRESHOLD === 0.5);
}

// ---- [2] classifyDsrLevel ----------------------------------------------------
{
  assert('[2.1] 0.99 → healthy', classifyDsrLevel(0.99) === 'healthy');
  assert(
    '[2.2] DSR_PASS_THRESHOLD 恰好 → healthy',
    classifyDsrLevel(DSR_PASS_THRESHOLD) === 'healthy'
  );
  assert('[2.3] 0.9 → degraded', classifyDsrLevel(0.9) === 'degraded');
  assert(
    '[2.4] DSR_DEGRADED_MIN 恰好 → degraded',
    classifyDsrLevel(DSR_DEGRADED_MIN) === 'degraded'
  );
  assert('[2.5] 0.5 → critical', classifyDsrLevel(0.5) === 'critical');
  assert('[2.6] 0 → critical', classifyDsrLevel(0) === 'critical');
  assert('[2.7] null → unknown', classifyDsrLevel(null) === 'unknown');
  assert('[2.8] undefined → unknown', classifyDsrLevel(undefined) === 'unknown');
  assert('[2.9] NaN → unknown', classifyDsrLevel(Number.NaN) === 'unknown');
  assert('[2.10] Infinity → unknown', classifyDsrLevel(Number.POSITIVE_INFINITY) === 'unknown');
}

// ---- [3] classifyPboLevel ----------------------------------------------------
{
  assert('[3.1] 0.1 → healthy', classifyPboLevel(0.1) === 'healthy');
  assert(
    '[3.2] PBO_DEGRADED_MIN-ε → healthy',
    classifyPboLevel(PBO_DEGRADED_MIN - 0.01) === 'healthy'
  );
  assert(
    '[3.3] PBO_DEGRADED_MIN 恰好 → degraded',
    classifyPboLevel(PBO_DEGRADED_MIN) === 'degraded'
  );
  assert('[3.4] 0.4 → degraded', classifyPboLevel(0.4) === 'degraded');
  assert(
    '[3.5] PBO_FAIL_THRESHOLD 恰好 → critical',
    classifyPboLevel(PBO_FAIL_THRESHOLD) === 'critical'
  );
  assert('[3.6] 0.9 → critical', classifyPboLevel(0.9) === 'critical');
  assert('[3.7] null → unknown', classifyPboLevel(null) === 'unknown');
  assert('[3.8] undefined → unknown', classifyPboLevel(undefined) === 'unknown');
  assert('[3.9] NaN → unknown', classifyPboLevel(Number.NaN) === 'unknown');
}

// ---- [4] deriveOverfitVerdict ------------------------------------------------
{
  // PASS: DSR ≥ 0.95 且 (PBO 缺失 或 PBO < 0.5)
  assert(
    '[4.1] DSR=0.99 PBO=null → PASS',
    deriveOverfitVerdict({ dsr: 0.99, pbo: null }) === 'PASS'
  );
  assert(
    '[4.2] DSR=0.96 PBO=0.4 → PASS',
    deriveOverfitVerdict({ dsr: 0.96, pbo: 0.4 }) === 'PASS'
  );
  assert(
    '[4.3] DSR=DSR_PASS_THRESHOLD 恰好 PBO=null → PASS',
    deriveOverfitVerdict({ dsr: DSR_PASS_THRESHOLD, pbo: null }) === 'PASS'
  );
  // FAIL: DSR < 0.95
  assert(
    '[4.4] DSR=0.8 PBO=null → FAIL',
    deriveOverfitVerdict({ dsr: 0.8, pbo: null }) === 'FAIL'
  );
  // FAIL: PBO ≥ 0.5 (即使 DSR PASS)
  assert(
    '[4.5] DSR=0.99 PBO=0.6 → FAIL',
    deriveOverfitVerdict({ dsr: 0.99, pbo: 0.6 }) === 'FAIL'
  );
  assert(
    '[4.6] DSR=0.96 PBO=PBO_FAIL_THRESHOLD 恰好 → FAIL',
    deriveOverfitVerdict({ dsr: 0.96, pbo: PBO_FAIL_THRESHOLD }) === 'FAIL'
  );
  // INSUFFICIENT: DSR null/NaN
  assert(
    '[4.7] DSR=null → INSUFFICIENT',
    deriveOverfitVerdict({ dsr: null, pbo: null }) === 'INSUFFICIENT'
  );
  assert(
    '[4.8] DSR=undefined → INSUFFICIENT',
    deriveOverfitVerdict({ dsr: undefined, pbo: null }) === 'INSUFFICIENT'
  );
  assert(
    '[4.9] DSR=NaN → INSUFFICIENT',
    deriveOverfitVerdict({ dsr: Number.NaN, pbo: null }) === 'INSUFFICIENT'
  );
  // INSUFFICIENT: PBO NaN (虽有 DSR)
  assert(
    '[4.10] DSR=0.99 PBO=NaN → INSUFFICIENT',
    deriveOverfitVerdict({ dsr: 0.99, pbo: Number.NaN }) === 'INSUFFICIENT'
  );
}

// ---- [5] extractOverfitMetric ------------------------------------------------
{
  // null / undefined / {} 安全
  assert('[5.1] null → INSUFFICIENT', extractOverfitMetric(null).verdict === 'INSUFFICIENT');
  assert(
    '[5.2] undefined → INSUFFICIENT',
    extractOverfitMetric(undefined).verdict === 'INSUFFICIENT'
  );
  assert(
    '[5.3] {} → INSUFFICIENT',
    extractOverfitMetric({} as any).verdict === 'INSUFFICIENT'
  );
  assert('[5.4] null dsr=null pbo=null', extractOverfitMetric(null).dsr === null);
  assert('[5.5] null dsr/pbo Level=unknown', extractOverfitMetric(null).dsrLevel === 'unknown');

  // wf_summary 优先: verdict 提示 + DSR/PBO 透传
  const wfRun: OptimizationRunLike = {
    id: 1,
    optimizer_type: 'walk_forward',
    strategy_name: 'multi_factor',
    status: 'completed',
    created_at: '2026-06-19T00:00:00Z',
    metadata_json: {
      wf_summary: { dsr: 0.98, pbo: 0.2, verdict: 'PASS' },
    },
  };
  const wfM = extractOverfitMetric(wfRun);
  assert('[5.6] wf_summary DSR 透传', wfM.dsr === 0.98);
  assert('[5.7] wf_summary PBO 透传', wfM.pbo === 0.2);
  assert('[5.8] wf_summary verdict 透传 (hint 优先)', wfM.verdict === 'PASS');
  assert('[5.9] wf_summary dsrLevel = healthy', wfM.dsrLevel === 'healthy');
  assert('[5.10] wf_summary pboLevel = healthy', wfM.pboLevel === 'healthy');

  // wf_summary verdict=FAIL hint 优先 (即使 DSR/PBO 看起来 PASS)
  const wfHint: OptimizationRunLike = {
    id: 2,
    optimizer_type: 'walk_forward',
    strategy_name: 'x',
    status: 'completed',
    created_at: '2026-06-19T00:00:00Z',
    metadata_json: {
      wf_summary: { dsr: 0.99, pbo: null, verdict: 'FAIL' }, // 假设上游 verdict 已综合其它信息
    },
  };
  assert('[5.11] wf_summary verdict=FAIL hint 优先', extractOverfitMetric(wfHint).verdict === 'FAIL');

  // 无 verdict hint → 兜底走 deriveOverfitVerdict
  const wfNoVerdict: OptimizationRunLike = {
    id: 3,
    optimizer_type: 'walk_forward',
    strategy_name: 'x',
    status: 'completed',
    created_at: '2026-06-19T00:00:00Z',
    metadata_json: { wf_summary: { dsr: 0.7, pbo: 0.4 } },
  };
  assert(
    '[5.12] wf_summary 无 verdict → deriveOverfitVerdict 兜底 FAIL',
    extractOverfitMetric(wfNoVerdict).verdict === 'FAIL'
  );

  // grid_search → metadata_json.deflated_sharpe.deflated_sharpe (无 PBO)
  const gsRun: OptimizationRunLike = {
    id: 4,
    optimizer_type: 'grid_search',
    strategy_name: 'gs_strategy',
    status: 'completed',
    created_at: '2026-06-19T00:00:00Z',
    metadata_json: {
      deflated_sharpe: { deflated_sharpe: 0.97, is_significant: true, explanation: '' },
    },
  };
  const gsM = extractOverfitMetric(gsRun);
  assert('[5.13] gs DSR 提取', gsM.dsr === 0.97);
  assert('[5.14] gs PBO=null', gsM.pbo === null);
  assert('[5.15] gs verdict = PASS', gsM.verdict === 'PASS');
  assert('[5.16] gs pboLevel = unknown (无 PBO)', gsM.pboLevel === 'unknown');

  // wf_summary 没 DSR + deflated_sharpe 有 → 回退到 deflated_sharpe
  const wfWithDs: OptimizationRunLike = {
    id: 5,
    optimizer_type: 'walk_forward',
    strategy_name: 'x',
    status: 'completed',
    created_at: '2026-06-19T00:00:00Z',
    metadata_json: {
      wf_summary: { dsr: null, pbo: 0.3 },
      deflated_sharpe: { deflated_sharpe: 0.92 },
    },
  };
  const wfDsM = extractOverfitMetric(wfWithDs);
  assert('[5.17] wf no DSR → 回退 deflated_sharpe', wfDsM.dsr === 0.92);
  assert('[5.18] wf 仍取 wf_summary pbo', wfDsM.pbo === 0.3);

  // wf_summary 有 DSR + deflated_sharpe 也有 → wf_summary 优先 (防双源覆盖)
  const wfDouble: OptimizationRunLike = {
    id: 6,
    optimizer_type: 'walk_forward',
    strategy_name: 'x',
    status: 'completed',
    created_at: '2026-06-19T00:00:00Z',
    metadata_json: {
      wf_summary: { dsr: 0.95, pbo: 0.1 },
      deflated_sharpe: { deflated_sharpe: 0.5 }, // 干扰
    },
  };
  assert('[5.19] 双源 wf_summary DSR 优先', extractOverfitMetric(wfDouble).dsr === 0.95);

  // 没 metadata_json
  const noMd: OptimizationRunLike = {
    id: 7,
    optimizer_type: 'bayesian',
    strategy_name: 'x',
    status: 'completed',
    created_at: '2026-06-19T00:00:00Z',
  };
  const noMdM = extractOverfitMetric(noMd);
  assert('[5.20] 无 metadata_json DSR=null', noMdM.dsr === null);
  assert('[5.21] 无 metadata_json verdict=INSUFFICIENT', noMdM.verdict === 'INSUFFICIENT');

  // summary 顶层别名等效 wf_summary (BacktestEngine.ts:157 把 wf_summary 抠到 summary)
  const summaryOnly: OptimizationRunLike = {
    id: 8,
    optimizer_type: 'walk_forward',
    strategy_name: 'x',
    status: 'completed',
    created_at: '2026-06-19T00:00:00Z',
    summary: { dsr: 0.96, pbo: 0.4, verdict: 'PASS' },
  };
  const summaryM = extractOverfitMetric(summaryOnly);
  assert('[5.22] summary 顶层别名 DSR', summaryM.dsr === 0.96);
  assert('[5.23] summary 顶层别名 verdict=PASS', summaryM.verdict === 'PASS');
}

// ---- [6] HEALTH_LEVEL / VERDICT 映射完整 ------------------------------------
{
  for (const level of ['healthy', 'degraded', 'critical', 'unknown'] as const) {
    assert(`[6.1] HEALTH_LEVEL_COLOR.${level} 非空`, typeof HEALTH_LEVEL_COLOR[level] === 'string' && HEALTH_LEVEL_COLOR[level].length > 0);
    assert(`[6.2] HEALTH_LEVEL_LABEL.${level} 非空`, typeof HEALTH_LEVEL_LABEL[level] === 'string' && HEALTH_LEVEL_LABEL[level].length > 0);
  }
  for (const v of ['PASS', 'FAIL', 'INSUFFICIENT'] as const) {
    assert(`[6.3] VERDICT_COLOR.${v} 非空`, typeof VERDICT_COLOR[v] === 'string' && VERDICT_COLOR[v].length > 0);
    assert(`[6.4] VERDICT_LABEL.${v} 非空`, typeof VERDICT_LABEL[v] === 'string' && VERDICT_LABEL[v].length > 0);
  }
}

// ---- [7] evaluatePromotionReadiness -----------------------------------------
{
  const mkRow = (
    id: number,
    overrides: Partial<OverfitMetricRow['metric']> = {}
  ): OverfitMetricRow => ({
    id,
    optimizer_type: 'walk_forward',
    strategy_name: 's',
    status: 'completed',
    created_at: '2026-06-19',
    metric: {
      dsr: 0.98,
      pbo: 0.1,
      verdict: 'PASS',
      dsrLevel: 'healthy',
      pboLevel: 'healthy',
      ...overrides,
    },
  });

  // null 输入
  const nr = evaluatePromotionReadiness(null);
  assert('[7.1] null ready=false', nr.ready === false);
  assert('[7.2] null level=unknown', nr.level === 'unknown');

  // 空数组
  const er = evaluatePromotionReadiness([]);
  assert('[7.3] 空 array ready=false', er.ready === false);
  assert('[7.4] 空 array level=unknown', er.level === 'unknown');

  // 样本不足 (< PROMOTE_MIN_RUNS) 但全 PASS
  const small = Array.from({ length: PROMOTE_MIN_RUNS - 1 }, (_, i) => mkRow(i));
  const sr = evaluatePromotionReadiness(small);
  assert('[7.5] 样本不足 ready=false', sr.ready === false);
  assert('[7.6] 样本不足 blocker 含 "样本量"', sr.blockers.some(b => /样本量/.test(b)));

  // 足量 + 全 PASS + 无 PBO critical → ready
  const happy = Array.from({ length: PROMOTE_MIN_RUNS }, (_, i) => mkRow(i));
  const hr = evaluatePromotionReadiness(happy);
  assert('[7.7] happy ready=true', hr.ready === true);
  assert('[7.8] happy level=healthy', hr.level === 'healthy');
  assert('[7.9] happy blockers=[]', hr.blockers.length === 0);

  // 多数 FAIL → ready=false + level=critical
  const mostFail = [
    ...Array.from({ length: 6 }, (_, i) =>
      mkRow(i, { verdict: 'FAIL', dsr: 0.5, dsrLevel: 'critical' })
    ),
    mkRow(99),
  ];
  const fr = evaluatePromotionReadiness(mostFail);
  assert('[7.10] 多数 FAIL ready=false', fr.ready === false);
  assert('[7.11] 多数 FAIL level=critical', fr.level === 'critical');
  assert('[7.12] 多数 FAIL blocker 含 "通过率"', fr.blockers.some(b => /通过率/.test(b)));

  // PBO critical 单 run 立刻 block
  const pboCrit = [
    ...Array.from({ length: PROMOTE_MIN_RUNS }, (_, i) => mkRow(i)),
    mkRow(200, { pbo: 0.6, pboLevel: 'critical', verdict: 'FAIL' }),
  ];
  const pr = evaluatePromotionReadiness(pboCrit);
  assert('[7.13] PBO critical 单 run ready=false', pr.ready === false);
  assert('[7.14] PBO critical level=critical', pr.level === 'critical');
  assert('[7.15] PBO critical blocker 含 "PBO 严重"', pr.blockers.some(b => /PBO 严重/.test(b)));

  // 全 INSUFFICIENT
  const insRows = Array.from({ length: PROMOTE_MIN_RUNS }, (_, i) =>
    mkRow(i, { verdict: 'INSUFFICIENT', dsr: null, pbo: null, dsrLevel: 'unknown', pboLevel: 'unknown' })
  );
  const ir = evaluatePromotionReadiness(insRows);
  assert('[7.16] 全 INSUFFICIENT ready=false', ir.ready === false);
  assert('[7.17] 全 INSUFFICIENT blocker 含 "INSUFFICIENT"', ir.blockers.some(b => /INSUFFICIENT/.test(b)));
}

// ---- [8] buildOverfitMetricsViewModel ---------------------------------------
{
  // null / 空安全
  const vmNull = buildOverfitMetricsViewModel(null);
  assert('[8.1] null vm.total=0', vmNull.total === 0);
  assert('[8.2] null vm.rows=[]', vmNull.rows.length === 0);
  assert('[8.3] null vm.distribution.pass=0', vmNull.distribution.pass === 0);
  assert('[8.4] null vm.distribution.passRate=null', vmNull.distribution.passRate === null);
  assert('[8.5] null vm.meanDsr=null', vmNull.meanDsr === null);
  assert('[8.6] null vm.promotion.ready=false', vmNull.promotion.ready === false);

  // happy path: 1 PASS / 1 FAIL / 1 INSUFFICIENT
  const sample: OptimizationRunLike[] = [
    {
      id: 1,
      optimizer_type: 'walk_forward',
      strategy_name: 'pass_strategy',
      status: 'completed',
      created_at: '2026-06-19T10:00:00Z',
      metadata_json: { wf_summary: { dsr: 0.98, pbo: 0.1, verdict: 'PASS' } },
    },
    {
      id: 2,
      optimizer_type: 'walk_forward',
      strategy_name: 'fail_strategy',
      status: 'completed',
      created_at: '2026-06-19T11:00:00Z',
      metadata_json: { wf_summary: { dsr: 0.6, pbo: 0.7, verdict: 'FAIL' } },
    },
    {
      id: 3,
      optimizer_type: 'bayesian',
      strategy_name: 'incomplete_strategy',
      status: 'running',
      created_at: '2026-06-19T12:00:00Z',
      // 无 metadata
    },
  ];
  const vm = buildOverfitMetricsViewModel(sample);
  assert('[8.7] total=3', vm.total === 3);
  assert('[8.8] dist.pass=1', vm.distribution.pass === 1);
  assert('[8.9] dist.fail=1', vm.distribution.fail === 1);
  assert('[8.10] dist.insufficient=1', vm.distribution.insufficient === 1);
  assert('[8.11] dist.passRate=0.5 (1/2)', vm.distribution.passRate === 0.5);
  // 均值 — 仅含 dsr 非 null (排除 INSUFFICIENT)
  assert('[8.12] meanDsr = (0.98+0.6)/2', Math.abs((vm.meanDsr || 0) - 0.79) < 1e-9);
  assert('[8.13] meanPbo = (0.1+0.7)/2', Math.abs((vm.meanPbo || 0) - 0.4) < 1e-9);

  // 排序: FAIL 最前 → PASS → INSUFFICIENT
  assert('[8.14] rows[0] FAIL', vm.rows[0].metric.verdict === 'FAIL');
  assert('[8.15] rows[1] PASS', vm.rows[1].metric.verdict === 'PASS');
  assert('[8.16] rows[2] INSUFFICIENT', vm.rows[2].metric.verdict === 'INSUFFICIENT');

  // 含脏数据自动 filter
  const dirty: any[] = [null, undefined, ...sample];
  const vmDirty = buildOverfitMetricsViewModel(dirty);
  assert('[8.17] dirty filter total=3', vmDirty.total === 3);

  // 全 PASS 足量
  const allPass: OptimizationRunLike[] = Array.from({ length: PROMOTE_MIN_RUNS }, (_, i) => ({
    id: i + 100,
    optimizer_type: 'walk_forward',
    strategy_name: 's' + i,
    status: 'completed',
    created_at: `2026-06-${10 + i}T00:00:00Z`,
    metadata_json: { wf_summary: { dsr: 0.99, pbo: 0.1, verdict: 'PASS' } },
  }));
  const vmReady = buildOverfitMetricsViewModel(allPass);
  assert('[8.18] allPass promotion.ready=true', vmReady.promotion.ready === true);
  assert('[8.19] allPass distribution.passRate=1', vmReady.distribution.passRate === 1);

  // 排序 tie-break: 同 verdict + 同 created_at → id desc
  const tieRows: OptimizationRunLike[] = [
    {
      id: 10,
      optimizer_type: 'walk_forward',
      strategy_name: 'a',
      status: 'completed',
      created_at: '2026-06-19T00:00:00Z',
      metadata_json: { wf_summary: { dsr: 0.98, pbo: 0.1, verdict: 'PASS' } },
    },
    {
      id: 20,
      optimizer_type: 'walk_forward',
      strategy_name: 'b',
      status: 'completed',
      created_at: '2026-06-19T00:00:00Z',
      metadata_json: { wf_summary: { dsr: 0.98, pbo: 0.1, verdict: 'PASS' } },
    },
  ];
  const vmTie = buildOverfitMetricsViewModel(tieRows);
  assert('[8.20] tie-break id desc', vmTie.rows[0].id === 20 && vmTie.rows[1].id === 10);
}

// ---- [9] formatRatio / formatPercent ----------------------------------------
{
  assert('[9.1] formatRatio 0.95 → "0.950"', formatRatio(0.95) === '0.950');
  assert('[9.2] formatRatio 0 → "0.000"', formatRatio(0) === '0.000');
  assert('[9.3] formatRatio null → "—"', formatRatio(null) === '—');
  assert('[9.4] formatRatio undefined → "—"', formatRatio(undefined) === '—');
  assert('[9.5] formatRatio NaN → "—"', formatRatio(Number.NaN) === '—');
  assert('[9.6] formatRatio digits=2', formatRatio(0.1234, 2) === '0.12');

  assert('[9.7] formatPercent 0.5 → "50.0%"', formatPercent(0.5) === '50.0%');
  assert('[9.8] formatPercent 0 → "0.0%"', formatPercent(0) === '0.0%');
  assert('[9.9] formatPercent null → "—"', formatPercent(null) === '—');
  assert('[9.10] formatPercent NaN → "—"', formatPercent(Number.NaN) === '—');
  assert('[9.11] formatPercent digits=2', formatPercent(0.1234, 2) === '12.34%');
}

// ---- [10] META-GUARD fs+regex -----------------------------------------------
{
  const workspacePath = join(__dirname, '../../../frontend/src/pages/workspace/LabWorkspace.tsx');
  const src = readFileSync(workspacePath, 'utf8');
  assert(
    '[10.1] LabWorkspace.tsx 含 import OverfitMetricsTab',
    /import\s+OverfitMetricsTab\s+from\s+['"]\.\/LabWorkspace\.OverfitMetricsTab['"]/.test(src)
  );
  assert(
    '[10.2] tabs 数组含 key=overfit_metrics',
    /\{\s*key:\s*['"]overfit_metrics['"]/.test(src)
  );
  assert(
    '[10.3] activeKey 分支 overfit_metrics',
    /activeKey\s*===\s*['"]overfit_metrics['"]/.test(src)
  );
  assert('[10.4] body 渲染 OverfitMetricsTab', /<OverfitMetricsTab\s*\/>/.test(src));
}

{
  const tabPath = join(
    __dirname,
    '../../../frontend/src/pages/workspace/LabWorkspace.OverfitMetricsTab.tsx'
  );
  const src = readFileSync(tabPath, 'utf8');
  assert(
    '[10.5] tab 组件 import overfitMetricsHelpers',
    /from\s+['"]\.\/overfitMetricsHelpers['"]/.test(src)
  );
  assert(
    '[10.6] tab 组件调 buildOverfitMetricsViewModel',
    /buildOverfitMetricsViewModel\(/.test(src)
  );
  assert(
    '[10.7] tab 组件调 labService.listOptimizationRuns',
    /labService\.listOptimizationRuns\(/.test(src)
  );
  assert(
    '[10.8] tab 组件含 overfit-metrics-refresh testid',
    /data-testid=['"]overfit-metrics-refresh['"]/.test(src)
  );
  assert(
    '[10.9] tab 组件含 overfit-metrics-promotion-alert testid',
    /data-testid=['"]overfit-metrics-promotion-alert['"]/.test(src)
  );
  assert(
    '[10.10] tab 组件含 HEALTH_LEVEL_COLOR 引用',
    /HEALTH_LEVEL_COLOR/.test(src)
  );
  assert(
    '[10.11] tab 组件含 VERDICT_COLOR 引用',
    /VERDICT_COLOR/.test(src)
  );
}

{
  const helperPath = join(
    __dirname,
    '../../../frontend/src/pages/workspace/overfitMetricsHelpers.ts'
  );
  const src = readFileSync(helperPath, 'utf8');
  assert(
    '[10.12] helper export buildOverfitMetricsViewModel',
    /export\s+function\s+buildOverfitMetricsViewModel/.test(src)
  );
  assert(
    '[10.13] helper export extractOverfitMetric',
    /export\s+function\s+extractOverfitMetric/.test(src)
  );
  assert(
    '[10.14] helper export deriveOverfitVerdict',
    /export\s+function\s+deriveOverfitVerdict/.test(src)
  );
  assert(
    '[10.15] helper export classifyDsrLevel',
    /export\s+function\s+classifyDsrLevel/.test(src)
  );
  assert(
    '[10.16] helper export classifyPboLevel',
    /export\s+function\s+classifyPboLevel/.test(src)
  );
  assert(
    '[10.17] helper export evaluatePromotionReadiness',
    /export\s+function\s+evaluatePromotionReadiness/.test(src)
  );
  assert(
    '[10.18] helper export DSR_PASS_THRESHOLD',
    /export\s+const\s+DSR_PASS_THRESHOLD/.test(src)
  );
  assert(
    '[10.19] helper export PBO_FAIL_THRESHOLD',
    /export\s+const\s+PBO_FAIL_THRESHOLD/.test(src)
  );
}

// ---- summary ----------------------------------------------------------------
console.log(`\n[overfit-metrics-helpers] ${passed} ok / ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
