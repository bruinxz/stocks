// backend/tests/quality/test_l2_verb_hard_fail.test.ts
// Task #52 v0 · L2 HTTP verb hard-fail lint
// 承接: Task #6 §API-Contract L2 warning-only → 升级为 hard-fail
// SHA-lock: f8ae20b (main @ 42 PR · post 十五连胜 8-22)
// Strategy Path AD 承接锚 · verb 收窄 SOP verbatim

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '../../..');
const ROUTES_DIRS = [
  join(REPO_ROOT, 'backend/src/api/routes'),
  join(REPO_ROOT, 'backend/src/live-trading/routes'),
];
const FORBIDDEN_VERB_RE = /router\.(head|options|all)\s*\(/g;

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

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

(async () => {
  let pass = 0, fail = 0;
  const violations: Array<{ file: string; matches: string[] }> = [];

  for (const dir of ROUTES_DIRS) {
    for (const f of walk(dir)) {
      const src = stripComments(readFileSync(f, 'utf8'));
      const matches = Array.from(src.matchAll(FORBIDDEN_VERB_RE), (m) => m[0]);
      if (matches.length > 0) violations.push({ file: f, matches });
    }
  }

  try {
    assert.equal(
      violations.length,
      0,
      `L2 verb hard-fail: ${violations.length} route file(s) use forbidden verb (head/options/all):\n` +
        violations.map((v) => `  ${v.file}: ${v.matches.join(', ')}`).join('\n'),
    );
    pass++;
    console.log('✅ L2 verb hard-fail: all route files use only get/post/put/delete/patch');
  } catch (e) {
    fail++;
    console.error(`❌ L2 verb hard-fail: ${(e as Error).message}`);
  }

  console.log(`\n=== test_l2_verb_hard_fail v0: ${pass} pass / ${fail} fail ===`);
  if (fail > 0) process.exit(1);
})();
