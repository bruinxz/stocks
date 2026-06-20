/**
 * US-077 [FE-038] — v2 modal 行动类子组件 (DataMissingBanner / ActionPlanCard)
 * 跨 monorepo 单测.
 *
 * 与 [[ai-stock-analysis-modal-v2-components.test.ts]] (US-076) 同范式:
 *   cd backend && npx ts-node --transpile-only tests/services/ai-stock-analysis-modal-v2-action-components.test.ts
 * 或:
 *   cd backend && npm test -- --filter=ai-stock-analysis-modal-v2-action-components
 *
 * 为何继续走 META-GUARD (regex 扫源文件) 而非真 mount React?
 *   - backend tsconfig 不开 jsx, ts-node --transpile-only 直接 require .tsx 会失败.
 *   - 同款决策见 ai-stock-analysis-modal-v2-components.test.ts; DataMissingBanner /
 *     ActionPlanCard 的纯逻辑分支 (entry_zone 缺失 / risk_warnings cap / level 判定) 已经在
 *     ai-stock-analysis-modal-v2-helpers.test.ts 覆盖, 子组件本质是 view model → JSX
 *     的直翻译. 本测守 META 契约: 子组件存在, props 走 view model, modal 真接入, 反向
 *     无 inline 残留.
 *
 * 7 测组:
 *   [1] 文件 sanity (components / modal / helpers 三方齐全)
 *   [2] components export 2 子组件 + 2 props interface
 *   [3] props 类型签名 — 直接复用 helper view model (避免字段漂移)
 *   [4] META-GUARD modal 已 import 2 子组件 + jsx 使用 + 喂全 view model
 *   [5] META-GUARD modal 已删 inline 实现 (反向: 不再有 missing_critical.length > 0 内联三元, 不再有 padding:16 borderRadius:8 inline 卡片等)
 *   [6] components 不引入新外部 lib
 *   [7] DataMissingBanner 渲染条件守 (missing_critical 非空 OR level==='critical') — 源码 regex 校验
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
const helpersSrc = readFileSync(HELPERS_PATH, 'utf-8');

// ---------------------------------------------------------------------------
// [2] components export 2 子组件 + 2 props interface
// ---------------------------------------------------------------------------
console.log('[2] components export DataMissingBanner / ActionPlanCard + 类型');
{
  for (const name of ['DataMissingBanner', 'ActionPlanCard']) {
    assert(
      new RegExp(`export\\s+const\\s+${name}\\b`).test(componentsSrc),
      `components export const ${name}`
    );
  }
  for (const t of ['DataMissingBannerProps', 'ActionPlanCardProps']) {
    assert(
      new RegExp(`export\\s+interface\\s+${t}\\b`).test(componentsSrc),
      `components export interface ${t}`
    );
  }
}

// ---------------------------------------------------------------------------
// [3] props 类型签名 — 直接复用 helper view model
// ---------------------------------------------------------------------------
console.log('[3] props 类型签名走 helper view model');
{
  // import 必须从 helpers 拉两个 view model 类型
  assert(
    /import\s+type\s+\{[\s\S]*?ActionPlanViewModelV2[\s\S]*?\}\s+from\s+'\.\/aiStockAnalysisModalV2Helpers'/.test(
      componentsSrc
    ),
    'components import ActionPlanViewModelV2 自 helpers'
  );
  assert(
    /import\s+type\s+\{[\s\S]*?DataQualityViewModelV2[\s\S]*?\}\s+from\s+'\.\/aiStockAnalysisModalV2Helpers'/.test(
      componentsSrc
    ),
    'components import DataQualityViewModelV2 自 helpers'
  );
  // helpers 也必须真 export 这两个 view model (避免 import 死引用)
  assert(
    /export\s+interface\s+ActionPlanViewModelV2\b/.test(helpersSrc),
    'helpers export interface ActionPlanViewModelV2'
  );
  assert(
    /export\s+interface\s+DataQualityViewModelV2\b/.test(helpersSrc),
    'helpers export interface DataQualityViewModelV2'
  );
  // props 必须用整个 view model 而非挑字段 (避免漂移)
  assert(
    /DataMissingBannerProps[\s\S]*?dataQuality:\s*DataQualityViewModelV2\s*\|\s*null\s*\|\s*undefined/.test(
      componentsSrc
    ),
    'DataMissingBannerProps.dataQuality: DataQualityViewModelV2 | null | undefined'
  );
  assert(
    /ActionPlanCardProps[\s\S]*?actionPlan:\s*ActionPlanViewModelV2/.test(componentsSrc),
    'ActionPlanCardProps.actionPlan: ActionPlanViewModelV2'
  );
}

// ---------------------------------------------------------------------------
// [4] META-GUARD modal 已 import + jsx 使用
// ---------------------------------------------------------------------------
console.log('[4] META-GUARD modal 已接入 2 子组件');
{
  for (const name of ['DataMissingBanner', 'ActionPlanCard']) {
    assert(
      new RegExp(`\\b${name}\\b`).test(modalSrc),
      `modal 引用 ${name}`
    );
    assert(
      new RegExp(`<${name}\\b`).test(modalSrc),
      `modal jsx 渲染 <${name} (子组件接入)`
    );
  }
  // 必须把整个 view model 喂下去, 不允许只挑字段
  assert(
    /<DataMissingBanner\s+dataQuality=\{data_quality\}/.test(modalSrc),
    'DataMissingBanner dataQuality={data_quality}'
  );
  assert(
    /<ActionPlanCard\s+actionPlan=\{action_plan\}/.test(modalSrc),
    'ActionPlanCard actionPlan={action_plan}'
  );
}

// ---------------------------------------------------------------------------
// [5] META-GUARD 反向 — modal 不再 inline
// ---------------------------------------------------------------------------
console.log('[5] META-GUARD modal 反向不再 inline');
{
  // 反向: V2Layout 不再 inline `data_quality.missing_critical.length > 0` 三元判定
  assert(
    !/data_quality\.missing_critical\.length\s*>\s*0\s*\|\|\s*data_quality\.level/.test(modalSrc),
    'modal 不再 inline data_quality.missing_critical.length>0 || data_quality.level 判定'
  );
  // 反向: V2Layout 不再 inline `action_plan.entry_zone[0].toFixed(2)` 卡片
  assert(
    !/action_plan\.entry_zone\[0\]\.toFixed\(2\)/.test(modalSrc),
    'modal 不再 inline action_plan.entry_zone[0].toFixed(2)'
  );
  // 反向: V2Layout 不再 inline `action_plan.risk_warnings.slice(0, 5)` 列表
  assert(
    !/action_plan\.risk_warnings\.slice\(0,\s*5\)/.test(modalSrc),
    'modal 不再 inline action_plan.risk_warnings.slice(0,5)'
  );
  // 反向: V2Layout 不再 inline 卡片 padding:16 borderRadius:8 background:'#fff7e6' 全套样式
  assert(
    !/background:\s*'#fff7e6'/.test(modalSrc),
    "modal 不再 inline background:'#fff7e6' (ActionPlanCard 内联样式)"
  );
  // 反向: V2Layout 不再 import WarningOutlined / ExclamationCircleOutlined (子组件已接管)
  assert(
    !/\bWarningOutlined\b/.test(modalSrc),
    'modal 不再 import WarningOutlined (DataMissingBanner 接管)'
  );
  assert(
    !/\bExclamationCircleOutlined\b/.test(modalSrc),
    'modal 不再 import ExclamationCircleOutlined (ActionPlanCard 接管)'
  );
  // 反向: V2Layout 不再 import Divider (ActionPlanCard 接管)
  assert(
    !/\bDivider\b/.test(modalSrc),
    'modal 不再 import Divider (ActionPlanCard 接管)'
  );
}

// ---------------------------------------------------------------------------
// [6] components 不引入新外部 lib
// ---------------------------------------------------------------------------
console.log('[6] components 不引入新外部 lib');
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
  assert(imports.size >= 3, `至少 3 个 import (react+antd+icons+helpers), 实际 ${imports.size}`);
}

// ---------------------------------------------------------------------------
// [7] DataMissingBanner 渲染条件守 (源码 regex 校验 — null 返 + missing_critical / critical 触发)
// ---------------------------------------------------------------------------
console.log('[7] DataMissingBanner 渲染条件 + ActionPlanCard 兜底守');
{
  // DataMissingBanner 必须先 null 兜底
  assert(
    /DataMissingBanner[\s\S]*?if\s*\(!dataQuality\)\s*return\s+null/.test(componentsSrc),
    'DataMissingBanner: dataQuality 缺失时 return null'
  );
  // DataMissingBanner 必须只有 missing_critical 非空 OR level==='critical' 才显示
  assert(
    /DataMissingBanner[\s\S]*?missing_critical\.length\s*>\s*0[\s\S]{0,80}?dataQuality\.level\s*===\s*'critical'/.test(
      componentsSrc
    ),
    "DataMissingBanner: 渲染条件 missing_critical.length>0 || level==='critical'"
  );
  // ActionPlanCard 必须对 entry_zone null 走 '—'
  assert(
    /ActionPlanCard[\s\S]*?entry_zone[\s\S]{0,200}?'—'/.test(componentsSrc),
    "ActionPlanCard: entry_zone 缺失走 '—' 占位"
  );
  // ActionPlanCard 必须对 suggested_position_pct null 走 '—'
  assert(
    /ActionPlanCard[\s\S]*?suggested_position_pct\s*!=\s*null/.test(componentsSrc),
    'ActionPlanCard: suggested_position_pct != null 判定'
  );
  // ActionPlanCard 必须有 risk_warnings 0 时不渲染 (避免空块占位)
  assert(
    /actionPlan\.risk_warnings\.length\s*>\s*0/.test(componentsSrc),
    'ActionPlanCard: risk_warnings.length>0 才渲染'
  );
  // ActionPlanCard 必须把 maxRiskWarningsShown 兜底为可配 (默认 5)
  assert(
    /maxRiskWarningsShown\s*=\s*5/.test(componentsSrc),
    'ActionPlanCard: maxRiskWarningsShown 默认 5'
  );
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
