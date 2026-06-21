/**
 * paperTrading.portfolio-crud.test.ts — AT-1 (2026-06-22)
 *
 *   cd backend && npx ts-node --transpile-only tests/api/paperTrading.portfolio-crud.test.ts
 *
 * 端点 schema + jsdoc 完整性校验. 不接 HTTP — 用 fs + regex 验证 7 个新 endpoint
 * (routes + controller method) 都注册完整且 OpenAPI jsdoc 含必备字段.
 */

import * as fs from 'fs';
import * as path from 'path';

let passed = 0;
let failed = 0;
function assert(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL ${name}${detail ? ' — ' + detail : ''}`);
  }
}

const ROOT = path.resolve(__dirname, '../..');
const routesText = fs.readFileSync(
  path.join(ROOT, 'src/api/routes/paperTrading.routes.ts'),
  'utf8'
);
const ctrlText = fs.readFileSync(
  path.join(ROOT, 'src/api/controllers/PaperTradingController.ts'),
  'utf8'
);

// ---------- [1] 7 endpoints registered ----------
function test_endpoints_registered(): void {
  const endpoints = [
    { method: 'GET', spec: '/portfolios', desc: 'list portfolios (扩展)' },
    { method: 'POST', spec: '/portfolios', desc: 'create portfolio' },
    { method: 'GET', spec: '/portfolios/:id', desc: 'get portfolio detail' },
    { method: 'PUT', spec: '/portfolios/:id', desc: 'update portfolio' },
    { method: 'DELETE', spec: '/portfolios/:id', desc: 'delete portfolio' },
    { method: 'POST', spec: '/portfolios/:id/reset', desc: 'reset portfolio' },
    { method: 'GET', spec: '/strategies/available', desc: 'list strategies' },
    { method: 'GET', spec: '/factors/available', desc: 'list factors' },
  ];
  for (const ep of endpoints) {
    const escapedPath = ep.spec.replace(/[/:]/g, '\\$&');
    const re = new RegExp(`router\\.${ep.method.toLowerCase()}\\s*\\(\\s*\\n?\\s*['"]${escapedPath}['"]`);
    assert(`[1] ${ep.method} ${ep.spec} (${ep.desc})`, re.test(routesText));
  }
}

// ---------- [2] OpenAPI jsdoc 含路径声明 ----------
function test_jsdoc_present(): void {
  const openapiPaths = [
    '/api/paper-trading/portfolios:',
    '/api/paper-trading/portfolios/{id}:',
    '/api/paper-trading/portfolios/{id}/reset:',
    '/api/paper-trading/strategies/available:',
    '/api/paper-trading/factors/available:',
  ];
  for (const p of openapiPaths) {
    assert(`[2] OpenAPI jsdoc ${p}`, routesText.includes(p));
  }
}

// ---------- [3] 资金字段保护 ----------
function test_money_field_protection(): void {
  // controller updatePortfolio 显式拒 initial_capital / current_cash / total_value
  assert(
    '[3] updatePortfolio 422 拒 initial_capital',
    /FORBIDDEN[\s\S]*initial_capital[\s\S]*current_cash[\s\S]*total_value/.test(ctrlText)
  );
  // OpenAPI jsdoc 中 PUT body 不含 initial_capital 作为可填属性 (visual review-friendly)
  // 注意: 422 description 行允许提到 initial_capital (描述拒绝原因), 这里查 schema.properties 段
  const putBlock = routesText.match(/put:[\s\S]*?responses:/);
  if (putBlock) {
    assert(
      '[3] PUT jsdoc body schema 不含 initial_capital 属性',
      !/initial_capital:\s*\{/.test(putBlock[0])
    );
  }
}

// ---------- [4] 7 controller methods present + 调用 service ----------
function test_controller_methods(): void {
  const methods = [
    'getPortfolioDetail',
    'createPortfolio',
    'updatePortfolio',
    'deletePortfolio',
    'resetPortfolio',
    'listAvailableStrategies',
    'listAvailableFactors',
  ];
  for (const m of methods) {
    const re = new RegExp(`\\b${m}\\s*=\\s*async\\s*\\(`);
    assert(`[4] controller has ${m}`, re.test(ctrlText));
  }
  // 都从 service 调用 (而不是直接操作 model)
  assert(
    '[4] createPortfolio 调 service.createForUser',
    /paperTradingPortfolioCrudService\.createForUser/.test(ctrlText)
  );
  assert(
    '[4] updatePortfolio 调 service.updateForUser',
    /paperTradingPortfolioCrudService\.updateForUser/.test(ctrlText)
  );
  assert(
    '[4] deletePortfolio 调 service.deleteForUser',
    /paperTradingPortfolioCrudService\.deleteForUser/.test(ctrlText)
  );
  assert(
    '[4] resetPortfolio 调 service.resetForUser',
    /paperTradingPortfolioCrudService\.resetForUser/.test(ctrlText)
  );
  assert(
    '[4] listAvailableStrategies 调 service',
    /paperTradingPortfolioCrudService\.listAvailableStrategies/.test(ctrlText)
  );
  assert(
    '[4] listAvailableFactors 调 service',
    /paperTradingPortfolioCrudService\.listAvailableFactors/.test(ctrlText)
  );
  assert(
    '[4] getPortfolioDetail 调 service',
    /paperTradingPortfolioCrudService\.getDetailForUser/.test(ctrlText)
  );
}

// ---------- [5] auth 所有新 route 必须经过 authenticate ----------
function test_auth_protected(): void {
  const newRoutes = [
    /router\.post\s*\(\s*['"]\/portfolios['"]\s*,\s*authController\.authenticate/,
    /router\.get\s*\(\s*\n?\s*['"]\/portfolios\/:id['"]\s*,\s*authController\.authenticate/,
    /router\.put\s*\(\s*\n?\s*['"]\/portfolios\/:id['"]\s*,\s*authController\.authenticate/,
    /router\.delete\s*\(\s*\n?\s*['"]\/portfolios\/:id['"]\s*,\s*authController\.authenticate/,
    /router\.post\s*\(\s*\n?\s*['"]\/portfolios\/:id\/reset['"]\s*,\s*authController\.authenticate/,
    /router\.get\s*\(\s*\n?\s*['"]\/strategies\/available['"]\s*,\s*authController\.authenticate/,
    /router\.get\s*\(\s*\n?\s*['"]\/factors\/available['"]\s*,\s*authController\.authenticate/,
  ];
  for (const re of newRoutes) {
    assert(`[5] route protected by authenticate (${re.toString().slice(0, 60)}…)`, re.test(routesText));
  }
}

// ---------- [6] 路由顺序: /portfolios/:id 之前必须有 /portfolios (静态路径) ----------
function test_route_order(): void {
  const ix_static_get = routesText.search(/router\.get\s*\(\s*['"]\/portfolios['"]/);
  const ix_static_post = routesText.search(/router\.post\s*\(\s*['"]\/portfolios['"]/);
  const ix_dynamic_get = routesText.search(/router\.get\s*\(\s*\n?\s*['"]\/portfolios\/:id['"]/);
  const ix_dynamic_reset = routesText.search(/router\.post\s*\(\s*\n?\s*['"]\/portfolios\/:id\/reset['"]/);
  assert(
    '[6] GET /portfolios before GET /portfolios/:id',
    ix_static_get > 0 && ix_static_get < ix_dynamic_get
  );
  assert(
    '[6] POST /portfolios before POST /portfolios/:id/reset',
    ix_static_post > 0 && ix_static_post < ix_dynamic_reset
  );
}

// ============================================================
(async () => {
  console.log('# paperTrading.portfolio-crud.test.ts (AT-1)');
  console.log('## [1] 7 endpoints registered');
  test_endpoints_registered();
  console.log('## [2] OpenAPI jsdoc');
  test_jsdoc_present();
  console.log('## [3] money field protection');
  test_money_field_protection();
  console.log('## [4] controller methods + service wiring');
  test_controller_methods();
  console.log('## [5] auth protected');
  test_auth_protected();
  console.log('## [6] route order');
  test_route_order();

  console.log(`\n# summary: ${passed} ok, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
