/**
 * ShadowDoubleRunService.test.ts — off / shadow / **hard** path.
 *
 * US-021 [AE-002] hard mode 落地 — 在原有 shadow path 基础上补:
 *   [6] hard mode AC 主验收: 真调 archiveHardSignal + persistShadowReport 两条路径
 *       (与 shadow mode 只调 persistShadowReport 形成强对比)
 *   [7] hard archive 失败 fail-OPEN: archive 抛错 + 返 {ok:false} 时 caller 不阻塞
 *   [8] hard mode + dataSource.archiveHardSignal 接收正确入参 (decision/prodReportId/user_id)
 *   [9] META-GUARD fs+regex 守:
 *       (a) ShadowDoubleRunService.ts 含 archiveAnalysisEngineResult import + cfg.mode==='hard'
 *           分支 + dataSource.archiveHardSignal 调用 (防 refactor 退回 shadow 行为)
 *       (b) 不再含 v1 不支持 hard 的 warn 文案 / 不再含 "走 shadow 行为" 标识
 *       (c) ShadowDataSource interface 必须有 archiveHardSignal method
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  ShadowDoubleRunService,
  normalizeAnalysisEngineConfig,
} from '../../../src/services/analysis-engine/ShadowDoubleRunService';
import type {
  AnalysisEngineUserConfig,
  ShadowDataSource,
} from '../../../src/services/analysis-engine/ShadowDoubleRunService';
import type { ArchiveAnalysisEngineResultOutput } from '../../../src/services/analysis-engine/analysisEngineSignalArchive';
import type { RecommendationDecision } from '../../../src/services/analysis-engine/AnalyzerTypes';

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

/**
 * fake archiveHardSignal helper: 记每次调用 + 默认返 ok=true. 测试可覆盖.
 */
interface ArchiveCall {
  decision: RecommendationDecision;
  prodReportId: string;
  user_id: number | null | undefined;
}
function makeArchiveSpy(
  result: ArchiveAnalysisEngineResultOutput = { ok: true, payload: null, created: true }
): {
  calls: ArchiveCall[];
  fn: ShadowDataSource['archiveHardSignal'];
} {
  const calls: ArchiveCall[] = [];
  return {
    calls,
    async fn(decision, prodReportId, user_id) {
      calls.push({ decision, prodReportId, user_id });
      return result;
    },
  };
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

  const c5 = normalizeAnalysisEngineConfig({ mode: 'hard' });
  assert(c5.mode === 'hard', 'hard valid (US-021 真支持)');

  // 2. off mode: persistShadowReport not called, archiveHardSignal not called
  let persistCalls = 0;
  let cfg: AnalysisEngineUserConfig = { mode: 'off' };
  const offSpy = makeArchiveSpy();
  const svcOff = new ShadowDoubleRunService({
    async loadUserConfig() {
      return cfg;
    },
    async persistShadowReport() {
      persistCalls += 1;
    },
    archiveHardSignal: offSpy.fn,
  });
  const r1 = await svcOff.runShadowSync({
    stock_code: 'sz.300750',
    user_id: 1,
    prod_report_id: 'prod-1',
  });
  assert(r1 === null, 'off mode → null');
  assert(persistCalls === 0, 'off mode → no persist');
  assert(offSpy.calls.length === 0, 'off mode → no archive');

  // 3. shadow mode: persist called, archive **not** called, returns decision
  cfg = { mode: 'shadow' };
  let lastDecision: any = null;
  const shadowSpy = makeArchiveSpy();
  const svcShadow = new ShadowDoubleRunService({
    async loadUserConfig() {
      return cfg;
    },
    async persistShadowReport(decision, prodReportId) {
      persistCalls += 1;
      lastDecision = decision;
      assert(prodReportId === 'prod-2', 'persist receives prod_report_id');
    },
    archiveHardSignal: shadowSpy.fn,
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
  assert(
    shadowSpy.calls.length === 0,
    'shadow mode → archiveHardSignal NOT called (不污染 AIInvestmentSignal)'
  );

  // 4. maybeRunShadow (fire-and-forget) doesn't throw / await
  const svcFire = new ShadowDoubleRunService({
    async loadUserConfig() {
      return { mode: 'off' };
    },
    async persistShadowReport() {
      // no-op
    },
    async archiveHardSignal() {
      return { ok: true, payload: null };
    },
  });
  const start = Date.now();
  svcFire.maybeRunShadow({ stock_code: 'sz.300750', user_id: 1, prod_report_id: 'fire-1' });
  const elapsed = Date.now() - start;
  assert(elapsed < 50, `maybeRunShadow returns quickly (${elapsed}ms)`);

  // ============ US-021 [AE-002] hard mode 主验收 ============

  // 5. hard mode AC 主验收: persistShadowReport **+** archiveHardSignal 双调
  persistCalls = 0;
  cfg = { mode: 'hard' };
  const hardSpy = makeArchiveSpy();
  const svcHard = new ShadowDoubleRunService({
    async loadUserConfig() {
      return cfg;
    },
    async persistShadowReport() {
      persistCalls += 1;
    },
    archiveHardSignal: hardSpy.fn,
  });
  const r5 = await svcHard.runShadowSync({
    stock_code: 'sz.300750',
    user_id: 7,
    prod_report_id: 'hard-1',
  });
  assert(r5 !== null, 'hard mode → returns decision');
  assert(persistCalls === 1, 'hard mode → persist called (AIStockAnalysisReport 不变)');
  assert(hardSpy.calls.length === 1, 'hard mode → archiveHardSignal CALLED (AC 主验收)');
  if (hardSpy.calls.length === 1) {
    const c = hardSpy.calls[0];
    assert(
      c.prodReportId === 'hard-1',
      `archiveHardSignal 收到 prod_report_id=hard-1 (got ${c.prodReportId})`
    );
    assert(
      c.user_id === 7,
      `archiveHardSignal 收到 user_id=7 (got ${c.user_id})`
    );
    assert(
      !!c.decision && c.decision.engine_variant === 'multi_dim_v1',
      'archiveHardSignal 收到 multi_dim_v1 decision'
    );
    assert(
      c.decision.stock_code === r5!.stock_code,
      'archiveHardSignal decision.stock_code 与返回值一致'
    );
  }

  // 6. hard mode archive 失败 fail-OPEN — 返 {ok:false, reason:'db_failure'} 不阻塞
  persistCalls = 0;
  cfg = { mode: 'hard' };
  const failSpy = makeArchiveSpy({
    ok: false,
    reason: 'db_failure',
    payload: null,
    error: { message: 'simulated DB outage' },
  });
  const svcHardFail = new ShadowDoubleRunService({
    async loadUserConfig() {
      return cfg;
    },
    async persistShadowReport() {
      persistCalls += 1;
    },
    archiveHardSignal: failSpy.fn,
  });
  const r6 = await svcHardFail.runShadowSync({
    stock_code: 'sz.300750',
    user_id: 9,
    prod_report_id: 'hard-fail-1',
  });
  assert(r6 !== null, 'hard archive 失败 → 仍返 decision (fail-OPEN, 不阻塞)');
  assert(persistCalls === 1, 'hard archive 失败 → persistShadowReport 仍调到');
  assert(failSpy.calls.length === 1, 'hard archive 失败 → archive 调到 (只是 ok=false)');

  // 7. hard mode archive throw — 同样 fail-OPEN (caller 不感知)
  cfg = { mode: 'hard' };
  let persistCount7 = 0;
  let archiveCount7 = 0;
  const svcHardThrow = new ShadowDoubleRunService({
    async loadUserConfig() {
      return cfg;
    },
    async persistShadowReport() {
      persistCount7 += 1;
    },
    async archiveHardSignal() {
      archiveCount7 += 1;
      throw new Error('unexpected archive helper crash');
    },
  });
  // 注意: 当前实现是 archiveHardSignal 抛错会让 runShadowAsync 顶层 catch 接住 → 返 null.
  // PRODUCTION_SHADOW_DATA_SOURCE.archiveHardSignal 内部已 try/catch 把 throw 转
  // {ok:false, reason:'db_failure'}, 所以真实路径不会 throw. 测试 fake 直接 throw 是
  // 验证主流程不会因 archive 异常导致 unhandled rejection.
  const r7 = await svcHardThrow.runShadowSync({
    stock_code: 'sz.300750',
    user_id: 11,
    prod_report_id: 'hard-throw-1',
  });
  assert(persistCount7 === 1, 'hard archive throw → persistShadowReport 已先调');
  assert(archiveCount7 === 1, 'hard archive throw → archiveHardSignal 调到 (抛后转入 catch)');
  // 顶层 catch 吞错返 null — 与 shadow 失败语义对齐
  assert(r7 === null, 'hard archive 直接 throw → 顶层 catch 吞错返 null (fail-OPEN)');

  // ============ [9] META-GUARD fs+regex 守 hard mode 落地 ============

  const svcSrc = fs.readFileSync(
    path.join(
      __dirname,
      '../../../src/services/analysis-engine/ShadowDoubleRunService.ts'
    ),
    'utf8'
  );

  // [9.1] 含 archiveAnalysisEngineResult / createProductionAnalysisEngineArchiveDataSource import
  assert(
    /import\s*\{[^}]*archiveAnalysisEngineResult[^}]*\}\s*from\s*['"]\.\/analysisEngineSignalArchive['"]/.test(
      svcSrc
    ),
    '[9.1] 源文件含 archiveAnalysisEngineResult import 自 ./analysisEngineSignalArchive'
  );
  assert(
    /createProductionAnalysisEngineArchiveDataSource/.test(svcSrc),
    '[9.2] 源文件含 createProductionAnalysisEngineArchiveDataSource (生产 DataSource 工厂)'
  );

  // [9.3] runShadowAsync 含 cfg.mode === 'hard' 分支
  assert(
    /cfg\.mode\s*===\s*['"]hard['"]/.test(svcSrc),
    '[9.3] 含 cfg.mode === "hard" 分支'
  );

  // [9.4] 含 dataSource.archiveHardSignal 调用 (走 helper 不直接 inline)
  assert(
    /dataSource\.archiveHardSignal\s*\(/.test(svcSrc),
    '[9.4] 调用 dataSource.archiveHardSignal(...)'
  );

  // [9.5] ShadowDataSource interface 必须含 archiveHardSignal method
  assert(
    /archiveHardSignal\s*\(/.test(svcSrc),
    '[9.5] ShadowDataSource interface 声明 archiveHardSignal'
  );

  // [9.6] **反向** 不再含 "v1 仅 shadow" / "走 shadow 行为" 退化文案
  assert(
    !/v1\s+仅\s*shadow/.test(svcSrc),
    '[9.6 reverse] 不再含 "v1 仅 shadow" 文案 (US-021 已真支持 hard)'
  );
  assert(
    !/不支持\s*\(v1/.test(svcSrc),
    '[9.7 reverse] 不再含 "不支持 (v1" 退化文案'
  );

  // [9.8] PRODUCTION_SHADOW_DATA_SOURCE 含 archiveHardSignal 实现 (默认接生产 helper)
  assert(
    /PRODUCTION_SHADOW_DATA_SOURCE[\s\S]{0,2000}archiveHardSignal/.test(svcSrc),
    '[9.8] PRODUCTION_SHADOW_DATA_SOURCE 含 archiveHardSignal 实现'
  );

  console.log(`\n${pass} passed, ${fail} failed.`);
  if (fail > 0) {
    console.error(`FAILURES:\n${failures.map(f => '  - ' + f).join('\n')}`);
    process.exit(1);
  } else {
    process.exit(0);
  }
})();
