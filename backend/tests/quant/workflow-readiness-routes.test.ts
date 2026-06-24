/**
 * workflow-readiness-routes.test.ts
 *
 * Ensures the Phase 1-3 workflow readiness service is exposed through the
 * authenticated /api/quant surface.
 */

import * as fs from 'fs';
import * as path from 'path';

let failed = 0;
let passed = 0;
const REPO_ROOT = findRepoRoot();

function assert(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed += 1;
    console.log(`  ok  ${name}${detail ? ` (${detail})` : ''}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}${detail ? ` (${detail})` : ''}`);
  }
}

function extractRouteCall(source: string, method: 'get' | 'post', routePath: string): string {
  const needle = `router.${method}(`;
  let index = source.indexOf(needle);

  while (index >= 0) {
    const routeStart = source.indexOf(routePath, index);
    const nextRoute = source.indexOf(needle, index + needle.length);

    if (routeStart >= 0 && (nextRoute < 0 || routeStart < nextRoute)) {
      const routeEnd = source.indexOf('\n);', routeStart);
      return routeEnd >= 0 ? source.slice(index, routeEnd + 3) : source.slice(index);
    }

    index = nextRoute;
  }

  return '';
}

function findRepoRoot(start = process.cwd()): string {
  let current = path.resolve(start);

  while (true) {
    if (
      fs.existsSync(path.join(current, 'frontend')) &&
      fs.existsSync(path.join(current, 'backend'))
    ) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`Cannot find repo root from ${start}`);
    }
    current = parent;
  }
}

const routes = fs.readFileSync(
  path.join(REPO_ROOT, 'backend/src/api/routes/quant.routes.ts'),
  'utf8'
);
const controller = fs.readFileSync(
  path.join(REPO_ROOT, 'backend/src/api/controllers/QuantController.ts'),
  'utf8'
);
const workflowPresetsRoute = extractRouteCall(routes, 'get', '/workflow-presets');
const readinessEvaluateRoute = extractRouteCall(routes, 'post', '/workflow-readiness/evaluate');

console.log('\n## quant workflow readiness routes');

assert(
  'GET /workflow-presets is authenticated',
  /authController\.authenticate/.test(workflowPresetsRoute) &&
    /getWorkflowPresets/.test(workflowPresetsRoute)
);
assert(
  'POST /workflow-readiness/evaluate is authenticated',
  /authController\.authenticate/.test(readinessEvaluateRoute) &&
    /evaluateWorkflowReadiness/.test(readinessEvaluateRoute)
);
assert(
  'POST /workflow-readiness/evaluate validates request body',
  /validateRequest/.test(routes) &&
    /strategy\.preset_key/.test(routes) &&
    /workflowPresetKeys/.test(routes) &&
    /validateRequest/.test(readinessEvaluateRoute)
);
assert(
  'POST /workflow-readiness/evaluate has route-level body size guard',
  /WORKFLOW_READINESS_BODY_LIMIT_BYTES\s*=\s*100\s*\*\s*1024/.test(routes) &&
    /workflowReadinessBodySizeGuard/.test(readinessEvaluateRoute) &&
    /status\(413\)/.test(routes)
);
assert(
  'controller imports workflow readiness service',
  /QuantWorkflowReadinessService/.test(controller) &&
    /evaluateQuantWorkflowReadiness/.test(controller) &&
    /getQuantWorkflowPresets/.test(controller)
);
assert(
  'controller returns readiness verdict conclusion as message',
  /message:\s*data\.verdict\.conclusion/.test(controller)
);

console.log(`\nResult: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
