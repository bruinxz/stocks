/**
 * Source-level route contract for phase 1 research credibility APIs.
 */
import fs from 'fs';
import path from 'path';

let passed = 0;
let failed = 0;

function assert(name: string, cond: boolean, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`  ok  ${name}${detail ? ` (${detail})` : ''}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}${detail ? ` (${detail})` : ''}`);
  }
}

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.resolve(__dirname, '../../', relativePath), 'utf8');
}

console.log('\n## Quant research route contract');

const routes = readRepoFile('src/api/routes/quant.routes.ts');
const controller = readRepoFile('src/api/controllers/QuantController.ts');
const facade = readRepoFile('src/quant/backtest/BacktestEngine.ts');
const service = readRepoFile('src/services/research/ResearchExperimentService.ts');

assert('research experiment list route exists', routes.includes("'/research-experiments'"));
assert('backtest research audit route exists', routes.includes("'/backtests/:id/research-audit'"));
assert(
  'execution constraint audit route exists',
  routes.includes("'/backtests/:id/execution-constraint-audit'")
);
assert(
  'execution constraint route is registered before generic backtest detail route',
  routes.indexOf("'/backtests/:id/execution-constraint-audit'") > -1 &&
    routes.indexOf("'/backtests/:id/execution-constraint-audit'") <
      routes.indexOf("'/backtests/:id'")
);
assert(
  'controller exposes execution audit handler',
  controller.includes('getBacktestExecutionConstraintAudit')
);
assert(
  'facade exposes execution audit method',
  facade.includes('getBacktestExecutionConstraintAudit')
);
assert(
  'service exposes execution audit payload method',
  service.includes('getBacktestExecutionConstraintAudit')
);
assert(
  'research audit includes point-in-time artifact integration',
  service.includes('buildPointInTimeArtifact') && service.includes('point_in_time')
);

console.log(`\nResult: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
