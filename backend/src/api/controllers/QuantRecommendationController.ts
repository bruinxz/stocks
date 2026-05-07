import { Request, Response } from 'express';
import { quantRecommendationService } from '../../services/QuantRecommendationService';
import { aiAdvisorService } from '../../services/AIAdvisorService';
import { aiPollingQueue } from '../../jobs/aiPollingQueue';
import { logger } from '../../utils/logger';

export class QuantRecommendationController {
  listRecommendations = async (req: Request, res: Response) => {
    try {
      const user_id = (req as any).user?.id;
      const { universe = 'favorites', style = 'balanced', limit = '20', lookback_days = '120' } = req.query;

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
                recommendation_style: typeof item === 'string' ? undefined : item.recommendation_style,
                recommendation_source: typeof item === 'string' ? 'manual_recommendation' : item.source,
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
}

export const quantRecommendationController = new QuantRecommendationController();
