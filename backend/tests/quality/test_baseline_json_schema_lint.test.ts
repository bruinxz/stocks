// backend/tests/quality/test_baseline_json_schema_lint.test.ts
// Task #52 v0 · baseline JSON schema 一致性 lint
// 承接: Strategy Path AF baseline JSON pattern hardening 引用锚
// 断言: docs/refactor/baseline/{api,quality}/**/*.json 每 file 必含 sha_lock + entries + burndown_history 三键
// v0 scope: {api, quality} 硬门禁 · {security} v1 承接后 grandfather 迁移

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '../../..');
const BASELINE_DIR = join(REPO_ROOT, 'docs/refactor/baseline');

// v0 硬门禁 scope · v1 扩展至 security 承接 grandfather 迁移
const HARD_SCOPE_SUBDIRS = ['api', 'quality'];

function walkJson(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) out.push(...walkJson(p));
    else if (p.endsWith('.json')) out.push(p);
  }
  return out;
}

(async () => {
  let pass = 0;
  let fail = 0;
  let warn = 0;
  const files = walkJson(BASELINE_DIR);
  console.log(`baseline JSON discovered: ${files.length} files under docs/refactor/baseline/**`);

  for (const f of files) {
    const rel = f.replace(BASELINE_DIR + '/', '');
    const inHardScope = HARD_SCOPE_SUBDIRS.some((sub) => rel.startsWith(sub + '/'));
    try {
      const j = JSON.parse(readFileSync(f, 'utf8'));
      assert.ok('sha_lock' in j, `${f}: missing sha_lock`);
      assert.ok(Array.isArray(j.entries), `${f}: entries not array`);
      assert.ok(Array.isArray(j.burndown_history), `${f}: burndown_history not array`);
      pass++;
      console.log(`  ✅ ${rel}`);
    } catch (e) {
      const msg = (e as Error).message;
      if (inHardScope) {
        fail++;
        console.error(`  ❌ ${rel}: ${msg}`);
      } else {
        warn++;
        console.warn(`  ⚠️  [v0 warn] ${rel}: ${msg} (v1 grandfather 迁移承接位)`);
      }
    }
  }

  console.log(
    `\n=== test_baseline_json_schema_lint v0: ${pass} pass / ${fail} fail / ${warn} warn (v1 grandfather) ===`,
  );
  if (fail > 0) process.exit(1);
})();
