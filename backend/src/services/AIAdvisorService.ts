import axios from 'axios';
import { logger } from '../utils/logger';

const TRADING_AGENTS_URL = process.env.TRADING_AGENTS_URL || 'http://47.93.224.109:8000';

export class AIAdvisorService {
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
