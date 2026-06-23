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

function assert(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed += 1;
    console.log(`  ok  ${name}${detail ? ` (${detail})` : ''}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}${detail ? ` (${detail})` : ''}`);
  }
}

const routes = fs.readFileSync(path.join(__dirname, '../../src/api/routes/quant.routes.ts'), 'utf8');
const controller = fs.readFileSync(
  path.join(__dirname, '../../src/api/controllers/QuantController.ts'),
  'utf8'
);

console.log('\n## quant workflow readiness routes');

assert(
  'GET /workflow-presets is authenticated',
  /router\.get\(\s*['"]\/workflow-presets['"][\s\S]{0,160}?authController\.authenticate[\s\S]{0,160}?getWorkflowPresets/.test(
    routes
  )
);
assert(
  'POST /workflow-readiness/evaluate is authenticated',
  /router\.post\(\s*['"]\/workflow-readiness\/evaluate['"][\s\S]{0,180}?authController\.authenticate[\s\S]{0,180}?evaluateWorkflowReadiness/.test(
    routes
  )
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
