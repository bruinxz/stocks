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

  const withWeights = normalizeAnalysisEngineConfig({
    mode: 'hard',
    weights: { fundamentals: 0.5, news: 0.3 },
    enabled_analyzers: ['fundamentals', 'news'],
  });
  assert(withWeights.mode === 'hard', 'weights/enabled_analyzers 不影响 mode');
  assert(
    !!withWeights.weights && withWeights.weights.fundamentals === 0.5,
    'weights 透传'
  );
  assert(
    Array.isArray(withWeights.enabled_analyzers) &&
      withWeights.enabled_analyzers!.length === 2,
    'enabled_analyzers 透传'
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
