/**
 * ShadowDoubleRunService.test.ts — off / shadow path.
 */

import {
  ShadowDoubleRunService,
  normalizeAnalysisEngineConfig,
} from '../../../src/services/analysis-engine/ShadowDoubleRunService';
import type { AnalysisEngineUserConfig } from '../../../src/services/analysis-engine/ShadowDoubleRunService';

let pass = 0;
let fail = 0;
const failures: string[] = [];
function assert(cond: boolean, msg: string): void {
  if (cond) pass += 1;
  else {
    fail += 1;
    failures.push(msg);
    console.error(`✗ ${msg}`);
  }
}

(async () => {
  // 1. normalizeAnalysisEngineConfig: empty → off
  const c1 = normalizeAnalysisEngineConfig(null);
  assert(c1.mode === 'off', `null config → off (got ${c1.mode})`);

  const c2 = normalizeAnalysisEngineConfig({ mode: 'shadow' });
  assert(c2.mode === 'shadow', 'shadow valid');

  const c3 = normalizeAnalysisEngineConfig({ mode: 'INVALID' });
  assert(c3.mode === 'off', 'invalid mode → off fallback');

  const c4 = normalizeAnalysisEngineConfig({
    mode: 'shadow',
    enabled_analyzers: ['fundamental', 123, 'risk'],
  });
  assert(
    Array.isArray(c4.enabled_analyzers) && c4.enabled_analyzers.length === 2,
    'enabled_analyzers filter non-strings'
  );

  // 2. off mode: persistShadowReport not called
  let persistCalls = 0;
  let cfg: AnalysisEngineUserConfig = { mode: 'off' };
  const svcOff = new ShadowDoubleRunService({
    async loadUserConfig() {
      return cfg;
    },
    async persistShadowReport() {
      persistCalls += 1;
    },
  });
  const r1 = await svcOff.runShadowSync({
    stock_code: 'sz.300750',
    user_id: 1,
    prod_report_id: 'prod-1',
  });
  assert(r1 === null, 'off mode → null');
  assert(persistCalls === 0, 'off mode → no persist');

  // 3. shadow mode: persist called, returns decision
  cfg = { mode: 'shadow' };
  // 注入 fake analysisEngineService 通过覆盖 require cache 不易, 直接构造一个 svc
  // 让它 underlying call AnalysisEngineService.analyzeStock — 由于 PRODUCTION_ANALYSIS_ENGINE_DATA_SOURCE
  // 在 lazy require Stock 模型时找不到 DB 会返回 null/empty, 但 analyzer 仍跑出 confidence=0 的 result.
  // shadow 路径走到 persist 即可.
  let lastDecision: any = null;
  const svcShadow = new ShadowDoubleRunService({
    async loadUserConfig() {
      return cfg;
    },
    async persistShadowReport(decision, prodReportId) {
      persistCalls += 1;
      lastDecision = decision;
      assert(prodReportId === 'prod-2', 'persist receives prod_report_id');
    },
  });
  const r2 = await svcShadow.runShadowSync({
    stock_code: 'sz.300750',
    user_id: 1,
    prod_report_id: 'prod-2',
  });
  assert(r2 !== null, 'shadow mode → returns decision');
  assert(persistCalls === 1, 'shadow mode → persist called');
  assert(
    lastDecision && lastDecision.engine_variant === 'multi_dim_v1',
    'shadow decision engine_variant=multi_dim_v1'
  );

  // 4. maybeRunShadow (fire-and-forget) doesn't throw / await
  // 验证: 调用同步立即返回, 后台异步执行
  const svcFire = new ShadowDoubleRunService({
    async loadUserConfig() {
      return { mode: 'off' };
    },
    async persistShadowReport() {
      // no-op
    },
  });
  const start = Date.now();
  svcFire.maybeRunShadow({ stock_code: 'sz.300750', user_id: 1, prod_report_id: 'fire-1' });
  const elapsed = Date.now() - start;
  assert(elapsed < 50, `maybeRunShadow returns quickly (${elapsed}ms)`);

  // 5. hard mode 降级为 shadow 行为 (warn + persist)
  persistCalls = 0;
  cfg = { mode: 'hard' };
  const svcHard = new ShadowDoubleRunService({
    async loadUserConfig() {
      return cfg;
    },
    async persistShadowReport() {
      persistCalls += 1;
    },
  });
  const r5 = await svcHard.runShadowSync({
    stock_code: 'sz.300750',
    user_id: 1,
    prod_report_id: 'hard-1',
  });
  assert(r5 !== null, 'hard mode (v1) → still returns (degraded to shadow)');
  assert(persistCalls === 1, 'hard mode (v1) → persist called (degraded)');

  console.log(`\n${pass} passed, ${fail} failed.`);
  if (fail > 0) {
    console.error(`FAILURES:\n${failures.map(f => '  - ' + f).join('\n')}`);
    process.exit(1);
  } else {
    process.exit(0);
  }
})();
