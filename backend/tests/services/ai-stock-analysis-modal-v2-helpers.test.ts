/**
 * US-075 [FE-036] — aiStockAnalysisModalV2Helpers 跨 monorepo 单测.
 *
 * 不依赖 jest / React 渲染. 跑法:
 *   cd backend && npx ts-node --transpile-only tests/services/ai-stock-analysis-modal-v2-helpers.test.ts
 *   cd backend && npm test -- --filter=ai-stock-analysis-modal-v2
 *
 * 与 [[todo-suggestions-helpers.test.ts]] / [[risk-parameters-center-tab.test.ts]]
 * 跨 monorepo "ts-node 直跑 frontend pure helper" 同款.
 *
 * 8 测组:
 *   [1] 8 dim 常量 frozen + sanity (顺序 / label / hint / 颜色)
 *   [2] scoreToBarValue / scoreToColor / confidenceToColor 边界
 *   [3] buildEvidenceItemV2 (label/detail/direction/weight 边界 + 无 direction 走 parentScore 推断)
 *   [4] buildAnalyzerDimensionViewModelV2 (失败/完整/缺数据/未知 key/error obj vs string)
 *   [5] normalizeAction + buildActionPlanViewModelV2 (entry 反序自动 swap / 单字段缺失 null / cap 风险提示)
 *   [6] buildDataQualityViewModelV2 (unknown level / coefficient cap / missing 数组)
 *   [7] isV2Result (3 触发条件: engine_variant / hard_short_circuit / per_dimension)
 *   [8] buildV2ViewModel 主入口 (非 v2 result 返 null / 8 dim 顺序固定补齐 / overall_confidence 兜底 / 完整 happy)
 */

import * as fs from 'fs';
import * as path from 'path';

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

const HELPER_PATH = path.resolve(
  __dirname,
  '../../../frontend/src/components/trading/aiStockAnalysisModalV2Helpers.ts'
);
const MODAL_PATH = path.resolve(
  __dirname,
  '../../../frontend/src/components/trading/AIStockAnalysisModal.tsx'
);

import {
  ANALYZER_KEYS_V2,
  ANALYZER_LABELS_V2,
  ANALYZER_HINTS_V2,
  ACTION_COLORS_V2,
  ACTION_LABELS_V2,
  DATA_QUALITY_COLOR,
  DATA_QUALITY_LABEL,
  buildActionPlanViewModelV2,
  buildAnalyzerDimensionViewModelV2,
  buildDataQualityViewModelV2,
  buildEvidenceItemV2,
  buildV2ViewModel,
  confidenceToColor,
  isV2Result,
  normalizeAction,
  scoreToBarValue,
  scoreToColor,
  type AnalyzerKeyV2,
} from '../../../frontend/src/components/trading/aiStockAnalysisModalV2Helpers';

// ---------------------------------------------------------------------------
// [1] 8 dim 常量 frozen + sanity
// ---------------------------------------------------------------------------
console.log('[1] 8 dim 常量 frozen + sanity');
{
  assert(Object.isFrozen(ANALYZER_KEYS_V2), 'ANALYZER_KEYS_V2 frozen');
  assert(Object.isFrozen(ANALYZER_LABELS_V2), 'ANALYZER_LABELS_V2 frozen');
  assert(Object.isFrozen(ANALYZER_HINTS_V2), 'ANALYZER_HINTS_V2 frozen');
  assert(Object.isFrozen(ACTION_COLORS_V2), 'ACTION_COLORS_V2 frozen');
  assert(Object.isFrozen(ACTION_LABELS_V2), 'ACTION_LABELS_V2 frozen');
  assert(Object.isFrozen(DATA_QUALITY_COLOR), 'DATA_QUALITY_COLOR frozen');
  assert(Object.isFrozen(DATA_QUALITY_LABEL), 'DATA_QUALITY_LABEL frozen');

  assert(ANALYZER_KEYS_V2.length === 8, '8 dim 数量');
  // 与 backend AnalyzerKey 一致
  const expected: AnalyzerKeyV2[] = [
    'fundamental',
    'technical',
    'capital',
    'sentiment',
    'news',
    'industry_regime',
    'risk',
    'event',
  ];
  for (let i = 0; i < expected.length; i++) {
    assert(ANALYZER_KEYS_V2[i] === expected[i], `ANALYZER_KEYS_V2[${i}] === ${expected[i]}`);
  }
  // 每个 key 都有 label + hint
  for (const k of ANALYZER_KEYS_V2) {
    assert(typeof ANALYZER_LABELS_V2[k] === 'string' && ANALYZER_LABELS_V2[k].length > 0, `label[${k}]`);
    assert(typeof ANALYZER_HINTS_V2[k] === 'string' && ANALYZER_HINTS_V2[k].length > 0, `hint[${k}]`);
  }
  // 中股惯例: 强烈买入 = 深红
  assert(ACTION_COLORS_V2['strong_buy'] === '#9b1f00', 'strong_buy 深红');
  assert(ACTION_COLORS_V2['strong_sell'] === '#135200', 'strong_sell 深绿');
  // data_quality 5 档全有定义
  for (const k of ['good', 'partial', 'degraded', 'critical', 'unknown']) {
    assert(typeof DATA_QUALITY_COLOR[k] === 'string', `DATA_QUALITY_COLOR[${k}]`);
    assert(typeof DATA_QUALITY_LABEL[k] === 'string', `DATA_QUALITY_LABEL[${k}]`);
  }
  assert(DATA_QUALITY_COLOR['critical'] === 'red', 'critical 必须红色');
}

// ---------------------------------------------------------------------------
// [2] scoreToBarValue / scoreToColor / confidenceToColor 边界
// ---------------------------------------------------------------------------
console.log('[2] scoreToBarValue / scoreToColor / confidenceToColor 边界');
{
  // scoreToBarValue: [-100, +100] → [0, 100], 中性 50
  assert(scoreToBarValue(0) === 50, 'score=0 → 50');
  assert(scoreToBarValue(100) === 100, 'score=100 → 100');
  assert(scoreToBarValue(-100) === 0, 'score=-100 → 0');
  assert(scoreToBarValue(50) === 75, 'score=50 → 75');
  assert(scoreToBarValue(-50) === 25, 'score=-50 → 25');
  // 越界 clamp
  assert(scoreToBarValue(200) === 100, 'score=200 clamp 100');
  assert(scoreToBarValue(-200) === 0, 'score=-200 clamp 0');
  // 非法 fallback 50
  assert(scoreToBarValue(null) === 50, 'null → 50');
  assert(scoreToBarValue(undefined) === 50, 'undefined → 50');
  assert(scoreToBarValue(NaN) === 50, 'NaN → 50');
  assert(scoreToBarValue(Infinity) === 50, 'Infinity → 50');

  // scoreToColor: 阈值 ±50, ±20
  assert(scoreToColor(70) === '#f5222d', '70 强利多 红');
  assert(scoreToColor(30) === '#fa541c', '30 弱利多 橙红');
  assert(scoreToColor(0) === '#1890ff', '0 中性 蓝');
  assert(scoreToColor(-30) === '#73d13d', '-30 弱利空 浅绿');
  assert(scoreToColor(-70) === '#52c41a', '-70 强利空 深绿');
  assert(scoreToColor(null) === '#bfbfbf', 'null 灰');
  assert(scoreToColor(NaN) === '#bfbfbf', 'NaN 灰');

  // confidenceToColor
  assert(confidenceToColor(0.1) === '#f5222d', '0.1 红');
  assert(confidenceToColor(0.4) === '#fa8c16', '0.4 橙');
  assert(confidenceToColor(0.8) === '#52c41a', '0.8 绿');
  assert(confidenceToColor(null) === '#bfbfbf', 'null 灰');
}

// ---------------------------------------------------------------------------
// [3] buildEvidenceItemV2 边界
// ---------------------------------------------------------------------------
console.log('[3] buildEvidenceItemV2 边界');
{
  assert(buildEvidenceItemV2(null, 0) === null, 'null → null');
  assert(buildEvidenceItemV2('x', 0) === null, '字符串 → null');
  assert(buildEvidenceItemV2({}, 0) === null, '空对象 → null (无 label)');
  assert(buildEvidenceItemV2({ label: '   ' }, 0) === null, '空白 label → null');

  // 完整 case
  const e1 = buildEvidenceItemV2(
    { label: 'ROE 突破', detail: 'ROE=18%', direction: 'bullish', weight: 0.7 },
    0
  );
  assert(e1 !== null, 'happy 非 null');
  assert(e1!.label === 'ROE 突破' && e1!.detail === 'ROE=18%', 'label/detail');
  assert(e1!.direction === 'bullish', 'direction bullish');
  assert(e1!.weight === 0.7, 'weight 0.7');

  // direction 缺失 → 走 parentScore 推断
  const e2 = buildEvidenceItemV2({ label: 'X', weight: 0.5 }, 60);
  assert(e2!.direction === 'bullish', 'parentScore=60 → bullish');
  const e3 = buildEvidenceItemV2({ label: 'X', weight: 0.5 }, -60);
  assert(e3!.direction === 'bearish', 'parentScore=-60 → bearish');
  const e4 = buildEvidenceItemV2({ label: 'X', weight: 0.5 }, 2);
  assert(e4!.direction === 'neutral', 'parentScore=2 (≤5) → neutral');
  const e5 = buildEvidenceItemV2({ label: 'X', weight: 0.5 }, null);
  assert(e5!.direction === 'neutral', 'parentScore=null → neutral');

  // weight 越界 clamp
  const e6 = buildEvidenceItemV2({ label: 'X', weight: 5 }, 0);
  assert(e6!.weight === 1, 'weight=5 clamp 1');
  const e7 = buildEvidenceItemV2({ label: 'X', weight: -5 }, 0);
  assert(e7!.weight === 0, 'weight=-5 clamp 0');

  // detail 缺失 → ''
  const e8 = buildEvidenceItemV2({ label: 'X' }, 0);
  assert(e8!.detail === '', 'detail 缺失 → 空串');
}

// ---------------------------------------------------------------------------
// [4] buildAnalyzerDimensionViewModelV2
// ---------------------------------------------------------------------------
console.log('[4] buildAnalyzerDimensionViewModelV2');
{
  assert(buildAnalyzerDimensionViewModelV2(null) === null, 'null → null');
  assert(buildAnalyzerDimensionViewModelV2({}) === null, '无 analyzer_key → null');
  assert(
    buildAnalyzerDimensionViewModelV2({ analyzer_key: 'unknown_dim' }) === null,
    '未知 analyzer_key → null (8 dim 之外)'
  );

  // 完整 happy
  const vm = buildAnalyzerDimensionViewModelV2({
    analyzer_key: 'fundamental',
    score: 70,
    confidence: 0.8,
    data_missing: [],
    error: null,
    evidence: [
      { label: 'ROE 突破', detail: '18%', direction: 'bullish', weight: 0.9 },
      { label: '营收增速', detail: '+25%', direction: 'bullish', weight: 0.7 },
      { label: '低权重', direction: 'bullish', weight: 0.1 },
    ],
  });
  assert(vm !== null && vm.key === 'fundamental', 'happy key');
  assert(vm!.label === '基本面', 'label 自动填');
  assert(vm!.score === 70 && vm!.bar_value === 85, 'score=70 → bar 85');
  assert(vm!.color === '#f5222d', '70 强利多 红');
  assert(vm!.confidence === 0.8, 'confidence');
  assert(vm!.confidence_color === '#52c41a', '0.8 绿');
  assert(!vm!.failed, 'happy 不 failed');
  // evidence 按 weight desc, 截前 5
  assert(vm!.evidence.length === 3, 'evidence 全保留 (<5)');
  assert(vm!.evidence[0].label === 'ROE 突破', '最高 weight 第一');
  assert(vm!.evidence[2].label === '低权重', '最低 weight 末尾');

  // error 对象
  const vmErr = buildAnalyzerDimensionViewModelV2({
    analyzer_key: 'technical',
    score: 0,
    confidence: 0,
    data_missing: ['daily_bars'],
    error: { code: 'NO_DATA', message: '日线缺失' },
    evidence: [],
  });
  assert(vmErr !== null, 'errored 非 null');
  assert(vmErr!.error === '日线缺失', 'error 从 obj.message 抽');
  assert(vmErr!.failed === true, '有 error 必 failed');

  // error 字符串
  const vmErrStr = buildAnalyzerDimensionViewModelV2({
    analyzer_key: 'risk',
    score: -50,
    confidence: 0,
    data_missing: [],
    error: '超时',
    evidence: [],
  });
  assert(vmErrStr!.error === '超时', 'error 字符串透传');

  // score 越界 clamp
  const vmClamp = buildAnalyzerDimensionViewModelV2({
    analyzer_key: 'capital',
    score: 999,
    confidence: 5,
    data_missing: [],
    error: null,
    evidence: [],
  });
  assert(vmClamp!.score === 100, 'score 越界 clamp 100');
  assert(vmClamp!.confidence === 1, 'confidence 越界 clamp 1');

  // evidence 超过 5 截
  const vmCap = buildAnalyzerDimensionViewModelV2({
    analyzer_key: 'news',
    score: 0,
    confidence: 0.5,
    data_missing: [],
    error: null,
    evidence: Array.from({ length: 10 }, (_, i) => ({
      label: `e${i}`,
      weight: (10 - i) / 10,
      direction: 'neutral',
    })),
  });
  assert(vmCap!.evidence.length === 5, 'evidence cap 5');
}

// ---------------------------------------------------------------------------
// [5] normalizeAction + buildActionPlanViewModelV2
// ---------------------------------------------------------------------------
console.log('[5] normalizeAction + buildActionPlanViewModelV2');
{
  assert(normalizeAction('buy') === 'buy', 'buy');
  assert(normalizeAction('add') === 'add', 'add');
  assert(normalizeAction('strong_sell') === 'strong_sell', 'strong_sell');
  assert(normalizeAction('foo') === 'unknown', '未知 → unknown');
  assert(normalizeAction(null) === 'unknown', 'null → unknown');
  assert(normalizeAction(42) === 'unknown', '数字 → unknown');

  // null metadata
  const ap0 = buildActionPlanViewModelV2(null);
  assert(ap0.action === 'unknown', 'null metadata → unknown');
  assert(ap0.entry_zone === null, '无 entry');
  assert(ap0.risk_warnings.length === 0, '无 warnings');
  assert(ap0.action_label === '暂无明确建议', 'unknown label');
  assert(ap0.action_color === '#8c8c8c', 'unknown 灰');

  // 完整 happy + entry 反序 swap
  const ap1 = buildActionPlanViewModelV2({
    hard_short_circuit_action: 'buy',
    entry_zone: [12, 10], // 反序
    stop_loss: 9,
    take_profit: 15,
    suggested_position_pct: 0.2,
    risk_warnings: ['  高估值  ', '', '商誉减值'],
  });
  assert(ap1.action === 'buy', 'action');
  assert(ap1.entry_zone !== null && ap1.entry_zone[0] === 10 && ap1.entry_zone[1] === 12, 'entry 反序自动 swap');
  assert(ap1.stop_loss === 9 && ap1.take_profit === 15, 'stop/take');
  assert(ap1.suggested_position_pct === 0.2, 'pos');
  assert(ap1.risk_warnings.length === 2, '空白过滤');
  assert(ap1.risk_warnings[0] === '高估值', 'trim');

  // entry 非法 → null
  const ap2 = buildActionPlanViewModelV2({ entry_zone: [10] });
  assert(ap2.entry_zone === null, 'entry 长度=1 → null');
  const ap3 = buildActionPlanViewModelV2({ entry_zone: ['a', 'b'] });
  assert(ap3.entry_zone === null, 'entry 非数字 → null');

  // risk_warnings cap 10
  const ap4 = buildActionPlanViewModelV2({
    risk_warnings: Array.from({ length: 20 }, (_, i) => `w${i}`),
  });
  assert(ap4.risk_warnings.length === 10, 'warnings cap 10');

  // pos clamp [0,1]
  const ap5 = buildActionPlanViewModelV2({ suggested_position_pct: 5 });
  assert(ap5.suggested_position_pct === 1, 'pos clamp 1');

  // action fallback: metadata.action
  const ap6 = buildActionPlanViewModelV2({ action: 'sell' });
  assert(ap6.action === 'sell', '从 metadata.action 取');
}

// ---------------------------------------------------------------------------
// [6] buildDataQualityViewModelV2
// ---------------------------------------------------------------------------
console.log('[6] buildDataQualityViewModelV2');
{
  assert(buildDataQualityViewModelV2(null) === null, 'null → null');
  assert(buildDataQualityViewModelV2({}) === null, '无 data_quality → null');
  assert(
    buildDataQualityViewModelV2({ data_quality: 'good' }) === null,
    '字符串 data_quality → null (非对象)'
  );

  const dq1 = buildDataQualityViewModelV2({
    data_quality: {
      level: 'partial',
      missing_critical: [],
      missing_optional: ['volume_30d', '  '],
      coefficient: 0.8,
    },
  });
  assert(dq1 !== null && dq1.level === 'partial', 'level');
  assert(dq1!.level_label === '部分缺失', 'label');
  assert(dq1!.level_color === 'blue', 'color');
  assert(dq1!.missing_optional.length === 1, '空白过滤');
  assert(dq1!.coefficient === 0.8, 'coefficient');

  // unknown level 兜底
  const dq2 = buildDataQualityViewModelV2({
    data_quality: { level: 'weird', missing_critical: ['x'] },
  });
  assert(dq2!.level === 'unknown', 'unknown level fallback');
  assert(dq2!.coefficient === 1, 'coefficient 缺失 → 1 (满)');

  // coefficient clamp
  const dq3 = buildDataQualityViewModelV2({
    data_quality: { level: 'good', coefficient: 5 },
  });
  assert(dq3!.coefficient === 1, 'coefficient clamp 1');
}

// ---------------------------------------------------------------------------
// [7] isV2Result 三触发条件
// ---------------------------------------------------------------------------
console.log('[7] isV2Result');
{
  assert(isV2Result(null) === false, 'null → false');
  assert(isV2Result(undefined) === false, 'undefined → false');
  // v1 result (无 metadata 标识)
  const v1: any = {
    report_id: 'r1',
    stock_code: '000001',
    stock_name: null,
    dimensions: ['fundamental'],
    summary: '',
    recommendation: 'buy',
    confidence_score: 60,
    risk_level: null,
    key_points: {},
    status: 'completed',
    task_id: null,
    target_date: null,
    error: null,
    generated_at: new Date().toISOString(),
    metadata: { something_else: true },
    persisted: false,
  };
  assert(isV2Result(v1) === false, 'metadata 无标识 → false (v1)');

  // 触发 1: engine_variant
  const v2a: any = { ...v1, metadata: { engine_variant: 'multi_dim_v1' } };
  assert(isV2Result(v2a) === true, 'engine_variant 触发');

  // 触发 2: hard_short_circuit
  const v2b: any = { ...v1, metadata: { hard_short_circuit: true } };
  assert(isV2Result(v2b) === true, 'hard_short_circuit 触发');

  // 触发 3: per_dimension 非空
  const v2c: any = {
    ...v1,
    metadata: { per_dimension: [{ analyzer_key: 'fundamental' }] },
  };
  assert(isV2Result(v2c) === true, 'per_dimension 触发');

  // per_dimension 空数组 → false
  const v2d: any = { ...v1, metadata: { per_dimension: [] } };
  assert(isV2Result(v2d) === false, 'per_dimension 空 → false');
}

// ---------------------------------------------------------------------------
// [8] buildV2ViewModel 主入口
// ---------------------------------------------------------------------------
console.log('[8] buildV2ViewModel 主入口');
{
  assert(buildV2ViewModel(null) === null, 'null → null');
  // 非 v2 → null
  const v1: any = {
    report_id: 'r1',
    stock_code: '000001',
    metadata: {},
    confidence_score: 60,
  };
  assert(buildV2ViewModel(v1) === null, '非 v2 → null');

  // 完整 v2 happy
  const v2: any = {
    report_id: 'r2',
    stock_code: '000001',
    stock_name: '平安银行',
    confidence_score: 75,
    risk_level: 'low',
    error: null,
    status: 'completed',
    metadata: {
      engine_variant: 'multi_dim_v1',
      overall_confidence: 0.7, // → 70
      hard_short_circuit_action: 'buy',
      entry_zone: [10.5, 11.5],
      stop_loss: 9.8,
      take_profit: 13,
      suggested_position_pct: 0.15,
      risk_warnings: ['行业景气下行'],
      data_quality: {
        level: 'good',
        missing_critical: [],
        missing_optional: [],
        coefficient: 1,
      },
      per_dimension: [
        {
          analyzer_key: 'fundamental',
          score: 60,
          confidence: 0.8,
          data_missing: [],
          error: null,
          evidence: [{ label: 'ROE 高', direction: 'bullish', weight: 0.9 }],
        },
        {
          analyzer_key: 'risk',
          score: -30,
          confidence: 0.5,
          data_missing: ['atr_60d'],
          error: null,
          evidence: [],
        },
      ],
    },
  };
  const vm = buildV2ViewModel(v2);
  assert(vm !== null, 'happy 非 null');
  assert(vm!.dimensions.length === 8, '8 dim 全填齐 (缺失走占位)');
  // 顺序固定按 ANALYZER_KEYS_V2
  for (let i = 0; i < 8; i++) {
    assert(vm!.dimensions[i].key === ANALYZER_KEYS_V2[i], `dim[${i}].key === ${ANALYZER_KEYS_V2[i]}`);
  }
  // fundamental 有真数据
  const fun = vm!.dimensions.find(d => d.key === 'fundamental')!;
  assert(fun.score === 60 && fun.confidence === 0.8, 'fundamental 真数据');
  assert(fun.evidence.length === 1, 'fundamental evidence');
  // technical (未提供) 走占位
  const tech = vm!.dimensions.find(d => d.key === 'technical')!;
  assert(tech.score === null, 'technical 占位 score null');
  assert(tech.data_missing.includes('analyzer 未执行'), 'technical 占位 data_missing');
  // event (未提供) 走占位
  const ev = vm!.dimensions.find(d => d.key === 'event')!;
  assert(ev.score === null, 'event 占位');

  assert(vm!.overall_confidence === 70, 'overall_confidence 0.7 → 70');
  assert(vm!.action_plan.action === 'buy', 'action_plan.action');
  assert(vm!.action_plan.entry_zone![0] === 10.5, 'action_plan.entry_zone');
  assert(vm!.data_quality !== null && vm!.data_quality.level === 'good', 'data_quality');
  assert(vm!.engine_variant === 'multi_dim_v1', 'engine_variant');

  // overall_confidence 缺失 → 走 confidence_score 兜底
  const v2b: any = {
    ...v2,
    metadata: { ...v2.metadata, overall_confidence: undefined },
  };
  delete v2b.metadata.overall_confidence;
  const vmb = buildV2ViewModel(v2b);
  assert(vmb!.overall_confidence === 75, 'overall_confidence 缺失 → confidence_score 75 兜底');

  // engine_variant 缺失 → 默认 'multi_dim_v1'
  const v2c: any = {
    ...v2,
    metadata: { hard_short_circuit: true, per_dimension: [] },
  };
  const vmc = buildV2ViewModel(v2c);
  assert(vmc !== null, 'hard_short_circuit 触发 v2 即便 per_dimension 空');
  assert(vmc!.engine_variant === 'multi_dim_v1', 'engine_variant 默认值');
}

// ---------------------------------------------------------------------------
// [9] META-GUARD fs+regex 守 helper 已被 modal 接入
// ---------------------------------------------------------------------------
console.log('[9] META-GUARD modal 接入');
{
  assert(fs.existsSync(HELPER_PATH), 'helper 文件存在');
  assert(fs.existsSync(MODAL_PATH), 'modal 文件存在');
  const modalSrc = fs.readFileSync(MODAL_PATH, 'utf-8');
  // 必须 import buildV2ViewModel + isV2Result
  assert(
    /from\s+'\.\/aiStockAnalysisModalV2Helpers'/.test(modalSrc),
    'modal import helper 模块'
  );
  assert(/buildV2ViewModel/.test(modalSrc), 'modal 调 buildV2ViewModel');
  assert(/isV2Result/.test(modalSrc), 'modal 调 isV2Result');
  // 必须有 v2/v1 分支 (区分 useV2Layout)
  assert(/useV2Layout/.test(modalSrc), 'modal 区分 v2/v1 layout');
  // 必须有 V2Layout 子组件
  assert(/const V2Layout[^=]*=/.test(modalSrc), 'V2Layout 子组件');
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
setTimeout(() => {
  console.log(`\n${pass} ok / ${fail} failed`);
  if (fail > 0) {
    console.error('\nFailures:');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  process.exit(0);
}, 50);
