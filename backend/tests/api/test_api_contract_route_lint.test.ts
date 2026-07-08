/**
 * test_api_contract_route_lint.test.ts
 *
 * Task #6 · §API-Contract 集中 route lint
 *
 * 7 lint rules:
 *  L1 · Route inventory zero-orphan (每 .routes.ts 必被 backend/src/index.ts 挂载)
 *  L2 · HTTP verb 收窄 (只允 get/post/put/delete/patch)
 *  L3 · Auth middleware 敏感 endpoint 覆盖
 *  L4 · 路径命名 kebab-case (segment · :param 允 camelCase)
 *  L5 · async handler 承接 (warning-only baseline)
 *  L6 · 敏感字段 response 泄露 (zero hard-fail bar)
 *  L7 · Rate-limit 敏感 endpoint (warning-only baseline)
 *
 * lesson anchors: #1 Layer-Separation · #11 broadcast pin · #12 反向应用第九例
 * dod v4.2 铁律 14/15 项 (S0.5 multi-stage · S0.6 test 层 grep)
 *
 * baseline: docs/refactor/baseline/api/task-6-baseline-42d6d0d6.json
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { strict as assert } from 'node:assert';

const REPO_ROOT = join(__dirname, '../../..');
const API_ROUTES_DIR = join(REPO_ROOT, 'backend/src/api/routes');
const LIVE_ROUTES_DIR = join(REPO_ROOT, 'backend/src/live-trading/routes');
const INDEX_TS = join(REPO_ROOT, 'backend/src/index.ts');
const BASELINE_JSON = join(REPO_ROOT, 'docs/refactor/baseline/api/task-6-baseline-42d6d0d6.json');

const SENSITIVE_ROUTES_AUTH = [
  'paperTrading', 'quant', 'settings', 'task', 'liveTrading', 'bridge',
  'risk', 'riskAlert', 'portfolio', 'journal', 'review', 'userFeedback',
];

const RATE_LIMIT_SENSITIVE = ['paperTrading', 'quant', 'liveTrading', 'bridge'];

const AUTH_PATTERN = /authRequired|requireAuth|isAuthenticated|verifyToken|authMiddleware|requireLogin|authenticateJWT|bridgeAuth|\.authenticate\b|authController\.authenticate/;
const RATE_LIMIT_PATTERN = /rateLimit|rateLimiter|limiter|throttle/;

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

function listRouteFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => f.endsWith('.routes.ts'))
    .map(f => join(dir, f));
}

const ALL_ROUTE_FILES = [
  ...listRouteFiles(API_ROUTES_DIR),
  ...listRouteFiles(LIVE_ROUTES_DIR),
];

(async () => {
  console.log('[test_api_contract_route_lint] start · route files =', ALL_ROUTE_FILES.length);

  // Baseline JSON exists + policy shape
  {
    assert.ok(existsSync(BASELINE_JSON), `baseline JSON missing: ${BASELINE_JSON}`);
    const bl = JSON.parse(readFileSync(BASELINE_JSON, 'utf8'));
    assert.equal(bl.sha_lock, '42d6d0d6', 'baseline sha_lock must be 42d6d0d6 (rebased onto main)');
    assert.ok(Array.isArray(bl.entries), 'baseline entries must be array');
    assert.equal(bl.entries.length, 0, 'baseline initial entries must be empty');
    console.log('[baseline] initial state ok · sha_lock=42d6d0d6 · entries=[]');
  }

  // Route inventory sanity
  assert.ok(ALL_ROUTE_FILES.length >= 29, `route file count regression: ${ALL_ROUTE_FILES.length} < 29`);

  // L1 · zero orphan
  {
    const indexSrc = readFileSync(INDEX_TS, 'utf8');
    const orphans: string[] = [];
    for (const f of ALL_ROUTE_FILES) {
      const name = basename(f).replace('.routes.ts', '');
      const relApi = `./api/routes/${name}.routes`;
      const relLive = `./live-trading/routes/${name}.routes`;
      const hitApi = indexSrc.includes(`'${relApi}'`) || indexSrc.includes(`"${relApi}"`);
      const hitLive = indexSrc.includes(`'${relLive}'`) || indexSrc.includes(`"${relLive}"`);
      if (!hitApi && !hitLive) orphans.push(name);
    }
    assert.deepEqual(orphans, [], `L1 orphan route files: ${JSON.stringify(orphans)}`);
    console.log(`[L1] zero-orphan pass · ${ALL_ROUTE_FILES.length} route files mounted`);
  }

  // L2 · verb 收窄
  {
    const violations: Array<{file: string; verb: string}> = [];
    const forbidden = /router\.(head|options|all|checkout|copy|lock|mkcol|move|purge|report|search|subscribe|trace|unlock|unsubscribe)\(/g;
    for (const f of ALL_ROUTE_FILES) {
      const src = stripComments(readFileSync(f, 'utf8'));
      let m: RegExpExecArray | null;
      while ((m = forbidden.exec(src))) {
        violations.push({file: basename(f), verb: m[1]});
      }
    }
    assert.equal(violations.length, 0, `L2 forbidden verbs: ${JSON.stringify(violations)}`);
    console.log('[L2] HTTP verb narrow pass');
  }

  // L3 · Auth middleware 敏感覆盖
  {
    const gaps: string[] = [];
    for (const name of SENSITIVE_ROUTES_AUTH) {
      const routeFile = ALL_ROUTE_FILES.find(f => basename(f) === `${name}.routes.ts`);
      if (!routeFile) continue;
      const src = stripComments(readFileSync(routeFile, 'utf8'));
      if (!AUTH_PATTERN.test(src)) gaps.push(name);
    }
    assert.deepEqual(gaps, [], `L3 sensitive route auth gap: ${JSON.stringify(gaps)}`);
    console.log(`[L3] auth sensitive coverage pass · ${SENSITIVE_ROUTES_AUTH.length} routes`);
  }

  // L4 · kebab-case path
  {
    const violations: Array<{file: string; path: string; seg: string}> = [];
    for (const f of ALL_ROUTE_FILES) {
      const src = stripComments(readFileSync(f, 'utf8'));
      const re = /router\.(get|post|put|delete|patch)\(\s*['"`]([^'"`]+)['"`]/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        const path = m[2];
        for (const seg of path.split('/').filter(Boolean)) {
          if (seg.startsWith(':')) continue;
          if (!/^[a-z0-9][a-z0-9-]*$/.test(seg)) {
            violations.push({file: basename(f), path, seg});
            break;
          }
        }
      }
    }
    assert.equal(violations.length, 0, `L4 kebab-case violations: ${JSON.stringify(violations)}`);
    console.log('[L4] kebab-case path naming pass');
  }

  // L5 · async handler 承接 (warning-only baseline)
  {
    let warnings = 0;
    for (const f of ALL_ROUTE_FILES) {
      const src = readFileSync(f, 'utf8');
      const lines = src.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (/\basync\s*\(/.test(lines[i]) && !lines[i].includes('asyncHandler(')) {
          const ctx = lines.slice(Math.max(0, i - 2), Math.min(lines.length, i + 8)).join('\n');
          if (!ctx.includes('asyncHandler(') && !ctx.includes('.catch(next)') && !ctx.includes('try {')) {
            warnings++;
          }
        }
      }
    }
    console.log(`[L5] async handler heuristic · warnings=${warnings} (baseline warning-only · future fail-mode)`);
  }

  // L6 · 敏感字段 response 泄露
  {
    const FORBIDDEN_FIELDS = ['password_hash', 'passwordHash', 'private_key', 'privateKey'];
    const violations: Array<{file: string; field: string}> = [];
    for (const f of ALL_ROUTE_FILES) {
      const src = stripComments(readFileSync(f, 'utf8'));
      for (const field of FORBIDDEN_FIELDS) {
        const re = new RegExp(`res\\.(json|send)\\s*\\([^)]*\\b${field}\\b`);
        if (re.test(src)) violations.push({file: basename(f), field});
      }
    }
    assert.deepEqual(violations, [], `L6 sensitive field leak: ${JSON.stringify(violations)}`);
    console.log('[L6] sensitive field response leak pass');
  }

  // L7 · Rate-limit 敏感覆盖 (warning-only baseline)
  {
    const gaps: string[] = [];
    for (const name of RATE_LIMIT_SENSITIVE) {
      const routeFile = ALL_ROUTE_FILES.find(f => basename(f) === `${name}.routes.ts`);
      if (!routeFile) continue;
      const src = stripComments(readFileSync(routeFile, 'utf8'));
      if (!RATE_LIMIT_PATTERN.test(src)) gaps.push(name);
    }
    console.log(`[L7] rate-limit sensitive · gaps=${JSON.stringify(gaps)} (baseline warning-only · future fail-mode)`);
  }

  console.log('[test_api_contract_route_lint] all pass');
})().catch(err => {
  console.error('[test_api_contract_route_lint] FAIL', err);
  process.exit(1);
});
