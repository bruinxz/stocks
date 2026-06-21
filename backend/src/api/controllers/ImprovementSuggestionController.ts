import { Request, Response, NextFunction } from 'express';
import { ImprovementSuggestion } from '../../models/ImprovementSuggestion';
import {
  IMPROVEMENT_STATUS,
  IMPROVEMENT_ACTION_TYPE,
} from '../../services/postmortem/ImprovementSuggestionService';
import { logger } from '../../utils/logger';

/**
 * US-126 [PM-024] — ImprovementSuggestion apply route
 *
 * POST /api/me/improvement-suggestions/:id/apply
 *   - 标记一条改进建议为 'applied' + 写入 applied_at + 透传 action snapshot.
 *   - 4 路径: 200 happy / 400 id 非法 / 401 未登录 / 403 跨用户 / 404 not found
 *     / 409 status 非 'open' (已 applied / dismissed / expired idempotent guard).
 *
 * **action 字段语义** (本 story 默认 noop):
 *   - action.type = 'noop'                 — service 默认; apply 仅标 status
 *   - action.type = 'tune_risk_param'      — 后续接 RiskConfigController.updateRiskConfig
 *   - action.type = 'enable_kill_switch'   — 后续接 KillSwitch service
 *   - action.type = 'open_workspace_tab'   — 前端跳转, 后端无副作用
 *
 *   本 story 仅消费 status + applied_at, action 透传到响应让前端按 type 决定后续 UX
 *   (跳 tab / 弹确认对话框 / 调他接口). 后续 PM-026/PM-027 story 可在此 controller
 *   按 action.type 分发到目标 service (注意要 idempotent + dry_run 选项).
 *
 * **idempotent 设计** (与 RiskAlertController.markAsRead 不同):
 *   - markAsRead 是幂等的 (status 字段是 boolean), 二次调返 200 不报错;
 *   - apply 一旦 'applied' 不允许重复触发 (action 可能有副作用如 tune_risk_param),
 *     返 409 + 现有 status; 前端按 status 提示"已应用过, X 时间";
 *   - dismissed / expired 也返 409 (不能 apply 已废弃的建议).
 *
 * **owner check 顺序 (防 user enumeration)**:
 *   findOne where {id, user_id} 单步 — 若 user_id 不匹配直接 404 not_found
 *   (避免 "id 存在但你无权" 的 403 暴露 id 命中状态). 与 RiskAlertController
 *   markAsRead 同款单步 where (id, user_id).
 */

const APPLY_ACTION_TYPES_KNOWN = new Set<string>([
  IMPROVEMENT_ACTION_TYPE.NOOP,
  IMPROVEMENT_ACTION_TYPE.TUNE_RISK_PARAM,
  IMPROVEMENT_ACTION_TYPE.ENABLE_KILL_SWITCH,
  IMPROVEMENT_ACTION_TYPE.OPEN_WORKSPACE_TAB,
]);

/**
 * 纯函数: 检查 status 是否允许 apply. 仅 'open' 可 apply.
 * 单独 export 给单测.
 */
export function canApplyStatus(status: string | null | undefined): boolean {
  return String(status || '') === IMPROVEMENT_STATUS.OPEN;
}

/**
 * 纯函数: 校验 id 参数. 必须正整数; 否则 null.
 * 单独 export 给单测.
 */
export function parseSuggestionId(raw: unknown): number | null {
  const n = parseInt(String(raw), 10);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return null;
  return n;
}

/**
 * 纯函数: 从 row.action snapshot 中提取 type, 未知 / 缺失 → 'noop'. 单独 export 给单测.
 */
export function resolveActionType(action: unknown): string {
  if (!action || typeof action !== 'object') return IMPROVEMENT_ACTION_TYPE.NOOP;
  const t = (action as { type?: unknown }).type;
  if (typeof t !== 'string') return IMPROVEMENT_ACTION_TYPE.NOOP;
  if (!APPLY_ACTION_TYPES_KNOWN.has(t)) return IMPROVEMENT_ACTION_TYPE.NOOP;
  return t;
}

export class ImprovementSuggestionController {
  constructor() {
    this.applyImprovementSuggestion = this.applyImprovementSuggestion.bind(this);
    this.listImprovementSuggestions = this.listImprovementSuggestions.bind(this);
  }

  /**
   * GET /api/me/improvement-suggestions
   * Query: status=open|applied|dismissed|expired (默认 open), limit=N (默认 50, max 200)
   *
   * Macro 串联补丁 (2026-06-21) — 前端 SettingsWorkspace.TodoSuggestionsTab apply 按钮
   * 的数据源. 之前后端只有 POST /:id/apply 但没 list 入口, 前端没法展示 → 永远点不到 apply.
   *
   * 响应:
   *   200 { success: true, data: { items: [...], total: N } }
   *   401 { success: false, message: '未登录' }
   *   500 { success: false, message: error.message }
   */
  async listImprovementSuggestions(req: Request, res: Response, _next: NextFunction) {
    try {
      const user_id = (req as any).user?.id;
      if (!user_id) {
        return res.status(401).json({ success: false, message: '未登录' });
      }
      const statusRaw = String(req.query.status || IMPROVEMENT_STATUS.OPEN);
      const ALLOWED_STATUS = new Set<string>([
        IMPROVEMENT_STATUS.OPEN,
        IMPROVEMENT_STATUS.APPLIED,
        IMPROVEMENT_STATUS.DISMISSED,
        IMPROVEMENT_STATUS.EXPIRED,
      ]);
      const status = ALLOWED_STATUS.has(statusRaw) ? statusRaw : IMPROVEMENT_STATUS.OPEN;

      const limitRaw = parseInt(String(req.query.limit || '50'), 10);
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 50;

      const rows = await ImprovementSuggestion.findAll({
        where: { user_id, status },
        order: [
          ['priority', 'DESC'],
          ['generated_at', 'DESC'],
        ],
        limit,
      });

      const items = rows.map(r => {
        const j = typeof (r as any).toJSON === 'function' ? (r as any).toJSON() : r;
        return {
          id: j.id,
          period_start: j.period_start,
          period_end: j.period_end,
          category: j.category,
          key: j.key,
          title: j.title,
          body: j.body,
          priority: j.priority,
          status: j.status,
          source: j.source,
          action: j.action,
          evidence: j.evidence,
          applied_at: j.applied_at,
          dismissed_at: j.dismissed_at,
          generated_at: j.generated_at,
          effect_metrics: j.effect_metrics,
          effect_tracked_at: j.effect_tracked_at,
        };
      });

      return res.json({ success: true, data: { items, total: items.length } });
    } catch (error: any) {
      logger.error('list ImprovementSuggestion 失败:', error);
      return res.status(500).json({
        success: false,
        message: error?.message || 'list ImprovementSuggestion 失败',
      });
    }
  }

  /**
   * POST /api/me/improvement-suggestions/:id/apply
   * Body: {} (本 story 不接 payload; 未来 PM-026/027 可加 dry_run / override)
   *
   * 响应:
   *   200 { success: true, data: { id, status: 'applied', applied_at, action_type } }
   *   400 { success: false, message: 'id 非法' }
   *   401 { success: false, message: '未登录' }       (authenticate 中间件已守, 这里兜底)
   *   404 { success: false, message: '建议不存在' }
   *   409 { success: false, message: '建议已 X, 不可重复 apply', data: { status, applied_at, dismissed_at } }
   *   500 { success: false, message: error.message }
   */
  async applyImprovementSuggestion(req: Request, res: Response, _next: NextFunction) {
    try {
      const user_id = (req as any).user?.id;
      if (!user_id) {
        return res.status(401).json({ success: false, message: '未登录' });
      }

      const id = parseSuggestionId(req.params.id);
      if (id === null) {
        return res.status(400).json({ success: false, message: 'id 非法' });
      }

      // owner check via where (id, user_id) — 不区分"不存在" vs "不属于本人" 都返 404
      // 防 enumeration (与 RiskAlertController.markAsRead 同款单步 where).
      const row = await ImprovementSuggestion.findOne({
        where: { id, user_id },
      });
      if (!row) {
        return res.status(404).json({ success: false, message: '建议不存在' });
      }

      if (!canApplyStatus(row.status)) {
        return res.status(409).json({
          success: false,
          message: `建议已 ${row.status}, 不可重复 apply`,
          data: {
            id: row.id,
            status: row.status,
            applied_at: row.applied_at,
            dismissed_at: row.dismissed_at,
          },
        });
      }

      const actionType = resolveActionType(row.action);
      const now = new Date();
      row.status = IMPROVEMENT_STATUS.APPLIED;
      row.applied_at = now;
      await row.save();

      return res.json({
        success: true,
        data: {
          id: row.id,
          status: row.status,
          applied_at: row.applied_at,
          action_type: actionType,
          action: row.action,
        },
      });
    } catch (error: any) {
      logger.error('apply ImprovementSuggestion 失败:', error);
      return res.status((error as any)?.statusCode || 500).json({
        success: false,
        message: error?.message || 'apply ImprovementSuggestion 失败',
      });
    }
  }
}

export const improvementSuggestionController = new ImprovementSuggestionController();
