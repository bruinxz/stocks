/**
 * hardShortCircuit — US-022 [AE-003] AIAdvisorService hard 短路 helper.
 *
 * 当用户 `risk_config.analysis_engine.mode === 'hard'` 时,
 * `AIAdvisorService.analyzeSingleStock` 在 **第一行** 调本助手:
 *
 *   const hard = await maybeRunHardShortCircuit(source, {stock_code, user_id, ...});
 *   if (hard) return hard;          // hard 模式: 直接返决策, 不调 TradingAgents
 *   // ↓ 仍走旧 5-维度路径 (TradingAgents 同步/异步 + saveReport + 末尾 shadow trigger)
 *
 * 行为契约:
 *
 *   - `off` / `shadow` / 任何未知 mode → 返 null (caller 必须 fall-through 旧路径).
 *     特别注意 shadow 仍走旧路径 + 末尾 shadow trigger, 本助手不接管.
 *   - `hard` → 直接调 `AnalysisEngineService.analyzeStock` → 转 `AnalyzeSingleStockResult`
 *     → 写 `AIStockAnalysisReport(engine_variant='multi_dim_v1')`
 *     → 同步 archive 到 `AIInvestmentSignal(source_type=ANALYSIS_ENGINE)`
 *     → 返 result. 失败 fail-OPEN (analyzeStock throw → status='failed' + error;
 *     persist throw → metadata.save_error; archive throw / ok=false → 仅 logger.warn).
 *
 * 与 ShadowDoubleRunService 的区别:
 *
 *   - shadow path **异步** 双跑 (旧路径主返 + 后台 setImmediate 调 analyzeStock).
 *   - hard path **同步** 直接接管 (analyzeStock 决策才是给用户看的结果).
 *
 *   shadow 的 `ShadowDataSource.archiveHardSignal` 仅在 mode==='hard' 触发, 与本助手
 *   完全独立 — 不要担心 hard 模式下双重 archive: AIAdvisorService 加 if (hardResult) return
 *   之后, 末尾 shadow trigger 的整段代码都跳过了 (含 maybeRunShadow 调用), 所以 archive
 *   只发生一次, signal.source_id 也只有一行.
 *
 * DataSource DI 模式 (与 US-018 / US-019 / US-020 / US-021 同款):
 *
 *   - HardShortCircuitDataSource interface 把 4 个 I/O 抽出来 (loadUserConfig /
 *     analyzeStock / persistEngineReport / archiveHardSignal).
 *   - createProductionHardShortCircuitDataSource() 工厂 lazy require 真实现 — User 模型 /
 *     analysisEngineService / AIStockAnalysisReport 模型 / analysisEngineSignalArchive.
 *   - 单测注入 fake DataSource 完整覆盖 6 路径 (off/shadow/hard happy / analyzeStock throw /
 *     persist throw / archive ok=false / archive throw / dry_run) — 不需起 DB.
 */

import { logger } from '../../utils/logger';
import { analysisEngineService } from './AnalysisEngineService';
import {
  archiveAnalysisEngineResult,
  createProductionAnalysisEngineArchiveDataSource,
  type AnalysisEngineArchiveDataSource,
  type ArchiveAnalysisEngineResultOutput,
} from './analysisEngineSignalArchive';
import {
  normalizeAnalysisEngineConfig,
  DEFAULT_ANALYSIS_ENGINE_CONFIG,
  type AnalysisEngineUserConfig,
} from './ShadowDoubleRunService';
import type { RecommendationDecision, AnalyzerOutput, RecommendationAction } from './AnalyzerTypes';
import type { AnalyzeStockOptions } from './AnalysisEngineService';

// ---------------------------------------------------------------------------
//  Public types (AnalyzeSingleStockResult 结构对齐, 不直接 import 防循环)
// ---------------------------------------------------------------------------

/** 与 AIAdvisorService.AnalysisDimension 对齐, 单列防循环 import. */
export const HARD_SHORT_CIRCUIT_DIMENSIONS = Object.freeze([
  'fundamental',
  'technical',
  'capital',
  'news',
  'sentiment',
] as const);
export type HardShortCircuitDimension = (typeof HARD_SHORT_CIRCUIT_DIMENSIONS)[number];

/** 与 AIAdvisorService.AnalyzeSingleStockResult 1:1 — 不 import 避免循环. */
export interface HardShortCircuitResult {
  report_id: string;
  stock_code: string;
  stock_name: string | null;
  dimensions: HardShortCircuitDimension[];
  summary: string;
  recommendation: string;
  confidence_score: number | null;
  risk_level: string | null;
  key_points: Record<string, string[]>;
  status: 'completed' | 'partial' | 'failed' | 'pending';
  task_id: string | null;
  target_date: string | null;
  error: string | null;
  generated_at: string;
  metadata: Record<string, unknown>;
  persisted: boolean;
}

// ---------------------------------------------------------------------------
//  Pure helpers
// ---------------------------------------------------------------------------

/**
 * 多维引擎 7 档 `RecommendationAction` → AIAdvisorService 5 档
 * (`normalizeRecommendation` 同口径). add → buy / reduce → sell.
 *
 * 显式枚举每一个 action, exhaustive guard 让未来 union 扩成员时编译期暴露漏分支.
 */
export function mapActionToRecommendation(action: RecommendationAction): string {
  switch (action) {
    case 'strong_buy':
      return 'strong_buy';
    case 'buy':
    case 'add':
      return 'buy';
    case 'hold':
      return 'hold';
    case 'reduce':
    case 'sell':
      return 'sell';
    case 'strong_sell':
      return 'strong_sell';
    default: {
      const _exhaustive: never = action;
      void _exhaustive;
      return 'unknown';
    }
  }
}

/**
 * 把 risk dimension score (∈ [-100,+100]) 映射成 `risk_level` 字符串.
 * 与 `ShadowDoubleRunService.pickRiskLevel` /
 * `analysisEngineSignalArchive.pickAnalysisEngineRiskLevel` 阈值对齐.
 */
export function pickHardRiskLevel(decision: RecommendationDecision): string {
  const risk = decision.per_dimension.find(d => d.analyzer_key === 'risk');
  if (!risk) return 'unknown';
  if (risk.score <= -50) return 'high';
  if (risk.score <= -20) return 'medium';
  return 'low';
}

/**
 * 多维引擎 8 analyzer → AIAdvisorService 5 legacy dimensions 的映射. 用于
 * `buildKeyPointsFromDecision` 抽 evidence label 喂前端旧 5-维度 modal.
 *
 * - capital → 资金面
 * - fundamental → 基本面
 * - technical → 技术面
 * - news → 新闻面
 * - sentiment → 情绪面
 * - industry_regime / risk / event 没有对应 legacy dim, 落到 metadata.per_dimension
 *   让 v2 UI 直接读, 不丢失.
 */
export const ANALYZER_TO_LEGACY_DIMENSION: Readonly<Record<string, HardShortCircuitDimension>> =
  Object.freeze({
    fundamental: 'fundamental',
    technical: 'technical',
    capital: 'capital',
    news: 'news',
    sentiment: 'sentiment',
  });

/**
 * 从 analyzer evidence 抽 top N 条 label, 喂 AnalyzeSingleStockResult.key_points
 * 保旧 UI 兼容. evidence 按 weight desc 排, 截前 N 条 label (非 detail).
 */
export function pickAnalyzerEvidenceLabels(out: AnalyzerOutput, max = 5): string[] {
  if (!Array.isArray(out.evidence)) return [];
  return out.evidence
    .slice()
    .sort((a, b) => Number(b.weight ?? 0) - Number(a.weight ?? 0))
    .map(e => String(e.label || '').trim())
    .filter(s => s.length > 0)
    .slice(0, max);
}

/**
 * 把 `decision.per_dimension` 折叠成旧 5 维度 key_points map.
 * 不丢字段: industry_regime/risk/event 仍可在 metadata.per_dimension 看到.
 */
export function buildKeyPointsFromDecision(
  decision: RecommendationDecision,
  dimensions: ReadonlyArray<HardShortCircuitDimension>
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const d of dimensions) out[d] = [];
  for (const ana of decision.per_dimension) {
    const legacyDim = ANALYZER_TO_LEGACY_DIMENSION[ana.analyzer_key];
    if (!legacyDim || !dimensions.includes(legacyDim)) continue;
    const labels = pickAnalyzerEvidenceLabels(ana);
    if (labels.length > 0) out[legacyDim] = labels;
  }
  return out;
}

/**
 * 与 AIAdvisorService.buildAnalysisSummary 同款 markdown layout —
 * 不 import 旧 helper 避免循环, 复刻最小版本足够 hard mode UI 展示.
 */
export function buildHardModeSummary(
  stockCode: string,
  stockName: string | null,
  recommendation: string,
  confidenceScore: number | null,
  riskLevel: string | null,
  dimensions: ReadonlyArray<HardShortCircuitDimension>,
  keyPoints: Record<string, string[]>
): string {
  const header = stockName
    ? `**【AI 解读 · ${stockCode} · ${stockName}】(多维引擎 hard)**`
    : `**【AI 解读 · ${stockCode}】(多维引擎 hard)**`;
  const labelMap: Record<string, string> = {
    strong_buy: '强烈买入',
    buy: '买入',
    hold: '持有 / 观望',
    sell: '卖出',
    strong_sell: '强烈卖出',
    unknown: '暂无明确建议',
  };
  const dimLabel: Record<HardShortCircuitDimension, string> = {
    fundamental: '基本面',
    technical: '技术面',
    capital: '资金面',
    news: '新闻面',
    sentiment: '情绪面',
  };
  const recoLabel = labelMap[recommendation] || recommendation;
  const recoParts = [`- 综合建议：${recoLabel}`];
  if (confidenceScore !== null && Number.isFinite(confidenceScore)) {
    recoParts.push(`置信 ${Math.round(confidenceScore)}`);
  }
  if (riskLevel) recoParts.push(`风险 ${riskLevel}`);
  const recoLine =
    recoParts.length > 1 ? `${recoParts[0]} (${recoParts.slice(1).join(' / ')})` : recoParts[0];
  const lines: string[] = [header, recoLine];
  for (const d of dimensions) {
    const points = keyPoints[d] || [];
    if (points.length === 0) continue;
    const label = dimLabel[d];
    if (points.length === 1) {
      lines.push(`- ${label}：${points[0]}`);
    } else {
      lines.push(`- ${label}：`);
      for (const p of points) lines.push(`  - ${p}`);
    }
  }
  return lines.join('\n');
}

/**
 * RecommendationDecision → HardShortCircuitResult 纯转换.
 * 不写 DB / 不调 archive — 主入口 (`maybeRunHardShortCircuit`) 单独走 persist + archive 步骤.
 */
export function buildHardShortCircuitResult(
  decision: RecommendationDecision,
  ctx: {
    report_id: string;
    stock_code: string;
    stock_name: string | null;
    dimensions: ReadonlyArray<HardShortCircuitDimension>;
    target_date: string | null;
    metadata: Record<string, unknown>;
    now: Date;
  }
): HardShortCircuitResult {
  const recommendation = mapActionToRecommendation(decision.action);
  const confidence = Number.isFinite(decision.overall_confidence)
    ? Math.max(0, Math.min(100, Math.round(decision.overall_confidence * 100)))
    : null;
  const riskLevel = pickHardRiskLevel(decision);
  const keyPoints = buildKeyPointsFromDecision(decision, ctx.dimensions);
  const filledDims = ctx.dimensions.filter(d => (keyPoints[d] || []).length > 0).length;
  // data_quality=critical → status=partial 显式提醒 UI; 否则任何 evidence 缺失也不降级
  // (与 ShadowDoubleRunService 行为对齐 — 多维引擎已显式 data_missing, 这里不复算).
  const status: 'completed' | 'partial' =
    decision.data_quality?.level === 'critical' || filledDims < ctx.dimensions.length
      ? 'partial'
      : 'completed';
  const summary = buildHardModeSummary(
    ctx.stock_code,
    ctx.stock_name,
    recommendation,
    confidence,
    riskLevel,
    ctx.dimensions,
    keyPoints
  );
  const metadata: Record<string, unknown> = {
    ...ctx.metadata,
    engine_variant: decision.engine_variant,
    overall_confidence: decision.overall_confidence,
    data_quality: decision.data_quality,
    entry_zone: decision.entry_zone,
    stop_loss: decision.stop_loss,
    take_profit: decision.take_profit,
    suggested_position_pct: decision.suggested_position_pct,
    per_dimension: decision.per_dimension.map(d => ({
      analyzer_key: d.analyzer_key,
      score: d.score,
      confidence: d.confidence,
      data_missing: d.data_missing,
      error: d.error,
    })),
    risk_warnings: decision.risk_warnings,
    hard_short_circuit: true,
    hard_short_circuit_action: decision.action,
  };
  return {
    report_id: ctx.report_id,
    stock_code: ctx.stock_code,
    stock_name: ctx.stock_name,
    dimensions: [...ctx.dimensions],
    summary,
    recommendation,
    confidence_score: confidence,
    risk_level: riskLevel,
    key_points: keyPoints,
    status,
    task_id: null,
    target_date: ctx.target_date,
    error: status === 'partial' ? '部分维度数据缺失或被 data_quality 降级' : null,
    generated_at: ctx.now.toISOString(),
    metadata,
    persisted: false,
  };
}

// ---------------------------------------------------------------------------
//  DataSource DI
// ---------------------------------------------------------------------------

export interface HardShortCircuitDataSource {
  /** 读取用户 risk_config.analysis_engine; user_id=null → 默认 off. */
  loadUserConfig(user_id: number | null | undefined): Promise<AnalysisEngineUserConfig>;
  /** 调多维引擎主路径; throw → caller 转 status='failed' result. */
  analyzeStock(stockCode: string, opts: AnalyzeStockOptions): Promise<RecommendationDecision>;
  /**
   * 持久化 `AIStockAnalysisReport(engine_variant='multi_dim_v1')`. 与 shadow path 的
   * persistShadowReport 不同 — 这里 shadow_of_report_id=null, 因为 hard mode 它本身就是 prod.
   * throw → caller 不阻塞返 metadata.save_error.
   */
  persistEngineReport(
    decision: RecommendationDecision,
    result: HardShortCircuitResult
  ): Promise<void>;
  /** Archive 到 AIInvestmentSignal; 失败返 {ok:false, reason}, 不抛 (helper 已内部 try/catch). */
  archiveHardSignal(
    decision: RecommendationDecision,
    prodReportId: string,
    user_id?: number | null
  ): Promise<ArchiveAnalysisEngineResultOutput>;
}

/**
 * 生产 DataSource — lazy require 让 module import 在 DB-less 单测环境不拽起 sequelize.
 * 与 createProductionAnalysisEngineArchiveDataSource / createProductionAIPollingEnqueueDataSource
 * 同模式.
 */
export function createProductionHardShortCircuitDataSource(): HardShortCircuitDataSource {
  return {
    async loadUserConfig(user_id) {
      if (!user_id) return { ...DEFAULT_ANALYSIS_ENGINE_CONFIG };
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { User } = require('../../models/User');
        const user = await User.findByPk(user_id);
        if (!user) return { ...DEFAULT_ANALYSIS_ENGINE_CONFIG };
        const cfg = (user.risk_config && user.risk_config.analysis_engine) || null;
        return normalizeAnalysisEngineConfig(cfg);
      } catch (_e) {
        return { ...DEFAULT_ANALYSIS_ENGINE_CONFIG };
      }
    },
    async analyzeStock(stockCode, opts) {
      return analysisEngineService.analyzeStock(stockCode, opts);
    },
    async persistEngineReport(decision, result) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { AIStockAnalysisReport } = require('../../models/AIStockAnalysisReport');
      await AIStockAnalysisReport.create({
        report_id: result.report_id,
        user_id: (result.metadata?.user_id as number | undefined) ?? null,
        stock_code: result.stock_code,
        stock_name: result.stock_name,
        dimensions: result.dimensions,
        summary: result.summary,
        recommendation: result.recommendation,
        confidence_score: result.confidence_score,
        risk_level: result.risk_level,
        key_points_json: result.key_points,
        status: result.status,
        task_id: null,
        target_date: result.target_date,
        error: result.error,
        generated_at: new Date(result.generated_at),
        engine_variant: decision.engine_variant,
        shadow_of_report_id: null,
        metadata: result.metadata,
      } as any);
    },
    async archiveHardSignal(decision, prodReportId, user_id) {
      try {
        const ds: AnalysisEngineArchiveDataSource =
          createProductionAnalysisEngineArchiveDataSource();
        return await archiveAnalysisEngineResult(ds, {
          decision,
          shadow_of_report_id: prodReportId,
          extra_metadata: {
            source_user_id: user_id ?? null,
            archived_from: 'ai_advisor_hard_short_circuit',
          },
        });
      } catch (e: any) {
        return {
          ok: false,
          reason: 'db_failure',
          payload: null,
          error: { message: String(e?.message || e) },
        };
      }
    },
  };
}

export const PRODUCTION_HARD_SHORT_CIRCUIT_DATA_SOURCE: HardShortCircuitDataSource =
  createProductionHardShortCircuitDataSource();

// ---------------------------------------------------------------------------
//  Main entry
// ---------------------------------------------------------------------------

export interface MaybeRunHardShortCircuitInput {
  stock_code: string;
  user_id?: number | null;
  target_date?: string;
  stock_name?: string | null;
  /** 默认 HARD_SHORT_CIRCUIT_DIMENSIONS 全 5 维度; caller 可子集. */
  dimensions?: ReadonlyArray<HardShortCircuitDimension>;
  task_label?: string | null;
  dry_run?: boolean;
  report_id: string;
  /** AIAdvisorService 早已构造的 base metadata, 直接透传 */
  metadata: Record<string, unknown>;
  now?: Date;
}

/**
 * 主入口 — 见文件头注释.
 *
 * 返回:
 *   - null → 非 hard 模式, caller 必须 fall-through 旧路径.
 *   - HardShortCircuitResult → hard 模式已完整跑完 (含 persist + archive),
 *     caller 直接 return.
 *
 * AC 一: mode='hard' 时直接调 analyzeStock — 实测靠 fake DataSource verify
 *        callRemoteAnalyze 0 次 + analyzeStock 1 次.
 * AC 二: 不阻塞主路径 — analyzeStock throw / persist throw / archive throw 都不抛.
 */
export async function maybeRunHardShortCircuit(
  source: HardShortCircuitDataSource,
  input: MaybeRunHardShortCircuitInput
): Promise<HardShortCircuitResult | null> {
  let cfg: AnalysisEngineUserConfig;
  try {
    cfg = await source.loadUserConfig(input.user_id);
  } catch (e: any) {
    logger.warn(
      `[analysis-engine.hard] loadUserConfig failed for user=${input.user_id ?? 'null'}: ${
        e?.message || e
      }`
    );
    return null;
  }
  if (cfg.mode !== 'hard') return null;

  const dimensions = input.dimensions || HARD_SHORT_CIRCUIT_DIMENSIONS;
  const now = input.now || new Date();
  const target_date = input.target_date || null;

  let decision: RecommendationDecision;
  try {
    decision = await source.analyzeStock(input.stock_code, {
      as_of: input.target_date,
      user_id: input.user_id ?? undefined,
      enabled_analyzers: cfg.enabled_analyzers as any,
      weights: cfg.weights,
    });
  } catch (e: any) {
    // analyzeStock throw → 返 status='failed' result, 让 UI 知道 hard 模式跑失败
    // 而不是静默 fallback 到 TradingAgents (后者破坏 hard 语义).
    logger.warn(
      `[analysis-engine.hard] analyzeStock failed for ${input.stock_code}: ${e?.message || e}`
    );
    return {
      report_id: input.report_id,
      stock_code: input.stock_code,
      stock_name: input.stock_name ?? null,
      dimensions: [...dimensions],
      summary: '',
      recommendation: 'unknown',
      confidence_score: null,
      risk_level: null,
      key_points: Object.fromEntries(dimensions.map(d => [d, []])) as Record<string, string[]>,
      status: 'failed',
      task_id: null,
      target_date,
      error: `analysis_engine hard mode failed: ${e?.message || e}`,
      generated_at: now.toISOString(),
      metadata: {
        ...input.metadata,
        hard_short_circuit: true,
        hard_short_circuit_error: String(e?.message || e),
      },
      persisted: false,
    };
  }

  const result = buildHardShortCircuitResult(decision, {
    report_id: input.report_id,
    stock_code: input.stock_code,
    stock_name: input.stock_name ?? null,
    dimensions,
    target_date,
    metadata: input.metadata,
    now,
  });

  if (input.dry_run) {
    return result;
  }

  try {
    await source.persistEngineReport(decision, result);
    result.persisted = true;
  } catch (e: any) {
    logger.warn(
      `[analysis-engine.hard] persistEngineReport failed for ${result.report_id}: ${
        e?.message || e
      }`
    );
    result.metadata = { ...result.metadata, save_error: String(e?.message || e) };
  }

  // Archive to AIInvestmentSignal — fail-OPEN. helper 自身已 try/catch 返
  // {ok:false, reason}, 这里再 try/catch 双保险.
  try {
    const archive = await source.archiveHardSignal(decision, result.report_id, input.user_id);
    if (!archive.ok) {
      logger.warn(
        `[analysis-engine.hard] archive failed for ${input.stock_code} ` +
          `reason=${archive.reason || 'unknown'} msg=${archive.error?.message || ''}`
      );
      result.metadata = {
        ...result.metadata,
        archive_error: archive.error?.message || archive.reason || 'unknown',
      };
    } else {
      result.metadata = {
        ...result.metadata,
        archive_signal_id: (archive.signal as any)?.id ?? null,
        archive_created: archive.created === true,
      };
    }
  } catch (e: any) {
    logger.warn(
      `[analysis-engine.hard] archiveHardSignal threw for ${input.stock_code}: ${e?.message || e}`
    );
    result.metadata = { ...result.metadata, archive_error: String(e?.message || e) };
  }

  return result;
}
