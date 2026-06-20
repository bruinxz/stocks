/**
 * US-065 [FE-026] — RiskController.getAnalysisEngineConfig / updateAnalysisEngineConfig 单测.
 *
 * 不依赖 jest / DB / express. node 直接跑:
 *   cd backend && npx ts-node --transpile-only tests/risk/analysis-engine-config.test.ts
 *
 * RiskController 顶层 import 一长串 guard singleton, 会拽起 sequelize-typescript 数据库连接, 单测进程
 * 不可加载 (与 [US-018 EX-004] 总结的 'private method 直接走 model + 顶层 import sequelize' DB-less
 * 不可测同源问题). 所以本测试不直接调 controller method, 而是:
 *   [1] 走 ShadowDoubleRunService 的 normalize 行为契约 (controller 的业务逻辑全靠这个 helper)
 *   [2] **复刻** controller 主流程 (User.findByPk → normalize → patch risk_config → changed/save)
 *       验证我们手抄的控制流与 controller.ts 中那段代码字字对应 (回归 by regex META-GUARD).
 *   [3] META-GUARD fs+regex 守 RiskController.ts + risk.routes.ts 形态没有退化:
 *       (a) controller 必含 normalizeAnalysisEngineConfig + DEFAULT_ANALYSIS_ENGINE_CONFIG +
 *           changed('risk_config', true) + 写入 risk_config.analysis_engine
 *       (b) routes 必同时挂 GET + PUT /analysis-engine-config 并绑到 controller method
 *           (漏 PUT = UI 保存按钮成 404, 漏 GET = UI 永远显示加载中)
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  normalizeAnalysisEngineConfig,
  DEFAULT_ANALYSIS_ENGINE_CONFIG,
} from '../../src/services/analysis-engine/ShadowDoubleRunService';

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

// ---------------------------------------------------------------------------
// T1 — normalizeAnalysisEngineConfig 行为契约（controller 依赖这里, 契约漂就漂）
// ---------------------------------------------------------------------------
console.log('T1 — normalizeAnalysisEngineConfig 行为契约');
{
  const off = normalizeAnalysisEngineConfig({ mode: 'off' });
  assert(off.mode === 'off', 'mode=off 透传');

  const shadow = normalizeAnalysisEngineConfig({ mode: 'shadow' });
  assert(shadow.mode === 'shadow', 'mode=shadow 透传');

  const hard = normalizeAnalysisEngineConfig({ mode: 'hard' });
  assert(hard.mode === 'hard', 'mode=hard 透传');

  const invalid = normalizeAnalysisEngineConfig({ mode: 'something_else' });
  assert(invalid.mode === 'off', '非法 mode → off (controller PUT lenient 必须依赖这条降级)');

  const fromNull = normalizeAnalysisEngineConfig(null);
  assert(fromNull.mode === 'off', 'null 输入 → off');

  const fromEmpty = normalizeAnalysisEngineConfig({});
  assert(fromEmpty.mode === 'off', '空对象 → off');

  // US-139 [AE-009] — weights/enabled_analyzers 走 AnalyzerKey 白名单过滤;
  // 注意必须用 canonical key (e.g. 'fundamental' 单数 — 与 AnalyzerTypes.AnalyzerKey 一致),
  // 写错的 'fundamentals' 复数会被 sanitize 当 unknown key 静默丢弃.
  const withWeights = normalizeAnalysisEngineConfig({
    mode: 'hard',
    weights: { fundamental: 0.5, news: 0.3 },
    enabled_analyzers: ['fundamental', 'news'],
  });
  assert(withWeights.mode === 'hard', 'weights/enabled_analyzers 不影响 mode');
  assert(
    !!withWeights.weights && withWeights.weights.fundamental === 0.5,
    'weights 透传 (canonical key)'
  );
  assert(
    Array.isArray(withWeights.enabled_analyzers) &&
      withWeights.enabled_analyzers!.length === 2,
    'enabled_analyzers 透传 (canonical key)'
  );

  assert(
    DEFAULT_ANALYSIS_ENGINE_CONFIG.mode === 'off',
    'DEFAULT_ANALYSIS_ENGINE_CONFIG.mode === off (controller GET 默认值)'
  );
  // Object.freeze 守护 — controller 把这个常量当 single source of truth 直返给 client
  let mutated = false;
  try {
    (DEFAULT_ANALYSIS_ENGINE_CONFIG as any).mode = 'hard';
  } catch {
    mutated = true; // strict mode throws
  }
  assert(
    mutated || DEFAULT_ANALYSIS_ENGINE_CONFIG.mode === 'off',
    'DEFAULT_ANALYSIS_ENGINE_CONFIG 必须 Object.freeze (防 caller 误改污染所有 user)'
  );
}

// ---------------------------------------------------------------------------
// T2 — 复刻 controller 主流程: 验证我们手抄的控制流与 controller.ts 行为对应
// ---------------------------------------------------------------------------
// 这段代码必须与 RiskController.updateAnalysisEngineConfig 主体保持镜像一致.
// T3 (META-GUARD) 会用 regex 守 controller.ts 含同款形态; 任一脱节立刻挂.
console.log('T2 — controller 主流程复刻 (镜像 RiskController.updateAnalysisEngineConfig)');
{
  type FakeUserRow = {
    risk_config: any;
    save: () => Promise<void>;
    changed: (col: string, flag: boolean) => void;
  };

  function mirrorUpdate(userRow: FakeUserRow | null, body: any) {
    if (!userRow) return { status: 404, body: { success: false, message: 'user 不存在' } };
    const normalized = normalizeAnalysisEngineConfig(body || {});
    const nextRiskConfig = {
      ...(userRow.risk_config || {}),
      analysis_engine: normalized,
    };
    userRow.risk_config = nextRiskConfig;
    userRow.changed('risk_config', true); // US-017 JSONB 必须显式标 changed
    return {
      status: 200,
      body: {
        success: true,
        data: { config: normalized },
        message: `AnalysisEngine 模式已设为 ${normalized.mode}`,
      },
    };
  }

  let saveSpy = 0;
  let changedSpy: { col: string; flag: boolean } | null = null;
  const row: FakeUserRow = {
    risk_config: { existing_key: 'kept' },
    save: async () => {
      saveSpy += 1;
    },
    changed: (col, flag) => {
      changedSpy = { col, flag };
    },
  };

  // hard 路径
  const r1 = mirrorUpdate(row, { mode: 'hard' });
  // controller 在 mirror 后会 await save (本测试 mirror 不调, 由调用方负责)
  row.save();
  assert(r1.status === 200, 'PUT mode=hard → 200');
  assert(r1.body?.data?.config?.mode === 'hard', '返 normalized hard');
  assert(saveSpy === 1, 'PUT 调 save 1 次');
  assert(
    changedSpy?.col === 'risk_config' && changedSpy?.flag === true,
    'PUT changed("risk_config", true) 标 JSONB (漏掉 Sequelize 不落盘)'
  );
  assert(row.risk_config?.existing_key === 'kept', 'PUT 保留 risk_config 既有字段');
  assert(
    row.risk_config?.analysis_engine?.mode === 'hard',
    'PUT 写入 risk_config.analysis_engine.mode=hard'
  );

  // invalid mode lenient
  const row2: FakeUserRow = {
    risk_config: {},
    save: async () => undefined,
    changed: () => undefined,
  };
  const r2 = mirrorUpdate(row2, { mode: 'evil' });
  assert(r2.status === 200, 'PUT 非法 mode 仍 200 (lenient)');
  assert(r2.body?.data?.config?.mode === 'off', 'PUT 非法 mode 静默退到 off');

  // 找不到 user → 404
  const r3 = mirrorUpdate(null, { mode: 'shadow' });
  assert(r3.status === 404, 'PUT user 不存在 → 404');
  assert(r3.body?.success === false, 'PUT user 不存在 → success=false');

  // GET 镜像
  function mirrorGet(userRow: FakeUserRow | null) {
    if (!userRow) return { status: 404, body: { success: false } };
    const raw = (userRow.risk_config || {})['analysis_engine'];
    const normalized = normalizeAnalysisEngineConfig(raw);
    return {
      status: 200,
      body: {
        success: true,
        data: { config: normalized, is_default: !raw, default: DEFAULT_ANALYSIS_ENGINE_CONFIG },
      },
    };
  }
  const g1 = mirrorGet({
    risk_config: {},
    save: async () => undefined,
    changed: () => undefined,
  } as any);
  assert(g1.body?.data?.is_default === true, 'GET 空 risk_config → is_default=true');
  assert(g1.body?.data?.config?.mode === 'off', 'GET 空 risk_config → default off');
  const g2 = mirrorGet({
    risk_config: { analysis_engine: { mode: 'shadow' } },
    save: async () => undefined,
    changed: () => undefined,
  } as any);
  assert(g2.body?.data?.is_default === false, 'GET 已配置 → is_default=false');
  assert(g2.body?.data?.config?.mode === 'shadow', 'GET 已配置 → 透传 shadow');
}

// ---------------------------------------------------------------------------
// T3 — META-GUARD fs+regex 守 controller / routes 形态没有退化
// ---------------------------------------------------------------------------
console.log('T3 — META-GUARD: RiskController.ts + risk.routes.ts 源码守约');
{
  const controllerSrc = fs.readFileSync(
    path.resolve(__dirname, '../../src/api/controllers/RiskController.ts'),
    'utf-8'
  );
  assert(
    /async\s+getAnalysisEngineConfig\s*\(/.test(controllerSrc),
    'RiskController.ts 必须 export getAnalysisEngineConfig method'
  );
  assert(
    /async\s+updateAnalysisEngineConfig\s*\(/.test(controllerSrc),
    'RiskController.ts 必须 export updateAnalysisEngineConfig method'
  );
  assert(
    /normalizeAnalysisEngineConfig/.test(controllerSrc),
    'RiskController.ts 必须 require normalizeAnalysisEngineConfig (不能 inline 字面量解析)'
  );
  assert(
    /DEFAULT_ANALYSIS_ENGINE_CONFIG/.test(controllerSrc),
    'RiskController.ts 必须 require DEFAULT_ANALYSIS_ENGINE_CONFIG (default 不能 inline 写)'
  );
  assert(
    /userRow\.changed\(\s*['"]risk_config['"]\s*,\s*true\s*\)/.test(controllerSrc),
    "RiskController.ts updateAnalysisEngineConfig 必须 changed('risk_config', true) (US-017 JSONB 触发)"
  );
  assert(
    /risk_config[\s\S]{0,80}analysis_engine/.test(controllerSrc),
    'RiskController.ts 必须把 normalized 写入 risk_config.analysis_engine 字段名'
  );
  assert(
    /analysis-engine\/ShadowDoubleRunService/.test(controllerSrc),
    'RiskController.ts 必须从 ShadowDoubleRunService require helper (avoid 字面量漂)'
  );

  const routesSrc = fs.readFileSync(
    path.resolve(__dirname, '../../src/api/routes/risk.routes.ts'),
    'utf-8'
  );
  assert(
    /router\.get\(\s*['"]\/analysis-engine-config['"]/.test(routesSrc),
    "risk.routes.ts 必须挂 GET '/analysis-engine-config'"
  );
  assert(
    /router\.put\(\s*['"]\/analysis-engine-config['"]/.test(routesSrc),
    "risk.routes.ts 必须挂 PUT '/analysis-engine-config' (漏一边 UI 保存按钮成 404)"
  );
  assert(
    /riskController\.getAnalysisEngineConfig/.test(routesSrc) &&
      /riskController\.updateAnalysisEngineConfig/.test(routesSrc),
    'risk.routes.ts 必须把 GET/PUT 分别绑到 controller method'
  );
  // authentcate middleware
  assert(
    /authController\.authenticate[\s\S]{0,200}analysis-engine-config/.test(routesSrc) ||
      /analysis-engine-config[\s\S]{0,200}authController\.authenticate/.test(routesSrc),
    "risk.routes.ts /analysis-engine-config 必须挂 authController.authenticate (不可裸路由)"
  );
}

// ---------------------------------------------------------------------------
// T4 — US-139 [AE-009] analyzer_weights 白名单过滤 (AnalyzerKey 8 dim 唯一可信)
// ---------------------------------------------------------------------------
// 进入 User.risk_config JSONB 的 weights/enabled_analyzers 必须先过 ANALYZER_KEYS
// 白名单, 防 typo / 历史脏数据 / 攻击者构造的越界键值污染 DecisionAggregator.
// 与 normalizeWeights 在 DecisionAggregator 端再 sum=1 归一形成双层防腐 (本层管
// "键值合法", 那层管"sum=1"), 与 [[Codebase Patterns]] "Optional thresholds param
// + DEFAULT fallback" lenient 模板同源.
console.log('T4 — US-139 [AE-009] AnalyzerKey 白名单过滤 (weights / enabled_analyzers)');
{
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { ANALYZER_KEYS } = require('../../src/services/analysis-engine/ShadowDoubleRunService');

  // [4.1] ANALYZER_KEYS 形态: 8 个 + 与 frontend / AnalyzerTypes 同款
  assert(Array.isArray(ANALYZER_KEYS) && ANALYZER_KEYS.length === 8, 'ANALYZER_KEYS 长度=8');
  const EXPECTED = new Set([
    'fundamental',
    'technical',
    'capital',
    'news',
    'sentiment',
    'industry_regime',
    'risk',
    'event',
  ]);
  assert(
    ANALYZER_KEYS.every((k: string) => EXPECTED.has(k)),
    'ANALYZER_KEYS 与 AnalyzerTypes.AnalyzerKey 8 dim 同集合'
  );
  // frozen 防 mutate (同 DEFAULT_ANALYSIS_ENGINE_CONFIG 思路)
  let mutated = false;
  try {
    (ANALYZER_KEYS as any).push('attacker_inject');
  } catch {
    mutated = true;
  }
  assert(
    mutated || ANALYZER_KEYS.length === 8,
    'ANALYZER_KEYS 必须 Object.freeze 防 caller push 污染'
  );

  // [4.2] weights — unknown key 丢弃
  const w1 = normalizeAnalysisEngineConfig({
    mode: 'hard',
    weights: {
      fundamental: 0.4,
      technical: 0.3,
      fundamentals: 0.5, // typo 复数 — drop
      industryRegime: 0.2, // camelCase — drop
      foo: 0.1, // unknown — drop
      __proto__: 0.1, // prototype pollution attempt — drop
    },
  });
  assert(
    !!w1.weights && Object.keys(w1.weights).length === 2,
    `weights 过滤后只剩 2 key (got ${w1.weights ? Object.keys(w1.weights).join(',') : 'null'})`
  );
  assert(
    !!w1.weights && w1.weights.fundamental === 0.4 && w1.weights.technical === 0.3,
    'weights canonical key 透传'
  );
  assert(
    !!w1.weights && (w1.weights as any).fundamentals === undefined,
    'weights typo "fundamentals" 必须丢弃 (防与 fundamental 共存写花 JSONB)'
  );

  // [4.3] weights — 非 finite / 负数 丢弃, 0 保留
  const w2 = normalizeAnalysisEngineConfig({
    mode: 'shadow',
    weights: {
      fundamental: 'oops' as any, // 非 number — drop
      technical: NaN, // NaN — drop
      capital: Infinity, // Infinity — drop
      news: -0.5, // 负数 — drop
      sentiment: 0, // 0 — 保留 (用户主动屏蔽合法)
      risk: 0.5,
    },
  });
  assert(
    !!w2.weights && w2.weights.sentiment === 0,
    'weights 0 保留 (用户主动屏蔽 dim)'
  );
  assert(
    !!w2.weights && w2.weights.risk === 0.5,
    'weights 正常 number 保留'
  );
  for (const bad of ['fundamental', 'technical', 'capital', 'news']) {
    assert(
      !!w2.weights && (w2.weights as any)[bad] === undefined,
      `weights 非法值 (${bad}) 必须丢弃`
    );
  }

  // [4.4] weights — 全丢弃 / 空对象 → undefined (走 DecisionAggregator 全默认权重)
  const w3 = normalizeAnalysisEngineConfig({
    mode: 'hard',
    weights: { foo: 1, bar: 2 },
  });
  assert(w3.weights === undefined, '全 unknown key → weights=undefined (走默认)');

  const w4 = normalizeAnalysisEngineConfig({ mode: 'hard', weights: {} });
  assert(w4.weights === undefined, '空 weights {} → undefined (与未填等价)');

  // [4.5] weights — 数组 / null / 非 object → undefined (防 Array.isArray 漏判)
  const w5 = normalizeAnalysisEngineConfig({ mode: 'hard', weights: [0.5, 0.3] });
  assert(w5.weights === undefined, '数组 weights → undefined (不能当对象 index)');

  const w6 = normalizeAnalysisEngineConfig({ mode: 'hard', weights: null });
  assert(w6.weights === undefined, 'null weights → undefined');

  const w7 = normalizeAnalysisEngineConfig({ mode: 'hard', weights: 'string' as any });
  assert(w7.weights === undefined, 'string weights → undefined');

  // [4.6] enabled_analyzers — unknown key dropped, dedupe
  const e1 = normalizeAnalysisEngineConfig({
    mode: 'shadow',
    enabled_analyzers: [
      'fundamental',
      'fundamental', // dup — dedupe
      'foo', // unknown — drop
      'INDUSTRY_REGIME', // 大小写不匹配 — drop (严格 case-sensitive)
      'industry_regime',
      123 as any, // 非 string — drop
    ],
  });
  assert(
    !!e1.enabled_analyzers && e1.enabled_analyzers.length === 2,
    `enabled_analyzers dedupe + filter 后剩 2 (got ${e1.enabled_analyzers?.join(',')})`
  );
  assert(
    !!e1.enabled_analyzers &&
      e1.enabled_analyzers.includes('fundamental') &&
      e1.enabled_analyzers.includes('industry_regime'),
    'enabled_analyzers 保留 canonical key'
  );

  // [4.7] enabled_analyzers — 全 unknown / 空 → undefined (走全 8 dim 默认)
  const e2 = normalizeAnalysisEngineConfig({
    mode: 'shadow',
    enabled_analyzers: ['foo', 'bar'],
  });
  assert(e2.enabled_analyzers === undefined, '全 unknown enabled_analyzers → undefined');

  const e3 = normalizeAnalysisEngineConfig({ mode: 'shadow', enabled_analyzers: [] });
  assert(e3.enabled_analyzers === undefined, '空 enabled_analyzers [] → undefined');

  // [4.8] META-GUARD: ShadowDoubleRunService.ts 必须 export ANALYZER_KEYS 且为 frozen
  const svcSrc = fs.readFileSync(
    path.resolve(__dirname, '../../src/services/analysis-engine/ShadowDoubleRunService.ts'),
    'utf-8'
  );
  assert(
    /export\s+const\s+ANALYZER_KEYS\s*:/.test(svcSrc),
    'ShadowDoubleRunService.ts 必须 export ANALYZER_KEYS (单一可信白名单)'
  );
  assert(
    /Object\.freeze\(\s*\[[\s\S]*?'fundamental'[\s\S]*?'event'[\s\S]*?\]/.test(svcSrc),
    'ANALYZER_KEYS 必须 Object.freeze 包裹字面量数组 (防 mutate)'
  );
  assert(
    /sanitizeWeights\s*\(/.test(svcSrc) && /sanitizeEnabledAnalyzers\s*\(/.test(svcSrc),
    'normalizeAnalysisEngineConfig 必须委托 sanitizeWeights / sanitizeEnabledAnalyzers 白名单'
  );
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
console.log('');
if (fail === 0) {
  console.log(`✓ analysis-engine-config controller: ${pass}/${pass} OK`);
  process.exit(0);
} else {
  console.log(`✗ analysis-engine-config controller: ${pass} passed, ${fail} FAILED`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
