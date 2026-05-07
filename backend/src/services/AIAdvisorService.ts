import axios from 'axios';
import { logger } from '../utils/logger';
import { DataSourceHealthService } from '../data/services/DataSourceHealthService';

const TRADING_AGENTS_URL = process.env.TRADING_AGENTS_URL || 'http://47.93.224.109:8000';

export class AIAdvisorService {
  /**
   * 获取 TradingAgents 健康与能力元信息
   */
  async getHealth(refresh = false) {
    if (refresh) {
      await DataSourceHealthService.probeTradingAgents();
    }

    const providers = await DataSourceHealthService.getHealthSnapshots();
    const tradingAgents = providers.find(provider => provider.provider_name === 'tradingagents');

    if (tradingAgents) {
      return {
        ...tradingAgents,
        base_url: tradingAgents.metadata?.base_url || TRADING_AGENTS_URL,
      };
    }

    const startedAt = Date.now();
    try {
      const response = await axios.get(`${TRADING_AGENTS_URL}/health`, { timeout: 5000 });
      return {
        provider_name: 'tradingagents',
        provider_label: 'TradingAgents',
        status: response.data?.status === 'ok' ? 'healthy' : 'degraded',
        health_score: response.data?.status === 'ok' ? 90 : 60,
        base_url: TRADING_AGENTS_URL,
        last_latency_ms: Date.now() - startedAt,
        metadata: response.data || {},
      };
    } catch (error: any) {
      logger.warn(`TradingAgents health probe failed: ${error.message}`);
      return {
        provider_name: 'tradingagents',
        provider_label: 'TradingAgents',
        status: 'unhealthy',
        health_score: 0,
        base_url: TRADING_AGENTS_URL,
        last_latency_ms: Date.now() - startedAt,
        last_error: error.message,
      };
    }
  }

  /**
   * 提交同步/异步分析任务
   */
  async analyzeStock(ticker: string, targetDate?: string, isAsync = false) {
    try {
      const response = await axios.post(`${TRADING_AGENTS_URL}/api/analyze`, {
        ticker,
        target_date: targetDate,
        is_async: isAsync,
      });
      return response.data;
    } catch (error: any) {
      logger.error(`AIAdvisorService analyzeStock failed: ${error.message}`);
      throw new Error(error.response?.data?.detail || '调用 AI 智能体服务失败');
    }
  }

  /**
   * 查询异步任务状态
   */
  async getTaskStatus(taskId: string) {
    try {
      const response = await axios.get(`${TRADING_AGENTS_URL}/api/tasks/${taskId}`);
      return response.data;
    } catch (error: any) {
      logger.error(`AIAdvisorService getTaskStatus failed: ${error.message}`);
      throw new Error(error.response?.data?.detail || '查询 AI 智能体任务状态失败');
    }
  }
}

export const aiAdvisorService = new AIAdvisorService();
