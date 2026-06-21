/**
 * ShadowDoubleRunService — 复用 PortfolioConstructionAdapter 的 off/shadow/hard 三态范式
 * (见 docs/audit/analysis_engine_design_2026_06_18.md §4.1).
 *
 * 入口:
 *   - 在 AIAdvisorService.analyzeSingleStock 末尾调 shadowDoubleRunService.maybeRunShadow(...)
 *   - 由本 service 读 User.risk_config.analysis_engine.mode 决定行为:
 *     - 'off' (默认): 立即返回, 零开销.
 *     - 'shadow': 异步 setImmediate 调 AnalysisEngineService.analyzeStock, 写入
 *       AIStockAnalysisReport(engine_variant='multi_dim_v1', shadow_of_report_id=prod_id).
 *       任何错误吞掉, 不影响 prod 主路径. **不** 写 AIInvestmentSignal (不污染跟单).
 *     - 'hard' (US-021/AE-002): 在 shadow 行为基础上, **追加** 调
 *       `archiveAnalysisEngineResult` 把决策落 `AIInvestmentSignal`
 *       (source_type=ANALYSIS_ENGINE), 让 PaperTradingAutomationService
 *       autoBuyFromSignals 真的能跟单 + Dashboard/Attribution 可视化.
 *       archive 失败 fail-OPEN — 仅 logger.warn 不阻塞主路径; 主路径错误同样吞掉.
 *       见 docs/audit/analysis_engine_runbook.md W4+.
 */

import { logger } from '../../utils/logger';
import { analysisEngineService } from './AnalysisEngineService';
import {
  archiveAnalysisEngineResult,
  createProductionAnalysisEngineArchiveDataSource,
  type AnalysisEngineArchiveDataSource,
  type ArchiveAnalysisEngineResultOutput,
} from './analysisEngineSignalArchive';
import type { AnalyzerKey, RecommendationDecision } from './AnalyzerTypes';

export type AnalysisEngineMode = 'off' | 'shadow' | 'hard';

/**
 * US-139 [AE-009] — 8 dim analyzer key 白名单 single source of truth.
 *
 * 与 `AnalyzerTypes.AnalyzerKey` / 前端 `analysisEngineWeightHelpers.ANALYZER_DIMENSIONS`
 * 同名同序; 任何 `risk_config.analysis_engine.weights` / `.enabled_analyzers` 进入
 * 持久化之前必须先过这层过滤, 把 unknown key / typo (e.g. 'fundamentals' 复数误写)
 * / 拼写差异 (e.g. 'industryRegime' camelCase) 直接 **静默丢弃**, 防止 JSONB 被污染.
 *
 * 为何不抛错: 与 mode='evil' → 'off' 同款 lenient 策略 — 上游 API/历史脏数据/前端
 * 老版本兼容. 写错的 key 等同未配置, 退回 `DEFAULT_ANALYZER_WEIGHTS` 兜底.
 *
 * Object.freeze + Set 防 caller 误 mutate 让全局漂移 (与 [[Codebase Patterns]]
 * "DEFAULT_* 必须 Object.freeze" 同源).
 */
export const ANALYZER_KEYS: ReadonlyArray<AnalyzerKey> = Object.freeze([
  'fundamental',
  'technical',
  'capital',
  'news',
  'sentiment',
  'industry_regime',
  'risk',
  'event',
]);
const ANALYZER_KEYS_SET: ReadonlySet<string> = new Set(ANALYZER_KEYS);

export interface AnalysisEngineUserConfig {
  mode: AnalysisEngineMode;
  enabled_analyzers?: string[];
  weights?: Record<string, number>;
}

export const DEFAULT_ANALYSIS_ENGINE_CONFIG: Readonly<AnalysisEngineUserConfig> = Object.freeze({
  mode: 'off',
});

/**
 * US-139 [AE-009] — 把任意 raw weights blob 过滤成 "仅 8 个 known AnalyzerKey + 有限非负 number".
 *
 * 设计:
 *  - unknown key 丢弃 (typo 'fundamentals' / 'industryRegime' / 'foo' 全 drop)
 *  - 非 number / NaN / Infinity / 负数 丢弃 (前端 slider 范围 0~100, 不应越界)
 *  - 0 保留 (用户主动屏蔽某一 dim 是合法语义)
 *  - 结果为空 {} 时返 undefined 走 DecisionAggregator 全默认权重 (sum=1 默认)
 *
 * 不在此处归一化 sum=1: DecisionAggregator.normalizeWeights 已做, 这里只把"垃圾键值"
 * 过滤掉, 保留用户语义 (e.g. 用户填 50/30/20 而非 0.5/0.3/0.2, 都会被 downstream
 * 重新归一化, 比例正确).
 */
function sanitizeWeights(raw: unknown): Record<string, number> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, number> = {};
  for (const k of Object.keys(raw as Record<string, unknown>)) {
    if (!ANALYZER_KEYS_SET.has(k)) continue;
    const v = Number((raw as Record<string, unknown>)[k]);
    if (!Number.isFinite(v) || v < 0) continue;
    out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * US-139 [AE-009] — enabled_analyzers 同款白名单 + dedupe.
 * 非 string / unknown key 丢弃; 结果为空时返 undefined 让 service 端走全 8 dim 默认.
 */
function sanitizeEnabledAnalyzers(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of raw) {
    if (typeof s !== 'string') continue;
    if (!ANALYZER_KEYS_SET.has(s)) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out.length > 0 ? out : undefined;
}

export function normalizeAnalysisEngineConfig(raw: any): AnalysisEngineUserConfig {
  const obj = raw && typeof raw === 'object' ? raw : {};
  const validModes: AnalysisEngineMode[] = ['off', 'shadow', 'hard'];
  const mode = validModes.includes(obj.mode) ? obj.mode : 'off';
  return {
    mode,
    enabled_analyzers: sanitizeEnabledAnalyzers(obj.enabled_analyzers),
    weights: sanitizeWeights(obj.weights),
  };
}

export interface ShadowDataSource {
  /** 读取用户 risk_config.analysis_engine. user_id=null/system 时返回默认 off. */
  loadUserConfig(user_id: number | null | undefined): Promise<AnalysisEngineUserConfig>;
  /** 把 shadow decision 持久化为 AIStockAnalysisReport(engine_variant=multi_dim_v1). */
  persistShadowReport(decision: RecommendationDecision, prodReportId: string): Promise<void>;
  /**
   * hard mode 专用 — 把 decision archive 到 AIInvestmentSignal
   * (source_type=ANALYSIS_ENGINE). 默认实现委托 `archiveAnalysisEngineResult`
   * + 生产 DataSource. 测试可注入 fake 复刻 findOrCreate / db_failure 路径.
   * 返 ArchiveAnalysisEngineResultOutput 让 caller 决定 logger.warn 哪种 reason.
   */
  archiveHardSignal(
    decision: RecommendationDecision,
    prodReportId: string,
    user_id?: number | null
  ): Promise<ArchiveAnalysisEngineResultOutput>;
}

export const PRODUCTION_SHADOW_DATA_SOURCE: ShadowDataSource = {
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
  async persistShadowReport(decision, prodReportId) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { AIStockAnalysisReport } = require('../../models/AIStockAnalysisReport');
      const reportId = `${decision.stock_code}-${decision.as_of}-shadow-${Date.now()}`;
      await AIStockAnalysisReport.create({
        report_id: reportId,
        stock_code: decision.stock_code,
        stock_name: null,
        dimensions: decision.per_dimension.map(d => d.analyzer_key),
        summary: `[shadow] action=${
          decision.action
        } confidence=${decision.overall_confidence.toFixed(2)}`,
        recommendation: decision.action,
        confidence_score: Math.round(decision.overall_confidence * 100),
        risk_level: pickRiskLevel(decision),
        key_points_json: {
          key_reasons: decision.key_reasons,
          risk_warnings: decision.risk_warnings,
          per_dimension: decision.per_dimension,
        },
        status: 'completed',
        target_date: decision.as_of,
        generated_at: new Date(),
        engine_variant: decision.engine_variant,
        shadow_of_report_id: prodReportId,
        metadata: {
          data_quality: decision.data_quality,
          entry_zone: decision.entry_zone,
          stop_loss: decision.stop_loss,
          take_profit: decision.take_profit,
          suggested_position_pct: decision.suggested_position_pct,
        },
      });
    } catch (e: any) {
      logger.warn(
        `[analysis-engine.shadow] persist failed for ${decision.stock_code}: ${e?.message || e}`
      );
    }
  },
  async archiveHardSignal(decision, prodReportId, user_id) {
    // US-021 [AE-002] hard mode 落 AIInvestmentSignal — 委托 US-020 helper.
    // helper 内部已 fail-LOUD (返 {ok:false, reason}), 这里再套 try/catch 拦
    // 极端 throw (e.g. lazy-require 模块加载失败), 让 caller 拿到统一形态.
    try {
      const ds: AnalysisEngineArchiveDataSource = createProductionAnalysisEngineArchiveDataSource();
      return await archiveAnalysisEngineResult(ds, {
        decision,
        shadow_of_report_id: prodReportId,
        extra_metadata: {
          source_user_id: user_id ?? null,
          archived_from: 'shadow_double_run_hard',
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

function pickRiskLevel(d: RecommendationDecision): string {
  const risk = d.per_dimension.find(p => p.analyzer_key === 'risk');
  if (!risk) return 'unknown';
  if (risk.score <= -50) return 'high';
  if (risk.score <= -20) return 'medium';
  return 'low';
}

export interface MaybeRunShadowInput {
  stock_code: string;
  as_of?: string;
  user_id?: number | null;
  prod_report_id: string;
}

export class ShadowDoubleRunService {
  constructor(private readonly dataSource: ShadowDataSource = PRODUCTION_SHADOW_DATA_SOURCE) {}

  /**
   * 入口: AIAdvisorService.analyzeSingleStock 末尾 fire-and-forget 调用.
   * **不返回 Promise**: 不阻塞主路径; 内部完全吞错.
   */
  maybeRunShadow(input: MaybeRunShadowInput): void {
    // 异步执行, 不 await
    setImmediate(() => {
      this.runShadowAsync(input).catch(e => {
        // double-defense: 内部已 try/catch, 这里再吞一次保险
        logger.warn(
          `[analysis-engine.shadow] uncaught for ${input.stock_code}: ${e?.message || e}`
        );
      });
    });
  }

  /**
   * 测试可见的同步版本 — 等待 shadow 跑完后返回.
   */
  async runShadowSync(input: MaybeRunShadowInput): Promise<RecommendationDecision | null> {
    return this.runShadowAsync(input);
  }

  private async runShadowAsync(input: MaybeRunShadowInput): Promise<RecommendationDecision | null> {
    try {
      const cfg = await this.dataSource.loadUserConfig(input.user_id);
      if (cfg.mode === 'off') return null;
      const decision = await analysisEngineService.analyzeStock(input.stock_code, {
        as_of: input.as_of,
        user_id: input.user_id ?? undefined,
        shadow_of_report_id: input.prod_report_id,
        enabled_analyzers: cfg.enabled_analyzers as any,
        weights: cfg.weights,
      });
      // shadow + hard 都写 AIStockAnalysisReport (engine_variant 标签 + 看板对照)
      await this.dataSource.persistShadowReport(decision, input.prod_report_id);
      // US-021 [AE-002] hard mode: **追加** archive 到 AIInvestmentSignal
      // 让 PaperTradingAutomationService.autoBuyFromSignals 真的能跟单.
      // shadow mode 完全不调 archive — 不污染 AIInvestmentSignal (与 README 边界一致).
      if (cfg.mode === 'hard') {
        const archive = await this.dataSource.archiveHardSignal(
          decision,
          input.prod_report_id,
          input.user_id ?? null
        );
        if (!archive.ok) {
          // fail-OPEN: archive 失败仅 warn, 不阻塞主路径 (shadow report 已写).
          logger.warn(
            `[analysis-engine.hard] archive failed for ${input.stock_code} ` +
              `reason=${archive.reason || 'unknown'} msg=${archive.error?.message || ''}`
          );
        }
      }
      return decision;
    } catch (e: any) {
      logger.warn(`[analysis-engine.shadow] failed for ${input.stock_code}: ${e?.message || e}`);
      return null;
    }
  }
}

export const shadowDoubleRunService = new ShadowDoubleRunService();
