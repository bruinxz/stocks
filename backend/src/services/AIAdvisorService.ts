import axios from 'axios';
import { logger } from '../utils/logger';
import { DataSourceHealthService } from '../data/services/DataSourceHealthService';

const TRADING_AGENTS_URL = process.env.TRADING_AGENTS_URL || 'http://47.93.224.109:8000';

export function normalizeTradingAgentsError(error: any): string {
  let raw = '';
  if (typeof error === 'string') {
    raw = error;
  } else if (error?.message || error?.error || error?.detail) {
    raw = error.message || error.error || error.detail;
  } else {
    try {
      raw = JSON.stringify(error || '');
    } catch {
      raw = String(error || '');
    }
  }
  const message = String(raw || '').trim();

  if (!message) return 'TradingAgents 远端任务失败，未返回具体原因';

  if (
    message === "'日期'" ||
    message.includes("KeyError: '日期'") ||
    message.includes("Remote AI task failed: '日期'")
  ) {
    return [
      'TradingAgents 行情缓存日期字段异常：本地 CSV/接口返回缺少“日期”列，或并发写入缓存时读到了半成品文件。',
      '系统已补强日期字段归一化与原子写入；如仍出现，请重启 TradingAgents 并重跑该股票分析。',
    ].join('');
  }

  if (message.includes('Cannot calculate requested indicators')) {
    return 'TradingAgents 技术指标计算失败：模型请求了不支持的指标，已降级为跳过该指标并继续分析。';
  }

  return message;
}

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
      const message = normalizeTradingAgentsError(error.response?.data?.detail || error);
      logger.error(`AIAdvisorService analyzeStock failed: ${message}`);
      throw new Error(message || '调用 AI 智能体服务失败');
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
      const message = normalizeTradingAgentsError(error.response?.data?.detail || error);
      logger.error(`AIAdvisorService getTaskStatus failed: ${message}`);
      throw new Error(message || '查询 AI 智能体任务状态失败');
    }
  }
}

export const aiAdvisorService = new AIAdvisorService();
