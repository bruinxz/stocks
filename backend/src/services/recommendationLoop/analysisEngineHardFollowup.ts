/**
 * analysisEngineHardFollowup — US-023 [AE-004] AutomatedRecommendationLoop hard 分支.
 *
 * 当 `risk_config.analysis_engine.mode === 'hard'` (US-021 / US-022) 把决策落到
 * `AIInvestmentSignal(source_type = ANALYSIS_ENGINE)` 之后, 自动荐股闭环
 * (AutomatedRecommendationLoopService.run) 在主 QUANT_RECOMMENDATION 跟单完成后,
 * **追加** 调一次 `PaperTradingAutomationService.autoBuyFromSignals`, 把 source_type
 * 锁成 `analysis_engine`, 让 hard mode 信号也能进入跟单流水线. 不动 quant 跟单本身.
 *
 * 与 ShadowDoubleRunService.hard / AIAdvisorService.maybeRunHardShortCircuit 的边界:
 *
 *   - 那两个 service 负责 *写* `AIInvestmentSignal(source_type=ANALYSIS_ENGINE)`
 *     (signal 落库).
 *   - 本助手负责 *读* 这些 signal 并把它们送进 autoBuyFromSignals 真触发 OrderIntent /
 *     PaperPosition. 没本助手, hard mode 只写 signal 不下单 — story AC "跟单触发" 不满足.
 *
 * 设计选择 (与 US-018 / US-019 / US-020 / US-021 / US-022 同款):
 *
 *   - 纯函数 `buildAnalysisEngineFollowupOptions(input)` 从 loop 已有的 paper_trading
 *     options 派生 — 复用所有风控参数 / strategy gate / sizing policy, 仅把 source_type 锁成
 *     `analysis_engine` 并解除 signal_ids 锁 (后者是 quant 当轮 archive 的 id 列表,
 *     与 analysis_engine 不同源, 必须清空否则 where.id IN [] 直接空集).
 *   - `AnalysisEngineHardFollowupDataSource` interface 把 autoBuyFromSignals 抽出来, 单测
 *     注入 fake 完整覆盖 4 路径 (enabled+happy / enabled+throw / disabled / dry_run).
 *   - `createProductionAnalysisEngineHardFollowupDataSource()` lazy require service singleton.
 *   - fail-OPEN: autoBuyFromSignals throw → 返 {ok:false, reason:'autobuy_failed'}, **不**
 *     re-throw — quant 跟单已经完成, analysis_engine 跟单失败不应让整个 loop result undefined.
 *
 * Caller 接入点: 见 AutomatedRecommendationLoopService.run 末尾 paper_trading 块之后.
 */

import { AISignalSourceType } from '../../models/AIInvestmentSignal';
import { logger } from '../../utils/logger';

// ---------------------------------------------------------------------------
//  Constants
// ---------------------------------------------------------------------------

/** caller 传 enabled === false 显式关闭; 其它任何值 (含 undefined) 默认开启. */
export const ANALYSIS_ENGINE_FOLLOWUP_ENABLED_DEFAULT = true;

/** 失败原因枚举 — 与 PrometheusRegistry label 对齐, 不要在 caller 自创字符串. */
export const ANALYSIS_ENGINE_FOLLOWUP_REASONS = Object.freeze({
  DISABLED: 'disabled',
  NO_USER: 'no_user',
  AUTOBUY_FAILED: 'autobuy_failed',
  EMPTY_BASE: 'empty_base_options',
} as const);

export type AnalysisEngineFollowupReason =
  (typeof ANALYSIS_ENGINE_FOLLOWUP_REASONS)[keyof typeof ANALYSIS_ENGINE_FOLLOWUP_REASONS];

// ---------------------------------------------------------------------------
//  Pure helpers
// ---------------------------------------------------------------------------

/**
 * 从主 QUANT_RECOMMENDATION 跟单的 base options 派生 analysis_engine 跟单的 options.
 *
 * - source_type 锁成 `analysis_engine` (不读 caller 传值).
 * - signal_ids 清空 — quant 当轮 archive 出来的 id 集对 analysis_engine 信号无意义,
 *   若不清, where.id IN [...quant_ids] 就把 analysis_engine 信号全过滤掉, 空集.
 * - 其它字段 (风控 / sizing / gate / strategy keys / dry_run / 风控阈值 ...) 全复用.
 * - report_to_feishu 强制 false — 主 loop 末尾若需推 webhook 由主 loop 统一推, 不重复.
 */
export function buildAnalysisEngineFollowupOptions(base: Record<string, any>): Record<string, any> {
  const cloned: Record<string, any> = { ...base };
  delete cloned.signal_ids;
  cloned.source_type = AISignalSourceType.ANALYSIS_ENGINE;
  cloned.report_to_feishu = false;
  cloned.notify_to_feishu_bot = false;
  return cloned;
}

// ---------------------------------------------------------------------------
//  DataSource DI
// ---------------------------------------------------------------------------

export interface AnalysisEngineHardFollowupDataSource {
  /** 调 PaperTradingAutomationService.autoBuyFromSignals. throw → caller 转 fail-OPEN. */
  autoBuyFromSignals(options: Record<string, any>): Promise<any>;
}

/**
 * 生产 DataSource — lazy require 让 module import 在 DB-less 单测环境不拽起 sequelize.
 * 与 createProductionHardShortCircuitDataSource / createProductionAIPollingEnqueueDataSource
 * 同模式.
 */
export function createProductionAnalysisEngineHardFollowupDataSource(): AnalysisEngineHardFollowupDataSource {
  return {
    async autoBuyFromSignals(options) {
      /* eslint-disable-next-line @typescript-eslint/no-var-requires */
      const ptas = require('../../portfolio/internal/PaperTradingAutomationService');
      return ptas.paperTradingAutomationService.autoBuyFromSignals(options);
    },
  };
}

export const PRODUCTION_ANALYSIS_ENGINE_HARD_FOLLOWUP_DATA_SOURCE: AnalysisEngineHardFollowupDataSource =
  createProductionAnalysisEngineHardFollowupDataSource();

// ---------------------------------------------------------------------------
//  Main entry
// ---------------------------------------------------------------------------

export interface RunAnalysisEngineHardFollowupInput {
  /**
   * 是否启用本次 followup. caller 透传 user/loop 级 flag.
   * 默认 ANALYSIS_ENGINE_FOLLOWUP_ENABLED_DEFAULT (=true). 显式 false 直接 skip.
   */
  enabled?: boolean;
  /**
   * 已挂 user_id 的 base autoBuyFromSignals options — 来自主 QUANT_RECOMMENDATION 调用.
   * 本助手不重复推导 sizing / risk / strategy gate.
   */
  base_options: Record<string, any>;
}

export interface RunAnalysisEngineHardFollowupResult {
  ok: boolean;
  reason?: AnalysisEngineFollowupReason;
  /** autoBuyFromSignals 返回值; ok=false 时为 null. */
  result?: any;
  error?: { message: string };
}

/**
 * 主入口 — 在 AutomatedRecommendationLoopService.run 主 paper_trading 块之后调.
 *
 * 返回:
 *   - {ok:true, result}: autoBuyFromSignals 成功 (可能 0 跟单, 不视为失败).
 *   - {ok:false, reason:'disabled'}: caller 显式 enabled=false.
 *   - {ok:false, reason:'empty_base_options'}: base_options 缺失 / 非 plain object.
 *   - {ok:false, reason:'no_user'}: base_options.user_id 缺失 — autoBuyFromSignals 必依赖.
 *   - {ok:false, reason:'autobuy_failed', error}: autoBuyFromSignals throw — fail-OPEN.
 */
export async function runAnalysisEngineHardFollowup(
  source: AnalysisEngineHardFollowupDataSource,
  input: RunAnalysisEngineHardFollowupInput
): Promise<RunAnalysisEngineHardFollowupResult> {
  if (input.enabled === false) {
    return { ok: false, reason: ANALYSIS_ENGINE_FOLLOWUP_REASONS.DISABLED };
  }
  if (!input.base_options || typeof input.base_options !== 'object') {
    return { ok: false, reason: ANALYSIS_ENGINE_FOLLOWUP_REASONS.EMPTY_BASE };
  }
  const followupOptions = buildAnalysisEngineFollowupOptions(input.base_options);
  if (
    followupOptions.user_id === undefined &&
    !followupOptions.username &&
    !followupOptions.portfolio_id
  ) {
    return { ok: false, reason: ANALYSIS_ENGINE_FOLLOWUP_REASONS.NO_USER };
  }
  try {
    const result = await source.autoBuyFromSignals(followupOptions);
    return { ok: true, result };
  } catch (e: any) {
    logger.warn(`[analysis-engine.followup] autoBuyFromSignals failed: ${e?.message || e}`);
    return {
      ok: false,
      reason: ANALYSIS_ENGINE_FOLLOWUP_REASONS.AUTOBUY_FAILED,
      error: { message: String(e?.message || e) },
    };
  }
}
