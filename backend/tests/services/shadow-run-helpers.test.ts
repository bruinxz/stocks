/**
 * US-051 [FE-012] LabWorkspace shadow run 区块 单元测试.
 *
 * 不依赖 jest / DB / 网络 / React; 直接跑:
 *   cd backend && npx ts-node --transpile-only tests/services/shadow-run-helpers.test.ts
 *
 * import 自 frontend/src/pages/workspace/shadowRunHelpers.ts (pure helpers, 无 antd/react,
 * ts-node 直接吃). 跨 monorepo 同款 [[quarterly-retrain.test.ts]] / US-049/047/043.
 *
 * 覆盖维度:
 *   [1] 阈值常量 sanity + frozen + 单调
 *   [2] classifyConsistencyLevel 三档边界 + null/NaN
 *   [3] classifyAnalyzerLevel 三档边界 + samples=0 兜底 + "取最差" 链
 *   [4] HEALTH_LEVEL_COLOR / HEALTH_LEVEL_LABEL 完整 + frozen
 *   [5] evaluateShadowPromotionReadiness — ready / 样本不足 / consistency 不达 / analyzer critical / null
 *   [6] buildShadowRunViewModel — happy / null / 排序 / fallback
 *   [7] formatPercent / formatSinceDate 边界
 *   [8] META-GUARD: LabWorkspace.tsx import + tabs 含 key + activeKey 分支; tab 组件 import helper + 主 export; labService.ts 含 getAnalysisEngineShadowStats
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  CONSISTENCY_HEALTHY_MIN,
  CONSISTENCY_DEGRADED_MIN,
  ERROR_RATE_CRITICAL,
  ERROR_RATE_DEGRADED,
  CONFIDENCE_HEALTHY_MIN,
  CONFIDENCE_DEGRADED_MIN,
  DATA_MISSING_HEALTHY_MAX,
  DATA_MISSING_DEGRADED_MAX,
  PROMOTE_HARD_MIN_SAMPLES,
  DEFAULT_SINCE_DAYS,
  HEALTH_LEVEL_COLOR,
  HEALTH_LEVEL_LABEL,
  classifyConsistencyLevel,
  classifyAnalyzerLevel,
  evaluateShadowPromotionReadiness,
  buildShadowRunViewModel,
  formatPercent,
  formatSinceDate,
  ShadowStatsResponse,
} from '../../../frontend/src/pages/workspace/shadowRunHelpers';

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

// ---- [1] 阈值常量 sanity ---------------------------------------------------
{
  assert('[1.1] CONSISTENCY_HEALTHY_MIN > CONSISTENCY_DEGRADED_MIN', CONSISTENCY_HEALTHY_MIN > CONSISTENCY_DEGRADED_MIN);
  assert('[1.2] ERROR_RATE_CRITICAL > ERROR_RATE_DEGRADED', ERROR_RATE_CRITICAL > ERROR_RATE_DEGRADED);
  assert('[1.3] CONFIDENCE_HEALTHY_MIN > CONFIDENCE_DEGRADED_MIN', CONFIDENCE_HEALTHY_MIN > CONFIDENCE_DEGRADED_MIN);
  assert('[1.4] DATA_MISSING_HEALTHY_MAX < DATA_MISSING_DEGRADED_MAX', DATA_MISSING_HEALTHY_MAX < DATA_MISSING_DEGRADED_MAX);
  assert('[1.5] PROMOTE_HARD_MIN_SAMPLES >= 10', PROMOTE_HARD_MIN_SAMPLES >= 10);
  assert('[1.6] DEFAULT_SINCE_DAYS >= 1', DEFAULT_SINCE_DAYS >= 1);
  assert('[1.7] CONSISTENCY_HEALTHY_MIN ∈ (0,1]', CONSISTENCY_HEALTHY_MIN > 0 && CONSISTENCY_HEALTHY_MIN <= 1);
  assert('[1.8] HEALTH_LEVEL_COLOR frozen', Object.isFrozen(HEALTH_LEVEL_COLOR));
  assert('[1.9] HEALTH_LEVEL_LABEL frozen', Object.isFrozen(HEALTH_LEVEL_LABEL));
}

// ---- [2] classifyConsistencyLevel -------------------------------------------
{
  assert('[2.1] 0.9 → healthy', classifyConsistencyLevel(0.9) === 'healthy');
  assert('[2.2] CONSISTENCY_HEALTHY_MIN 恰好 → healthy', classifyConsistencyLevel(CONSISTENCY_HEALTHY_MIN) === 'healthy');
  assert('[2.3] 0.75 → degraded', classifyConsistencyLevel(0.75) === 'degraded');
  assert('[2.4] CONSISTENCY_DEGRADED_MIN 恰好 → degraded', classifyConsistencyLevel(CONSISTENCY_DEGRADED_MIN) === 'degraded');
  assert('[2.5] 0.5 → critical', classifyConsistencyLevel(0.5) === 'critical');
  assert('[2.6] 0 → critical', classifyConsistencyLevel(0) === 'critical');
  assert('[2.7] null → unknown', classifyConsistencyLevel(null) === 'unknown');
  assert('[2.8] undefined → unknown', classifyConsistencyLevel(undefined) === 'unknown');
  assert('[2.9] NaN → unknown', classifyConsistencyLevel(Number.NaN) === 'unknown');
  assert('[2.10] Infinity → unknown', classifyConsistencyLevel(Number.POSITIVE_INFINITY) === 'unknown');
}

// ---- [3] classifyAnalyzerLevel ----------------------------------------------
{
  // healthy
  assert(
    '[3.1] healthy all-good',
    classifyAnalyzerLevel({
      key: 'a',
      samples: 100,
      error_rate: 0.01,
      mean_confidence: 0.8,
      data_missing_rate: 0.3,
    }) === 'healthy'
  );
  // error_rate degraded
  assert(
    '[3.2] error_rate degraded',
    classifyAnalyzerLevel({
      key: 'a',
      samples: 100,
      error_rate: ERROR_RATE_DEGRADED,
      mean_confidence: 0.8,
      data_missing_rate: 0.3,
    }) === 'degraded'
  );
  // error_rate critical
  assert(
    '[3.3] error_rate critical',
    classifyAnalyzerLevel({
      key: 'a',
      samples: 100,
      error_rate: ERROR_RATE_CRITICAL,
      mean_confidence: 0.8,
      data_missing_rate: 0.3,
    }) === 'critical'
  );
  // confidence degraded
  assert(
    '[3.4] confidence degraded',
    classifyAnalyzerLevel({
      key: 'a',
      samples: 100,
      error_rate: 0.01,
      mean_confidence: 0.5,
      data_missing_rate: 0.3,
    }) === 'degraded'
  );
  // confidence critical
  assert(
    '[3.5] confidence critical',
    classifyAnalyzerLevel({
      key: 'a',
      samples: 100,
      error_rate: 0.01,
      mean_confidence: 0.3,
      data_missing_rate: 0.3,
    }) === 'critical'
  );
  // data missing degraded
  assert(
    '[3.6] data_missing degraded',
    classifyAnalyzerLevel({
      key: 'a',
      samples: 100,
      error_rate: 0.01,
      mean_confidence: 0.8,
      data_missing_rate: 2.0,
    }) === 'degraded'
  );
  // data missing critical
  assert(
    '[3.7] data_missing critical',
    classifyAnalyzerLevel({
      key: 'a',
      samples: 100,
      error_rate: 0.01,
      mean_confidence: 0.8,
      data_missing_rate: 5.0,
    }) === 'critical'
  );
  // 取最差 — error healthy + confidence critical → critical
  assert(
    '[3.8] 取最差 critical 主导 degraded',
    classifyAnalyzerLevel({
      key: 'a',
      samples: 100,
      error_rate: 0.01,
      mean_confidence: 0.3,
      data_missing_rate: 2.0,
    }) === 'critical'
  );
  // samples=0 → unknown
  assert(
    '[3.9] samples=0 → unknown',
    classifyAnalyzerLevel({
      key: 'a',
      samples: 0,
      error_rate: 0.5,
      mean_confidence: 0,
      data_missing_rate: 10,
    }) === 'unknown'
  );
  // null → unknown
  assert('[3.10] null → unknown', classifyAnalyzerLevel(null) === 'unknown');
  assert('[3.11] undefined → unknown', classifyAnalyzerLevel(undefined) === 'unknown');
}

// ---- [4] HEALTH_LEVEL_COLOR / LABEL 完整性 ----------------------------------
{
  const keys: Array<'healthy' | 'degraded' | 'critical' | 'unknown'> = [
    'healthy',
    'degraded',
    'critical',
    'unknown',
  ];
  keys.forEach(k => {
    assert(`[4.1.${k}] COLOR 有 ${k}`, typeof HEALTH_LEVEL_COLOR[k] === 'string' && HEALTH_LEVEL_COLOR[k].length > 0);
    assert(`[4.2.${k}] LABEL 有 ${k}`, typeof HEALTH_LEVEL_LABEL[k] === 'string' && HEALTH_LEVEL_LABEL[k].length > 0);
  });
  assert('[4.3] healthy color = green', HEALTH_LEVEL_COLOR.healthy === 'green');
  assert('[4.4] critical color = red', HEALTH_LEVEL_COLOR.critical === 'red');
}

// ---- [5] evaluateShadowPromotionReadiness ------------------------------------
{
  // ready happy
  const happy: ShadowStatsResponse = {
    since: '2026-06-12',
    total_shadow_reports: PROMOTE_HARD_MIN_SAMPLES + 100,
    consistency_rate: { buy_class: 0.9, sell_class: 0.88, hold_class: 0.92, overall: 0.9 },
    analyzer_health: [
      { key: 'a', samples: 100, error_rate: 0.01, mean_confidence: 0.8, data_missing_rate: 0.3 },
    ],
    forward_return_5d: { samples: 80, mean_pct: 1.2 },
  };
  const rHappy = evaluateShadowPromotionReadiness(happy);
  assert('[5.1] happy ready=true', rHappy.ready === true);
  assert('[5.2] happy blockers empty', rHappy.blockers.length === 0);
  assert('[5.3] happy level=healthy', rHappy.level === 'healthy');

  // 样本不足
  const fewSamples: ShadowStatsResponse = {
    ...happy,
    total_shadow_reports: 10,
  };
  const rFew = evaluateShadowPromotionReadiness(fewSamples);
  assert('[5.4] 样本不足 ready=false', rFew.ready === false);
  assert('[5.5] 样本不足 含原因', rFew.blockers.some(b => /样本量/.test(b)));

  // overall 不达 + buy 严重低
  const badConsistency: ShadowStatsResponse = {
    ...happy,
    consistency_rate: { buy_class: 0.5, sell_class: 0.9, hold_class: 0.9, overall: 0.6 },
  };
  const rBad = evaluateShadowPromotionReadiness(badConsistency);
  assert('[5.6] bad consistency ready=false', rBad.ready === false);
  assert('[5.7] bad consistency 含 overall + buy', rBad.blockers.length >= 2);
  assert('[5.8] bad consistency level=critical', rBad.level === 'critical');

  // analyzer critical
  const criticalAnalyzer: ShadowStatsResponse = {
    ...happy,
    analyzer_health: [
      { key: 'fund', samples: 100, error_rate: 0.5, mean_confidence: 0.8, data_missing_rate: 0.3 },
    ],
  };
  const rAnz = evaluateShadowPromotionReadiness(criticalAnalyzer);
  assert('[5.9] analyzer critical ready=false', rAnz.ready === false);
  assert('[5.10] analyzer critical 含 fund', rAnz.blockers.some(b => /fund/.test(b)));
  assert('[5.11] analyzer critical level=critical', rAnz.level === 'critical');

  // 仅 degraded — overall 0.83 在 healthy 下面但 degraded 上面
  const degradedOnly: ShadowStatsResponse = {
    ...happy,
    consistency_rate: { buy_class: 0.8, sell_class: 0.8, hold_class: 0.85, overall: 0.83 },
  };
  const rDeg = evaluateShadowPromotionReadiness(degradedOnly);
  assert('[5.12] degraded only ready=false', rDeg.ready === false);
  assert('[5.13] degraded only level=degraded', rDeg.level === 'degraded');

  // null
  const rNull = evaluateShadowPromotionReadiness(null);
  assert('[5.14] null ready=false', rNull.ready === false);
  assert('[5.15] null blockers >=1', rNull.blockers.length >= 1);
  assert('[5.16] null level=unknown', rNull.level === 'unknown');
}

// ---- [6] buildShadowRunViewModel --------------------------------------------
{
  const sample: ShadowStatsResponse = {
    since: '2026-06-12',
    total_shadow_reports: 123,
    consistency_rate: { buy_class: 0.9, sell_class: 0.88, hold_class: 0.92, overall: 0.9 },
    analyzer_health: [
      { key: 'tech', samples: 100, error_rate: 0.5, mean_confidence: 0.3, data_missing_rate: 5 }, // critical
      { key: 'fund', samples: 100, error_rate: 0.01, mean_confidence: 0.8, data_missing_rate: 0.3 }, // healthy
      { key: 'macro', samples: 100, error_rate: 0.06, mean_confidence: 0.7, data_missing_rate: 0.5 }, // degraded (error_rate=0.06>=0.05)
    ],
    forward_return_5d: { samples: 50, mean_pct: 1.5 },
  };
  const vm = buildShadowRunViewModel(sample);
  assert('[6.1] vm.since 透传', vm.since === '2026-06-12');
  assert('[6.2] vm.totalShadowReports', vm.totalShadowReports === 123);
  assert('[6.3] vm.consistencyLevel = healthy', vm.consistencyLevel === 'healthy');
  assert('[6.4] vm.analyzers 长度 3', vm.analyzers.length === 3);
  // 排序: critical -> degraded -> healthy
  assert('[6.5] sort[0] = tech (critical)', vm.analyzers[0].key === 'tech');
  assert('[6.6] sort[0].level = critical', vm.analyzers[0].level === 'critical');
  assert('[6.7] sort[1] = macro (degraded)', vm.analyzers[1].key === 'macro');
  assert('[6.8] sort[1].level = degraded', vm.analyzers[1].level === 'degraded');
  assert('[6.9] sort[2] = fund (healthy)', vm.analyzers[2].key === 'fund');
  assert('[6.10] sort[2].level = healthy', vm.analyzers[2].level === 'healthy');
  // promotion 应是 critical (因 tech analyzer)
  assert('[6.11] promotion.ready=false', vm.promotion.ready === false);
  assert('[6.12] promotion.level=critical', vm.promotion.level === 'critical');
  assert('[6.13] forwardReturn 透传', vm.forwardReturn.mean_pct === 1.5);

  // null/undefined 安全
  const vmNull = buildShadowRunViewModel(null);
  assert('[6.14] null vm.since=""', vmNull.since === '');
  assert('[6.15] null vm.totalShadowReports=0', vmNull.totalShadowReports === 0);
  assert('[6.16] null vm.analyzers=[]', vmNull.analyzers.length === 0);
  assert('[6.17] null vm.consistencyLevel=unknown', vmNull.consistencyLevel === 'unknown');
  assert('[6.18] null vm.promotion.ready=false', vmNull.promotion.ready === false);
  assert('[6.19] null vm.consistency 默认 0', vmNull.consistency.overall === 0);
  assert('[6.20] null vm.forwardReturn.mean_pct=null', vmNull.forwardReturn.mean_pct === null);

  // 空 analyzer_health 数组也安全
  const vmEmpty = buildShadowRunViewModel({
    ...sample,
    analyzer_health: [],
  });
  assert('[6.21] 空 analyzer_health vm.analyzers=[]', vmEmpty.analyzers.length === 0);
  // 全 healthy + 样本足: promotion.ready=true
  const vmReady = buildShadowRunViewModel({
    ...sample,
    analyzer_health: [
      { key: 'a', samples: 100, error_rate: 0.01, mean_confidence: 0.8, data_missing_rate: 0.3 },
    ],
  });
  assert('[6.22] vmReady promotion.ready=true', vmReady.promotion.ready === true);
  assert('[6.23] vmReady promotion.level=healthy', vmReady.promotion.level === 'healthy');

  // 无效项被过滤
  const vmDirty = buildShadowRunViewModel({
    ...sample,
    // @ts-expect-error — 故意塞脏数据
    analyzer_health: [null, undefined, { key: '', samples: 0 }, { key: 'ok', samples: 10, error_rate: 0, mean_confidence: 0.9, data_missing_rate: 0 }],
  });
  // 仅 'ok' (key 非空) 留下
  assert('[6.24] dirty filter 仅留 1 个', vmDirty.analyzers.length === 1);
  assert('[6.25] dirty filter key=ok', vmDirty.analyzers[0].key === 'ok');
}

// ---- [7] formatPercent / formatSinceDate ------------------------------------
{
  assert('[7.1] formatPercent 0.5 → "50.0%"', formatPercent(0.5) === '50.0%');
  assert('[7.2] formatPercent 0 → "0.0%"', formatPercent(0) === '0.0%');
  assert('[7.3] formatPercent 1 → "100.0%"', formatPercent(1) === '100.0%');
  assert('[7.4] formatPercent null → "—"', formatPercent(null) === '—');
  assert('[7.5] formatPercent undefined → "—"', formatPercent(undefined) === '—');
  assert('[7.6] formatPercent NaN → "—"', formatPercent(Number.NaN) === '—');
  assert('[7.7] formatPercent digits=2', formatPercent(0.1234, 2) === '12.34%');

  // formatSinceDate: 固定 now 算 daysAgo
  const fixedNow = new Date(Date.UTC(2026, 5, 20)); // 2026-06-20 UTC
  assert('[7.8] formatSinceDate now-7 → 2026-06-13', formatSinceDate(fixedNow, 7) === '2026-06-13');
  assert('[7.9] formatSinceDate now-1 → 2026-06-19', formatSinceDate(fixedNow, 1) === '2026-06-19');
  assert('[7.10] formatSinceDate now-30 → 2026-05-21', formatSinceDate(fixedNow, 30) === '2026-05-21');
  // 非法
  assert('[7.11] formatSinceDate 非法 Date → ""', formatSinceDate(new Date('invalid'), 7) === '');
  // 默认天数
  const defaultStr = formatSinceDate(fixedNow);
  assert(
    '[7.12] formatSinceDate 默认 DEFAULT_SINCE_DAYS',
    defaultStr === formatSinceDate(fixedNow, DEFAULT_SINCE_DAYS)
  );
  // 边界 — daysAgo<1 clamp 到 1
  assert('[7.13] daysAgo=0 clamp 到 1', formatSinceDate(fixedNow, 0) === '2026-06-19');
  // 边界 — 巨大 daysAgo clamp 到 365
  const lo = formatSinceDate(fixedNow, 10000);
  assert('[7.14] 巨大 daysAgo clamp 到 365', lo === formatSinceDate(fixedNow, 365));
}

// ---- [8] META-GUARD fs+regex ------------------------------------------------
{
  const workspacePath = join(__dirname, '../../../frontend/src/pages/workspace/LabWorkspace.tsx');
  const src = readFileSync(workspacePath, 'utf8');
  assert(
    '[8.1] LabWorkspace.tsx 含 import ShadowRunTab',
    /import\s+ShadowRunTab\s+from\s+['"]\.\/LabWorkspace\.ShadowRunTab['"]/.test(src)
  );
  assert(
    '[8.2] tabs 数组含 key=shadow_run',
    /\{\s*key:\s*['"]shadow_run['"]/.test(src)
  );
  assert(
    '[8.3] activeKey 分支 shadow_run',
    /activeKey\s*===\s*['"]shadow_run['"]/.test(src)
  );
  assert('[8.4] body 渲染 ShadowRunTab', /<ShadowRunTab\s*\/>/.test(src));
}

{
  const tabPath = join(__dirname, '../../../frontend/src/pages/workspace/LabWorkspace.ShadowRunTab.tsx');
  const src = readFileSync(tabPath, 'utf8');
  assert(
    '[8.5] tab 组件 import shadowRunHelpers',
    /from\s+['"]\.\/shadowRunHelpers['"]/.test(src)
  );
  assert('[8.6] tab 组件调 buildShadowRunViewModel', /buildShadowRunViewModel\(/.test(src));
  assert(
    '[8.7] tab 组件调 labService.getAnalysisEngineShadowStats',
    /labService\.getAnalysisEngineShadowStats\(/.test(src)
  );
  assert(
    '[8.8] tab 组件含 shadow-run-refresh testid',
    /data-testid=['"]shadow-run-refresh['"]/.test(src)
  );
  assert(
    '[8.9] tab 组件含 shadow-run-since-picker testid',
    /data-testid=['"]shadow-run-since-picker['"]/.test(src)
  );
  assert(
    '[8.10] tab 组件含 shadow-run-promotion-alert testid',
    /data-testid=['"]shadow-run-promotion-alert['"]/.test(src)
  );
  assert(
    '[8.11] tab 组件含 HEALTH_LEVEL_COLOR 引用',
    /HEALTH_LEVEL_COLOR/.test(src)
  );
}

{
  const helperPath = join(__dirname, '../../../frontend/src/pages/workspace/shadowRunHelpers.ts');
  const src = readFileSync(helperPath, 'utf8');
  assert('[8.12] helper export buildShadowRunViewModel', /export\s+function\s+buildShadowRunViewModel/.test(src));
  assert(
    '[8.13] helper export classifyAnalyzerLevel',
    /export\s+function\s+classifyAnalyzerLevel/.test(src)
  );
  assert(
    '[8.14] helper export evaluateShadowPromotionReadiness',
    /export\s+function\s+evaluateShadowPromotionReadiness/.test(src)
  );
  assert(
    '[8.15] helper export CONSISTENCY_HEALTHY_MIN',
    /export\s+const\s+CONSISTENCY_HEALTHY_MIN/.test(src)
  );
  assert(
    '[8.16] helper export PROMOTE_HARD_MIN_SAMPLES',
    /export\s+const\s+PROMOTE_HARD_MIN_SAMPLES/.test(src)
  );
}

{
  const labSvcPath = join(__dirname, '../../../frontend/src/services/labService.ts');
  const src = readFileSync(labSvcPath, 'utf8');
  assert(
    '[8.17] labService 含 getAnalysisEngineShadowStats 函数',
    /export\s+async\s+function\s+getAnalysisEngineShadowStats/.test(src)
  );
  assert(
    '[8.18] labService.getAnalysisEngineShadowStats 注册到 bundle',
    /getAnalysisEngineShadowStats,?\s*\n\s*\}/.test(src) ||
      /getAnalysisEngineShadowStats,/.test(src)
  );
  assert(
    '[8.19] labService 调 /admin/analysis-engine/shadow-stats',
    /['"]\/admin\/analysis-engine\/shadow-stats['"]/.test(src)
  );
  // 兼容 success / ok 两路 envelope (因为后端 shadow controller 用 ok=true 不是 success=true)
  assert(
    '[8.20] labService 兼容 ok=true envelope',
    /envelope\.ok/.test(src)
  );
}

// ---- summary ----
setTimeout(() => {
  console.log(`\n=== shadow-run-helpers.test.ts ===`);
  console.log(`✅ ${passed} ok / ❌ ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}, 100);
