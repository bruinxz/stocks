/**
 * US-067 [FE-028] SettingsWorkspace AI 引擎 8 dim 权重 slider — 单元测试.
 *
 * 跑法 (项目无 jest, 直接 ts-node spawn):
 *   cd backend && npx ts-node --transpile-only tests/services/analysis-engine-weight-helpers.test.ts
 * 或
 *   cd backend && npm test -- --filter=analysis-engine-weight
 *
 * 跨 monorepo import (../../../frontend) 跟 factor-ai-weight / shadow-run /
 * overfit-metrics 等 [[前端 pure helper 模板]] 同款 — pure helpers, 无
 * antd/react 依赖, ts-node --transpile-only 直接吃.
 *
 * 覆盖维度:
 *   [1] ANALYZER_DIMENSIONS 形态 (frozen / 长度=8 / 默认值 sum=100 / key 与
 *       backend AnalyzerKey 集合一致)
 *   [2] DEFAULT_ANALYZER_WEIGHTS_PERCENT 与后端 DEFAULT_ANALYZER_WEIGHTS ×100 等价
 *   [3] clampPercent 边界 (NaN/负数/超 MAX/取 fallback)
 *   [4] ensureAllPercents 补默认 / null / 非 object / 部分键
 *   [5] ratioToPercents 启发: ratio(sum≈1) vs percent(sum≈100) 自动识别
 *   [6] normalizeWeightsForSave: 空 / 全 0 / 单 dim 独占 / 多 dim 等比例 / sum=1.0
 *   [7] sumPercents + pickSumStatusColor 三段色
 *   [8] resetToDefaults 返新对象 (不复用 frozen 常量) + 8 key 完整
 *   [9] getDefaultPercent
 *  [10] META-GUARD fs+regex:
 *       - SettingsWorkspace.AnalysisEngineTab.tsx: import helper + Slider/InputNumber
 *         data-testid + sum tag + 恢复默认按钮 + save 调 normalizeWeightsForSave
 *       - analysisEngineWeightHelpers.ts: 关键 export 全在
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  ANALYZER_DIMENSIONS,
  ANALYZER_WEIGHT_MAX_PERCENT,
  ANALYZER_WEIGHT_MIN_PERCENT,
  DEFAULT_ANALYZER_WEIGHTS_PERCENT,
  WEIGHT_SUM_OK_MAX_PERCENT,
  WEIGHT_SUM_OK_MIN_PERCENT,
  clampPercent,
  ensureAllPercents,
  getDefaultPercent,
  normalizeWeightsForSave,
  pickSumStatusColor,
  ratioToPercents,
  resetToDefaults,
  sumPercents,
  type AnalyzerKey,
} from '../../../frontend/src/pages/workspace/analysisEngineWeightHelpers';

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

function approx(a: number, b: number, eps = 1e-9): boolean {
  return Math.abs(a - b) <= eps;
}

// ============================================================
// [1] ANALYZER_DIMENSIONS 形态
// ============================================================
const EXPECTED_KEYS: AnalyzerKey[] = [
  'fundamental',
  'technical',
  'capital',
  'sentiment',
  'news',
  'industry_regime',
  'risk',
  'event',
];
assert('[1.1] ANALYZER_DIMENSIONS 长度=8', ANALYZER_DIMENSIONS.length === 8);
assert(
  '[1.2] ANALYZER_DIMENSIONS 顺序与默认权重从大到小一致',
  ANALYZER_DIMENSIONS.map(d => d.key).join(',') === EXPECTED_KEYS.join(',')
);
assert(
  '[1.3] ANALYZER_DIMENSIONS 每项 frozen',
  ANALYZER_DIMENSIONS.every(d => Object.isFrozen(d))
);
assert('[1.4] ANALYZER_DIMENSIONS 整体 frozen', Object.isFrozen(ANALYZER_DIMENSIONS));
assert(
  '[1.5] ANALYZER_DIMENSIONS 默认权重 sum=100',
  ANALYZER_DIMENSIONS.reduce((acc, d) => acc + d.defaultPercent, 0) === 100
);
assert(
  '[1.6] ANALYZER_DIMENSIONS 每项含 label/hint 非空',
  ANALYZER_DIMENSIONS.every(d => typeof d.label === 'string' && d.label.length > 0 && d.hint.length > 0)
);

// ============================================================
// [2] DEFAULT_ANALYZER_WEIGHTS_PERCENT 与 backend × 100 一致
// ============================================================
const BACKEND_DEFAULT_RATIOS: Record<AnalyzerKey, number> = {
  fundamental: 0.25,
  technical: 0.2,
  capital: 0.15,
  sentiment: 0.1,
  news: 0.1,
  industry_regime: 0.1,
  risk: 0.05,
  event: 0.05,
};
assert(
  '[2.1] DEFAULT_ANALYZER_WEIGHTS_PERCENT frozen',
  Object.isFrozen(DEFAULT_ANALYZER_WEIGHTS_PERCENT)
);
for (const key of EXPECTED_KEYS) {
  assert(
    `[2.2.${key}] DEFAULT_PERCENT[${key}] = backend ratio × 100`,
    DEFAULT_ANALYZER_WEIGHTS_PERCENT[key] === Math.round(BACKEND_DEFAULT_RATIOS[key] * 100),
    `got ${DEFAULT_ANALYZER_WEIGHTS_PERCENT[key]} expected ${BACKEND_DEFAULT_RATIOS[key] * 100}`
  );
}
assert(
  '[2.3] DEFAULT_ANALYZER_WEIGHTS_PERCENT sum=100',
  EXPECTED_KEYS.reduce((acc, k) => acc + DEFAULT_ANALYZER_WEIGHTS_PERCENT[k], 0) === 100
);
assert(
  '[2.4] MIN/MAX/OK_MIN/OK_MAX 常量 sanity',
  ANALYZER_WEIGHT_MIN_PERCENT === 0 &&
    ANALYZER_WEIGHT_MAX_PERCENT === 60 &&
    WEIGHT_SUM_OK_MIN_PERCENT === 95 &&
    WEIGHT_SUM_OK_MAX_PERCENT === 105
);

// ============================================================
// [3] clampPercent 边界
// ============================================================
assert('[3.1] clamp 正常值', clampPercent(20) === 20);
assert('[3.2] clamp 0 取 0', clampPercent(0) === 0);
assert('[3.3] clamp 超 MAX 截顶', clampPercent(99) === ANALYZER_WEIGHT_MAX_PERCENT);
assert('[3.4] clamp 负数截到 MIN', clampPercent(-5) === ANALYZER_WEIGHT_MIN_PERCENT);
assert('[3.5] clamp NaN 取 fallback', clampPercent(NaN, 25) === 25);
assert('[3.6] clamp Infinity 取 fallback', clampPercent(Infinity, 25) === 25);
assert('[3.7] clamp 边界值', clampPercent(ANALYZER_WEIGHT_MAX_PERCENT) === ANALYZER_WEIGHT_MAX_PERCENT);

// ============================================================
// [4] ensureAllPercents
// ============================================================
{
  const r = ensureAllPercents(null);
  assert('[4.1] ensureAllPercents(null) 返默认全 8 key', EXPECTED_KEYS.every(k => r[k] === DEFAULT_ANALYZER_WEIGHTS_PERCENT[k]));
  // 改默认对象 不会污染
  r.fundamental = 99;
  assert('[4.2] ensureAllPercents 返副本可 mutate', r.fundamental === 99);
  assert('[4.3] 原默认未被污染', DEFAULT_ANALYZER_WEIGHTS_PERCENT.fundamental === 25);
}
{
  const r = ensureAllPercents(undefined);
  assert('[4.4] undefined 返默认', r.fundamental === 25 && r.event === 5);
}
{
  const r = ensureAllPercents('not-object' as any);
  assert('[4.5] 非 object 返默认', r.fundamental === 25);
}
{
  const r = ensureAllPercents({ fundamental: 30, news: NaN, event: -10 } as any);
  assert('[4.6] 部分键覆盖, 其它走默认', r.fundamental === 30 && r.technical === 20);
  assert('[4.7] NaN 跳过用默认', r.news === 10);
  assert('[4.8] 负数跳过用默认 (而非 clamp 到 0)', r.event === 5);
}
{
  const r = ensureAllPercents({ fundamental: 999 } as any);
  // 999 ≥ 0 且 finite → 进 clampPercent → MAX
  assert('[4.9] 超 MAX 钳到 MAX', r.fundamental === ANALYZER_WEIGHT_MAX_PERCENT);
}

// ============================================================
// [5] ratioToPercents 启发
// ============================================================
{
  const ratios = { fundamental: 0.25, technical: 0.2, capital: 0.15, sentiment: 0.1, news: 0.1, industry_regime: 0.1, risk: 0.05, event: 0.05 };
  const r = ratioToPercents(ratios);
  assert('[5.1] ratio (sum=1) → percent (sum=100)', r.fundamental === 25 && r.event === 5);
}
{
  // 用户已经存的 percent (sum=100) — 不应再 ×100
  const pct = { fundamental: 25, technical: 20, capital: 15, sentiment: 10, news: 10, industry_regime: 10, risk: 5, event: 5 };
  const r = ratioToPercents(pct);
  assert('[5.2] percent (sum=100) 直接用, 不再 ×100', r.fundamental === 25);
}
{
  const r = ratioToPercents(null);
  assert('[5.3] null → 默认', r.fundamental === 25);
}
{
  const r = ratioToPercents({} as any);
  assert('[5.4] 空对象 (total=0) → 默认', r.fundamental === 25);
}
{
  // 部分 ratio (3 个 dim) — 总和 ≤ 2, isRatio=true
  const r = ratioToPercents({ fundamental: 0.5, technical: 0.5 } as any);
  assert('[5.5] 部分 ratio fundamental 0.5 → 50%', r.fundamental === 50);
  assert('[5.6] 未提供 key 走默认', r.capital === 15);
}

// ============================================================
// [6] normalizeWeightsForSave
// ============================================================
{
  const r = normalizeWeightsForSave(null);
  let sum = 0;
  for (const k of EXPECTED_KEYS) sum += r[k];
  assert('[6.1] null → 默认 ratio sum=1', approx(sum, 1));
  assert('[6.2] null → fundamental=0.25', approx(r.fundamental, 0.25));
}
{
  const r = normalizeWeightsForSave({});
  // 全 0 → 默认
  assert('[6.3] empty 走默认 sum=1', approx(EXPECTED_KEYS.reduce((a, k) => a + r[k], 0), 1));
}
{
  const r = normalizeWeightsForSave({ fundamental: 0, technical: 0, capital: 0, sentiment: 0, news: 0, industry_regime: 0, risk: 0, event: 0 });
  assert('[6.4] 全 0 → 默认', approx(r.fundamental, 0.25));
}
{
  // 单 dim 独占
  const r = normalizeWeightsForSave({ fundamental: 100 } as any);
  assert('[6.5] 单 dim 独占 sum=1, fundamental=1.0', approx(r.fundamental, 1) && approx(r.event, 0));
}
{
  // 多 dim 等比例
  const r = normalizeWeightsForSave({ fundamental: 50, technical: 50 } as any);
  assert('[6.6] 双 dim 等比例', approx(r.fundamental, 0.5) && approx(r.technical, 0.5));
  let s = 0;
  for (const k of EXPECTED_KEYS) s += r[k];
  assert('[6.7] 多 dim 归一化 sum=1', approx(s, 1));
}
{
  // 8 dim 各 25 — 各 1/8
  const eq: Partial<Record<AnalyzerKey, number>> = {};
  for (const k of EXPECTED_KEYS) eq[k] = 25;
  const r = normalizeWeightsForSave(eq);
  for (const k of EXPECTED_KEYS) {
    assert(`[6.8.${k}] 8 dim 等权 → 0.125`, approx(r[k], 1 / 8));
  }
}
{
  // 含 NaN/负数 → 视为 0
  const r = normalizeWeightsForSave({ fundamental: NaN, technical: -5, capital: 10 } as any);
  assert('[6.9] NaN 视为 0, 唯一有效=10 → capital=1', approx(r.capital, 1));
  assert('[6.10] NaN dim → 0', r.fundamental === 0);
  assert('[6.11] 负数 dim → 0', r.technical === 0);
}

// ============================================================
// [7] sumPercents + pickSumStatusColor
// ============================================================
{
  assert('[7.1] sumPercents 默认 = 100', sumPercents(DEFAULT_ANALYZER_WEIGHTS_PERCENT) === 100);
  assert('[7.2] sumPercents 空对象 = 0', sumPercents({}) === 0);
  assert('[7.3] sumPercents 半数 = 50', sumPercents({ fundamental: 25, technical: 25 } as any) === 50);
  assert('[7.4] sumPercents NaN 跳过', sumPercents({ fundamental: NaN, technical: 10 } as any) === 10);
}
{
  assert('[7.5] sum=100 → success', pickSumStatusColor(100) === 'success');
  assert('[7.6] sum=95 → success', pickSumStatusColor(95) === 'success');
  assert('[7.7] sum=105 → success', pickSumStatusColor(105) === 'success');
  assert('[7.8] sum=94.9 → warning', pickSumStatusColor(94.9) === 'warning');
  assert('[7.9] sum=130 → warning', pickSumStatusColor(130) === 'warning');
  assert('[7.10] sum=131 → error', pickSumStatusColor(131) === 'error');
  assert('[7.11] sum=0 → error', pickSumStatusColor(0) === 'error');
  assert('[7.12] sum=NaN → error', pickSumStatusColor(NaN) === 'error');
}

// ============================================================
// [8] resetToDefaults
// ============================================================
{
  const r = resetToDefaults();
  assert('[8.1] resetToDefaults 含 8 key', EXPECTED_KEYS.every(k => r[k] === DEFAULT_ANALYZER_WEIGHTS_PERCENT[k]));
  r.fundamental = 99;
  assert('[8.2] 返新对象, mutate 不影响默认', r.fundamental === 99 && DEFAULT_ANALYZER_WEIGHTS_PERCENT.fundamental === 25);
  const r2 = resetToDefaults();
  assert('[8.3] 连续 reset 返新对象', r2 !== r && r2.fundamental === 25);
}

// ============================================================
// [9] getDefaultPercent
// ============================================================
assert('[9.1] getDefaultPercent fundamental = 25', getDefaultPercent('fundamental') === 25);
assert('[9.2] getDefaultPercent event = 5', getDefaultPercent('event') === 5);
assert('[9.3] getDefaultPercent capital = 15', getDefaultPercent('capital') === 15);

// ============================================================
// [10] META-GUARD fs+regex 守护 component / helper 接入与 export 完整性
// ============================================================
{
  const componentSrc = readFileSync(
    join(__dirname, '../../../frontend/src/pages/workspace/SettingsWorkspace.AnalysisEngineTab.tsx'),
    'utf-8'
  );
  // 必须 import 至少一组 helper
  assert(
    '[10.1] AnalysisEngineTab 必须 import analysisEngineWeightHelpers',
    /from\s+['"]\.\/analysisEngineWeightHelpers['"]/.test(componentSrc)
  );
  assert('[10.2] 必须 import ANALYZER_DIMENSIONS', /ANALYZER_DIMENSIONS/.test(componentSrc));
  assert(
    '[10.3] 必须 import normalizeWeightsForSave (保存路径)',
    /normalizeWeightsForSave/.test(componentSrc)
  );
  assert(
    '[10.4] 必须 import ensureAllPercents / ratioToPercents (load 路径)',
    /ensureAllPercents/.test(componentSrc) && /ratioToPercents/.test(componentSrc)
  );
  assert(
    '[10.5] 必须 import resetToDefaults (恢复默认按钮)',
    /resetToDefaults/.test(componentSrc)
  );
  // UI 渲染
  assert(
    '[10.6] 必须用 antd Slider 控件',
    /import\s+\{[^}]*\bSlider\b/.test(componentSrc) || /from\s+['"]antd['"]/.test(componentSrc)
  );
  assert(
    '[10.7] 必须用 antd InputNumber 控件',
    /InputNumber/.test(componentSrc)
  );
  assert(
    '[10.8] 必须有 8 dim 渲染 (ANALYZER_DIMENSIONS.map)',
    /ANALYZER_DIMENSIONS\.map/.test(componentSrc)
  );
  assert(
    '[10.9] 必须有 data-testid="ae-weight-sum-tag" (UI 守护)',
    /ae-weight-sum-tag/.test(componentSrc)
  );
  assert(
    '[10.10] 必须有 "恢复默认" / reset 按钮 data-testid',
    /ae-weight-reset/.test(componentSrc)
  );
  assert(
    '[10.11] 必须挂 onChange 改 weightDraft',
    /setWeightDraft/.test(componentSrc) && /onWeightChange/.test(componentSrc)
  );
  // 反向: 不能直接对 draft.weights 改 ratio (会绕过归一化)
  assert(
    '[10.12] save 路径必须调 normalizeWeightsForSave(weightDraft)',
    /normalizeWeightsForSave\s*\(\s*weightDraft\s*\)/.test(componentSrc)
  );
  // off 模式不显示 slider (节约视觉空间) — 守"currentMode === 'shadow' || currentMode === 'hard'" 包裹
  assert(
    '[10.13] slider 卡片必须包在 shadow/hard mode 条件下渲染',
    /currentMode\s*===\s*'shadow'\s*\|\|\s*currentMode\s*===\s*'hard'/.test(componentSrc)
  );

  // helper 自身 export 守护
  const helperSrc = readFileSync(
    join(__dirname, '../../../frontend/src/pages/workspace/analysisEngineWeightHelpers.ts'),
    'utf-8'
  );
  for (const name of [
    'ANALYZER_DIMENSIONS',
    'DEFAULT_ANALYZER_WEIGHTS_PERCENT',
    'ANALYZER_WEIGHT_MIN_PERCENT',
    'ANALYZER_WEIGHT_MAX_PERCENT',
    'WEIGHT_SUM_OK_MIN_PERCENT',
    'WEIGHT_SUM_OK_MAX_PERCENT',
    'clampPercent',
    'ensureAllPercents',
    'ratioToPercents',
    'normalizeWeightsForSave',
    'sumPercents',
    'pickSumStatusColor',
    'resetToDefaults',
    'getDefaultPercent',
  ]) {
    assert(
      `[10.14.${name}] helper 必须 export ${name}`,
      new RegExp(`export\\s+(?:const|function)\\s+${name}\\b`).test(helperSrc)
    );
  }
  // ANALYZER_DIMENSIONS 8 key 字面量
  for (const key of EXPECTED_KEYS) {
    assert(
      `[10.15.${key}] helper 源码必须含 key '${key}'`,
      new RegExp(`key:\\s*'${key}'`).test(helperSrc)
    );
  }
  // 默认 sum=100 字面量 (反向守: 改默认值时下次单测会爆)
  assert(
    '[10.16] helper 源码默认 percent fundamental: 25',
    /fundamental:\s*25/.test(helperSrc)
  );
  assert(
    '[10.17] helper 源码默认 percent event: 5',
    /event:\s*5/.test(helperSrc)
  );
}

// ============================================================
// summary
// ============================================================
setTimeout(() => {
  console.log(`\n${passed} ok / ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}, 50);
