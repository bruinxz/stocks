import { pushPlusService } from './PushPlusService';
import { logger } from '../utils/logger';

/**
 * 通知服务：负责把业务事件转化成用户能收到的微信推送（PushPlus）
 *
 * 核心能力：
 *  - 单只股票 AI 分析完成 → 推送到 PushPlus 群组
 */

export interface StockAnalysisPayload {
  symbol: string;
  name: string;
  decision: string; // BUY / SELL / HOLD / STRONG_BUY
  rationale: string;
  detail?: string;
  score?: number;
  current_price?: number | null;
  price_change_pct?: number | null;
  task_label?: string; // 如 "AI优选-早盘分析"
}

const DECISION_EMOJI: Record<string, string> = {
  STRONG_BUY: '🔥',
  BUY: '🟢',
  HOLD: '🟡',
  SELL: '🔴',
  STRONG_SELL: '🔴',
};

const DECISION_LABEL: Record<string, string> = {
  STRONG_BUY: '强烈买入',
  BUY: '买入',
  HOLD: '持有',
  SELL: '卖出',
  STRONG_SELL: '强烈卖出',
};

class NotificationService {
  /**
   * 推送单只股票的 AI 分析结果到 PushPlus 群组
   * 采用全局群发模式，关注了该群组的所有人都会收到
   */
  async notifyStockAnalysis(payload: StockAnalysisPayload): Promise<void> {
    try {
      const { title, content } = this._buildMarkdown(payload);

      // 发送到 PushPlus 群组
      const result = await pushPlusService.sendMarkdownToTopic(title, content);

      if (result.success) {
        logger.info(`已成功向 PushPlus 群组推送 ${payload.symbol} (${payload.name}) 的 AI 分析结果`);
      } else {
        logger.error(`向 PushPlus 群组推送失败: ${result.message}`);
      }
    } catch (err) {
      logger.error('notifyStockAnalysis 失败:', err);
    }
  }

  private _buildMarkdown(payload: StockAnalysisPayload): {
    title: string;
    content: string;
  } {
    const decisionKey = (payload.decision || 'HOLD').toUpperCase();
    const emoji = DECISION_EMOJI[decisionKey] || '📊';
    const label = DECISION_LABEL[decisionKey] || decisionKey;

    const priceLine =
      payload.current_price != null
        ? `**最新价**: ${Number(payload.current_price).toFixed(2)}` +
          (payload.price_change_pct != null
            ? ` (${Number(payload.price_change_pct) >= 0 ? '+' : ''}${Number(
                payload.price_change_pct
              ).toFixed(2)}%)`
            : '')
        : '';

    const scoreLine =
      payload.score != null ? `**评分**: ${Number(payload.score).toFixed(0)}/100` : '';

    const labelLine = payload.task_label ? `**任务**: ${payload.task_label}` : '';

    const frontendBase = process.env.FRONTEND_BASE_URL || '';
    const jumpLine = frontendBase
      ? `\n[点击查看完整研报](${frontendBase}/screener)`
      : '';

    const title = `${emoji} ${payload.name}(${payload.symbol}) · ${label}`;

    const content = [
      `# ${emoji} ${payload.name} (${payload.symbol})`,
      '',
      `## 评级：${label}`,
      '',
      labelLine,
      priceLine,
      scoreLine,
      '',
      '---',
      '',
      '### 核心理由',
      payload.rationale ? payload.rationale.substring(0, 800) : '（暂无）',
      jumpLine,
    ]
      .filter(line => line !== null && line !== undefined && line !== '')
      .join('\n');

    return { title, content };
  }
}

export const notificationService = new NotificationService();
