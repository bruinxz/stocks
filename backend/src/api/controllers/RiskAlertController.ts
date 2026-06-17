import { Request, Response, NextFunction } from 'express';
import { Op, WhereOptions } from 'sequelize';
import { RiskAlert } from '../../models/RiskAlert';
import { User } from '../../models/User';
import { logger } from '../../utils/logger';

/**
 * US-077 — 风控告警中心：在原 4 个 endpoint 之外新增
 *   - **GET /api/risk-alerts/list**（带 query 过滤的分页 list；与 `/api/risk-alerts` 保留向后兼容）
 *   - **PUT /api/risk-alerts/mark-read**（按 ID 数组批量标记已读）
 *
 * 设计点：
 *   - 既有 GET /api/risk-alerts（getAlerts）返回 50 条 + risk_config，**保持不变**
 *     以兼容现有 RiskAlerts 旧页面 & TodaySignalsService 5-条预览；
 *   - 新 list 端点支持 filter：level / type / date_from / date_to / is_read /
 *     page / limit / search，page 默认 1、limit 默认 30（前端表格分页）；
 *   - **type 字段**：alert 没有显式类别字段，由 symbol 前缀派生：
 *       - `SYSTEM:*`（如 SYSTEM:MARKET_REGIME_DROP_3D, SYSTEM:PER_STOCK_STOP_LOSS_MASS） → `市场/系统`
 *       - 其他股票代码（6 位数字 / sh./sz./bj. 前缀） → 默认 `单股`
 *       - 在 service 层根据 rule_id 进一步细化：
 *           - `position_limit / industry_concentration / drawdown_breaker / trailing_stop / per_stock_stop_loss` → `持仓`
 *           - `market_regime_alert / factor_correlation / black_swan` → `市场`
 *           - 其他 → `单股`
 *   - SQL where 端只能过滤 level / date 范围 / is_read / symbol like search；
 *     type 过滤在内存层（拿出来后 filter），因 type 是派生字段；
 *   - 分页 count 用 findAndCountAll，前端拿 total 显示「共 N 条 当前第 X 页」。
 */

const PAGE_DEFAULT = 1;
const PAGE_LIMIT_DEFAULT = 30;
const PAGE_LIMIT_MAX = 200;

/** type 派生函数 — 单 export 供单测 + 前端兜底（前端也分类一遍） */
export type AlertCategory = 'position' | 'market' | 'individual';

export function deriveAlertCategory(alert: {
  symbol?: string | null;
  rule_id?: string | null;
}): AlertCategory {
  const ruleId = String(alert.rule_id || '').toLowerCase();
  const symbol = String(alert.symbol || '');

  // rule_id 优先（含义最明确）
  if (
    ruleId === 'position_limit' ||
    ruleId === 'industry_concentration' ||
    ruleId === 'drawdown_breaker' ||
    ruleId === 'trailing_stop' ||
    ruleId === 'per_stock_stop_loss'
  ) {
    return 'position';
  }
  if (
    ruleId === 'market_regime_alert' ||
    ruleId === 'factor_correlation' ||
    ruleId === 'black_swan'
  ) {
    return 'market';
  }

  // symbol 兜底
  if (symbol.startsWith('SYSTEM:')) return 'market';

  return 'individual';
}

function safeInt(v: unknown, defaultVal: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return defaultVal;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function safeIsoDate(v: unknown): Date | null {
  if (typeof v !== 'string' || !v.trim()) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function safeLevel(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const upper = v.trim().toUpperCase();
  if (upper === 'HIGH' || upper === 'MEDIUM' || upper === 'LOW') return upper;
  return null;
}

function safeType(v: unknown): AlertCategory | null {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim().toLowerCase();
  if (trimmed === 'position' || trimmed === '持仓') return 'position';
  if (trimmed === 'market' || trimmed === '市场' || trimmed === 'system') return 'market';
  if (trimmed === 'individual' || trimmed === '单股' || trimmed === 'stock') return 'individual';
  return null;
}

function safeIsRead(v: unknown): boolean | null {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'boolean') return v;
  const str = String(v).trim().toLowerCase();
  if (str === 'true' || str === '1' || str === 'yes') return true;
  if (str === 'false' || str === '0' || str === 'no') return false;
  return null;
}

export class RiskAlertController {
  // 获取当前用户的未读告警及风控配置（既有，保持向后兼容）
  async getAlerts(req: Request, res: Response, next: NextFunction) {
    try {
      const user_id = (req as any).user.id;

      const user = await User.findByPk(user_id);
      const alerts = await RiskAlert.findAll({
        where: { user_id: user_id },
        order: [['created_at', 'DESC']],
        limit: 50, // 只返回最近的50条
      });

      res.json({
        success: true,
        data: {
          alerts,
          risk_config: user?.risk_config || {
            stop_loss_percent: 5,
            take_profit_percent: 10,
            enableVolumeAlert: true,
            enableTechnicalAlert: true,
          },
        },
      });
    } catch (error: any) {
      logger.error('获取风控告警数据失败:', error);
      res.status((error as any)?.statusCode || 500).json({ success: false, message: error.message });
    }
  }

  /**
   * US-077 — GET /api/risk-alerts/list
   * 风控中心分页 + 过滤端点。
   *
   * Query params (所有可选)：
   *   - level: HIGH | MEDIUM | LOW
   *   - type: position | market | individual（中文 持仓 / 市场 / 单股 也接受）
   *   - date_from: YYYY-MM-DD or ISO
   *   - date_to: YYYY-MM-DD or ISO
   *   - is_read: true | false
   *   - search: symbol or name 模糊匹配
   *   - page: 1-based，默认 1
   *   - limit: 默认 30，最大 200
   *
   * 返回：
   *   { items: [...alert + category], total: N, page, limit, unread_count }
   */
  async listAlerts(req: Request, res: Response, next: NextFunction) {
    try {
      const user_id = (req as any).user.id;

      const level = safeLevel(req.query.level);
      const type = safeType(req.query.type);
      const dateFrom = safeIsoDate(req.query.date_from);
      const dateTo = safeIsoDate(req.query.date_to);
      const isRead = safeIsRead(req.query.is_read);
      const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
      const page = safeInt(req.query.page, PAGE_DEFAULT, 1, 10000);
      const limit = safeInt(req.query.limit, PAGE_LIMIT_DEFAULT, 1, PAGE_LIMIT_MAX);

      const where: WhereOptions = { user_id };
      if (level) (where as any).level = level;
      if (isRead !== null) (where as any).is_read = isRead;

      if (dateFrom || dateTo) {
        const range: any = {};
        if (dateFrom) range[Op.gte] = dateFrom;
        if (dateTo) {
          // 含 dateTo 当日 23:59:59 — 默认 YYYY-MM-DD 解析为当日 00:00:00
          const endOfDay = new Date(dateTo);
          if (dateTo.getUTCHours() === 0 && dateTo.getUTCMinutes() === 0) {
            endOfDay.setUTCHours(23, 59, 59, 999);
          }
          range[Op.lte] = endOfDay;
        }
        (where as any).created_at = range;
      }

      if (search) {
        (where as any)[Op.or] = [
          { symbol: { [Op.iLike]: `%${search}%` } },
          { name: { [Op.iLike]: `%${search}%` } },
        ];
      }

      // type 过滤在内存层（type 是派生字段，SQL where 表达不出）
      // 为了让分页 total 准确，先用 type=null 拉全集，再过滤、再分页
      // 否则若 type 过滤前的 total=50 / type 过滤后只剩 3，但分页声称还有 47
      // 实践上 user 总告警数有限（最多几百条），全集拉取无性能问题
      if (type) {
        const allMatching = await RiskAlert.findAll({
          where,
          order: [['created_at', 'DESC']],
        });
        const filtered = allMatching
          .map(a => ({ alert: a, category: deriveAlertCategory(a) }))
          .filter(x => x.category === type);
        const total = filtered.length;
        const offset = (page - 1) * limit;
        const sliced = filtered.slice(offset, offset + limit);
        const unreadCount = await RiskAlert.count({
          where: { user_id, is_read: false },
        });
        return res.json({
          success: true,
          data: {
            items: sliced.map(x => ({
              ...x.alert.get({ plain: true }),
              category: x.category,
            })),
            total,
            page,
            limit,
            unread_count: unreadCount,
          },
        });
      }

      // 无 type 过滤 → SQL 端正常分页
      const result = await RiskAlert.findAndCountAll({
        where,
        order: [['created_at', 'DESC']],
        offset: (page - 1) * limit,
        limit,
      });

      const unreadCount = await RiskAlert.count({
        where: { user_id, is_read: false },
      });

      res.json({
        success: true,
        data: {
          items: result.rows.map(a => ({
            ...a.get({ plain: true }),
            category: deriveAlertCategory(a),
          })),
          total: result.count,
          page,
          limit,
          unread_count: unreadCount,
        },
      });
    } catch (error: any) {
      logger.error('获取风控告警列表失败:', error);
      res.status((error as any)?.statusCode || 500).json({ success: false, message: error.message });
    }
  }

  // 更新风控配置
  async updateRiskConfig(req: Request, res: Response, next: NextFunction) {
    try {
      const user_id = (req as any).user.id;
      const { stop_loss_percent, take_profit_percent, enableVolumeAlert, enableTechnicalAlert } =
        req.body;

      const user = await User.findByPk(user_id);
      if (!user) {
        return res.status(404).json({ success: false, message: '用户不存在' });
      }

      user.risk_config = {
        ...user.risk_config,
        stop_loss_percent:
          stop_loss_percent !== undefined ? stop_loss_percent : user.risk_config?.stop_loss_percent,
        take_profit_percent:
          take_profit_percent !== undefined
            ? take_profit_percent
            : user.risk_config?.take_profit_percent,
        enableVolumeAlert:
          enableVolumeAlert !== undefined ? enableVolumeAlert : user.risk_config?.enableVolumeAlert,
        enableTechnicalAlert:
          enableTechnicalAlert !== undefined
            ? enableTechnicalAlert
            : user.risk_config?.enableTechnicalAlert,
      };

      // M8 (Batch H, 2026-06-17): JSONB 字段必须 changed() 标 dirty, 否则 Sequelize
      // shallow-compare 看不到引用变化 (我们 spread 新对象但底层 model 仍是同一指针)
      // → save 不写库, 配置静默丢. 与 US-017 risk_config 同款 lesson.
      user.changed('risk_config', true);
      await user.save();

      res.json({
        success: true,
        data: user.risk_config,
        message: '风控配置已保存',
      });
    } catch (error: any) {
      logger.error('更新风控配置失败:', error);
      res.status((error as any)?.statusCode || 500).json({ success: false, message: error.message });
    }
  }

  // 标记为已读
  async markAsRead(req: Request, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const user = (req as any).user;

      const alert = await RiskAlert.findOne({ where: { id, user_id: user.id } });
      if (alert) {
        alert.is_read = true;
        await alert.save();
      }

      res.json({ success: true, message: '已标记为已读' });
    } catch (error: any) {
      logger.error('标记已读失败:', error);
      res.status((error as any)?.statusCode || 500).json({ success: false, message: error.message });
    }
  }

  // 标记所有未读为已读
  async markAllAsRead(req: Request, res: Response, next: NextFunction) {
    try {
      const user = (req as any).user;

      await RiskAlert.update({ is_read: true }, { where: { user_id: user.id, is_read: false } });

      res.json({ success: true, message: '所有告警已标记为已读' });
    } catch (error: any) {
      logger.error('一键标记已读失败:', error);
      res.status((error as any)?.statusCode || 500).json({ success: false, message: error.message });
    }
  }

  /**
   * US-077 — PUT /api/risk-alerts/mark-read
   * 按 ID 数组批量标记已读。
   *
   * Body: { ids: number[] } — 单次最多 200 个 ID。
   *
   * 返回：{ updated: N }（实际更新条数）。
   */
  async markIdsAsRead(req: Request, res: Response, next: NextFunction) {
    try {
      const user = (req as any).user;
      const raw = req.body?.ids;

      if (!Array.isArray(raw)) {
        return res.status(400).json({
          success: false,
          message: '请求体 ids 必须是数字数组',
        });
      }

      // 去重 + 过滤非整数 + 限长
      const ids: number[] = [];
      const seen = new Set<number>();
      for (const v of raw) {
        const n = Number(v);
        if (!Number.isFinite(n) || !Number.isInteger(n)) continue;
        if (seen.has(n)) continue;
        seen.add(n);
        ids.push(n);
        if (ids.length >= 200) break;
      }

      if (ids.length === 0) {
        return res.json({
          success: true,
          data: { updated: 0 },
          message: '未提供有效告警 ID',
        });
      }

      const [updatedCount] = await RiskAlert.update(
        { is_read: true },
        {
          where: {
            id: { [Op.in]: ids },
            user_id: user.id,
            is_read: false,
          },
        }
      );

      res.json({
        success: true,
        data: { updated: updatedCount },
        message: `已标记 ${updatedCount} 条告警为已读`,
      });
    } catch (error: any) {
      logger.error('批量标记已读失败:', error);
      res.status((error as any)?.statusCode || 500).json({ success: false, message: error.message });
    }
  }
}

export const riskAlertController = new RiskAlertController();
