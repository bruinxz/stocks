/**
 * market-sensitive-routes-auth.test.ts
 *
 * Regression guard: market data mutation / queue-control endpoints must be
 * explicitly protected at the route layer. These routes can trigger expensive
 * sync jobs or mutate operational queue state, so they require both JWT auth
 * and admin authorization.
 */

import * as fs from 'fs';
import * as path from 'path';

let failed = 0;
let passed = 0;

function assert(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed += 1;
    console.log(`  ok  ${name}${detail ? ` (${detail})` : ''}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}${detail ? ` (${detail})` : ''}`);
  }
}

function extractRouteCall(src: string, route_path: string): string | null {
  const escaped_route_path = route_path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const route_pattern = new RegExp(`router\\.post\\(\\s*['"]${escaped_route_path}['"]`);
  const match = route_pattern.exec(src);
  if (!match) return null;

  const end = src.indexOf(');', match.index);
  if (end < 0) return null;

  return src.slice(match.index, end + 2);
}

const source = fs.readFileSync(
  path.join(__dirname, '../../src/api/routes/market.routes.ts'),
  'utf8'
);

const sensitive_routes = [
  { route_path: '/update-data', handler: 'marketController.updateData' },
  { route_path: '/manual-sync', handler: 'marketController.triggerManualSync' },
  { route_path: '/bulk-sync', handler: 'marketController.triggerBulkSync' },
  { route_path: '/clean-queue', handler: 'marketController.cleanUpdateQueue' },
  { route_path: '/queue/:jobId/cancel', handler: 'marketController.cancelJob' },
  { route_path: '/queue/:jobId/retry', handler: 'marketController.retryJob' },
  { route_path: '/factors/sync', handler: 'marketController.syncFactors' },
  {
    route_path: '/data-completeness/refresh',
    handler: 'marketController.refreshDataCompletenessCache',
  },
];

console.log('\n## market.routes sensitive POST endpoints require auth + admin');

assert(
  'routes file imports requireRole middleware',
  /import\s+\{\s*requireRole\s*\}\s+from\s+['"]\.\.\/\.\.\/middlewares\/auth['"]/.test(source)
);

for (const item of sensitive_routes) {
  const route_call = extractRouteCall(source, item.route_path);
  assert(`${item.route_path}: route registration exists`, !!route_call);
  if (!route_call) continue;

  const auth_idx = route_call.indexOf('authController.authenticate');
  const role_idx = route_call.indexOf("requireRole('admin')");
  const handler_idx = route_call.indexOf(item.handler);

  assert(`${item.route_path}: includes JWT auth middleware`, auth_idx >= 0);
  assert(`${item.route_path}: includes admin role middleware`, role_idx >= 0);
  assert(`${item.route_path}: includes expected controller handler`, handler_idx >= 0);
  assert(
    `${item.route_path}: auth runs before admin role and controller`,
    auth_idx >= 0 && role_idx > auth_idx && handler_idx > role_idx
  );
}

console.log(`\nResult: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
