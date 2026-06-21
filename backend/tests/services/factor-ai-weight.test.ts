/**
 * US-046 因子 AI 权重对照 (FE-007) 单元测试
 *
 * 不依赖 jest; 直接跑:
 *   cd backend && npx ts-node --transpile-only tests/services/factor-ai-weight.test.ts
 *
 * 也不依赖 DB/网络/React: 全部 import 自 frontend/src/pages/workspace/factorAIWeightHelpers.ts
 * (pure helpers, 无 antd/react 依赖, ts-node 可以直接吃) + 内置 assert. 跨 monorepo
 * import 用 `../../../frontend/...` 相对路径, 与 frontend lab 工程师手测一致.
 *
 * 覆盖维度:
 *   [1] AI_WEIGHT_SUM_EPS 常量值
 *   [2] computeAIRawScore — health_class gate / abs(ic) / abs(ir) / NaN 防御
 *   [3] normalizeAIWeights — 空 / 全 0 / 单因子独占 100 / 多因子归一化 / 余数法
 *   [4] computeAIWeights — 端到端 (FactorOverviewItem-shape → weights map)
 *   [5] computeWeightDeltas — 仅 AI 推荐的 factor 进 delta / 缺失字段当 0
 *   [6] META-GUARD fs+regex:
 *       - FactorWorkspace.tsx: import + 注入 + Apply 按钮 + AI chip
 *       - factorAIWeightHelpers.ts: 4 个 helper 全 export
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  AI_WEIGHT_SUM_EPS,
  computeAIRawScore,
  normalizeAIWeights,
  computeAIWeights,
  computeWeightDeltas,
} from '../../../frontend/src/pages/workspace/factorAIWeightHelpers';

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

// ---- 测试夹具: 仿 FactorOverviewItem 形状 (我们的 helper 只读 ic_90d/ic_ir/health_class+name) ----
type FOI = {
  name: string;
  category: string;
  description: string;
  latest_trade_date: string | null;
  universe_size: number;
  non_neutral_count: number;
  ic_90d: number | null;
  ic_ir: number | null;
  ic_sample_count: number;
  health_class: 'alpha' | 'weak' | 'unstable' | 'unknown';
};
function mkF(over: Partial<FOI> & { name: string }): FOI {
  return {
    name: over.name,
    category: 'other',
    description: '',
    latest_trade_date: '2026-06-19',
    universe_size: 5000,
    non_neutral_count: 4800,
    ic_90d: 0,
    ic_ir: 0,
    ic_sample_count: 60,
    health_class: 'unknown',
    ...over,
  };
}

// ---- [1] AI_WEIGHT_SUM_EPS ---------------------------------------------------
assert('[1.1] AI_WEIGHT_SUM_EPS 是数值 ≤0.5', typeof AI_WEIGHT_SUM_EPS === 'number' && AI_WEIGHT_SUM_EPS <= 0.5);

// ---- [2] computeAIRawScore ---------------------------------------------------
assert(
  '[2.1] unknown → 0',
  computeAIRawScore({ ic_90d: 0.05, ic_ir: 0.5, health_class: 'unknown' }) === 0
);
assert(
  '[2.2] weak → 0',
  computeAIRawScore({ ic_90d: 0.05, ic_ir: 0.5, health_class: 'weak' }) === 0
);
assert(
  '[2.3] alpha, 正向 IC → |IC|×|IR|',
  Math.abs(computeAIRawScore({ ic_90d: 0.05, ic_ir: 0.6, health_class: 'alpha' }) - 0.03) < 1e-9
);
assert(
  '[2.4] alpha, 负向 IC (短期反转) → abs 后参与 = 0.04×0.5=0.02',
  Math.abs(computeAIRawScore({ ic_90d: -0.04, ic_ir: -0.5, health_class: 'alpha' }) - 0.02) < 1e-9
);
assert(
  '[2.5] unstable 也参与, 只是分数低',
  computeAIRawScore({ ic_90d: 0.02, ic_ir: 0.25, health_class: 'unstable' }) > 0
);
assert(
  '[2.6] ic_90d null → 0',
  computeAIRawScore({ ic_90d: null, ic_ir: 0.5, health_class: 'alpha' }) === 0
);
assert(
  '[2.7] ic_ir null → 0',
  computeAIRawScore({ ic_90d: 0.05, ic_ir: null, health_class: 'alpha' }) === 0
);
assert(
  '[2.8] NaN ic_90d 不会传染',
  computeAIRawScore({ ic_90d: NaN, ic_ir: 0.5, health_class: 'alpha' }) === 0
);
assert(
  '[2.9] NaN ic_ir 不会传染',
  computeAIRawScore({ ic_90d: 0.05, ic_ir: NaN, health_class: 'alpha' }) === 0
);
assert(
  '[2.10] alpha + IC=0 → 0 (噪声因子排除)',
  computeAIRawScore({ ic_90d: 0, ic_ir: 0.5, health_class: 'alpha' }) === 0
);

// ---- [3] normalizeAIWeights --------------------------------------------------
const r1 = normalizeAIWeights({});
assert('[3.1] 空输入 → 空对象', Object.keys(r1).length === 0);

const r2 = normalizeAIWeights({ a: 0, b: 0, c: 0 });
assert('[3.2] 全 0 → 空对象', Object.keys(r2).length === 0);

const r3 = normalizeAIWeights({ a: 5 });
assert('[3.3] 单因子独占 100.0', r3.a === 100.0 && Object.keys(r3).length === 1);

const r4 = normalizeAIWeights({ a: 1, b: 1, c: 1, d: 1 });
const sumR4 = Object.values(r4).reduce((acc, v) => acc + v, 0);
assert(
  '[3.4] 4 个等权 → 各 25%, sum=100',
  Math.abs(sumR4 - 100) < AI_WEIGHT_SUM_EPS &&
    r4.a === 25.0 &&
    r4.b === 25.0 &&
    r4.c === 25.0 &&
    r4.d === 25.0
);

const r5 = normalizeAIWeights({ a: 1, b: 2 });
const sumR5 = Object.values(r5).reduce((acc, v) => acc + v, 0);
assert(
  '[3.5] 1:2 → 33.3 / 66.7 (含余数补)',
  Math.abs(sumR5 - 100) < AI_WEIGHT_SUM_EPS && r5.a < r5.b && r5.a + r5.b === 100
);

const r6 = normalizeAIWeights({ a: 1, b: 1, c: 1 });
const sumR6 = Object.values(r6).reduce((acc, v) => acc + v, 0);
assert(
  '[3.6] 3 等权 → sum=100 精确 (1/3=33.3, 余数法补 1 个 0.1 到 33.4)',
  Math.abs(sumR6 - 100) < AI_WEIGHT_SUM_EPS
);

const r7 = normalizeAIWeights({ a: 0.0006, b: 0.0003, c: 0.0001 });
const sumR7 = Object.values(r7).reduce((acc, v) => acc + v, 0);
assert(
  '[3.7] 极小数也归一化到 sum=100',
  Math.abs(sumR7 - 100) < AI_WEIGHT_SUM_EPS && r7.a > r7.b && r7.b > r7.c
);

const r8 = normalizeAIWeights({ a: NaN, b: 1, c: 1 });
assert('[3.8] NaN 项被排除', Object.keys(r8).length === 2 && !('a' in r8));

const r9 = normalizeAIWeights({ a: -5, b: 1 });
assert('[3.9] 负值被排除 (rawScore 不该是负)', Object.keys(r9).length === 1 && r9.b === 100);

// ---- [4] computeAIWeights (端到端) ------------------------------------------
const w0 = computeAIWeights([]);
assert('[4.1] 空 factors → 空 map', Object.keys(w0).length === 0);

const w1 = computeAIWeights([
  mkF({ name: 'value', ic_90d: 0.05, ic_ir: 0.6, health_class: 'alpha' }),
  mkF({ name: 'quality', ic_90d: 0.04, ic_ir: 0.5, health_class: 'alpha' }),
  mkF({ name: 'momentum', ic_90d: 0.02, ic_ir: 0.4, health_class: 'unstable' }),
  mkF({ name: 'low_vol', ic_90d: 0.01, ic_ir: 0.2, health_class: 'weak' }), // 排除
  mkF({ name: 'northbound', ic_90d: null, ic_ir: null, health_class: 'unknown' }), // 排除
]);
assert('[4.2] 3 个有效因子 + 2 个被排除', Object.keys(w1).length === 3);
const sumW1 = Object.values(w1).reduce((acc, v) => acc + v, 0);
assert('[4.3] sum=100', Math.abs(sumW1 - 100) < AI_WEIGHT_SUM_EPS);
assert(
  '[4.4] 高 IC×IR 的 value (=0.03) 权重 > quality (=0.02) > momentum (=0.008)',
  w1.value > w1.quality && w1.quality > w1.momentum
);

const w2 = computeAIWeights([
  mkF({ name: 'a', ic_90d: 0.05, ic_ir: 0.6, health_class: 'weak' }),
  mkF({ name: 'b', ic_90d: null, ic_ir: null, health_class: 'unknown' }),
]);
assert('[4.5] 全 weak/unknown → 空 map (= AI 暂无建议)', Object.keys(w2).length === 0);

const w3 = computeAIWeights([
  mkF({ name: 'rev', ic_90d: -0.05, ic_ir: -0.6, health_class: 'alpha' }), // 短期反转
  mkF({ name: 'mom', ic_90d: 0.05, ic_ir: 0.6, health_class: 'alpha' }), // 动量
]);
assert(
  '[4.6] 正向 / 反向 IC 同样有效, |IC|×|IR| 相等 → 等权 50/50',
  Math.abs(w3.rev - 50) < AI_WEIGHT_SUM_EPS && Math.abs(w3.mom - 50) < AI_WEIGHT_SUM_EPS
);

// ---- [5] computeWeightDeltas -------------------------------------------------
const d1 = computeWeightDeltas({ a: 30, b: 20 }, { a: 25, b: 25 });
assert('[5.1] +5 / -5', d1.a === 5 && d1.b === -5);

const d2 = computeWeightDeltas({ a: 30 }, { a: 25, b: 25 });
assert('[5.2] user 缺 b → user.b 当 0 → delta = 0 - 25 = -25', d2.b === -25);

const d3 = computeWeightDeltas({ a: 30, c: 99 }, { a: 25, b: 25 });
assert(
  '[5.3] AI 不推荐的 c 不进入 delta map',
  !('c' in d3) && d3.a === 5 && d3.b === -25
);

const d4 = computeWeightDeltas({ a: NaN }, { a: 10 });
assert('[5.4] NaN user weight → 当 0, delta=-10', d4.a === -10);

// ---- [6] META-GUARD fs+regex -------------------------------------------------
const repoRoot = join(__dirname, '../../../');

const helpersSrc = readFileSync(
  join(repoRoot, 'frontend/src/pages/workspace/factorAIWeightHelpers.ts'),
  'utf8'
);
assert(
  '[6.1] factorAIWeightHelpers.ts: 4 个 helper 全 export',
  /export\s+function\s+computeAIRawScore/.test(helpersSrc) &&
    /export\s+function\s+normalizeAIWeights/.test(helpersSrc) &&
    /export\s+function\s+computeAIWeights/.test(helpersSrc) &&
    /export\s+function\s+computeWeightDeltas/.test(helpersSrc)
);
assert(
  '[6.2] factorAIWeightHelpers.ts: AI_WEIGHT_SUM_EPS export',
  /export\s+const\s+AI_WEIGHT_SUM_EPS/.test(helpersSrc)
);

const workspaceSrc = readFileSync(
  join(repoRoot, 'frontend/src/pages/workspace/FactorWorkspace.tsx'),
  'utf8'
);
assert(
  '[6.3] FactorWorkspace.tsx import factorAIWeightHelpers',
  /from\s+['"]\.\/factorAIWeightHelpers['"]/.test(workspaceSrc) &&
    /computeAIWeights/.test(workspaceSrc) &&
    /computeWeightDeltas/.test(workspaceSrc)
);
assert(
  '[6.4] FactorWorkspace.tsx 调用 computeAIWeights(overview...factors)',
  /computeAIWeights\(overview\?\.factors\s*\?\?\s*\[\]\)/.test(workspaceSrc)
);
assert(
  '[6.5] FactorWorkspace.tsx WeightsTab 接 aiWeights / onApplyAIWeights props',
  /aiWeights:\s*Record<string,\s*number>/.test(workspaceSrc) &&
    /onApplyAIWeights:\s*\(\)\s*=>\s*void/.test(workspaceSrc)
);
assert(
  '[6.6] FactorWorkspace.tsx 有 apply-ai-weights-btn data-testid',
  /data-testid=['"]apply-ai-weights-btn['"]/.test(workspaceSrc)
);
assert(
  '[6.7] FactorWorkspace.tsx 渲染 ai-weight-chip data-testid 前缀',
  /data-testid=\{`ai-weight-chip-\$\{factor\.name\}`\}/.test(workspaceSrc)
);
assert(
  '[6.8] FactorWorkspace.tsx handleApplyAIWeights 包含 message.warning + setWeights',
  /handleApplyAIWeights/.test(workspaceSrc) &&
    /message\.warning\(.*AI/.test(workspaceSrc) &&
    /setWeights\(prev/.test(workspaceSrc)
);

// ---- 报告 --------------------------------------------------------------------
const total = passed + failed;
console.log(`\n${passed} ok / ${failed} failed (of ${total})`);
if (failed > 0) process.exit(1);
process.exit(0);
