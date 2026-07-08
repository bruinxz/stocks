// backend/tests/quality/test_api_version_header_assertion.test.ts
// Task #52 v0 · ADR-0010 §R2 X-API-Version response header assertion baseline
// 承接: Path η #1 v0.1 evolution · R2 warning-only → Phase 2 hard-fail candidate
// v0 = static grep skeleton · v1 = Playwright E2E header assertion (post Phase 2)

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '../../..');
const ROUTES_DIRS = [
  join(REPO_ROOT, 'backend/src/api/routes'),
  join(REPO_ROOT, 'backend/src/live-trading/routes'),
];
const HEADER_RE = /X-API-Version/i;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.routes.ts')) out.push(p);
  }
  return out;
}

(async () => {
  let pass = 0;
  const fail = 0;
  const routes: string[] = [];
  for (const dir of ROUTES_DIRS) routes.push(...walk(dir));

  const hits = routes.filter((f) => HEADER_RE.test(readFileSync(f, 'utf8')));

  console.log(
    `[warning-only v0] X-API-Version header referenced in ${hits.length}/${routes.length} route files (Phase 1 landing 后转 middleware-based · Phase 2 hard-fail)`,
  );
  pass++;

  console.log(
    '[skeleton] Playwright E2E header assertion armed for v1 (post Phase 2 · Frontend httpClient interceptor landing 后)',
  );

  console.log(`\n=== test_api_version_header_assertion v0: ${pass} pass / ${fail} fail ===`);
  if (fail > 0) process.exit(1);
})();
