import { User } from '../models/User';
import { Stock } from '../models/Stock';
import { FavoriteStock } from '../models/FavoriteStock';
import { pushPlusService } from './PushPlusService';
import { logger } from '../utils/logger';

/**
 * 通知服务：负责把业务事件转化成用户能收到的微信推送（PushPlus）
 *
 * 核心能力：
 *  - 单只股票 AI 分析完成 → 精准推送给「开启通知 && 收藏了该股票 && 已绑定 PushPlus」的用户
 *
 * 精准性保证：
 *  - 用户必须开启 wechat_notify_enabled
 *  - 用户必须已绑定 pushplus_token
 *  - 用户必须收藏了这只股票
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
   * 推送单只股票的 AI 分析结果给所有订阅用户
   * 每个用户使用自己的 PushPlus token 独立发送
   */
  async notifyStockAnalysis(payload: StockAnalysisPayload): Promise<void> {
    try {
      // 1. 找到这只股票的 id
      const stock = await Stock.findOne({ where: { symbol: payload.symbol } });
      if (!stock) {
        logger.warn(`通知推送跳过：股票 ${payload.symbol} 不存在`);
        return;
      }

      // 2. 找到所有收藏了该股票的用户
      const favs = await FavoriteStock.findAll({
        where: { stock_id: stock.id },
        attributes: ['user_id'],
      });
      if (favs.length === 0) return;

      const userIds = favs.map(f => f.user_id);

      // 3. 筛选出「开启通知 && 已绑定 PushPlus」的用户
      const users = await User.findAll({
        where: {
          id: userIds,
          is_active: true,
          wechat_notify_enabled: true,
        },
      });
      const subscribers = users.filter(u => !!u.pushplus_token);

      if (subscribers.length === 0) {
        logger.info(`股票 ${payload.symbol} 的分析无需推送（没有符合条件的用户）`);
        return;
      }

      const { title, content } = this._buildMarkdown(payload);

      // 4. 每个用户用自己的 token 独立发送（并发）
      const results = await Promise.allSettled(
        subscribers.map(u =>
          pushPlusService.sendMarkdownToUser(u.pushplus_token!, title, content)
        )
      );
      const okCount = results.filter(
        r => r.status === 'fulfilled' && (r.value as any).success
      ).length;
      logger.info(
        `已向 ${okCount}/${subscribers.length} 位用户推送 ${payload.symbol} (${payload.name}) 的 AI 分析结果`
      );
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
