import { Request, Response } from 'express';
import { quantRecommendationService } from '../../services/QuantRecommendationService';
import { aiAdvisorService } from '../../services/AIAdvisorService';
import { aiInvestmentSignalService } from '../../services/AIInvestmentSignalService';
import { AISignalSourceType } from '../../models/AIInvestmentSignal';
import { aiPollingQueue } from '../../jobs/aiPollingQueue';
import { logger } from '../../utils/logger';

export class QuantRecommendationController {
  listRecommendations = async (req: Request, res: Response) => {
    try {
      const user_id = (req as any).user?.id;
      const {
        universe = 'favorites',
        style = 'balanced',
        limit = '20',
        lookback_days = '120',
      } = req.query;

      const result = await quantRecommendationService.generateRecommendations({
        user_id,
        universe: universe === 'market' ? 'market' : 'favorites',
        style: ['balanced', 'momentum', 'value', 'low_risk'].includes(style as string)
          ? (style as any)
          : 'balanced',
        limit: parseInt(limit as string, 10),
        lookback_days: parseInt(lookback_days as string, 10),
      });

      res.json({ success: true, data: result });
    } catch (error: any) {
      logger.error('获取量化候选推荐失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  };

  submitToTradingAgents = async (req: Request, res: Response) => {
    try {
      const { symbols, target_date, max_count = 5 } = req.body || {};
      if (!Array.isArray(symbols) || symbols.length === 0) {
        return res.status(400).json({ success: false, message: 'symbols 不能为空' });
      }

      const limitedSymbols = symbols.slice(0, Math.min(Number(max_count) || 5, 10));
      const submitted: any[] = [];
      const failed: any[] = [];

      for (const item of limitedSymbols) {
        const symbol = typeof item === 'string' ? item : item.symbol;
        const name = typeof item === 'string' ? item : item.name || item.symbol;
        if (!symbol) continue;

        try {
          const result = await aiAdvisorService.analyzeStock(symbol, target_date, true);
          if (result?.task_id) {
            await aiPollingQueue.add(
              {
                taskId: result.task_id,
                symbol,
                name,
                taskLabel: '多因子候选深度研报',
                quant_score: typeof item === 'string' ? undefined : item.score,
                quant_factors: typeof item === 'string' ? undefined : item.factors,
                quant_reasons: typeof item === 'string' ? undefined : item.reasons,
                quant_warnings: typeof item === 'string' ? undefined : item.warnings,
                recommendation_style:
                  typeof item === 'string' ? undefined : item.recommendation_style,
                recommendation_source:
                  typeof item === 'string' ? 'manual_recommendation' : item.source,
              },
              {
                jobId: `ai-recommend-${result.task_id}`,
                attempts: 10,
                backoff: { type: 'fixed', delay: 3 * 60 * 1000 },
              }
            );
            submitted.push({ symbol, name, task_id: result.task_id, status: result.status });
          } else {
            failed.push({ symbol, name, error: 'TradingAgents 未返回 task_id' });
          }
        } catch (error: any) {
          failed.push({ symbol, name, error: error.message });
        }
      }

      res.json({ success: true, data: { submitted, failed } });
    } catch (error: any) {
      logger.error('提交多因子候选至 TradingAgents 失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  };

  archiveRecommendations = async (req: Request, res: Response) => {
    try {
      const user_id = (req as any).user?.id;
      const {
        candidates,
        universe = 'favorites',
        style = 'balanced',
        limit = 20,
        lookback_days = 120,
        signal_date,
        verify = true,
      } = req.body || {};

      const normalizedUniverse = universe === 'market' ? 'market' : 'favorites';
      const normalizedStyle = ['balanced', 'momentum', 'value', 'low_risk'].includes(style)
        ? style
        : 'balanced';

      let payloadCandidates = Array.isArray(candidates) ? candidates : [];
      let as_of = req.body?.as_of;
      let generated: any = null;

      if (payloadCandidates.length === 0) {
        generated = await quantRecommendationService.generateRecommendations({
          user_id,
          universe: normalizedUniverse,
          style: normalizedStyle,
          limit: Number(limit) || 20,
          lookback_days: Number(lookback_days) || 120,
          include_trend: true,
        });
        payloadCandidates = generated.recommendations || [];
        as_of = generated.as_of;
      }

      if (payloadCandidates.length === 0) {
        return res.status(400).json({ success: false, message: '没有可归档的候选推荐' });
      }

      const sync = await aiInvestmentSignalService.archiveQuantRecommendations({
        candidates: payloadCandidates,
        universe: normalizedUniverse,
        style: normalizedStyle,
        as_of,
        signal_date,
      });

      const verification =
        verify === false
          ? null
          : await aiInvestmentSignalService.verifySignals({
              source_type: AISignalSourceType.QUANT_RECOMMENDATION,
              limit: Math.max(sync.total, 20),
            });
      const stats = await aiInvestmentSignalService.getSignalStats({
        source_type: AISignalSourceType.QUANT_RECOMMENDATION,
      });

      res.json({
        success: true,
        data: {
          sync,
          verification,
          stats,
          generated: generated
            ? {
                as_of: generated.as_of,
                total_candidates: generated.total_candidates,
                analyzed_candidates: generated.analyzed_candidates,
              }
            : null,
        },
      });
    } catch (error: any) {
      logger.error('归档量化候选信号失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  };
}

export const quantRecommendationController = new QuantRecommendationController();
