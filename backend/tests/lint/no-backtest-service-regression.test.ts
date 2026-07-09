/**
 * no-backtest-service-regression.test.ts
 *
 * ADR-0011 §5 · UI enum SSOT · PR-M3-4 pre-guard for PR-M3-2 (Frontend elim
 * legacy `backtestService`).
 *
 * Purpose: walk `frontend/src/**\/*.{ts,tsx}` and assert zero import matches
 * `backtestService`. Wall-of-shame current-state (pass) → semantic hard-fail
 * post-PR-M3-2 land (Frontend 主签 · elim id=15 legacy · migrate consumers to
 * `labService` BacktestTask.status).
 *
 * 不依赖 jest · node 直接跑:
 *   cd backend && npx ts-node --transpile-only tests/lint/no-backtest-service-regression.test.ts
 */
import * as fs from 'fs';
import * as path from 'path';

const frontendSrcDir = path.resolve(__dirname, '../../../frontend/src');
const importPattern = /(?:import\s+(?:[\s\S]+?)\s+from\s+|require\s*\(\s*)['"]([^'"]*backtestService[^'"]*)['"]/g;

interface Offender {
  file: string;
  line: number;
  match: string;
}

function walk(dir: string, acc: string[] = []): string[] {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
    if (entry.name === 'backtestService.ts') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, acc);
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name)) {
      acc.push(full);
    }
  }
  return acc;
}

let passed = 0;
let failed = 0;

function assert(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed += 1;
    console.log(`  ok  ${name}${detail ? ` (${detail})` : ''}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${name}${detail ? ` (${detail})` : ''}`);
  }
}

console.log('\n## ADR-0011 §5 · no-backtest-service-regression (PR-M3-2 pre-guard)');

const files = walk(frontendSrcDir);
assert(
  'frontend/src walk found at least one .ts/.tsx file',
  files.length > 0,
  `count=${files.length}`
);

const offenders: Offender[] = [];
for (const file of files) {
  const content = fs.readFileSync(file, 'utf8');
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    importPattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = importPattern.exec(line)) !== null) {
      offenders.push({
        file: path.relative(frontendSrcDir, file),
        line: i + 1,
        match: m[1],
      });
    }
  }
}

if (offenders.length > 0) {
  console.error('\n  Wall-of-shame · legacy `backtestService` consumers:');
  for (const o of offenders) {
    console.error(`    - ${o.file}:${o.line} → ${o.match}`);
  }
}

// Baseline residual: BacktestResults.tsx is the last known consumer, awaiting
// PR-M3-2 (Frontend 主签 · T+7d 2026-07-16) migration to `labService`
// BacktestTask.status (id=15 legacy elim). Assertion locks the count from
// growing; PR-M3-2 must tighten this to `=== 0` at land time.
const KNOWN_RESIDUAL = 1;
assert(
  `frontend/src consumers of legacy backtestService <= ${KNOWN_RESIDUAL} (PR-M3-2 pre-guard · post-M3-2 tighten to 0)`,
  offenders.length <= KNOWN_RESIDUAL,
  `offenders=${offenders.length} known-residual=${KNOWN_RESIDUAL}`
);

console.log(`\nResult: ${passed} passed, ${failed} failed, 0 skipped`);
process.exit(failed > 0 ? 1 : 0);
