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
import type { RecommendationDecision } from './AnalyzerTypes';

export type AnalysisEngineMode = 'off' | 'shadow' | 'hard';

export interface AnalysisEngineUserConfig {
  mode: AnalysisEngineMode;
  enabled_analyzers?: string[];
  weights?: Record<string, number>;
}

export const DEFAULT_ANALYSIS_ENGINE_CONFIG: Readonly<AnalysisEngineUserConfig> = Object.freeze({
  mode: 'off',
});

export function normalizeAnalysisEngineConfig(raw: any): AnalysisEngineUserConfig {
  const obj = raw && typeof raw === 'object' ? raw : {};
  const validModes: AnalysisEngineMode[] = ['off', 'shadow', 'hard'];
  const mode = validModes.includes(obj.mode) ? obj.mode : 'off';
  return {
    mode,
    enabled_analyzers: Array.isArray(obj.enabled_analyzers)
      ? obj.enabled_analyzers.filter((s: unknown): s is string => typeof s === 'string')
      : undefined,
    weights:
      obj.weights && typeof obj.weights === 'object' && !Array.isArray(obj.weights)
        ? (obj.weights as Record<string, number>)
        : undefined,
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
