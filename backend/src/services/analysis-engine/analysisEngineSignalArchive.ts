/**
 * analysisEngineSignalArchive — US-020 [AE-001] archiveAnalysisEngineResult 助手.
 *
 * 把多维分析引擎 (`AnalysisEngineService.analyzeStock`) 产出的
 * `RecommendationDecision` 落到 `AIInvestmentSignal` 表
 * (`source_type = AISignalSourceType.ANALYSIS_ENGINE`), 让下游 hard mode
 * (`AutomatedRecommendationLoopService` / `PaperTradingAutomationService` /
 * `PaperTradingDashboardService` / `PaperTradingAttributionService`)
 * 能识别这一新来源并自动跟单 / 归因.
 *
 * 设计要点 (与 US-018 bridgeFailSafe / US-019 aiPollingEnqueue 同款):
 *
 *   1. **DataSource DI seam** 把 DB I/O 抽到 interface, 让 unit 测注入 fake
 *      DataSource (Map-backed) 完整覆盖 findOrCreate + update 两条路径,
 *      不需起真 Sequelize.
 *
 *   2. **纯函数** `mapRecommendationActionToDecision` / `buildAnalysisEngineSourceId`
 *      / `buildAnalysisEngineSignalPayload` / `mergeAnalysisEnginePayload`
 *      全 export 便于单测.
 *
 *   3. **METADATA 列覆写保护** 与 `archiveTradingAgentsResult` 同款 —
 *      `paper_trading` / `paper_trading_by_portfolio` 两个 key 由
 *      `PaperTradingFacade` 在 trade lifecycle 中回写, 重复 archive 必须保留.
 *
 *   4. **fail-LOUD** decision 字段非法 (空 stock_code / 非法 action) 抛
 *      `Error('analysis_engine archive invalid input: ...')` 不静默落空记录 —
 *      与 US-019 「taskId 非法返 null 不静默 fallback」同款.
 *
 * Shadow vs Hard mode 边界:
 *
 *   - shadow: `ShadowDoubleRunService.persistShadowReport` 写
 *     `AIStockAnalysisReport(engine_variant='multi_dim_v1')` —
 *     **不调本助手**, 不污染 AIInvestmentSignal.
 *
 *   - hard (US-021/AE-002): 同时调本助手 + 写 `AIStockAnalysisReport`,
 *     让 paper trading 自动跟单 + UI 看板可视化.
 */

import type { AIInvestmentSignal as AIInvestmentSignalType } from '../../models/AIInvestmentSignal';
import { AISignalDecision, AISignalSourceType } from '../../models/AIInvestmentSignal';
import type { RecommendationAction, RecommendationDecision } from './AnalyzerTypes';

/**
 * 与 `archiveTradingAgentsResult` 同款 — 重新 archive 时这些 metadata key 必须保留
 * (由 PaperTradingFacade 在 trade lifecycle 中回写, 重复 archive 不能擦掉).
 */
export const ANALYSIS_ENGINE_PRESERVED_METADATA_KEYS: ReadonlyArray<string> = Object.freeze([
  'paper_trading',
  'paper_trading_by_portfolio',
]);

/**
 * 多维引擎 7 档 `RecommendationAction` → `AISignalDecision` 5 档归一.
 *
 * - `strong_buy` / `add` (加仓也走 BUY 流程) → BUY
 * - `buy` → BUY
 * - `hold` → HOLD
 * - `reduce` (减仓) → SELL
 * - `sell` → SELL
 * - `strong_sell` → STRONG_SELL
 *
 * 显式枚举每一个 action, 未来 action union 加成员时 TypeScript exhaustive check
 * 会编译期暴露漏分支.
 */
export function mapRecommendationActionToDecision(action: RecommendationAction): AISignalDecision {
  switch (action) {
    case 'strong_buy':
      return AISignalDecision.STRONG_BUY;
    case 'buy':
    case 'add':
      return AISignalDecision.BUY;
    case 'hold':
      return AISignalDecision.HOLD;
    case 'reduce':
    case 'sell':
      return AISignalDecision.SELL;
    case 'strong_sell':
      return AISignalDecision.STRONG_SELL;
    default: {
      // exhaustive guard — 编译期 + 运行时双保险
      const _exhaustive: never = action;
      void _exhaustive;
      return AISignalDecision.UNKNOWN;
    }
  }
}

/**
 * 把 risk dimension score (∈ [-100,+100]) 映射成 `risk_level` 字符串.
 * 与 `ShadowDoubleRunService.pickRiskLevel` 行为对齐 — 阈值改一处生效.
 */
export function pickAnalysisEngineRiskLevel(decision: RecommendationDecision): string {
  const risk = decision.per_dimension.find(d => d.analyzer_key === 'risk');
  if (!risk) return 'unknown';
  if (risk.score <= -50) return 'high';
  if (risk.score <= -20) return 'medium';
  return 'low';
}

/**
 * source_id 命名 — 同一 (symbol, as_of) 多次跑应该 dedup 到同一行
 * (findOrCreate path), 让后续 hard mode + 跟单生成的 paper trade
 * 能稳定 join 回这条 signal.
 *
 * 加 `loop_run_id` 后缀 (可选): 让闭环对照 (AutomatedRecommendationLoop)
 * 在同一日多次重训时仍能区分 run.
 */
export function buildAnalysisEngineSourceId(input: {
  stock_code: string;
  as_of: string;
  loop_run_id?: string | null;
}): string {
  const symbol = String(input.stock_code || '').trim();
  const as_of = String(input.as_of || '').trim();
  const loopRunId = input.loop_run_id ? String(input.loop_run_id).trim() : '';
  if (!symbol || !as_of) {
    throw new Error('analysis_engine archive invalid input: stock_code/as_of required');
  }
  const base = `${symbol}_${as_of}`;
  return loopRunId ? `${base}_${loopRunId}` : base;
}

export interface BuildAnalysisEngineSignalPayloadInput {
  decision: RecommendationDecision;
  stock_name?: string | null;
  loop_run_id?: string | null;
  loop_policy_snapshot_id?: number | null;
  shadow_of_report_id?: string | null;
  /** 透传环境策略快照, 便于灰度对比 */
  market_environment?: Record<string, unknown> | null;
  /** 调用方可附加 trace_id / task_label 等业务元数据 (与 paper_trading 系列保留 key 区分) */
  extra_metadata?: Record<string, unknown>;
}

export interface AnalysisEngineSignalPayload {
  source_type: string;
  source_id: string;
  loop_run_id?: string;
  symbol: string;
  name?: string;
  signal_date: string;
  decision: string;
  normalized_decision: string;
  confidence_score: number | null;
  risk_level: string;
  rationale: string;
  detail: string;
  current_price?: number | null;
  metadata: Record<string, unknown>;
}

/**
 * 把 `RecommendationDecision` + 调用方上下文 → archive payload.
 *
 * - confidence_score: decision.overall_confidence ∈ [0,1] 映射到 [0,100] 整数,
 *   与 AIStockAnalysisReport / 现有 AIInvestmentSignal `confidence_score`
 *   字段 0-100 语义保持一致.
 * - rationale: 取 `key_reasons` 前 5 条 join, 兜底 `[shadow]` 风格摘要.
 * - detail: 序列化 (`key_reasons`, `risk_warnings`, `per_dimension` 摘要)
 *   方便 UI 展开看 8 维 breakdown.
 * - metadata: 同步落 entry/stop_loss/take_profit/sized 仓位 +
 *   data_quality + extra_metadata, 让下游 PaperTradingFacade 直接读不重算.
 */
export function buildAnalysisEngineSignalPayload(
  input: BuildAnalysisEngineSignalPayloadInput
): AnalysisEngineSignalPayload {
  const { decision } = input;
  if (!decision || !decision.stock_code || !decision.as_of) {
    throw new Error('analysis_engine archive invalid input: decision.stock_code/as_of required');
  }
  const normalizedDecision = mapRecommendationActionToDecision(decision.action);
  const decisionText = String(decision.action || normalizedDecision || 'unknown').slice(0, 100);
  const confidence = Number.isFinite(decision.overall_confidence)
    ? Math.max(0, Math.min(100, Math.round(decision.overall_confidence * 100)))
    : null;
  const riskLevel = pickAnalysisEngineRiskLevel(decision);
  const keyReasons = Array.isArray(decision.key_reasons) ? decision.key_reasons.slice(0, 5) : [];
  const riskWarnings = Array.isArray(decision.risk_warnings)
    ? decision.risk_warnings.slice(0, 5)
    : [];
  const rationale =
    keyReasons.join('；') ||
    `[analysis_engine] action=${decision.action} confidence=${(
      decision.overall_confidence ?? 0
    ).toFixed(2)}`;

  // detail JSON 串化 — 给 UI / 监控看完整 8 维分解; 不放 ctx 等大对象
  const detailObj = {
    key_reasons: keyReasons,
    risk_warnings: riskWarnings,
    per_dimension: decision.per_dimension.map(d => ({
      analyzer_key: d.analyzer_key,
      score: d.score,
      confidence: d.confidence,
      data_missing: d.data_missing,
      error: d.error,
    })),
    data_quality: decision.data_quality,
    entry_zone: decision.entry_zone,
    stop_loss: decision.stop_loss,
    take_profit: decision.take_profit,
    suggested_position_pct: decision.suggested_position_pct,
    engine_variant: decision.engine_variant,
  };

  const currentPrice =
    decision.entry_zone && Number.isFinite(decision.entry_zone[0])
      ? Number(decision.entry_zone[0])
      : null;

  const metadata: Record<string, unknown> = {
    engine_variant: decision.engine_variant,
    overall_confidence: decision.overall_confidence,
    confidence_tier: decision.confidence_tier,
    data_quality: decision.data_quality,
    entry_zone: decision.entry_zone,
    stop_loss: decision.stop_loss,
    take_profit: decision.take_profit,
    suggested_position_pct: decision.suggested_position_pct,
    risk_warnings: riskWarnings,
    per_dimension_summary: decision.per_dimension.map(d => ({
      analyzer_key: d.analyzer_key,
      score: d.score,
      confidence: d.confidence,
    })),
    shadow_of_report_id: input.shadow_of_report_id ?? null,
    loop_run_id: input.loop_run_id ?? null,
    loop_policy_snapshot_id: input.loop_policy_snapshot_id ?? null,
    market_environment: input.market_environment ?? null,
    ...(input.extra_metadata && typeof input.extra_metadata === 'object'
      ? input.extra_metadata
      : {}),
  };

  const payload: AnalysisEngineSignalPayload = {
    source_type: AISignalSourceType.ANALYSIS_ENGINE,
    source_id: buildAnalysisEngineSourceId({
      stock_code: decision.stock_code,
      as_of: decision.as_of,
      loop_run_id: input.loop_run_id,
    }),
    symbol: decision.stock_code,
    signal_date: decision.as_of,
    decision: decisionText,
    normalized_decision: normalizedDecision,
    confidence_score: confidence,
    risk_level: riskLevel,
    rationale,
    detail: JSON.stringify(detailObj),
    current_price: currentPrice,
    metadata,
  };
  if (input.loop_run_id) payload.loop_run_id = String(input.loop_run_id);
  if (input.stock_name) payload.name = String(input.stock_name);
  return payload;
}

/**
 * 与 `archiveTradingAgentsResult` 同款 metadata 合并 — 新 payload 覆盖
 * + 显式保留 `ANALYSIS_ENGINE_PRESERVED_METADATA_KEYS` 列出的 key.
 */
export function mergeAnalysisEnginePayload(
  existingMetadata: Record<string, unknown> | null | undefined,
  newPayload: AnalysisEngineSignalPayload
): AnalysisEngineSignalPayload {
  const existing =
    existingMetadata && typeof existingMetadata === 'object'
      ? (existingMetadata as Record<string, unknown>)
      : {};
  const merged: Record<string, unknown> = { ...existing, ...newPayload.metadata };
  for (const key of ANALYSIS_ENGINE_PRESERVED_METADATA_KEYS) {
    if (existing[key] !== undefined) merged[key] = existing[key];
  }
  return { ...newPayload, metadata: merged };
}

/**
 * DB I/O 抽象 — 单测可注入 Map-backed fake 复刻 findOrCreate + update 语义.
 */
export interface AnalysisEngineArchiveDataSource {
  /**
   * 找已存在的 (source_type, source_id) 记录或新建. 行为对齐 Sequelize
   * `Model.findOrCreate`: 返 [record, created].
   */
  findOrCreateSignal(
    where: { source_type: string; source_id: string },
    defaults: AnalysisEngineSignalPayload
  ): Promise<[AIInvestmentSignalType, boolean]>;
  /**
   * 已存在则 update — 调用方负责合并 metadata (已含 preserved keys 保护).
   */
  updateSignal(
    record: AIInvestmentSignalType,
    payload: AnalysisEngineSignalPayload
  ): Promise<AIInvestmentSignalType>;
}

/**
 * 生产 DataSource — lazy require AIInvestmentSignal model (与
 * `bridgeFailSafe.createProductionBridgeFailSafeDataSource` /
 * `aiPollingEnqueue.createProductionAIPollingEnqueueDataSource` 同模式),
 * 让本 module 在没有 DB 的纯单测环境 import 不会拽起 sequelize-typescript.
 */
export function createProductionAnalysisEngineArchiveDataSource(): AnalysisEngineArchiveDataSource {
  return {
    async findOrCreateSignal(where, defaults) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { AIInvestmentSignal } = require('../../models/AIInvestmentSignal');
      const [record, created] = await AIInvestmentSignal.findOrCreate({ where, defaults });
      return [record as AIInvestmentSignalType, created as boolean];
    },
    async updateSignal(record, payload) {
      await (record as any).update(payload);
      return record;
    },
  };
}

export interface ArchiveAnalysisEngineResultInput extends BuildAnalysisEngineSignalPayloadInput {
  /**
   * 显式 dry_run — 仅构造 payload, 不写 DB. 用于灰度对比 / UI 预览.
   */
  dry_run?: boolean;
}

export interface ArchiveAnalysisEngineResultOutput {
  ok: boolean;
  reason?: 'invalid_input' | 'db_failure' | 'dry_run';
  signal?: AIInvestmentSignalType | null;
  created?: boolean;
  payload: AnalysisEngineSignalPayload | null;
  error?: { message: string };
}

/**
 * 主入口 — 等价 `archiveTradingAgentsResult` 之于 TradingAgents.
 *
 * - dry_run=true 返 {ok:false, reason:'dry_run', payload}, 不调 DataSource.
 * - decision 非法返 {ok:false, reason:'invalid_input', error}, 不抛.
 * - DataSource 抛错返 {ok:false, reason:'db_failure', error}, 不抛 (与
 *   archiveTradingAgentsResult 行为差异: 后者是 caller 内 try/catch, 本助手
 *   把 try/catch 内化以让 hard mode loop 不会因为单条 archive 失败炸整批).
 *   caller 视下游需求决定 throw/log/skip.
 */
export async function archiveAnalysisEngineResult(
  source: AnalysisEngineArchiveDataSource,
  input: ArchiveAnalysisEngineResultInput
): Promise<ArchiveAnalysisEngineResultOutput> {
  let payload: AnalysisEngineSignalPayload;
  try {
    payload = buildAnalysisEngineSignalPayload(input);
  } catch (e: any) {
    return {
      ok: false,
      reason: 'invalid_input',
      payload: null,
      error: { message: String(e?.message || e) },
    };
  }

  if (input.dry_run) {
    return { ok: false, reason: 'dry_run', payload, signal: null };
  }

  try {
    const [record, created] = await source.findOrCreateSignal(
      { source_type: payload.source_type, source_id: payload.source_id },
      payload
    );
    if (!created) {
      const existingMetadata = (record as any).metadata as Record<string, unknown> | undefined;
      const merged = mergeAnalysisEnginePayload(existingMetadata, payload);
      const updated = await source.updateSignal(record, merged);
      return { ok: true, signal: updated, created: false, payload: merged };
    }
    return { ok: true, signal: record, created: true, payload };
  } catch (e: any) {
    return {
      ok: false,
      reason: 'db_failure',
      payload,
      error: { message: String(e?.message || e) },
    };
  }
}
