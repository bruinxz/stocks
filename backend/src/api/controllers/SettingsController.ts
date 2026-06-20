import { Request, Response, NextFunction } from 'express';
import {
  dailyTradingDigestService,
  NotificationChannelsConfig,
} from '../../services/DailyTradingDigestService';
import { earningsForecastWatcher } from '../../services/EarningsForecastWatcher';
import { weeklyReviewReportService } from '../../services/WeeklyReviewReportService';
import { weChatOAService } from '../../services/WeChatOAService';
import { realtimeAlertDispatcher } from '../../services/RealtimeAlertDispatcher';
import { logger } from '../../utils/logger';

/**
 * US-143 [PM-015] — POST /api/settings/weekly-review/apply body parser.
 *
 * 必填: week_id (string), recommendation_index (number, >=0).
 * 可选: text (string), source (string).
 * 单独 export 给单测 (controller 顶层 require 拽 sequelize, mirror-style 单测复刻
 * 主流程时直接用此 helper, 与 [[ImprovementSuggestionController parseSuggestionId]]
 * PM-024 同款 "可单测 pure helper export" 范式).
 */
export function parseApplyRecommendationBody(body: unknown): {
  week_id: string;
  recommendation_index: number;
  text?: string;
  source?: string;
} | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const weekId = typeof b.week_id === 'string' ? b.week_id.trim() : '';
  if (weekId.length === 0 || weekId.length > 32) return null;
  const idxRaw = Number(b.recommendation_index);
  if (!Number.isFinite(idxRaw) || idxRaw < 0) return null;
  const idx = Math.floor(idxRaw);
  if (idx > 999) return null;
  const text = typeof b.text === 'string' ? b.text : undefined;
  const source = typeof b.source === 'string' ? b.source : undefined;
  return { week_id: weekId, recommendation_index: idx, text, source };
}

/**
 * US-080 — 推送渠道 (push-channels) 矩阵视图。
 *
 * 把 NotificationChannelsConfig 的 4 个 channel 拍平成 4 × 4 矩阵：
 *   - 行 = 事件类型 (daily_digest / earnings_alert / risk_alert / weekly_review)
 *   - 列 = 渠道 (feishu / email / wechat / sms)
 *
 * 单元格三态：
 *   - `applicable=true`：该 (event, channel) 组合受支持，`enabled` 是当前开关；
 *   - `applicable=false`：该组合在当前架构下不支持（例如 sms.daily_digest），
 *     UI 显示为"—"，PUT 时被忽略。
 *
 * 设计逻辑见 `NotificationConfigMatrixView` jsdoc。
 */
type NotificationEventKey = 'daily_digest' | 'earnings_alert' | 'risk_alert' | 'weekly_review';
type NotificationChannelKey = 'feishu' | 'email' | 'wechat' | 'sms';

interface MatrixCell {
  applicable: boolean;
  enabled: boolean;
}

/**
 * applicable 表 —— (event, channel) -> 是否支持。
 *
 * 业务约束：weekly_review 当前只有 email 通道（HTML 邮件复盘报告，飞书/微信/短信
 * 无 HTML 富文本能力）。Daily/earnings 在 feishu+wechat 支持但 email/sms 不支持
 * (避免邮件轰炸 + 短信成本控制)。risk_alert 在 4 通道全开（实时告警是 multi-pipe）。
 *
 * 改动 applicable 集合需要同步：
 *   - DailyTradingDigestService.listEligibleUsers (daily_digest 通道选择)
 *   - EmailNotificationService (weekly_review 通道选择)
 *   - WeChatOAService (各模板支持的事件)
 *   - RealtimeAlertDispatcher (risk_alert 4 通道分发)
 *
 * 单测可以 import 这两个常量验证业务约束没被人误改：US-080 test 覆盖一个
 * representative 对断言（e.g. sms.daily_digest = false，email.weekly_review = true）。
 */
export const NOTIFICATION_APPLICABLE_MATRIX: Record<
  NotificationEventKey,
  Record<NotificationChannelKey, boolean>
> = {
  daily_digest: { feishu: true, email: false, wechat: true, sms: false },
  earnings_alert: { feishu: true, email: false, wechat: true, sms: false },
  risk_alert: { feishu: true, email: true, wechat: true, sms: true },
  weekly_review: { feishu: false, email: true, wechat: false, sms: false },
};

const APPLICABLE_MATRIX = NOTIFICATION_APPLICABLE_MATRIX;

const EVENT_ORDER: NotificationEventKey[] = [
  'daily_digest',
  'earnings_alert',
  'risk_alert',
  'weekly_review',
];

const CHANNEL_ORDER: NotificationChannelKey[] = ['feishu', 'email', 'wechat', 'sms'];

/**
 * NotificationConfigMatrixView — GET /api/settings/notification-config 返回结构。
 *
 * `channels` 段：每个 channel 的"是否启用 + 是否配置完整"概览，供前端推送渠道页
 * 顶部 3 个 Card 显示绑定状态（不含细节字段，需 PUT 走 /notification-channels）。
 *
 * `matrix` 段：4 × 4 矩阵 (event × channel)，每格 `{applicable, enabled}`。前端用
 * antd Table + Checkbox 渲染，PUT 时通过 `matrix_updates` 字段反向写回。
 *
 * `raw` 段：底层的 NotificationChannelsConfig，避免前端为了拿 webhook_url / address
 * 再发一次 GET。
 */
export interface NotificationConfigMatrixView {
  channels: {
    feishu: { enabled: boolean; webhook_url: string; configured: boolean };
    email: { enabled: boolean; address: string; configured: boolean };
    wechat: {
      enabled: boolean;
      openid: string;
      bound_at: string;
      bound: boolean;
    };
    sms: { enabled: boolean; phone: string; configured: boolean };
  };
  matrix: Record<NotificationEventKey, Record<NotificationChannelKey, MatrixCell>>;
  raw: NotificationChannelsConfig;
}

/**
 * 把 NotificationChannelsConfig 编译成矩阵视图。
 *
 * 单元格 `enabled` 严格 = (该 channel 总开关 enabled) && (该 channel.<event> 开关).
 * 这避免 UI 让用户在 channel.enabled=false 的情况下勾上事件订阅但不生效造成困惑。
 */
export function buildMatrixView(cfg: NotificationChannelsConfig): NotificationConfigMatrixView {
  const eventToChannelField: Record<
    NotificationEventKey,
    Partial<Record<NotificationChannelKey, string>>
  > = {
    daily_digest: { feishu: 'daily_digest', wechat: 'daily_digest' },
    earnings_alert: { feishu: 'earnings_alert', wechat: 'earnings_alert' },
    risk_alert: {
      feishu: 'risk_alert',
      email: 'risk_alert',
      wechat: 'risk_alert',
      sms: 'risk_alert',
    },
    weekly_review: { email: 'weekly_review' },
  };

  const matrix = {} as Record<NotificationEventKey, Record<NotificationChannelKey, MatrixCell>>;
  for (const event of EVENT_ORDER) {
    const row = {} as Record<NotificationChannelKey, MatrixCell>;
    for (const channel of CHANNEL_ORDER) {
      const applicable = APPLICABLE_MATRIX[event][channel];
      let enabled = false;
      if (applicable) {
        const channelEnabled = (cfg as any)[channel]?.enabled === true;
        const field = eventToChannelField[event][channel];
        const fieldOn = field ? (cfg as any)[channel]?.[field] === true : false;
        enabled = channelEnabled && fieldOn;
      }
      row[channel] = { applicable, enabled };
    }
    matrix[event] = row;
  }

  return {
    channels: {
      feishu: {
        enabled: cfg.feishu.enabled,
        webhook_url: cfg.feishu.webhook_url || '',
        configured: !!(cfg.feishu.webhook_url || '').trim(),
      },
      email: {
        enabled: cfg.email.enabled,
        address: cfg.email.address || '',
        configured: !!(cfg.email.address || '').trim(),
      },
      wechat: {
        enabled: cfg.wechat.enabled,
        openid: cfg.wechat.openid || '',
        bound_at: cfg.wechat.bound_at || '',
        bound: !!(cfg.wechat.openid || '').trim(),
      },
      sms: {
        enabled: cfg.sms.enabled,
        phone: cfg.sms.phone || '',
        configured: !!(cfg.sms.phone || '').trim(),
      },
    },
    matrix,
    raw: cfg,
  };
}

/**
 * 把前端传来的 `{ matrix_updates: { event: { channel: boolean } } }` patch
 * 翻译成 NotificationChannelsConfig 的 partial patch（只覆盖 applicable 的格子，
 * 非 applicable 静默忽略；不动 channel.enabled / webhook_url / address 等字段）。
 */
export function matrixUpdatesToConfigPatch(updates: any): Partial<NotificationChannelsConfig> {
  if (!updates || typeof updates !== 'object') return {};
  const patch: any = {};
  for (const event of EVENT_ORDER) {
    const row = updates[event];
    if (!row || typeof row !== 'object') continue;
    for (const channel of CHANNEL_ORDER) {
      if (!APPLICABLE_MATRIX[event][channel]) continue;
      const v = row[channel];
      if (v !== true && v !== false) continue;
      // 把矩阵格映射回 config 字段（与 buildMatrixView 的 eventToChannelField 互补）
      const fieldByEvent: Record<NotificationEventKey, string> = {
        daily_digest: 'daily_digest',
        earnings_alert: 'earnings_alert',
        risk_alert: 'risk_alert',
        weekly_review: 'weekly_review',
      };
      const field = fieldByEvent[event];
      patch[channel] = { ...(patch[channel] || {}), [field]: v };
    }
  }
  return patch as Partial<NotificationChannelsConfig>;
}

/**
 * SettingsController — US-063 / US-064 / US-065 / US-066 / US-067 / US-080 通知通道配置
 *
 * Mounted at `/api/settings/*`. 与 `RiskController`（/api/risk）平行：风控配置
 * 是 pre-trade policy 关于*交易决策*；通知通道是 *消息触达* 维度，分开命名空间。
 *
 * 共用 `User.risk_config` JSONB 列下的 `notification_channels` namespace
 * （与 position_limits / trailing_stop 等并列），免去新表，遵循 US-047 模式。
 *
 * Endpoints:
 *   GET /api/settings/notification-channels — 取当前用户的 normalized 配置
 *   POST /api/settings/notification-channels — merge + 落盘（normalize 静默丢非法字段）
 *   GET /api/settings/notification-config — US-080 矩阵视图 (event × channel)
 *   PUT /api/settings/notification-config — US-080 矩阵反向 patch + 单字段同步
 *   POST /api/settings/daily-digest/preview — dry-run preview 当日日报
 *   POST /api/settings/daily-digest/send — 立即推送当日日报
 *   POST /api/settings/earnings-forecast/scan — 立即扫描持仓 + 自选股推送 (US-064)
 *   POST /api/settings/earnings-forecast/preview — dry-run preview 业绩预告推送 (US-064)
 *   POST /api/settings/email-config — 更新邮件通道开关 / 接收地址 / weekly_review 开关 (US-065)
 *   POST /api/settings/weekly-review/preview — dry-run preview 上周复盘邮件 payload (US-065)
 *   POST /api/settings/weekly-review/send — 立即发上周复盘邮件 (US-065)
 *   GET  /api/settings/wechat-bind-qrcode — 生成微信公众号参数二维码 + 落 scene_str (US-066)
 *   POST /api/settings/wechat-bind-confirm — 轮询确认绑定状态 (US-066)
 *   POST /api/settings/wechat-config — 更新 wechat 通道开关 / 3 类订阅消息开关 (US-066)
 *   POST /api/settings/wechat-unbind — 解除微信绑定 (US-066)
 *   POST /api/settings/wechat-test — 立即发一条测试微信订阅消息 (US-066)
 *   POST /api/settings/sms-config — 更新 SMS 通道开关 / 接收手机号 (US-067)
 *   POST /api/settings/sms-test — 冒烟测试一条 HIGH 级风控告警 (US-067)
 */
export class SettingsController {
  /**
   * GET /api/settings/notification-channels
   * Return the user's effective notification-channel config (defaults if never customized).
   */
  async getNotificationChannels(req: Request, res: Response, _next: NextFunction) {
    try {
      const user_id = (req as any).user.id;
      const config = await dailyTradingDigestService.getNotificationConfig(user_id);
      res.json({ success: true, data: config });
    } catch (error: any) {
      logger.error('获取通知通道配置失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  /**
   * POST /api/settings/notification-channels
   * Merge the supplied patch into the user's notification-channels config.
   * Input is normalized — invalid fields silently revert to defaults
   * (US-047..US-055 convention).
   */
  async updateNotificationChannels(req: Request, res: Response, _next: NextFunction) {
    try {
      const user_id = (req as any).user.id;
      const saved = await dailyTradingDigestService.updateNotificationConfig(
        user_id,
        req.body || {}
      );
      res.json({ success: true, data: saved, message: '通知通道配置已保存' });
    } catch (error: any) {
      logger.error('更新通知通道配置失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  /**
   * GET /api/settings/notification-config (US-080)
   *
   * 返回 "推送渠道" 工作台的矩阵视图 —— 把 NotificationChannelsConfig 的 4 个
   * channel × 4 个事件类型拍平成 4 × 4 矩阵。前端用 antd Table + Checkbox 渲染，
   * 上方 3 个 Card 显示每个 channel 的绑定/配置状态摘要。
   *
   * Response: `NotificationConfigMatrixView` （含 channels 概览 / matrix 4×4 / raw 原始 config）
   */
  async getNotificationConfig(req: Request, res: Response, _next: NextFunction) {
    try {
      const user_id = (req as any).user.id;
      const cfg = await dailyTradingDigestService.getNotificationConfig(user_id);
      const view = buildMatrixView(cfg);
      res.json({ success: true, data: view });
    } catch (error: any) {
      logger.error('获取通知矩阵配置失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  /**
   * PUT /api/settings/notification-config (US-080)
   *
   * 推送渠道工作台的"批量保存"端点 —— 支持两种 payload 形态共存于同一 body：
   *   - `matrix_updates: { event: { channel: bool } }` —— 矩阵格反向 patch；
   *     非 applicable 格静默忽略；该 cell 翻译回 `channel.<event_field>` 后 merge。
   *   - `channels_updates: { feishu?: { enabled?, webhook_url? }, email?: { ... } }`
   *     —— 顶部 3 个 Card 的单字段同步（webhook URL / email address / channel.enabled）。
   *
   * 两种 patch 都走相同的 `dailyTradingDigestService.updateNotificationConfig`
   * (merge + normalize + JSONB 落盘)，保证与 POST /notification-channels 完全等价。
   * 返回最新的矩阵视图，前端可直接 setView。
   */
  async updateNotificationConfig(req: Request, res: Response, _next: NextFunction) {
    try {
      const user_id = (req as any).user.id;
      const body = req.body || {};
      // 翻译两种 patch 形态 → 一份合并的 Partial<NotificationChannelsConfig>
      const matrixPatch = matrixUpdatesToConfigPatch(body.matrix_updates);
      const channelsPatch: any =
        body.channels_updates && typeof body.channels_updates === 'object'
          ? body.channels_updates
          : {};
      // matrix 优先级最低 —— channel-level（webhook_url / address）显式 patch 覆盖矩阵开关
      const merged: any = {};
      for (const ch of ['feishu', 'email', 'wechat', 'sms']) {
        const m = (matrixPatch as any)[ch];
        const c = channelsPatch[ch];
        if (m || c) merged[ch] = { ...(m || {}), ...(c || {}) };
      }
      const saved = await dailyTradingDigestService.updateNotificationConfig(user_id, merged);
      const view = buildMatrixView(saved);
      res.json({ success: true, data: view, message: '推送渠道配置已保存' });
    } catch (error: any) {
      logger.error('更新通知矩阵配置失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  /**
   * POST /api/settings/daily-digest/preview
   * dry_run 预演当前用户当日的日报 payload —— 不实际推 webhook，只返回 payload。
   * 让用户在 SettingsWorkspace 点 "预览今日日报" 即时验证 webhook URL + 配置正确。
   */
  async previewDailyDigest(req: Request, res: Response, _next: NextFunction) {
    try {
      const user_id = (req as any).user.id;
      const result = await dailyTradingDigestService.sendDigests({
        user_id,
        dry_run: true,
        trade_date: (req.body || {}).trade_date,
      });
      res.json({ success: true, data: result });
    } catch (error: any) {
      logger.error('预览当日日报失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  /**
   * POST /api/settings/daily-digest/send
   * 立即给当前用户发一次日报（非 dry_run），用于手动触发或冒烟测试。
   */
  async sendDailyDigestNow(req: Request, res: Response, _next: NextFunction) {
    try {
      const user_id = (req as any).user.id;
      const result = await dailyTradingDigestService.sendDigests({
        user_id,
        dry_run: false,
        trade_date: (req.body || {}).trade_date,
      });
      res.json({ success: true, data: result, message: '当日日报已触发推送' });
    } catch (error: any) {
      logger.error('手动触发日报失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  /**
   * POST /api/settings/earnings-forecast/preview (US-064)
   * dry_run 预演当前用户当日的业绩预告推送 payload：
   *   - 扫持仓股 (held path) — 返回每条 forecast 的 single-card payload；
   *   - 扫自选股 (watchlist path) — 返回合并的 digest payload；
   * 不实际推送 webhook + 不写 dedup buffer，让用户多次预演。
   */
  async previewEarningsForecast(req: Request, res: Response, _next: NextFunction) {
    try {
      const user_id = (req as any).user.id;
      const body = req.body || {};
      const heldResult = await earningsForecastWatcher.scanHeldStocks({
        user_id,
        dry_run: true,
        trade_date: body.trade_date,
        recent_days: body.recent_days,
        frontend_base_url: body.frontend_base_url,
      });
      const watchlistResult = await earningsForecastWatcher.scanWatchlistStocks({
        user_id,
        dry_run: true,
        trade_date: body.trade_date,
        recent_days: body.recent_days,
        frontend_base_url: body.frontend_base_url,
      });
      res.json({
        success: true,
        data: {
          held: heldResult,
          watchlist: watchlistResult,
        },
      });
    } catch (error: any) {
      logger.error('预览业绩预告推送失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  /**
   * POST /api/settings/earnings-forecast/scan (US-064)
   * 立即扫描当前用户的持仓 + 自选股业绩预告并实际推送（同 scheduler cron 流程）。
   * dedup buffer 会被更新避免下次重发；适用于手动触发或冒烟测试。
   */
  async scanEarningsForecastNow(req: Request, res: Response, _next: NextFunction) {
    try {
      const user_id = (req as any).user.id;
      const body = req.body || {};
      const heldResult = await earningsForecastWatcher.scanHeldStocks({
        user_id,
        dry_run: false,
        trade_date: body.trade_date,
        recent_days: body.recent_days,
        frontend_base_url: body.frontend_base_url,
      });
      const watchlistResult = await earningsForecastWatcher.scanWatchlistStocks({
        user_id,
        dry_run: false,
        trade_date: body.trade_date,
        recent_days: body.recent_days,
        frontend_base_url: body.frontend_base_url,
      });
      res.json({
        success: true,
        data: { held: heldResult, watchlist: watchlistResult },
        message: '业绩预告扫描完成',
      });
    } catch (error: any) {
      logger.error('手动触发业绩预告扫描失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  /**
   * POST /api/settings/email-config (US-065)
   * 更新当前用户的邮件通道开关 / 接收地址 / weekly_review 开关。
   *
   * Body: { enabled?: boolean, address?: string, weekly_review?: boolean }
   *
   * AC 字面要求："新增 endpoint：POST /api/settings/email-config"。
   * 与 POST /api/settings/notification-channels 互补 —— 后者支持任意 channel 的
   * 批量 patch；本 endpoint 是 email channel 的专用语义化 endpoint，让前端 UI
   * 表单代码更紧凑。
   */
  async updateEmailConfig(req: Request, res: Response, _next: NextFunction) {
    try {
      const user_id = (req as any).user.id;
      const body = req.body || {};
      const patch: any = {};
      if (body.enabled !== undefined) patch.enabled = body.enabled;
      if (body.address !== undefined) patch.address = body.address;
      if (body.weekly_review !== undefined) patch.weekly_review = body.weekly_review;
      // US-067 — 邮件高优先级风控告警订阅开关
      if (body.risk_alert !== undefined) patch.risk_alert = body.risk_alert;
      const saved = await weeklyReviewReportService.updateEmailConfig(user_id, patch);
      res.json({ success: true, data: saved, message: '邮件通道配置已保存' });
    } catch (error: any) {
      logger.error('更新邮件通道配置失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  /**
   * POST /api/settings/weekly-review/preview (US-065)
   * dry_run 预演当前用户上周复盘邮件 payload（不实际发邮件）。
   * 让用户在 SettingsWorkspace 点 "预览上周周报" 即时验证 SMTP + 配置正确。
   */
  async previewWeeklyReview(req: Request, res: Response, _next: NextFunction) {
    try {
      const user_id = (req as any).user.id;
      const body = req.body || {};
      const result = await weeklyReviewReportService.sendWeeklyReviewReports({
        user_id,
        dry_run: true,
        reference_date: body.reference_date,
        upcoming_lookahead_days: body.upcoming_lookahead_days,
      });
      res.json({ success: true, data: result });
    } catch (error: any) {
      logger.error('预览周报失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  /**
   * POST /api/settings/weekly-review/send (US-065)
   * 立即给当前用户发一次上周复盘邮件（非 dry_run），用于手动触发或冒烟测试。
   */
  async sendWeeklyReviewNow(req: Request, res: Response, _next: NextFunction) {
    try {
      const user_id = (req as any).user.id;
      const body = req.body || {};
      const result = await weeklyReviewReportService.sendWeeklyReviewReports({
        user_id,
        dry_run: false,
        reference_date: body.reference_date,
        upcoming_lookahead_days: body.upcoming_lookahead_days,
      });
      res.json({ success: true, data: result, message: '上周复盘邮件已触发推送' });
    } catch (error: any) {
      logger.error('手动触发周报失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  /**
   * POST /api/settings/weekly-review/apply (US-143 [PM-015])
   *
   * 把上周复盘邮件中的某条 recommendation 落到 user 的
   * `risk_config.weekly_review_applied[]` JSONB 数组. 该数组下游被 PM-027 (US-146)
   * effect tracker 消费, 用于回看"被采纳的建议" N 周后是否真改善 PnL.
   *
   * Body: { week_id: string, recommendation_index: number, text?: string, source?: string }
   *
   * 响应:
   *   200 { success: true, data: { applied, history } }
   *   400 { success: false, message: '参数非法' }              — week_id / index 缺失或越界
   *   404 { success: false, message: '用户不存在' }            — User.findByPk null (理论上不该到)
   *   409 { success: false, message: '该建议已 apply 过',
   *          data: { previous } }                              — idempotent guard (同 week+index)
   *   500 { success: false, message }                          — DB throw
   *
   * 与 [[ImprovementSuggestion apply]] (PM-024) 同源 idempotent 设计 — apply 有
   * "落 strategy_config" 副作用, 不能重复触发, 必须 409 而非 200 上重复.
   */
  async applyWeeklyReviewRecommendation(req: Request, res: Response, _next: NextFunction) {
    try {
      const user_id = (req as any).user?.id;
      if (!user_id) {
        return res.status(401).json({ success: false, message: '未登录' });
      }
      const body = req.body || {};
      const parsed = parseApplyRecommendationBody(body);
      if (!parsed) {
        return res
          .status(400)
          .json({ success: false, message: '参数非法 (week_id / recommendation_index 必填)' });
      }
      const result = await weeklyReviewReportService.applyRecommendation(user_id, parsed);
      return res.json({
        success: true,
        data: { applied: result.applied, history: result.history },
        message: '建议已应用',
      });
    } catch (error: any) {
      const msg = String(error?.message || '');
      if (msg === 'USER_NOT_FOUND') {
        return res.status(404).json({ success: false, message: '用户不存在' });
      }
      if (msg === 'ALREADY_APPLIED') {
        return res.status(409).json({
          success: false,
          message: '该建议已 apply 过, 不可重复触发',
          data: { previous: (error as any).previous || null },
        });
      }
      if (msg === 'INVALID_RECOMMENDATION_INPUT') {
        return res.status(400).json({ success: false, message: '参数非法' });
      }
      logger.error('apply 周报建议失败:', error);
      return res.status(500).json({ success: false, message: error?.message || 'apply 失败' });
    }
  }

  /**
   * GET /api/settings/weekly-review/applied (US-143 [PM-015])
   * 返回当前用户已 apply 过的 recommendation 历史 (按 applied_at 升序, LRU cap=50).
   * 前端用于 SettingsWorkspace "已采纳建议" 列表展示, 防止重复点击 + 留痕.
   */
  async listAppliedWeeklyReviewRecommendations(
    req: Request,
    res: Response,
    _next: NextFunction
  ) {
    try {
      const user_id = (req as any).user?.id;
      if (!user_id) {
        return res.status(401).json({ success: false, message: '未登录' });
      }
      const history = await weeklyReviewReportService.listAppliedRecommendations(user_id);
      return res.json({ success: true, data: { history } });
    } catch (error: any) {
      logger.error('获取已 apply 建议历史失败:', error);
      return res.status(500).json({ success: false, message: error?.message || '获取失败' });
    }
  }

  /**
   * GET /api/settings/wechat-bind-qrcode (US-066)
   *
   * 生成微信公众号参数二维码 —— 后端调 weixin qrcode/create 接口拿 ticket 与
   * 跳转 url，把 scene_str 持久化到 user.wechat.bind_scene_str，前端拿到
   * qrcode_image_url 后用 <img> 直接显示让用户扫码。
   */
  async getWeChatBindQrCode(req: Request, res: Response, _next: NextFunction) {
    try {
      const user_id = (req as any).user.id;
      const result = await weChatOAService.getBindQrCode(user_id);
      res.json({ success: true, data: result });
    } catch (error: any) {
      logger.error('生成微信绑定二维码失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  /**
   * POST /api/settings/wechat-bind-confirm (US-066)
   *
   * 前端轮询：检查当前 user 的 wechat.openid 是否已通过 webhook SCAN 事件写入。
   * 返回 `{bound: true}` 后前端关闭轮询并刷新 notification-channels。
   */
  async confirmWeChatBind(req: Request, res: Response, _next: NextFunction) {
    try {
      const user_id = (req as any).user.id;
      const body = req.body || {};
      const result = await weChatOAService.confirmBind(user_id, body.scene_str);
      res.json({ success: true, data: result });
    } catch (error: any) {
      logger.error('确认微信绑定状态失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  /**
   * POST /api/settings/wechat-config (US-066)
   *
   * 更新当前用户的 wechat 通道 4 个开关：enabled / daily_digest / earnings_alert /
   * risk_alert。openid / bind_scene_str / bound_at 不可手动改，靠 webhook 写入。
   *
   * Body: { enabled?, daily_digest?, earnings_alert?, risk_alert? }
   *
   * 与 POST /api/settings/notification-channels 互补 —— 后者支持任意 channel 的
   * 批量 patch；本 endpoint 是 wechat channel 的专用语义化 endpoint，让前端 UI
   * 表单代码更紧凑，与 POST /api/settings/email-config 同款 sub-resource 范式。
   */
  async updateWeChatConfig(req: Request, res: Response, _next: NextFunction) {
    try {
      const user_id = (req as any).user.id;
      const body = req.body || {};
      const patch: any = {};
      if (body.enabled !== undefined) patch.enabled = body.enabled;
      if (body.daily_digest !== undefined) patch.daily_digest = body.daily_digest;
      if (body.earnings_alert !== undefined) patch.earnings_alert = body.earnings_alert;
      if (body.risk_alert !== undefined) patch.risk_alert = body.risk_alert;
      const saved = await weChatOAService.updateWeChatConfig(user_id, patch);
      res.json({ success: true, data: saved, message: '微信通道配置已保存' });
    } catch (error: any) {
      logger.error('更新微信通道配置失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  /**
   * POST /api/settings/wechat-unbind (US-066)
   *
   * 解除微信绑定 —— 清空 openid / bind_scene_str / bound_at，保留 enabled /
   * alert 开关让用户重新扫码绑定即可继续。
   */
  async unbindWeChat(req: Request, res: Response, _next: NextFunction) {
    try {
      const user_id = (req as any).user.id;
      const saved = await weChatOAService.unbindWeChat(user_id);
      res.json({ success: true, data: saved, message: '微信绑定已解除' });
    } catch (error: any) {
      logger.error('解除微信绑定失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  /**
   * POST /api/settings/wechat-test (US-066)
   *
   * 给当前用户发一条测试订阅消息（默认 daily_digest 模板），用于冒烟测试 access_token
   * + 模板 id + 用户 openid 是否畅通。Body 接受 `template_kind: 'daily_digest' |
   * 'earnings_alert' | 'risk_alert'`，缺省 daily_digest；`dry_run: true` 则不真发，
   * 只返回组装好的 data 字段供前端 Modal 预览。
   */
  async testWeChatMessage(req: Request, res: Response, _next: NextFunction) {
    try {
      const user_id = (req as any).user.id;
      const body = req.body || {};
      // Batch X (2026-06-17, notif-2 fix): 强制 dry_run=true + 用 fixture payload
      // 忽略 body.url / body.payload. 之前用户可塞任意 url + payload, 把"自家系统消息"
      // 渲染钓鱼链接发到微信公众号 — 比飞书 phish 信任度更高.
      const dryRun = true;
      const kind = String(body.template_kind || 'daily_digest').toLowerCase();
      let result;
      if (kind === 'earnings_alert' || kind === 'earnings_forecast') {
        result = await weChatOAService.sendEarningsForecast({
          user_id,
          dry_run: dryRun,
          // Batch X: 不接受 body.url / body.payload, 一律用 fixture.
          payload: {
            symbol: '600519',
            name: '贵州茅台',
            forecast_type: '预增',
            profit_change_text: '+50.0% ~ +80.0%',
            report_period: '2026Q1',
            announce_date: '2026-04-10',
          },
        });
      } else if (kind === 'risk_alert') {
        result = await weChatOAService.sendRiskAlert({
          user_id,
          dry_run: dryRun,
          payload: {
            level: 'HIGH',
            title: '测试风控告警',
            detail: '这是一条来自 wechat-test 端点的冒烟测试告警',
            triggered_at: new Date().toISOString(),
            symbol: '600519',
          },
        });
      } else {
        result = await weChatOAService.sendDailyDigest({
          user_id,
          dry_run: dryRun,
          payload: {
            user_id,
            username: 'test',
            trade_date: new Date().toISOString().slice(0, 10),
            pnl: {
              total_value: 100000,
              prev_total_value: 99000,
              pnl_today: 1000,
              pnl_today_pct: 1.0,
              position_value: 50000,
              current_cash: 50000,
            },
            trades_today_buy: [],
            trades_today_sell: [],
            trades_today_buy_count: 0,
            trades_today_sell_count: 0,
            candidates_tomorrow: [],
          },
        });
      }
      res.json({ success: true, data: result, message: '微信测试消息已派发 (dry_run 强制)' });
    } catch (error: any) {
      logger.error('发送测试微信消息失败:', error);
      res
        .status((error as any)?.statusCode || 500)
        .json({ success: false, message: error.message });
    }
  }

  /**
   * POST /api/settings/wechat-bind-simulate (US-066)
   *
   * 仅供本地开发 / 单测使用的"模拟微信扫码事件"端点：在生产 webhook 没接入时
   * 让前端 + 后端走通端到端绑定流程（直接调用 service.handleBindEventFromWebhook
   * 落 openid）。生产环境应由 WechatEventController 解析微信 XML 调用同一 method。
   *
   * Body: { scene_str: string, openid: string }
   */
  async simulateWeChatBindEvent(req: Request, res: Response, _next: NextFunction) {
    try {
      // 安全护栏：本端点仅用于本地开发 / 单测，生产环境一律 404 让攻击者拿不到任何反馈，
      // 避免恶意 user A 拿 B 的 scene_str 偷绑 B 的微信账号。
      if (
        process.env.NODE_ENV === 'production' ||
        String(process.env.ALLOW_WECHAT_BIND_SIMULATE || '').toLowerCase() !== 'true'
      ) {
        return res.status(404).json({ success: false, message: 'Not Found' });
      }
      const body = req.body || {};
      if (!body.scene_str || !body.openid) {
        return res.status(400).json({ success: false, message: 'scene_str + openid 必填' });
      }
      const result = await weChatOAService.handleBindEventFromWebhook({
        sceneStr: String(body.scene_str),
        openid: String(body.openid),
        eventAt: body.event_at,
      });
      res.json({ success: true, data: result, message: '微信绑定事件已应用' });
    } catch (error: any) {
      logger.error('模拟微信绑定事件失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  /**
   * POST /api/settings/sms-config (US-067)
   *
   * 更新当前用户的 SMS 通道配置：enabled / phone / risk_alert。
   *
   * Body: `{ enabled?: boolean, phone?: string, risk_alert?: boolean }`
   *
   * 与 POST /api/settings/email-config / wechat-config 同款 sub-resource 范式 ——
   * 让前端 SettingsWorkspace 的 SMS Card 表单代码不必构造嵌套 patch 对象。
   *
   * 后端 phone normalize 由 `normalizeNotificationConfig` (DailyTradingDigestService)
   * 走 string 安全转换；实际发送时 `AliyunSmsService.normalizeChinesePhone` 会再做
   * 11 位国内号严格校验 + fail-OPEN（非法手机号 → skip）。
   */
  async updateSmsConfig(req: Request, res: Response, _next: NextFunction) {
    try {
      const user_id = (req as any).user.id;
      const body = req.body || {};
      const patch: any = {};
      if (body.enabled !== undefined) patch.enabled = body.enabled;
      if (body.phone !== undefined) patch.phone = body.phone;
      if (body.risk_alert !== undefined) patch.risk_alert = body.risk_alert;
      const saved = await dailyTradingDigestService.updateSmsConfig(user_id, patch);
      res.json({ success: true, data: saved, message: 'SMS 通道配置已保存' });
    } catch (error: any) {
      logger.error('更新 SMS 通道配置失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  /**
   * POST /api/settings/sms-test (US-067)
   *
   * 给当前用户发一条测试 HIGH 级风控告警，3 channel 全派（dry_run=true 仅返回 payload
   * 不真发）。让用户在 SettingsWorkspace 一键验证 webhook + SMTP + 阿里云 SMS 是否
   * 畅通。`dry_run=true` 不写 dedup buffer 让用户可反复测试。
   *
   * Body: `{ dry_run?: boolean, message?: string }`
   */
  async testSmsMessage(req: Request, res: Response, _next: NextFunction) {
    try {
      const user_id = (req as any).user.id;
      const body = req.body || {};
      // Batch X (2026-06-17, notif-2 fix): 强制 dry_run=true, 用户不能改.
      // 之前任意 login 用户可改 dry_run=false 让冒烟测试真发 SMS/邮件/飞书 +
      // body.message 用户可控塞钓鱼链接 ("点这里激活账号 → evil.com"). 现在:
      //  (a) dry_run 强制 true 永远不真发;
      //  (b) message 用固定 fixture, 忽略 body.message.
      const dryRun = true;
      const result = await realtimeAlertDispatcher.dispatch(
        {
          user_id,
          alert_id: 0, // 0 = 冒烟测试，不对应真实 RiskAlert 行
          symbol: '600519',
          name: '贵州茅台',
          level: 'HIGH',
          message: '【冒烟测试】这是一条来自 settings/sms-test 端点的测试 HIGH 风控告警',
          rule_id: 'smoke_test',
          triggered_at: new Date().toISOString(),
        },
        { dry_run: dryRun }
      );
      res.json({
        success: true,
        data: result,
        message: '已生成测试告警 payload（dry_run，永远不真发；如需真发请联系 admin）',
      });
    } catch (error: any) {
      logger.error('发送测试 SMS / 实时告警失败:', error);
      res
        .status((error as any)?.statusCode || 500)
        .json({ success: false, message: error.message });
    }
  }
}

export const settingsController = new SettingsController();
