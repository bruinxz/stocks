/**
 * US-050 [FE-011] LabWorkspace 季度参数重训 tab 单元测试.
 *
 * 不依赖 jest / DB / 网络 / React; 直接跑:
 *   cd backend && npx ts-node --transpile-only tests/services/quarterly-retrain.test.ts
 *
 * import 自 frontend/src/pages/workspace/quarterlyRetrainHelpers.ts
 * (pure helpers, 无 antd/react, ts-node 直接吃). 跨 monorepo 同款 US-049/047/043.
 *
 * 覆盖维度:
 *   [1] 常量 sanity / frozen
 *   [2] getQuarterKey — Date/ISO/边界/null/非法
 *   [3] getRecentQuarters — count=1/4/跨年/非法 now
 *   [4] parseQuarterKey
 *   [5] toRetrainCandidate — null / invalid / DSR 路径 / mean_test_sharpe 路径 / deflated_sharpe 路径 / 无指标
 *   [6] groupCandidatesByQuarterAndStrategy — 多季度/多策略/排序 tie-break
 *   [7] topKCandidates — slice 边界
 *   [8] isShadowStrategy / lookupShadowByStrategyName — 三态 (true/false/缺失)
 *   [9] buildQuarterlyRetrainViewModel — happy + 空 + 活动季度 KPI
 *  [10] META-GUARD: LabWorkspace.tsx import + tabs 含 key + activeKey 分支; tab 组件 import helper; helper 主要 export
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  QUARTER_LABELS,
  DEFAULT_QUARTERS_WINDOW,
  DEFAULT_CANDIDATES_PER_BUCKET,
  SHADOW_BADGE_TEXT,
  HARD_BADGE_TEXT,
  getQuarterKey,
  getRecentQuarters,
  parseQuarterKey,
  toRetrainCandidate,
  groupCandidatesByQuarterAndStrategy,
  topKCandidates,
  isShadowStrategy,
  lookupShadowByStrategyName,
  buildQuarterlyRetrainViewModel,
} from '../../../frontend/src/pages/workspace/quarterlyRetrainHelpers';

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

// ---- [1] 常量 sanity --------------------------------------------------------
{
  assert('[1.1] QUARTER_LABELS frozen', Object.isFrozen(QUARTER_LABELS));
  assert('[1.2] QUARTER_LABELS 含 Q1..Q4', !!QUARTER_LABELS.Q1 && !!QUARTER_LABELS.Q2 && !!QUARTER_LABELS.Q3 && !!QUARTER_LABELS.Q4);
  assert('[1.3] DEFAULT_QUARTERS_WINDOW = 4', DEFAULT_QUARTERS_WINDOW === 4);
  assert('[1.4] DEFAULT_CANDIDATES_PER_BUCKET = 5', DEFAULT_CANDIDATES_PER_BUCKET === 5);
  assert('[1.5] SHADOW_BADGE_TEXT non-empty', typeof SHADOW_BADGE_TEXT === 'string' && SHADOW_BADGE_TEXT.length > 0);
  assert('[1.6] HARD_BADGE_TEXT non-empty', typeof HARD_BADGE_TEXT === 'string' && HARD_BADGE_TEXT.length > 0);
}

// ---- [2] getQuarterKey ------------------------------------------------------
{
  // 2026-06-19 → Q2
  assert('[2.1] 6/19 → Q2', getQuarterKey('2026-06-19T00:00:00Z') === '2026-Q2');
  // 1/1 → Q1
  assert('[2.2] 1/1 → Q1', getQuarterKey('2026-01-01T00:00:00Z') === '2026-Q1');
  // 12/31 → Q4
  assert('[2.3] 12/31 → Q4', getQuarterKey('2026-12-31T23:59:59Z') === '2026-Q4');
  // 边界 3/31 → Q1, 4/1 → Q2
  assert('[2.4] 3/31 → Q1', getQuarterKey('2026-03-31T00:00:00Z') === '2026-Q1');
  assert('[2.5] 4/1 → Q2', getQuarterKey('2026-04-01T00:00:00Z') === '2026-Q2');
  // 9/30 → Q3, 10/1 → Q4
  assert('[2.6] 9/30 → Q3', getQuarterKey('2026-09-30T00:00:00Z') === '2026-Q3');
  assert('[2.7] 10/1 → Q4', getQuarterKey('2026-10-01T00:00:00Z') === '2026-Q4');
  // Date 实例
  assert('[2.8] Date 实例', getQuarterKey(new Date(Date.UTC(2025, 7, 15))) === '2025-Q3');
  // 非法
  assert('[2.9] null → null', getQuarterKey(null) === null);
  assert('[2.10] undefined → null', getQuarterKey(undefined) === null);
  assert('[2.11] "" → null', getQuarterKey('') === null);
  assert('[2.12] 垃圾字符串 → null', getQuarterKey('not-a-date') === null);
}

// ---- [3] getRecentQuarters --------------------------------------------------
{
  const now = new Date(Date.UTC(2026, 5, 19)); // 2026-06-19 → Q2
  const r4 = getRecentQuarters(now, 4);
  assert('[3.1] count=4 长度', r4.length === 4);
  assert('[3.2] 首项是本季', r4[0] === '2026-Q2');
  assert('[3.3] 第二项 Q1', r4[1] === '2026-Q1');
  assert('[3.4] 跨年 Q4', r4[2] === '2025-Q4');
  assert('[3.5] 跨年 Q3', r4[3] === '2025-Q3');
  // count=1
  const r1 = getRecentQuarters(now, 1);
  assert('[3.6] count=1 长度', r1.length === 1 && r1[0] === '2026-Q2');
  // 非法 now → 空
  assert('[3.7] 非法 now → []', getRecentQuarters(new Date('invalid'), 4).length === 0);
  // count<1 兜底 1
  assert('[3.8] count=0 → ≥1', getRecentQuarters(now, 0).length === 1);
}

// ---- [4] parseQuarterKey ----------------------------------------------------
{
  const p = parseQuarterKey('2026-Q3');
  assert('[4.1] parse 2026-Q3', p?.year === 2026 && p?.quarter === 3);
  assert('[4.2] 非法返 null', parseQuarterKey('2026-Q5' as any) === null);
  assert('[4.3] 空串', parseQuarterKey('') === null);
  assert('[4.4] 非 string', parseQuarterKey(123 as any) === null);
}

// ---- [5] toRetrainCandidate -------------------------------------------------
{
  // null / undefined / 缺 id → null
  assert('[5.1] null → null', toRetrainCandidate(null) === null);
  assert('[5.2] undefined → null', toRetrainCandidate(undefined) === null);
  assert('[5.3] 缺 id', toRetrainCandidate({} as any) === null);

  // DSR 路径 (WF)
  const cDsr = toRetrainCandidate({
    id: 1,
    optimizer_type: 'walk_forward',
    strategy_name: 'multi_factor_alpha',
    status: 'completed',
    total_combos: 10,
    completed_combos: 10,
    failed_combos: 0,
    best_result_id: 1,
    created_at: '2026-05-10T00:00:00Z',
    started_at: null,
    finished_at: '2026-05-11T00:00:00Z',
    summary: { dsr: 0.85, mean_test_sharpe: 1.2, verdict: 'PASS' } as any,
  } as any);
  assert('[5.4a] DSR 路径 metric', cDsr?.primary_metric === 0.85);
  assert('[5.4b] DSR 路径 kind', cDsr?.primary_metric_kind === 'dsr');
  assert('[5.4c] verdict 透传', cDsr?.verdict === 'PASS');
  assert('[5.4d] quarter_key', cDsr?.quarter_key === '2026-Q2');

  // mean_test_sharpe 路径 (WF, 无 DSR)
  const cMs = toRetrainCandidate({
    id: 2,
    optimizer_type: 'walk_forward',
    strategy_name: 's',
    status: 'completed',
    total_combos: 1,
    completed_combos: 1,
    failed_combos: 0,
    best_result_id: null,
    created_at: '2026-04-15T00:00:00Z',
    started_at: null,
    finished_at: null,
    metadata_json: { wf_summary: { mean_test_sharpe: 0.5, verdict: 'INSUFFICIENT' } as any } as any,
  } as any);
  assert('[5.5a] mean_test_sharpe 路径 metric', cMs?.primary_metric === 0.5);
  assert('[5.5b] mean_test_sharpe kind', cMs?.primary_metric_kind === 'mean_test_sharpe');
  assert('[5.5c] verdict 透传', cMs?.verdict === 'INSUFFICIENT');

  // deflated_sharpe 路径 (GS/Bayesian)
  const cDef = toRetrainCandidate({
    id: 3,
    optimizer_type: 'bayesian',
    strategy_name: 's',
    status: 'completed',
    total_combos: 5,
    completed_combos: 5,
    failed_combos: 0,
    best_result_id: null,
    created_at: '2026-04-01T00:00:00Z',
    started_at: null,
    finished_at: null,
    metadata_json: { deflated_sharpe: { deflated_sharpe: 1.4 } as any } as any,
  } as any);
  assert('[5.6a] deflated_sharpe 路径 metric', cDef?.primary_metric === 1.4);
  assert('[5.6b] deflated_sharpe kind', cDef?.primary_metric_kind === 'deflated_sharpe');
  assert('[5.6c] verdict null (非 WF)', cDef?.verdict === null);

  // 无任何指标
  const cNone = toRetrainCandidate({
    id: 4,
    optimizer_type: 'grid_search',
    strategy_name: 's',
    status: 'completed',
    total_combos: 1,
    completed_combos: 1,
    failed_combos: 0,
    best_result_id: null,
    created_at: '2026-04-01T00:00:00Z',
    started_at: null,
    finished_at: null,
  } as any);
  assert('[5.7a] 无指标 metric=null', cNone?.primary_metric === null);
  assert('[5.7b] kind=none', cNone?.primary_metric_kind === 'none');

  // NaN/Infinity 不走 (用 deflated_sharpe 兜底 → 没合法值 → none)
  const cNaN = toRetrainCandidate({
    id: 5,
    optimizer_type: 'grid_search',
    strategy_name: 's',
    status: 'completed',
    total_combos: 1,
    completed_combos: 1,
    failed_combos: 0,
    best_result_id: null,
    created_at: '2026-04-01T00:00:00Z',
    started_at: null,
    finished_at: null,
    metadata_json: { deflated_sharpe: { deflated_sharpe: NaN } as any } as any,
  } as any);
  assert('[5.8] NaN 不被采纳', cNaN?.primary_metric === null && cNaN?.primary_metric_kind === 'none');
}

// ---- [6] groupCandidatesByQuarterAndStrategy --------------------------------
{
  const cs = [
    toRetrainCandidate({
      id: 100,
      optimizer_type: 'walk_forward',
      strategy_name: 'strategy_a',
      status: 'completed',
      total_combos: 1,
      completed_combos: 1,
      failed_combos: 0,
      best_result_id: null,
      created_at: '2026-05-10T00:00:00Z',
      started_at: null,
      finished_at: '2026-05-12T00:00:00Z',
      summary: { dsr: 0.5 } as any,
    } as any),
    toRetrainCandidate({
      id: 101,
      optimizer_type: 'walk_forward',
      strategy_name: 'strategy_a',
      status: 'completed',
      total_combos: 1,
      completed_combos: 1,
      failed_combos: 0,
      best_result_id: null,
      created_at: '2026-05-15T00:00:00Z',
      started_at: null,
      finished_at: '2026-05-16T00:00:00Z',
      summary: { dsr: 0.9 } as any,
    } as any),
    toRetrainCandidate({
      id: 102,
      optimizer_type: 'walk_forward',
      strategy_name: 'strategy_b',
      status: 'completed',
      total_combos: 1,
      completed_combos: 1,
      failed_combos: 0,
      best_result_id: null,
      created_at: '2026-04-10T00:00:00Z',
      started_at: null,
      finished_at: null,
      summary: { dsr: 0.3 } as any,
    } as any),
    toRetrainCandidate({
      id: 103,
      optimizer_type: 'walk_forward',
      strategy_name: 'strategy_a',
      status: 'completed',
      total_combos: 1,
      completed_combos: 1,
      failed_combos: 0,
      best_result_id: null,
      created_at: '2026-02-01T00:00:00Z',
      started_at: null,
      finished_at: null,
      summary: { dsr: 1.5 } as any,
    } as any),
  ].filter(Boolean) as any[];

  const grouped = groupCandidatesByQuarterAndStrategy(cs);
  assert('[6.1] 含 2026-Q2', grouped.has('2026-Q2'));
  assert('[6.2] 含 2026-Q1', grouped.has('2026-Q1'));
  const q2 = grouped.get('2026-Q2')!;
  assert('[6.3] Q2 有 strategy_a + strategy_b', q2.size === 2);
  const q2a = q2.get('strategy_a')!;
  assert('[6.4] Q2 strategy_a 有 2 候选', q2a.length === 2);
  // 排序 — dsr 0.9 在前, 0.5 在后
  assert('[6.5] 排序 DSR DESC', q2a[0].run_id === 101 && q2a[1].run_id === 100);
  const q1 = grouped.get('2026-Q1')!;
  assert('[6.6] Q1 仅 strategy_a', q1.size === 1 && q1.has('strategy_a'));
  // 空入参
  assert('[6.7] 空数组 → 空 Map', groupCandidatesByQuarterAndStrategy([]).size === 0);
  assert('[6.8] 非数组 → 空 Map', groupCandidatesByQuarterAndStrategy(null as any).size === 0);
}

// ---- [7] topKCandidates -----------------------------------------------------
{
  const fake = Array.from({ length: 10 }, (_, i) => ({ run_id: i } as any));
  assert('[7.1] default 5', topKCandidates(fake).length === 5);
  assert('[7.2] k=3', topKCandidates(fake, 3).length === 3);
  assert('[7.3] k 超过长度', topKCandidates(fake, 100).length === 10);
  assert('[7.4] k=0 兜底 5', topKCandidates(fake, 0).length === 5);
  assert('[7.5] 空数组', topKCandidates([]).length === 0);
  assert('[7.6] undefined', topKCandidates(undefined).length === 0);
}

// ---- [8] shadow 判定 ---------------------------------------------------------
{
  assert('[8.1] null → false', isShadowStrategy(null) === false);
  assert('[8.2] undefined → false', isShadowStrategy(undefined) === false);
  assert('[8.3] 无 lifecycle_policy → false', isShadowStrategy({ strategy_key: 's' } as any) === false);
  assert('[8.4] dry_run=true → true', isShadowStrategy({ strategy_key: 's', lifecycle_policy: { dry_run: true } } as any) === true);
  assert('[8.5] dry_run=false → false', isShadowStrategy({ strategy_key: 's', lifecycle_policy: { dry_run: false } } as any) === false);
  assert('[8.6] dry_run="true" 字符串 → false (严格)', isShadowStrategy({ strategy_key: 's', lifecycle_policy: { dry_run: 'true' } } as any) === false);

  const strategies = [
    { strategy_key: 's_a', lifecycle_policy: { dry_run: true } } as any,
    { strategy_key: 's_b', lifecycle_policy: { dry_run: false } } as any,
    { strategy_key: 's_c' } as any,
  ];
  assert('[8.7] lookup s_a → shadow', lookupShadowByStrategyName(strategies, 's_a') === true);
  assert('[8.8] lookup s_b → hard', lookupShadowByStrategyName(strategies, 's_b') === false);
  assert('[8.9] lookup s_c → hard', lookupShadowByStrategyName(strategies, 's_c') === false);
  assert('[8.10] lookup 不存在', lookupShadowByStrategyName(strategies, 'unknown') === false);
  assert('[8.11] 空 strategies', lookupShadowByStrategyName([], 'x') === false);
  assert('[8.12] null strategies', lookupShadowByStrategyName(null as any, 'x') === false);
  assert('[8.13] 空 name', lookupShadowByStrategyName(strategies, '') === false);
}

// ---- [9] buildQuarterlyRetrainViewModel -------------------------------------
{
  const now = new Date(Date.UTC(2026, 5, 19)); // 2026-06-19 → Q2
  const runs: any[] = [
    {
      id: 1,
      optimizer_type: 'walk_forward',
      strategy_name: 'strategy_a',
      status: 'completed',
      total_combos: 1,
      completed_combos: 1,
      failed_combos: 0,
      best_result_id: null,
      created_at: '2026-05-10T00:00:00Z',
      started_at: null,
      finished_at: null,
      summary: { dsr: 0.85 } as any,
    },
    {
      id: 2,
      optimizer_type: 'walk_forward',
      strategy_name: 'strategy_b',
      status: 'completed',
      total_combos: 1,
      completed_combos: 1,
      failed_combos: 0,
      best_result_id: null,
      created_at: '2026-05-10T00:00:00Z',
      started_at: null,
      finished_at: null,
      summary: { dsr: 0.5 } as any,
    },
  ];
  const strategies = [
    { strategy_key: 'strategy_a', lifecycle_policy: { dry_run: true } } as any,
    { strategy_key: 'strategy_b', lifecycle_policy: { dry_run: false } } as any,
  ];
  const vm = buildQuarterlyRetrainViewModel({ runs, strategies, now });
  assert('[9.1] quarterOptions 长度=4 默认', vm.quarterOptions.length === DEFAULT_QUARTERS_WINDOW);
  assert('[9.2] quarterOptions 首项=2026-Q2', vm.quarterOptions[0] === '2026-Q2');
  assert('[9.3] totalCandidates=2', vm.totalCandidates === 2);
  assert('[9.4] strategiesInActiveQuarter=2', vm.strategiesInActiveQuarter === 2);
  assert('[9.5] shadowStrategiesInActiveQuarter=1', vm.shadowStrategiesInActiveQuarter === 1);
  const bucket = vm.bucketsByQuarter.get('2026-Q2');
  assert('[9.6] bucket 有 2 个 strategy', bucket?.size === 2);

  // 空数据兜底
  const vmEmpty = buildQuarterlyRetrainViewModel({ runs: null, strategies: null, now });
  assert('[9.7] empty totalCandidates', vmEmpty.totalCandidates === 0);
  assert('[9.8] empty buckets', vmEmpty.bucketsByQuarter.size === 0);
  assert('[9.9] empty shadows', vmEmpty.shadowStrategiesInActiveQuarter === 0);

  // activeQuarter 显式指定
  const vm2 = buildQuarterlyRetrainViewModel({
    runs,
    strategies,
    now,
    activeQuarter: '2025-Q4', // 历史季 — 没数据
  });
  assert('[9.10] 历史 activeQuarter strategies=0', vm2.strategiesInActiveQuarter === 0);
}

// ---- [10] META-GUARD fs+regex -----------------------------------------------
{
  const workspacePath = join(__dirname, '../../../frontend/src/pages/workspace/LabWorkspace.tsx');
  const src = readFileSync(workspacePath, 'utf8');
  assert(
    '[10.1] LabWorkspace.tsx 含 import QuarterlyRetrainTab',
    /import\s+QuarterlyRetrainTab\s+from\s+['"]\.\/LabWorkspace\.QuarterlyRetrainTab['"]/.test(src)
  );
  assert(
    '[10.2] tabs 数组含 key=quarterly_retrain',
    /\{\s*key:\s*['"]quarterly_retrain['"]/.test(src)
  );
  assert(
    '[10.3] activeKey 分支 quarterly_retrain',
    /activeKey\s*===\s*['"]quarterly_retrain['"]/.test(src)
  );
  assert(
    '[10.4] body 渲染 QuarterlyRetrainTab',
    /<QuarterlyRetrainTab/.test(src)
  );
}

{
  const tabPath = join(__dirname, '../../../frontend/src/pages/workspace/LabWorkspace.QuarterlyRetrainTab.tsx');
  const src = readFileSync(tabPath, 'utf8');
  assert(
    '[10.5] tab 组件 import quarterlyRetrainHelpers',
    /from\s+['"]\.\/quarterlyRetrainHelpers['"]/.test(src)
  );
  assert(
    '[10.6] tab 组件调 buildQuarterlyRetrainViewModel',
    /buildQuarterlyRetrainViewModel\(/.test(src)
  );
  assert(
    '[10.7] tab 组件调 lookupShadowByStrategyName',
    /lookupShadowByStrategyName\(/.test(src)
  );
  assert(
    '[10.8] tab 组件含 SHADOW_BADGE_TEXT 引用',
    /SHADOW_BADGE_TEXT/.test(src)
  );
  assert(
    '[10.9] tab 组件含 quarterly-retrain-quarter-select testid',
    /data-testid=['"]quarterly-retrain-quarter-select['"]/.test(src)
  );
  assert(
    '[10.10] tab 组件含 refresh testid',
    /data-testid=['"]quarterly-retrain-refresh['"]/.test(src)
  );
}

{
  const helperPath = join(__dirname, '../../../frontend/src/pages/workspace/quarterlyRetrainHelpers.ts');
  const src = readFileSync(helperPath, 'utf8');
  assert('[10.11] helper export QUARTER_LABELS', /export\s+const\s+QUARTER_LABELS/.test(src));
  assert('[10.12] helper export DEFAULT_QUARTERS_WINDOW', /export\s+const\s+DEFAULT_QUARTERS_WINDOW/.test(src));
  assert('[10.13] helper export DEFAULT_CANDIDATES_PER_BUCKET', /export\s+const\s+DEFAULT_CANDIDATES_PER_BUCKET/.test(src));
  assert('[10.14] helper export getQuarterKey', /export\s+function\s+getQuarterKey/.test(src));
  assert('[10.15] helper export getRecentQuarters', /export\s+function\s+getRecentQuarters/.test(src));
  assert('[10.16] helper export toRetrainCandidate', /export\s+function\s+toRetrainCandidate/.test(src));
  assert('[10.17] helper export groupCandidatesByQuarterAndStrategy', /export\s+function\s+groupCandidatesByQuarterAndStrategy/.test(src));
  assert('[10.18] helper export topKCandidates', /export\s+function\s+topKCandidates/.test(src));
  assert('[10.19] helper export isShadowStrategy', /export\s+function\s+isShadowStrategy/.test(src));
  assert('[10.20] helper export lookupShadowByStrategyName', /export\s+function\s+lookupShadowByStrategyName/.test(src));
  assert('[10.21] helper export buildQuarterlyRetrainViewModel', /export\s+function\s+buildQuarterlyRetrainViewModel/.test(src));
}

// ---- summary ----------------------------------------------------------------
console.log(`\nquarterly-retrain: ${passed} ok / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
