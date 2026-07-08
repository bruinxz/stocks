// backend/tests/e2e/playwright-header-assertion.spec.ts
// Task #51 Phase 2 T+1w · ADR-0010 §R2 X-API-Version E2E header assertion (Playwright)
// 承接: Path η #1 v1 evolution · Phase 2 full impl 前置件 skip stub
// SHA-lock: d6a0c1e (baseline: docs/refactor/baseline/api/api-version-header-baseline-d6a0c1e.json)
//
// 本文件当前状态: skip stub (Phase 2 T+1w wire · SLA 2026-07-15 24:00 CST)
// 前置件: Backend Phase 1 T+3d `/api/v1/*` mount + api-version middleware landed
//         + Playwright dev dependency 安装 + playwright.config.ts 创建
//
// 覆盖 8 endpoint (baseline JSON playwright_e2e_endpoints_pending_phase_2):
//   /api/v1/health · /api/v1/auth/* · /api/v1/stocks/* · /api/v1/quant/*
//   /api/v1/paper-trading/* · /api/v1/portfolio/* · /api/v1/backtests/* · /api/v1/strategies/*
//
// header assertion pattern: expect(response.headers()['x-api-version']).toBe('1')
//
// Wire 触发件:
//   1. Backend mount + middleware PR MERGED
//   2. npm i --save-dev @playwright/test (Phase 2 wire)
//   3. playwright.config.ts (Phase 2 wire · runner env)
//   4. 本 file test.skip → test 转换 (SKIP_PLAYWRIGHT_E2E env unset)
//
// 本文件在 Phase 1 landing 时不被 backend runner 拾取 (path 走 backend/tests/e2e/ 而非 backend/tests/**/*.test.ts)
// backend/src/scripts/run-tests.ts:64 walker 仅 walk tests/ 下所有 *.test.ts · e2e/*.spec.ts 不入 walker · 独立 Playwright runner 位

/* eslint-disable */
// @ts-nocheck
// Phase 2 T+1w wire · Phase 1 landing 时 Playwright dev dep 未安装 · 本 file 静默 skip stub

/*
import { test, expect, request as pwRequest } from '@playwright/test';

const BASE_URL = process.env.API_BASE_URL || 'http://localhost:3001';
const HEADER_NAME = 'x-api-version';
const HEADER_VALUE = '1';

const ENDPOINTS = [
  '/api/v1/health',
  '/api/v1/auth/login',
  '/api/v1/stocks/000001',
  '/api/v1/quant/factors',
  '/api/v1/paper-trading/positions',
  '/api/v1/portfolio/summary',
  '/api/v1/backtests',
  '/api/v1/strategies',
];

test.describe('R2 X-API-Version header assertion (Phase 2 T+1w wire)', () => {
  for (const endpoint of ENDPOINTS) {
    test.skip(`X-API-Version: 1 header on GET ${endpoint}`, async () => {
      const ctx = await pwRequest.newContext({ baseURL: BASE_URL });
      const response = await ctx.get(endpoint);
      expect(response.headers()[HEADER_NAME]).toBe(HEADER_VALUE);
      await ctx.dispose();
    });
  }
});
*/

// Phase 1 landing skip stub · zero import · zero runtime side effect
export const __PHASE_1_SKIP_STUB__ = 'wire pending Phase 2 T+1w · SLA 2026-07-15 24:00 CST';
