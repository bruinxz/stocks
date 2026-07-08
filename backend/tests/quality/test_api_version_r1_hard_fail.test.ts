// backend/tests/quality/test_api_version_r1_hard_fail.test.ts
// Task #51 Phase 1 T+3d · ADR-0010 §R1 /api/v1/* URL prefix hard-fail assertion
// 承接: Path η #1 v0.1 evolution · R1 warning-only → hard-fail 升级
// SHA-lock: d6a0c1e (baseline: docs/refactor/baseline/api/api-version-header-baseline-d6a0c1e.json)
//
// 前置件: Backend Phase 1 T+3d `/api/v1/*` mount PR MERGED
// 本 test 当前状态: skip-stub default-on (backend mount 未 landed)
// skip → hard-fail 转换触发件: Backend mount PR MERGED confirmed + RUN_R1_R2_HARD_FAIL=1 env set
// baseline JSON policy.test_gating_mode = "skip-stub" · policy.test_gating_wire_procedure_step 定义 4-step wire
//
// R1 rule: 所有 app.use('/api/*', ...) route mount 必须走 '/api/v1/*' prefix
// R1 scope: backend/src/index.ts

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SKIP = process.env.RUN_R1_R2_HARD_FAIL !== '1';
const REPO_ROOT = resolve(__dirname, '../../..');
const INDEX_TS = resolve(REPO_ROOT, 'backend/src/index.ts');
const API_MOUNT_RE = /app\.use\(\s*['"`](\/api\/[^'"`]+)['"`]/g;

(async () => {
  let pass = 0, fail = 0;

  if (SKIP) {
    console.log(
      '[skip-stub] R1 /api/v1/* prefix hard-fail SKIPPED · RUN_R1_R2_HARD_FAIL != 1 · Backend Phase 1 T+3d mount 前置件未 landed',
    );
    console.log('[skip-stub] 转 hard-fail 触发件: Backend mount PR MERGED + RUN_R1_R2_HARD_FAIL=1 env set');
    console.log(`\n=== test_api_version_r1_hard_fail v0.1 [SKIP-STUB]: 0 pass / 0 fail (skip) ===`);
    process.exit(0);
  }

  const src = readFileSync(INDEX_TS, 'utf8');
  const mounts = Array.from(src.matchAll(API_MOUNT_RE), (m) => m[1]);
  const violations = mounts.filter((path) => !path.startsWith('/api/v1/'));

  try {
    assert.equal(
      violations.length,
      0,
      `R1 /api/v1/* prefix hard-fail: ${violations.length} mount(s) 未走 /api/v1/* prefix:\n` +
        violations.map((p) => `  ${p}`).join('\n'),
    );
    pass++;
    console.log(`✅ R1 /api/v1/* prefix hard-fail: ${mounts.length} mount 全走 /api/v1/* prefix`);
  } catch (e) {
    fail++;
    console.error(`❌ R1 /api/v1/* prefix hard-fail: ${(e as Error).message}`);
  }

  console.log(`\n=== test_api_version_r1_hard_fail v0.1: ${pass} pass / ${fail} fail ===`);
  if (fail > 0) process.exit(1);
})();
