// backend/tests/quality/test_api_version_r2_hard_fail.test.ts
// Task #51 Phase 1 T+3d · ADR-0010 §R2 X-API-Version response header hard-fail assertion
// 承接: Path η #1 v0.1 evolution · R2 warning-only → hard-fail 升级
// SHA-lock: d6a0c1e (baseline: docs/refactor/baseline/api/api-version-header-baseline-d6a0c1e.json)
//
// 前置件: Backend Phase 1 T+3d `/api/v1/*` mount PR MERGED
//         + backend/src/api/middleware/api-version.ts middleware 挂载 landed
// 本 test 当前状态: skip-stub default-on (backend middleware 未 landed)
// skip → hard-fail 转换触发件: Backend mount + api-version middleware PR MERGED + RUN_R1_R2_HARD_FAIL=1 env set
//
// R2 rule: response 必须携带 `X-API-Version: 1` header (middleware 全局挂载 · 所有 /api/v1/* endpoint 生效)
// R2 scope: backend/src/api/middleware/api-version.ts (前置件文件 · 本 PR 未创建)

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SKIP = process.env.RUN_R1_R2_HARD_FAIL !== '1';
const REPO_ROOT = resolve(__dirname, '../../..');
const MIDDLEWARE_PATH = resolve(REPO_ROOT, 'backend/src/api/middleware/api-version.ts');
const INDEX_TS = resolve(REPO_ROOT, 'backend/src/index.ts');
const HEADER_LITERAL = 'X-API-Version';
const HEADER_VALUE = '1';

(async () => {
  let pass = 0, fail = 0;

  if (SKIP) {
    console.log(
      '[skip-stub] R2 X-API-Version: 1 header hard-fail SKIPPED · RUN_R1_R2_HARD_FAIL != 1 · Backend Phase 1 T+3d middleware 前置件未 landed',
    );
    console.log(
      '[skip-stub] 转 hard-fail 触发件: Backend mount + api-version middleware PR MERGED + RUN_R1_R2_HARD_FAIL=1 env set',
    );
    console.log(`\n=== test_api_version_r2_hard_fail v0.1 [SKIP-STUB]: 0 pass / 0 fail (skip) ===`);
    process.exit(0);
  }

  try {
    assert.ok(
      existsSync(MIDDLEWARE_PATH),
      `R2 middleware file 缺失: ${MIDDLEWARE_PATH} (前置件 Backend Phase 1 T+3d mount PR 未 landed)`,
    );
    const middleware = readFileSync(MIDDLEWARE_PATH, 'utf8');
    assert.ok(
      middleware.includes(HEADER_LITERAL),
      `R2 middleware 缺 X-API-Version header literal: ${MIDDLEWARE_PATH}`,
    );
    assert.ok(
      middleware.includes(`'${HEADER_VALUE}'`) || middleware.includes(`"${HEADER_VALUE}"`),
      `R2 middleware 缺 header value '${HEADER_VALUE}': ${MIDDLEWARE_PATH}`,
    );

    const indexSrc = readFileSync(INDEX_TS, 'utf8');
    assert.ok(
      /apiVersion|api-version|apiVersionMiddleware/.test(indexSrc),
      `R2 middleware 未在 backend/src/index.ts 挂载: 期望 app.use(apiVersionMiddleware) 或等价挂载`,
    );

    pass++;
    console.log(`✅ R2 X-API-Version: ${HEADER_VALUE} header hard-fail: middleware landed + 全局挂载 verified`);
  } catch (e) {
    fail++;
    console.error(`❌ R2 X-API-Version header hard-fail: ${(e as Error).message}`);
  }

  console.log(`\n=== test_api_version_r2_hard_fail v0.1: ${pass} pass / ${fail} fail ===`);
  if (fail > 0) process.exit(1);
})();
