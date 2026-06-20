/**
 * US-066 [FE-027] / US-135 [PR-020] — SettingsWorkspace.RiskParametersCenterTab 单测.
 *
 * 不依赖 jest / DB / React 渲染. node 直接跑:
 *   cd backend && npx ts-node --transpile-only tests/risk/risk-parameters-center-tab.test.ts
 *
 * 测试范式与 [US-065 analysis-engine-config.test.ts] 同款 — RiskController 顶层
 * import 一长串 guard singleton, 会拽起 sequelize-typescript 数据库连接, 单测进程
 * 不可加载 (与 US-018 EX-004 同源问题). 所以本测试不直接调任何组件 render, 而是:
 *   [T1] fs+regex META-GUARD 守 RiskParametersCenterTab.tsx 含 8 个 endpoint
 *        全部 wired + 关键 hook (loadAll / saveSection / hasSectionChanges)
 *   [T2] fs+regex META-GUARD 守 SettingsWorkspace.tsx 已注册 risk-parameters tab
 *        + headerActions 已挂 + conditional render 已挂 (与 US-065 analysis-engine
 *        tab 上线时手抄路径同款 — 漏 headerActions 用户看到 "待迁移现有个人中心"
 *        误导, 漏 render 用户点了 tab 但看不到内容)
 *   [T3] 8 个 backend endpoint 已存在 (RiskController.ts + risk.routes.ts 都有
 *        对应 GET / PUT 形态)
 *
 * US-135 [PR-020] 在 US-066 5 endpoint 之上 +3 (market-regime / black-swan /
 * morning-checkup), 测试同步扩 5→8 endpoint 覆盖.
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

const TAB_PATH = path.resolve(
  __dirname,
  '../../../frontend/src/pages/workspace/SettingsWorkspace.RiskParametersCenterTab.tsx'
);
const SETTINGS_WS_PATH = path.resolve(
  __dirname,
  '../../../frontend/src/pages/workspace/SettingsWorkspace.tsx'
);
const CONTROLLER_PATH = path.resolve(
  __dirname,
  '../../src/api/controllers/RiskController.ts'
);
const ROUTES_PATH = path.resolve(__dirname, '../../src/api/routes/risk.routes.ts');

// ---------------------------------------------------------------------------
// T1 — RiskParametersCenterTab.tsx 形态守约
// ---------------------------------------------------------------------------
console.log('T1 — RiskParametersCenterTab.tsx META-GUARD');
{
  assert(fs.existsSync(TAB_PATH), 'frontend/src/pages/workspace/SettingsWorkspace.RiskParametersCenterTab.tsx 必须存在');
  const tabSrc = fs.readFileSync(TAB_PATH, 'utf-8');

  // 5 个 endpoint 全部 wired
  assert(
    /['"]\/risk\/position-limits['"]/.test(tabSrc),
    '必须接入 /risk/position-limits endpoint'
  );
  assert(
    /['"]\/risk\/trailing-stop['"]/.test(tabSrc),
    '必须接入 /risk/trailing-stop endpoint'
  );
  assert(
    /['"]\/risk\/drawdown-breaker['"]/.test(tabSrc),
    '必须接入 /risk/drawdown-breaker endpoint'
  );
  assert(
    /['"]\/risk\/per-stock-stop-loss['"]/.test(tabSrc),
    '必须接入 /risk/per-stock-stop-loss endpoint'
  );
  assert(
    /['"]\/risk\/industry-concentration['"]/.test(tabSrc),
    '必须接入 /risk/industry-concentration endpoint'
  );
  // US-135 [PR-020] +3 endpoint
  assert(
    /['"]\/risk\/market-regime['"]/.test(tabSrc),
    '必须接入 /risk/market-regime endpoint (US-135 PR-020)'
  );
  assert(
    /['"]\/risk\/black-swan['"]/.test(tabSrc),
    '必须接入 /risk/black-swan endpoint (US-135 PR-020)'
  );
  assert(
    /['"]\/risk\/morning-checkup['"]/.test(tabSrc),
    '必须接入 /risk/morning-checkup endpoint (US-135 PR-020)'
  );

  // 关键 helper / hook
  assert(
    /Promise\.allSettled/.test(tabSrc),
    'loadAll 必须用 Promise.allSettled 并行拉 — 单 endpoint 失败不阻塞其它 section'
  );
  assert(
    /hasSectionChanges/.test(tabSrc),
    '必须定义 hasSectionChanges 帮 hasChanges 派生 (draft/view 双状态范式)'
  );
  assert(
    /loadSection/.test(tabSrc) && /saveSection/.test(tabSrc),
    '必须有通用 loadSection / saveSection helper (5 section 共用)'
  );
  // GET + PUT 都用 api.get / api.put
  assert(
    /api\.get\(/.test(tabSrc) && /api\.put\(/.test(tabSrc),
    '必须同时调 api.get 和 api.put (5 个 section 都有 GET/PUT 对)'
  );
  // 每个 section 必须有独立 Save 按钮 + saving state
  assert(
    /pl\.saving/.test(tabSrc) &&
      /ts\.saving/.test(tabSrc) &&
      /db\.saving/.test(tabSrc) &&
      /psl\.saving/.test(tabSrc) &&
      /ic\.saving/.test(tabSrc) &&
      /mr\.saving/.test(tabSrc) &&
      /bs\.saving/.test(tabSrc) &&
      /mc\.saving/.test(tabSrc),
    '8 个 section 必须有独立 saving state (pl/ts/db/psl/ic/mr/bs/mc) — US-135 +3'
  );
  // draft/view 回灌 — 保存后用 server normalize 值回灌 (US-065 lesson)
  assert(
    /view:\s*normalized,\s*draft:\s*normalized/.test(tabSrc),
    'saveSection 必须用 server normalized 值同时回灌 view+draft (防 hasChanges 永真)'
  );

  // export default
  assert(
    /export\s+default\s+RiskParametersCenterTab/.test(tabSrc),
    'tab 必须 default export RiskParametersCenterTab'
  );
}

// ---------------------------------------------------------------------------
// T2 — SettingsWorkspace.tsx 已注册 risk-parameters tab + 关键三处都挂
// ---------------------------------------------------------------------------
console.log('T2 — SettingsWorkspace.tsx 已注册 risk-parameters tab');
{
  const wsSrc = fs.readFileSync(SETTINGS_WS_PATH, 'utf-8');

  assert(
    /import\s+RiskParametersCenterTab\s+from\s+['"]\.\/SettingsWorkspace\.RiskParametersCenterTab['"]/.test(
      wsSrc
    ),
    'SettingsWorkspace.tsx 必须 import RiskParametersCenterTab'
  );

  assert(
    /SafetyOutlined/.test(wsSrc),
    'SettingsWorkspace.tsx 必须 import SafetyOutlined (tab icon)'
  );

  // tabs array 含 risk-parameters
  assert(
    /key:\s*['"]risk-parameters['"]/.test(wsSrc),
    'SettingsWorkspace.tsx tabs array 必须含 key: risk-parameters'
  );
  assert(
    /label:\s*['"]风控参数中心['"]/.test(wsSrc),
    'SettingsWorkspace.tsx tabs array 必须含 label: 风控参数中心'
  );

  // headerActions 已挂 risk-parameters 分支 — 漏掉用户看到 "待迁移现有个人中心" 误导
  assert(
    /activeKey\s*===\s*['"]risk-parameters['"][\s\S]{0,100}Tag/.test(wsSrc),
    'SettingsWorkspace.tsx headerActions 必须挂 risk-parameters 分支 (不挂会显示占位 Tag 误导用户)'
  );

  // conditional render 已挂 — 漏掉用户点了 tab 但看不到内容
  assert(
    /activeKey\s*===\s*['"]risk-parameters['"][\s\S]{0,80}<RiskParametersCenterTab\s*\/>/.test(
      wsSrc
    ),
    'SettingsWorkspace.tsx conditional render 必须挂 risk-parameters → <RiskParametersCenterTab />'
  );
}

// ---------------------------------------------------------------------------
// T3 — 5 个 backend endpoint 都已 existing (RiskController + routes 都有)
// ---------------------------------------------------------------------------
console.log('T3 — 5 个 backend endpoint 都已 existing');
{
  const controllerSrc = fs.readFileSync(CONTROLLER_PATH, 'utf-8');
  const routesSrc = fs.readFileSync(ROUTES_PATH, 'utf-8');

  const endpoints: Array<{
    path: string;
    getMethod: string;
    putMethod: string;
  }> = [
    {
      path: 'position-limits',
      getMethod: 'getPositionLimits',
      putMethod: 'updatePositionLimits',
    },
    {
      path: 'trailing-stop',
      getMethod: 'getTrailingStop',
      putMethod: 'updateTrailingStop',
    },
    {
      path: 'drawdown-breaker',
      getMethod: 'getDrawdownBreaker',
      putMethod: 'updateDrawdownBreaker',
    },
    {
      path: 'per-stock-stop-loss',
      getMethod: 'getPerStockStopLoss',
      putMethod: 'updatePerStockStopLoss',
    },
    {
      path: 'industry-concentration',
      getMethod: 'getIndustryConcentration',
      putMethod: 'updateIndustryConcentration',
    },
    // US-135 [PR-020] +3 endpoint
    {
      path: 'market-regime',
      getMethod: 'getMarketRegimeConfig',
      putMethod: 'updateMarketRegimeConfig',
    },
    {
      path: 'black-swan',
      getMethod: 'getBlackSwan',
      putMethod: 'updateBlackSwan',
    },
    {
      path: 'morning-checkup',
      getMethod: 'getMorningCheckupConfig',
      putMethod: 'updateMorningCheckupConfig',
    },
  ];

  for (const e of endpoints) {
    assert(
      new RegExp(`async\\s+${e.getMethod}\\s*\\(`).test(controllerSrc),
      `RiskController.ts 必须存在 ${e.getMethod} method (UI GET /risk/${e.path} 依赖)`
    );
    assert(
      new RegExp(`async\\s+${e.putMethod}\\s*\\(`).test(controllerSrc),
      `RiskController.ts 必须存在 ${e.putMethod} method (UI PUT /risk/${e.path} 依赖)`
    );
    assert(
      new RegExp(`router\\.get\\(\\s*['"]\\/${e.path}['"]`).test(routesSrc),
      `risk.routes.ts 必须挂 GET '/${e.path}'`
    );
    assert(
      new RegExp(`router\\.put\\(\\s*['"]\\/${e.path}['"]`).test(routesSrc),
      `risk.routes.ts 必须挂 PUT '/${e.path}' (漏 PUT 导致 UI Save 按钮 404)`
    );
  }
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
console.log('');
if (fail === 0) {
  console.log(`✓ risk-parameters-center-tab: ${pass}/${pass} OK`);
  process.exit(0);
} else {
  console.log(`✗ risk-parameters-center-tab: ${pass} passed, ${fail} FAILED`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
