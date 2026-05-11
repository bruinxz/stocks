import { logger } from '../utils/logger';
import { feishuTaskReportService, StockAnalysisReportPayload } from './FeishuTaskReportService';

/**
 * 通知服务：负责把业务事件写入飞书多维表格。
 *
 * 核心能力：
 *  - 单只股票 AI 分析完成 → 写入飞书 Base，供团队沉淀和复盘
 */

export type StockAnalysisPayload = StockAnalysisReportPayload;

class NotificationService {
  /**
   * 写入单只股票的 AI 分析结果到飞书多维表格。
   */
  async notifyStockAnalysis(payload: StockAnalysisPayload): Promise<void> {
    try {
      const result = await feishuTaskReportService.reportStockAnalysis(payload);
      if (result.success) {
        logger.info(`已写入飞书 AI 分析结果: ${payload.symbol} (${payload.name})`);
      } else {
        logger.error(`写入飞书 AI 分析结果失败: ${result.message}`);
      }
    } catch (err) {
      logger.error('notifyStockAnalysis 失败:', err);
    }
  }
}

export const notificationService = new NotificationService();
