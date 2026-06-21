/**
 * analysisEngineHardFollowup.test.ts — US-023 [AE-004] AutomatedRecommendationLoop
 * hard 分支单测.
 *
 * 覆盖 5 大模块:
 *   [1] 常量冻结 (ANALYSIS_ENGINE_FOLLOWUP_REASONS) + ENABLED_DEFAULT 形态.
 *   [2] buildAnalysisEngineFollowupOptions 纯函数 — source_type 锁 / signal_ids 清 /
 *       report_to_feishu 强制 false / 其它字段透传.
 *   [3] runAnalysisEngineHardFollowup 主入口 — fake DataSource 注入完整覆盖
 *       enabled+happy / enabled+throw fail-OPEN / disabled / empty_base /
 *       no_user / dry_run 透传 6 路径 + AC 主验收 (enabled=true 真调
 *       autoBuyFromSignals 且 options.source_type==='analysis_engine').
 *   [4] PRODUCTION DataSource smoke (lazy require 工厂 + interface 形态).
 *   [5] META-GUARD fs+regex 守:
 *       (a) AutomatedRecommendationLoopService.ts 含 helper import +
 *           调用 + use_analysis_engine_followup option 接入;
 *       (b) helper 含 buildAnalysisEngineFollowupOptions 默认值常量 +
 *           top-level try/catch fail-OPEN + 4 reason enum 全 export;
 *       (c) 反向 — helper 不再 inline `paperTradingAutomationService.autoBuyFromSignals(`,
 *           而是走 DataSource interface (与 US-018/US-019/US-020/US-021/US-022 同款
 *           "抽 helper 后必须切干净" 形态).
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  ANALYSIS_ENGINE_FOLLOWUP_ENABLED_DEFAULT,
  ANALYSIS_ENGINE_FOLLOWUP_REASONS,
  buildAnalysisEngineFollowupOptions,
  createProductionAnalysisEngineHardFollowupDataSource,
  PRODUCTION_ANALYSIS_ENGINE_HARD_FOLLOWUP_DATA_SOURCE,
  runAnalysisEngineHardFollowup,
  type AnalysisEngineHardFollowupDataSource,
  type RunAnalysisEngineHardFollowupInput,
} from '../../../src/services/recommendationLoop/analysisEngineHardFollowup';
import { AISignalSourceType } from '../../../src/models/AIInvestmentSignal';

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

// ---------------------------------------------------------------------------
// [1] 常量 + 默认值形态
// ---------------------------------------------------------------------------

(function moduleOneConstants() {
  assert(
    ANALYSIS_ENGINE_FOLLOWUP_ENABLED_DEFAULT === true,
    '[1.1] ENABLED_DEFAULT 默认 true'
  );
  // 冻结 — Object.isFrozen
  assert(
    Object.isFrozen(ANALYSIS_ENGINE_FOLLOWUP_REASONS),
    '[1.2] ANALYSIS_ENGINE_FOLLOWUP_REASONS Object.freeze'
  );
  // 4 个 reason key 全在
  assert(
    ANALYSIS_ENGINE_FOLLOWUP_REASONS.DISABLED === 'disabled',
    '[1.3a] reason DISABLED=disabled'
  );
  assert(
    ANALYSIS_ENGINE_FOLLOWUP_REASONS.NO_USER === 'no_user',
    '[1.3b] reason NO_USER=no_user'
  );
  assert(
    ANALYSIS_ENGINE_FOLLOWUP_REASONS.AUTOBUY_FAILED === 'autobuy_failed',
    '[1.3c] reason AUTOBUY_FAILED=autobuy_failed'
  );
  assert(
    ANALYSIS_ENGINE_FOLLOWUP_REASONS.EMPTY_BASE === 'empty_base_options',
    '[1.3d] reason EMPTY_BASE=empty_base_options'
  );
})();

// ---------------------------------------------------------------------------
// [2] buildAnalysisEngineFollowupOptions 纯函数
// ---------------------------------------------------------------------------

(function moduleTwoBuildOptions() {
  // [2.1] source_type 永远锁 analysis_engine, 即便 caller 传别的
  const opts1 = buildAnalysisEngineFollowupOptions({
    source_type: AISignalSourceType.QUANT_RECOMMENDATION,
    user_id: 7,
    limit: 5,
  });
  assert(
    opts1.source_type === AISignalSourceType.ANALYSIS_ENGINE,
    '[2.1] source_type 锁为 analysis_engine'
  );
  assert(opts1.user_id === 7, '[2.1b] user_id 透传');
  assert(opts1.limit === 5, '[2.1c] limit 透传');

  // [2.2] signal_ids 清空 (quant 当轮 archive id 与 analysis_engine 不同源)
  const opts2 = buildAnalysisEngineFollowupOptions({
    user_id: 1,
    signal_ids: [1, 2, 3, 4, 5],
  });
  assert(opts2.signal_ids === undefined, '[2.2] signal_ids 被清空');

  // [2.3] report_to_feishu / notify_to_feishu_bot 强制 false
  const opts3 = buildAnalysisEngineFollowupOptions({
    user_id: 1,
    report_to_feishu: true,
    notify_to_feishu_bot: true,
  });
  assert(opts3.report_to_feishu === false, '[2.3a] report_to_feishu 强制 false');
  assert(opts3.notify_to_feishu_bot === false, '[2.3b] notify_to_feishu_bot 强制 false');

  // [2.4] 其它字段透传 (allowed_risk_levels, dry_run, risk_profile_gate, env policy)
  const env = { snapshot_id: 's-1' };
  const gate = { effective_trade_limit: 3 };
  const opts4 = buildAnalysisEngineFollowupOptions({
    user_id: 1,
    allowed_risk_levels: ['low'],
    dry_run: true,
    external_environment_policy: env,
    risk_profile_gate: gate,
    block_limit_up: false,
  });
  assert(JSON.stringify(opts4.allowed_risk_levels) === '["low"]', '[2.4a] allowed_risk_levels 透传');
  assert(opts4.dry_run === true, '[2.4b] dry_run 透传');
  assert(opts4.external_environment_policy === env, '[2.4c] external_environment_policy 透传');
  assert(opts4.risk_profile_gate === gate, '[2.4d] risk_profile_gate 透传');
  assert(opts4.block_limit_up === false, '[2.4e] block_limit_up 透传');

  // [2.5] base 不被改 (immutability check)
  const base: any = { signal_ids: [99], user_id: 2 };
  const _opts5 = buildAnalysisEngineFollowupOptions(base);
  assert(
    Array.isArray(base.signal_ids) && base.signal_ids[0] === 99,
    '[2.5] base.signal_ids 原对象不被改 (浅拷贝)'
  );
  assert(base.source_type === undefined, '[2.5b] base.source_type 未被注入');
})();

// ---------------------------------------------------------------------------
// [3] runAnalysisEngineHardFollowup 主入口 — fake DataSource
// ---------------------------------------------------------------------------

function makeFakeDataSource(opts: {
  throwError?: Error;
  result?: any;
} = {}): AnalysisEngineHardFollowupDataSource & {
  calls: Array<{ options: Record<string, any> }>;
} {
  const calls: Array<{ options: Record<string, any> }> = [];
  return {
    calls,
    async autoBuyFromSignals(options) {
      calls.push({ options });
      if (opts.throwError) throw opts.throwError;
      return (
        opts.result ?? {
          executed: 0,
          planned: 0,
          skipped: 0,
          trades: [],
        }
      );
    },
  };
}

(async function moduleThreeRunFollowup() {
  // [3.1] AC 主验收 — enabled=true + happy: autoBuyFromSignals 真被调 1 次, options.source_type=analysis_engine
  {
    const ds = makeFakeDataSource({
      result: { executed: 2, planned: 1, skipped: 0, trades: [{ id: 1 }, { id: 2 }, { id: 3 }] },
    });
    const r = await runAnalysisEngineHardFollowup(ds, {
      enabled: true,
      base_options: {
        user_id: 5,
        username: 'u1',
        limit: 3,
        signal_ids: [10, 11, 12],
        source_type: AISignalSourceType.QUANT_RECOMMENDATION,
      },
    });
    assert(r.ok === true, '[3.1a] enabled+happy ok=true');
    assert(ds.calls.length === 1, '[3.1b] autoBuyFromSignals 被调 1 次');
    assert(
      ds.calls[0].options.source_type === AISignalSourceType.ANALYSIS_ENGINE,
      '[3.1c] AC: options.source_type=analysis_engine (override quant_recommendation)'
    );
    assert(ds.calls[0].options.signal_ids === undefined, '[3.1d] signal_ids 被清空');
    assert(ds.calls[0].options.user_id === 5, '[3.1e] user_id 透传');
    assert(r.result?.executed === 2, '[3.1f] result.executed 透传');
  }

  // [3.2] enabled=false: 不调 autoBuyFromSignals, reason=disabled
  {
    const ds = makeFakeDataSource();
    const r = await runAnalysisEngineHardFollowup(ds, {
      enabled: false,
      base_options: { user_id: 1 },
    });
    assert(r.ok === false, '[3.2a] enabled=false ok=false');
    assert(r.reason === ANALYSIS_ENGINE_FOLLOWUP_REASONS.DISABLED, '[3.2b] reason=disabled');
    assert(ds.calls.length === 0, '[3.2c] autoBuyFromSignals 0 次 (skip)');
  }

  // [3.3] enabled undefined 默认 true: 调到
  {
    const ds = makeFakeDataSource();
    const r = await runAnalysisEngineHardFollowup(ds, {
      base_options: { user_id: 1 },
    } as RunAnalysisEngineHardFollowupInput);
    assert(r.ok === true, '[3.3a] enabled 缺省时默认 true → ok');
    assert(ds.calls.length === 1, '[3.3b] autoBuyFromSignals 调到');
  }

  // [3.4] base_options 缺失或非 object: reason=empty_base_options
  {
    const ds = makeFakeDataSource();
    const r = await runAnalysisEngineHardFollowup(ds, {
      enabled: true,
      base_options: null as any,
    });
    assert(r.ok === false, '[3.4a] base=null ok=false');
    assert(r.reason === ANALYSIS_ENGINE_FOLLOWUP_REASONS.EMPTY_BASE, '[3.4b] reason=empty_base_options');
    assert(ds.calls.length === 0, '[3.4c] autoBuyFromSignals 0 次');
  }

  // [3.5] user_id / username / portfolio_id 都缺: reason=no_user
  {
    const ds = makeFakeDataSource();
    const r = await runAnalysisEngineHardFollowup(ds, {
      enabled: true,
      base_options: { limit: 5 },
    });
    assert(r.ok === false, '[3.5a] no user ok=false');
    assert(r.reason === ANALYSIS_ENGINE_FOLLOWUP_REASONS.NO_USER, '[3.5b] reason=no_user');
    assert(ds.calls.length === 0, '[3.5c] autoBuyFromSignals 0 次');
  }

  // [3.6] autoBuyFromSignals throw → fail-OPEN: reason=autobuy_failed, 不 re-throw
  {
    const ds = makeFakeDataSource({ throwError: new Error('downstream-boom') });
    let caught: Error | null = null;
    let r: any = null;
    try {
      r = await runAnalysisEngineHardFollowup(ds, {
        enabled: true,
        base_options: { user_id: 1 },
      });
    } catch (e: any) {
      caught = e;
    }
    assert(caught === null, '[3.6a] fail-OPEN: helper 不 re-throw');
    assert(r?.ok === false, '[3.6b] ok=false');
    assert(r?.reason === ANALYSIS_ENGINE_FOLLOWUP_REASONS.AUTOBUY_FAILED, '[3.6c] reason=autobuy_failed');
    assert(r?.error?.message === 'downstream-boom', '[3.6d] error.message 透传');
    assert(ds.calls.length === 1, '[3.6e] autoBuyFromSignals 被调到才 throw');
  }

  // [3.7] dry_run + 其它复杂字段透传到 autoBuyFromSignals
  {
    const ds = makeFakeDataSource();
    await runAnalysisEngineHardFollowup(ds, {
      enabled: true,
      base_options: {
        user_id: 7,
        dry_run: true,
        allowed_risk_levels: ['low', 'medium'],
        risk_profile_gate: { effective_trade_limit: 2 },
        external_environment_policy: { snapshot_id: 'env-1' },
      },
    });
    assert(ds.calls[0].options.dry_run === true, '[3.7a] dry_run 透传');
    assert(
      JSON.stringify(ds.calls[0].options.allowed_risk_levels) === '["low","medium"]',
      '[3.7b] allowed_risk_levels 透传'
    );
    assert(
      ds.calls[0].options.risk_profile_gate?.effective_trade_limit === 2,
      '[3.7c] risk_profile_gate 透传'
    );
    assert(
      ds.calls[0].options.external_environment_policy?.snapshot_id === 'env-1',
      '[3.7d] external_environment_policy 透传'
    );
  }

  // [3.8] 只有 username 时也算有 user identity (走 ensurePortfolio fallback)
  {
    const ds = makeFakeDataSource();
    const r = await runAnalysisEngineHardFollowup(ds, {
      enabled: true,
      base_options: { username: 'alice' },
    });
    assert(r.ok === true, '[3.8a] username-only 也通过 no_user check');
    assert(ds.calls.length === 1, '[3.8b] autoBuyFromSignals 调到');
  }

  // ---------------------------------------------------------------------------
  // [4] PRODUCTION DataSource smoke
  // ---------------------------------------------------------------------------
  {
    const prodDs = createProductionAnalysisEngineHardFollowupDataSource();
    assert(typeof prodDs.autoBuyFromSignals === 'function', '[4.1] prod DataSource autoBuyFromSignals 是 function');
    assert(
      PRODUCTION_ANALYSIS_ENGINE_HARD_FOLLOWUP_DATA_SOURCE !== null &&
        typeof PRODUCTION_ANALYSIS_ENGINE_HARD_FOLLOWUP_DATA_SOURCE.autoBuyFromSignals === 'function',
      '[4.2] PRODUCTION singleton 已 export'
    );
  }

  // ---------------------------------------------------------------------------
  // [5] META-GUARD fs+regex
  // ---------------------------------------------------------------------------
  {
    const ROOT = path.resolve(__dirname, '../../..');
    const loopSrc = fs.readFileSync(
      path.join(ROOT, 'src/services/AutomatedRecommendationLoopService.ts'),
      'utf8'
    );
    const helperSrc = fs.readFileSync(
      path.join(ROOT, 'src/services/recommendationLoop/analysisEngineHardFollowup.ts'),
      'utf8'
    );

    // [5.1] Loop service 含 import
    assert(
      /from\s+['"]\.\/recommendationLoop\/analysisEngineHardFollowup['"]/.test(loopSrc),
      '[5.1a] Loop service 含 analysisEngineHardFollowup import'
    );
    assert(
      /runAnalysisEngineHardFollowup/.test(loopSrc),
      '[5.1b] Loop service 引用 runAnalysisEngineHardFollowup'
    );
    assert(
      /PRODUCTION_ANALYSIS_ENGINE_HARD_FOLLOWUP_DATA_SOURCE/.test(loopSrc),
      '[5.1c] Loop service 引用 PRODUCTION_ANALYSIS_ENGINE_HARD_FOLLOWUP_DATA_SOURCE'
    );
    assert(
      /await\s+runAnalysisEngineHardFollowup\s*\(/.test(loopSrc),
      '[5.1d] Loop service 真调 runAnalysisEngineHardFollowup'
    );
    // [5.2] option 接入
    assert(
      /use_analysis_engine_followup/.test(loopSrc),
      '[5.2a] Loop service 含 use_analysis_engine_followup option'
    );
    assert(
      /enabled:\s*options\.use_analysis_engine_followup\s*!==\s*false/.test(loopSrc),
      '[5.2b] enabled 派生自 use_analysis_engine_followup !== false (默认 true)'
    );
    // [5.3] helper 含默认值 + 4 个 reason + fail-OPEN top-level try/catch
    assert(
      /ANALYSIS_ENGINE_FOLLOWUP_ENABLED_DEFAULT/.test(helperSrc),
      '[5.3a] helper 含 ENABLED_DEFAULT 常量'
    );
    assert(
      /ANALYSIS_ENGINE_FOLLOWUP_REASONS/.test(helperSrc),
      '[5.3b] helper 含 REASONS enum'
    );
    assert(
      /DISABLED:\s*['"]disabled['"]/.test(helperSrc),
      '[5.3c] helper REASONS.DISABLED=disabled'
    );
    assert(
      /AUTOBUY_FAILED:\s*['"]autobuy_failed['"]/.test(helperSrc),
      '[5.3d] helper REASONS.AUTOBUY_FAILED=autobuy_failed'
    );
    // try { ... source.autoBuyFromSignals ... } catch fail-OPEN
    assert(
      /try\s*\{[\s\S]{0,400}source\.autoBuyFromSignals[\s\S]{0,200}catch/.test(helperSrc),
      '[5.3e] helper 主入口 try/catch 包 source.autoBuyFromSignals (fail-OPEN)'
    );
    // [5.4] 反向 — helper 不 inline paperTradingAutomationService.autoBuyFromSignals(...)
    //   只能通过 createProduction... lazy require 调到, 不允许 helper 顶层 import 或裸调.
    //   注意: createProductionAnalysisEngineHardFollowupDataSource 内 require 字符串
    //   会包含 'PaperTradingAutomationService', 但是不应该有
    //   `paperTradingAutomationService.autoBuyFromSignals(...)` 这种裸字面调用形态.
    //   排除 require chain — 仅守 'foo.bar' 顶层裸调用形态.
    const inlineUsage = helperSrc.match(
      /paperTradingAutomationService\.autoBuyFromSignals\s*\(/g
    );
    // 允许 createProductionAnalysisEngineHardFollowupDataSource 里通过 require 后调用一次, 也是合理的:
    // 但确保不超过 1 次, 不绕开 DataSource interface
    assert(
      !inlineUsage || inlineUsage.length <= 1,
      `[5.4 反向] helper 不裸调 paperTradingAutomationService.autoBuyFromSignals 超过 1 次 (实际 ${inlineUsage?.length || 0})`
    );
    // [5.5] DataSource interface 形态
    assert(
      /interface\s+AnalysisEngineHardFollowupDataSource[\s\S]{0,200}autoBuyFromSignals/.test(helperSrc),
      '[5.5] helper 含 AnalysisEngineHardFollowupDataSource interface + autoBuyFromSignals'
    );
  }

  console.log(`\n${pass} passed, ${fail} failed.`);
  if (fail > 0) {
    console.error(`FAILURES:\n${failures.map(f => '  - ' + f).join('\n')}`);
    process.exit(1);
  } else {
    process.exit(0);
  }
})();
