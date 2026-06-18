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
 *       任何错误吞掉, 不影响 prod 主路径.
 *     - 'hard': v1 不实现, 留 warn log + 走 'off' 行为. 见 runbook W4+.
 */

import { logger } from '../../utils/logger';
import { analysisEngineService } from './AnalysisEngineService';
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
      if (cfg.mode === 'hard') {
        // v1: 不实现 hard mode; 退化为 shadow 行为 + warn (避免用户误开 hard 后 silent)
        logger.warn(
          `[analysis-engine.shadow] user_id=${input.user_id} mode=hard 不支持 (v1 仅 shadow); ` +
            '走 shadow 行为. 见 runbook W4+.'
        );
      }
      const decision = await analysisEngineService.analyzeStock(input.stock_code, {
        as_of: input.as_of,
        user_id: input.user_id ?? undefined,
        shadow_of_report_id: input.prod_report_id,
        enabled_analyzers: cfg.enabled_analyzers as any,
        weights: cfg.weights,
      });
      await this.dataSource.persistShadowReport(decision, input.prod_report_id);
      return decision;
    } catch (e: any) {
      logger.warn(`[analysis-engine.shadow] failed for ${input.stock_code}: ${e?.message || e}`);
      return null;
    }
  }
}

export const shadowDoubleRunService = new ShadowDoubleRunService();
