/**
 * US-076 [FE-037] — v2 modal 子组件 (AnalyzerScoreBar / ConfidenceRing / EvidenceList)
 * 跨 monorepo 单测.
 *
 * 跑法 (与 [[ai-stock-analysis-modal-v2-helpers.test.ts]] 同范式):
 *   cd backend && npx ts-node --transpile-only tests/services/ai-stock-analysis-modal-v2-components.test.ts
 * 或:
 *   cd backend && npm test -- --filter=ai-stock-analysis-modal-v2-components
 *
 * 与 helpers test 区别:
 *   - helpers test 校验 view model 形态 / 边界 / 颜色映射 (输入数据 → 模型转换);
 *   - 本 test 校验子组件 *接入正确* (modal 已替换 inline 实现) + 子组件常量/类型签名稳定.
 *
 * **为何不 require .tsx 跑 React.createElement?** backend tsconfig 没开 jsx
 * (`"jsx": "react-jsx"` 只在 frontend/tsconfig.json), 用 ts-node --transpile-only 直接
 * require `.tsx` 会 module-not-found / parse 失败. 同款决策见 [[critical-alert-modal-helpers.test.ts]]
 * (它的目标文件 criticalAlertModalHelpers.ts 是 .ts 不含 JSX 所以能 require). 本 story 的
 * 3 子组件 *本质是 JSX render*, 没有可单独验证的纯逻辑分支 (颜色/标签映射在 helpers test
 * 已覆盖). 因此本测改用 **fs + regex META-GUARD** 守 3 项契约:
 *   (a) 子组件文件存在且 export 了 3 子组件;
 *   (b) 子组件 props 类型直接复用 helper view model (避免字段漂移);
 *   (c) modal 已 import + jsx 调用子组件 + 不再 inline 实现.
 *
 * 7 测组:
 *   [1] 文件存在 sanity (components / modal / helpers)
 *   [2] components 源文件 export 3 子组件 + 2 常量 (regex 扫)
 *   [3] EVIDENCE_DIRECTION_LABELS / EVIDENCE_DIRECTION_COLORS 内容固化 (regex 扫源文件)
 *   [4] 子组件 props 类型签名 — dimension/evidence 直接复用 helper view model
 *   [5] META-GUARD modal 已 import 3 子组件 + jsx 使用
 *   [6] META-GUARD modal 已删除 inline 渲染 (反向: <Progress percent={dim.bar_value} 等)
 *   [7] components 不引入新外部 lib (只 antd / icons / react / 同目录 helpers)
 */

import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

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

const COMPONENTS_PATH = resolve(
  __dirname,
  '../../../frontend/src/components/trading/aiStockAnalysisModalV2Components.tsx'
);
const MODAL_PATH = resolve(
  __dirname,
  '../../../frontend/src/components/trading/AIStockAnalysisModal.tsx'
);
const HELPERS_PATH = resolve(
  __dirname,
  '../../../frontend/src/components/trading/aiStockAnalysisModalV2Helpers.ts'
);

// ---------------------------------------------------------------------------
// [1] 文件 sanity
// ---------------------------------------------------------------------------
console.log('[1] 文件 sanity');
{
  assert(existsSync(COMPONENTS_PATH), 'components 文件存在');
  assert(existsSync(MODAL_PATH), 'modal 文件存在');
  assert(existsSync(HELPERS_PATH), 'helpers 文件存在');
}

const componentsSrc = readFileSync(COMPONENTS_PATH, 'utf-8');
const modalSrc = readFileSync(MODAL_PATH, 'utf-8');

// ---------------------------------------------------------------------------
// [2] components export 3 子组件 + 2 常量
// ---------------------------------------------------------------------------
console.log('[2] components export 3 子组件 + 2 常量');
{
  // export 形式: `export const AnalyzerScoreBar` / `export const ConfidenceRing` / `export const EvidenceList`
  for (const name of ['AnalyzerScoreBar', 'ConfidenceRing', 'EvidenceList']) {
    assert(
      new RegExp(`export\\s+const\\s+${name}\\b`).test(componentsSrc),
      `components export const ${name}`
    );
  }
  // 直接 export 类型 (let caller TS 自动推断)
  for (const t of ['AnalyzerScoreBarProps', 'ConfidenceRingProps', 'EvidenceListProps']) {
    assert(
      new RegExp(`export\\s+interface\\s+${t}\\b`).test(componentsSrc),
      `components export interface ${t}`
    );
  }
  // 2 颜色/标签常量 export
  for (const k of ['EVIDENCE_DIRECTION_LABELS', 'EVIDENCE_DIRECTION_COLORS']) {
    assert(
      new RegExp(`export\\s+const\\s+${k}\\b`).test(componentsSrc),
      `components export const ${k}`
    );
  }
}

// ---------------------------------------------------------------------------
// [3] EVIDENCE_DIRECTION_LABELS / COLORS 内容固化 (中股惯例: 利多=红)
// ---------------------------------------------------------------------------
console.log('[3] EVIDENCE_DIRECTION_LABELS / COLORS 内容固化');
{
  // 必须含 Object.freeze (与 helpers 常量同款)
  assert(
    /EVIDENCE_DIRECTION_LABELS[\s\S]{0,80}Object\.freeze/.test(componentsSrc),
    'EVIDENCE_DIRECTION_LABELS 走 Object.freeze'
  );
  assert(
    /EVIDENCE_DIRECTION_COLORS[\s\S]{0,80}Object\.freeze/.test(componentsSrc),
    'EVIDENCE_DIRECTION_COLORS 走 Object.freeze'
  );
  // 三档全有 (任一缺漏 evidence.direction 走 undefined 渲染失败)
  for (const d of ['bullish', 'bearish', 'neutral']) {
    assert(
      new RegExp(`${d}:\\s*'`).test(componentsSrc),
      `direction ${d} 在常量里`
    );
  }
  // 中股惯例: 利多=红, 利空=绿 (与 ACTION_COLORS_V2 同方向)
  assert(/bullish:\s*'利多'/.test(componentsSrc), 'bullish=利多');
  assert(/bearish:\s*'利空'/.test(componentsSrc), 'bearish=利空');
  assert(/neutral:\s*'中性'/.test(componentsSrc), 'neutral=中性');
  assert(/bullish:\s*'red'/.test(componentsSrc), 'bullish=red (中股惯例)');
  assert(/bearish:\s*'green'/.test(componentsSrc), 'bearish=green');
}

// ---------------------------------------------------------------------------
// [4] 子组件 props 类型签名 — 直接复用 helper view model 类型 (避免字段漂移)
// ---------------------------------------------------------------------------
console.log('[4] 子组件 props 类型签名');
{
  // import 必须 from 'helpers' 同目录文件 (不能挑字段也不能 copy 类型)
  assert(
    /import\s+type\s+\{[\s\S]*?AnalyzerDimensionViewModelV2[\s\S]*?\}\s+from\s+'\.\/aiStockAnalysisModalV2Helpers'/.test(
      componentsSrc
    ),
    'components 必须 import AnalyzerDimensionViewModelV2 自 helpers'
  );
  assert(
    /EvidenceViewItemV2/.test(componentsSrc),
    'components 必须引用 EvidenceViewItemV2'
  );
  // AnalyzerScoreBar/ConfidenceRing 用整个 dim view model — 不允许只挑 bar_value/color/confidence 字段
  assert(
    /AnalyzerScoreBarProps[\s\S]*?dimension:\s*AnalyzerDimensionViewModelV2/.test(componentsSrc),
    'AnalyzerScoreBarProps.dimension: AnalyzerDimensionViewModelV2'
  );
  assert(
    /ConfidenceRingProps[\s\S]*?dimension:\s*AnalyzerDimensionViewModelV2/.test(componentsSrc),
    'ConfidenceRingProps.dimension: AnalyzerDimensionViewModelV2'
  );
  assert(
    /EvidenceListProps[\s\S]*?evidence:\s*EvidenceViewItemV2\[\]/.test(componentsSrc),
    'EvidenceListProps.evidence: EvidenceViewItemV2[]'
  );
}

// ---------------------------------------------------------------------------
// [5] META-GUARD — modal 已 import 3 子组件 + jsx 使用
// ---------------------------------------------------------------------------
console.log('[5] META-GUARD modal 接入');
{
  assert(
    /from\s+'\.\/aiStockAnalysisModalV2Components'/.test(modalSrc),
    'modal import components 模块'
  );
  for (const name of ['AnalyzerScoreBar', 'ConfidenceRing', 'EvidenceList']) {
    assert(
      new RegExp(`\\b${name}\\b`).test(modalSrc),
      `modal 引用 ${name}`
    );
    assert(
      new RegExp(`<${name}\\b`).test(modalSrc),
      `modal jsx 渲染 <${name} (子组件接入)`
    );
  }
  // 必须把整个 dim 喂下去, 不允许只挑字段
  assert(/<AnalyzerScoreBar\s+dimension=\{dim\}/.test(modalSrc), 'AnalyzerScoreBar dimension={dim}');
  assert(/<ConfidenceRing\s+dimension=\{dim\}/.test(modalSrc), 'ConfidenceRing dimension={dim}');
  assert(
    /<EvidenceList[\s\S]*?evidence=\{dim\.evidence\}/.test(modalSrc),
    'EvidenceList evidence={dim.evidence}'
  );
}

// ---------------------------------------------------------------------------
// [6] META-GUARD 反向 — modal 已删 inline 实现 (避免回退)
// ---------------------------------------------------------------------------
console.log('[6] META-GUARD modal 反向不再 inline');
{
  // 反向: V2Layout 内不再直接 `<Progress percent={dim.bar_value}` (已由 AnalyzerScoreBar 接管)
  assert(
    !/<Progress\s+percent=\{dim\.bar_value\}/.test(modalSrc),
    'modal 不再 inline <Progress percent={dim.bar_value}'
  );
  // 反向: V2Layout 内不再 inline `ev.direction === 'bullish' ? 'red'` ternary
  // (已由 EvidenceList + EVIDENCE_DIRECTION_COLORS 接管)
  assert(
    !/ev\.direction\s*===\s*'bullish'\s*\?\s*'red'/.test(modalSrc),
    "modal 不再 inline ev.direction==='bullish'?'red' ternary"
  );
  // 反向: 不再 inline `Math.round(dim.confidence * 100)` (由 ConfidenceRing 接管)
  assert(
    !/Math\.round\(dim\.confidence\s*\*\s*100\)/.test(modalSrc),
    'modal 不再 inline Math.round(dim.confidence*100)'
  );
}

// ---------------------------------------------------------------------------
// [7] components 不引入新外部 lib — 与 modal 同款依赖 (避免 bundle 膨胀)
// ---------------------------------------------------------------------------
console.log('[7] components 不引入新外部 lib');
{
  const allowedImports = new Set([
    'react',
    'antd',
    '@ant-design/icons',
    './aiStockAnalysisModalV2Helpers',
  ]);
  const importRe = /^\s*import\s+[^;]+\s+from\s+'([^']+)';\s*$/gm;
  const imports = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = importRe.exec(componentsSrc)) !== null) {
    imports.add(m[1]);
  }
  for (const imp of imports) {
    assert(
      allowedImports.has(imp),
      `import 必须在允许集: '${imp}' 不在 [react / antd / @ant-design/icons / ./aiStockAnalysisModalV2Helpers]`
    );
  }
  // 必须真的有 import (avoid 漏判)
  assert(imports.size >= 3, `至少 3 个 import (react+antd+icons+helpers), 实际 ${imports.size}`);
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
