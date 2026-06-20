import { Request, Response, NextFunction } from 'express';
import { Op, WhereOptions } from 'sequelize';
import { BlackSwanEvent } from '../../models/BlackSwanEvent';
import { BlackSwanPostmortemReport } from '../../models/BlackSwanPostmortemReport';
import { logger } from '../../utils/logger';

/**
 * US-133 [PR-018] — 黑天鹅事件历史 read-only 接口
 *
 * 为前端 SettingsWorkspace `/black-swan` tab 提供两条只读接口:
 *   - GET /api/black-swan/events     — 分页列表 + 过滤 (event_type/severity/scope/status/symbol/日期)
 *   - GET /api/black-swan/events/:id — 单事件详情 + 关联 BlackSwanPostmortemReport (若有)
 *
 * 与既有控制器边界:
 *   - RiskAlertController (US-077) — 消费 RiskAlert (per-user-per-position), 与
 *     BlackSwanWatchdog (US-053) 共生; 本表 BlackSwanEvent (PR-010) 是事件本身的
 *     global 视角, 二者正交.
 *   - RiskController.getBlackSwan / updateBlackSwan — 仅操作 User.risk_config.black_swan
 *     (per-user watchdog config), 与本控制器消费的 global event 无重叠.
 *
 * **read-only 设计** (本 story 仅展示, 不改写):
 *   - 无 PUT / POST / DELETE — 事件由 PR-011 BlackSwanDetector cron 自动落表;
 *     PR-013 postmortem service 写关联报告. UI 只读.
 *   - 任何"标记 expired / 强 resolve / 调 severity" 类操作走未来 PR 单独定义.
 *
 * **不做 per-user 过滤** (PRD US-133 AC 是"事件列表 + 详情", 不分 user):
 *   - BlackSwanEvent 是全局视角 (scope ∈ {market, sector, symbol, portfolio}),
 *     与 user 无关. 仅 portfolio 类 scope_detail.user_id 是 per-user, 但 PRD AC
 *     未要求按 user 过滤. 后续 UI 若要"只看本人 portfolio 黑天鹅" 可加 query
 *     param + scope_detail JSONB 过滤, 本 story 不引入.
 *   - 风险: 任何登录用户都能看全市场事件 — 这是 PRD 设计 (黑天鹅本身 global 视角,
 *     ops 视角等同). 与 RiskAlert per-user 隔离的语义不同.
 *
 * **PR-013/014/015/016 4 段报告同时返回**:
 *   - 详情接口 includes BlackSwanPostmortemReport 的全部 4 段 JSONB (event_summary,
 *     counterfactual_baselines, event_timeline, improvement_suggestions). UI 用
 *     antd Tabs 展示 4 段, 缺失段显示 "未生成" placeholder.
 *   - 若 PR-013 service 还没跑 → postmortem=null, UI 显示 "待生成". 不阻塞列表/详情访问.
 *
 * 分页与 RiskAlertController.listAlerts 同款:
 *   - page 默认 1, limit 默认 30, max 200
 *   - order by detected_at DESC (最新事件最先)
 */

const PAGE_DEFAULT = 1;
const PAGE_LIMIT_DEFAULT = 30;
const PAGE_LIMIT_MAX = 200;

/** 事件类型枚举 (与 [[BlackSwanEvent]] event_type 字段对齐) */
const KNOWN_EVENT_TYPES = new Set<string>([
  'ST',
  'SUSPENDED',
  'NEWS_KEYWORD',
  'SHAREHOLDER_REDUCTION',
  'MARKET_REGIME',
  'OTHER',
]);

/** severity 枚举 (与 [[BlackSwanEvent]] severity 字段 + RiskAlert.level 对齐) */
const KNOWN_SEVERITIES = new Set<string>(['low', 'medium', 'high', 'critical']);

/** scope 枚举 (与 [[BlackSwanEvent]] scope 字段对齐) */
const KNOWN_SCOPES = new Set<string>(['symbol', 'sector', 'market', 'portfolio']);

/** status 枚举 (与 [[BlackSwanEvent]] status 字段对齐) */
const KNOWN_STATUSES = new Set<string>(['open', 'resolved', 'expired']);

// ---------------------------------------------------------------------------
// pure helpers — export 给单测
// ---------------------------------------------------------------------------

/** 整数参数兜底 — 与 RiskAlertController.safeInt 同款 */
export function safeInt(v: unknown, defaultVal: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return defaultVal;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

/** ISO 日期解析 — 非法返 null (与 RiskAlertController.safeIsoDate 同款) */
export function safeIsoDate(v: unknown): Date | null {
  if (typeof v !== 'string' || !v.trim()) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

/** event_type 校验 — 仅返已知 enum, 非法返 null */
export function safeEventType(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim().toUpperCase();
  if (KNOWN_EVENT_TYPES.has(trimmed)) return trimmed;
  return null;
}

/** severity 校验 — 仅返已知 enum (小写), 非法返 null */
export function safeSeverity(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim().toLowerCase();
  if (KNOWN_SEVERITIES.has(trimmed)) return trimmed;
  return null;
}

/** scope 校验 — 仅返已知 enum, 非法返 null */
export function safeScope(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim().toLowerCase();
  if (KNOWN_SCOPES.has(trimmed)) return trimmed;
  return null;
}

/** status 校验 — 仅返已知 enum, 非法返 null */
export function safeStatus(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim().toLowerCase();
  if (KNOWN_STATUSES.has(trimmed)) return trimmed;
  return null;
}

/** 解析事件 id (与 ImprovementSuggestionController.parseSuggestionId 同款) */
export function parseEventId(raw: unknown): number | null {
  const n = parseInt(String(raw), 10);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return null;
  return n;
}

export class BlackSwanEventController {
  constructor() {
    this.listEvents = this.listEvents.bind(this);
    this.getEvent = this.getEvent.bind(this);
  }

  /**
   * GET /api/black-swan/events
   *
   * Query params:
   *   - event_type ∈ {ST, SUSPENDED, NEWS_KEYWORD, SHAREHOLDER_REDUCTION, MARKET_REGIME, OTHER}
   *   - severity ∈ {low, medium, high, critical}
   *   - scope ∈ {symbol, sector, market, portfolio}
   *   - status ∈ {open, resolved, expired}
   *   - symbol (模糊匹配)
   *   - date_from / date_to (ISO date; range over detected_at)
   *   - page (default 1), limit (default 30, max 200)
   *
   * 响应:
   *   200 { success: true, data: { items: [...], total, page, limit } }
   *   500 { success: false, message }
   */
  async listEvents(req: Request, res: Response, _next: NextFunction) {
    try {
      const eventType = safeEventType(req.query.event_type);
      const severity = safeSeverity(req.query.severity);
      const scope = safeScope(req.query.scope);
      const status = safeStatus(req.query.status);
      const symbol = typeof req.query.symbol === 'string' ? req.query.symbol.trim() : '';
      const dateFrom = safeIsoDate(req.query.date_from);
      const dateTo = safeIsoDate(req.query.date_to);
      const page = safeInt(req.query.page, PAGE_DEFAULT, 1, 10000);
      const limit = safeInt(req.query.limit, PAGE_LIMIT_DEFAULT, 1, PAGE_LIMIT_MAX);

      const where: WhereOptions = {};
      if (eventType) (where as any).event_type = eventType;
      if (severity) (where as any).severity = severity;
      if (scope) (where as any).scope = scope;
      if (status) (where as any).status = status;

      if (symbol) {
        (where as any).symbol = { [Op.iLike]: `%${symbol}%` };
      }

      if (dateFrom || dateTo) {
        const range: any = {};
        if (dateFrom) range[Op.gte] = dateFrom;
        if (dateTo) {
          const endOfDay = new Date(dateTo);
          if (dateTo.getUTCHours() === 0 && dateTo.getUTCMinutes() === 0) {
            endOfDay.setUTCHours(23, 59, 59, 999);
          }
          range[Op.lte] = endOfDay;
        }
        (where as any).detected_at = range;
      }

      const result = await BlackSwanEvent.findAndCountAll({
        where,
        order: [['detected_at', 'DESC']],
        offset: (page - 1) * limit,
        limit,
      });

      res.json({
        success: true,
        data: {
          items: result.rows.map(r => r.get({ plain: true })),
          total: result.count,
          page,
          limit,
        },
      });
    } catch (error: any) {
      logger.error('获取黑天鹅事件列表失败:', error);
      res
        .status((error as any)?.statusCode || 500)
        .json({ success: false, message: error?.message || '获取黑天鹅事件列表失败' });
    }
  }

  /**
   * GET /api/black-swan/events/:id
   *
   * 响应:
   *   200 { success: true, data: { event: {...}, postmortem: {...}|null } }
   *   400 { success: false, message: 'id 非法' }
   *   404 { success: false, message: '事件不存在' }
   *   500 { success: false, message }
   *
   * postmortem 由 PR-013 cron 异步生成, 可能尚未存在 → 返 null, UI 提示"待生成".
   */
  async getEvent(req: Request, res: Response, _next: NextFunction) {
    try {
      const id = parseEventId(req.params.id);
      if (id === null) {
        return res.status(400).json({ success: false, message: 'id 非法' });
      }

      const event = await BlackSwanEvent.findByPk(id);
      if (!event) {
        return res.status(404).json({ success: false, message: '事件不存在' });
      }

      // 关联 postmortem — UNIQUE(black_swan_event_id) 业务键, 一事件一份最新
      const postmortem = await BlackSwanPostmortemReport.findOne({
        where: { black_swan_event_id: id },
      });

      return res.json({
        success: true,
        data: {
          event: event.get({ plain: true }),
          postmortem: postmortem ? postmortem.get({ plain: true }) : null,
        },
      });
    } catch (error: any) {
      logger.error('获取黑天鹅事件详情失败:', error);
      return res
        .status((error as any)?.statusCode || 500)
        .json({ success: false, message: error?.message || '获取黑天鹅事件详情失败' });
    }
  }
}

export const blackSwanEventController = new BlackSwanEventController();
