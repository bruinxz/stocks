import { Request, Response, NextFunction } from 'express';
import { Op } from 'sequelize';
import {
  paperTradingFacade,
  AUTONOMOUS_PORTFOLIO_NAME,
  DEFAULT_AUTONOMOUS_INITIAL_CAPITAL,
  QUANT_ONLY_PORTFOLIO_NAME,
} from '../../portfolio/PaperTradingFacade';
import { PaperTradingPortfolio } from '../../models/PaperTradingPortfolio';
import { PaperTradingOrderIntent } from '../../models/PaperTradingOrderIntent';
// AT-1 (2026-06-22) — 模拟盘 CRUD
import { paperTradingPortfolioCrudService } from '../../portfolio/internal/PaperTradingPortfolioCrudService';
import { logger } from '../../utils/logger';

// AUTONOMOUS_PORTFOLIO_NAME / DEFAULT_AUTONOMOUS_INITIAL_CAPITAL / QUANT_ONLY_PORTFOLIO_NAME
// are re-exported from the facade for legacy reasons (some routes/tests may still
// reference them directly).  All actual operations go through `paperTradingFacade`.
export { AUTONOMOUS_PORTFOLIO_NAME, DEFAULT_AUTONOMOUS_INITIAL_CAPITAL, QUANT_ONLY_PORTFOLIO_NAME };

function sendError(res: Response, error: any, fallbackMessage: string) {
  const status = error?.statusCode || 500;
  // BC-3-r2 (2026-06-23): 4xx 是用户输入/权限/资源缺失的业务错误, 不应污染
  // error.log (prod error 看板). 5xx (默认) 是真异常, 保持 error 级别.
  // 之前: '未找到模拟盘 (或无权访问)' (404) 等业务错误近 3 天累计 49 条噪声.
  // 对照 BC-2-r1 (autoBuyFromSignals 持仓上限 warn 降级) 同款分级.
  if (status >= 400 && status < 500) {
    logger.warn(`${fallbackMessage} ${error?.message || ''} (status=${status})`);
  } else {
    logger.error(fallbackMessage, error);
  }
  return res.status(status).json({ success: false, message: error?.message || fallbackMessage });
}

export class PaperTradingController {
  /**
   * 修复 HIGH #16 (2026-06-16): 客户端可能在 body 里传 bypass_trading_hours /
   * bypass_t_plus_1 / dry_run 等内部 flag 直接绕过 facade guard. 用户传的 body
   * 必须先经过这个 sanitizer 把 sensitive flag 剥掉 (除非是 admin).
   *
   * Batch H (2026-06-17): 黑名单扩容. 普通 user 不应该能跨账户 / 跨盘 fan-out:
   *   - all_portfolios=true: 跨用户全平台 risk_check / refresh outcome (C3/C5)
   *   - scope='all': per_stock_stop_loss_check 跨用户扫描 (C4)
   *   - username / user_id: 改归属盘 → 跨账户操纵 (M1, C11)
   *   - portfolio_name: 绕过 portfolio_id 直接按名字路由到他人盘
   *   - dry_run_strategy_keys: 影响策略 dry-run 范围, 用户不应直接控制
   *
   * 允许从 body 透传的字段保留 dry_run (用户合理"预览"需求) / source_type / signal_ids /
   * agent_session / scope='self' (默认值).
   */
  private sanitizeAutomationBody(body: any, user: any): any {
    if (!body || typeof body !== 'object') return body || {};
    const isAdmin = user?.role === 'admin';
    const sensitiveFlags = [
      'bypass_trading_hours',
      'bypass_t_plus_1',
      'force_new_portfolio',
      'allow_low_data_quality_for_forced_signals',
      'ignore_profit_gate_for_forced_signals',
      // Batch H 新增:
      'all_portfolios',
      'username',
      'user_id',
      'portfolio_name',
      'dry_run_strategy_keys',
    ];
    const sanitized = { ...body };
    if (!isAdmin) {
      for (const flag of sensitiveFlags) {
        if (sanitized[flag] !== undefined) {
          logger.warn(
            `[sanitizeAutomationBody] user=${user?.id} 非 admin 尝试传 ${flag}=${JSON.stringify(
              sanitized[flag]
            )}, 已剥除`
          );
          delete sanitized[flag];
        }
      }
      // scope 只允许 'self'; 'all' 必须 admin.
      if (sanitized.scope !== undefined && sanitized.scope !== 'self') {
        logger.warn(
          `[sanitizeAutomationBody] user=${user?.id} 非 admin 尝试传 scope=${sanitized.scope}, 强制 self`
        );
        sanitized.scope = 'self';
      }
    }
    return sanitized;
  }

  // 修复 (2026-06-17 串盘): 列出当前 user 所有 active portfolio, 让前端展示选盘下拉.
  // 之前 user 4 有 9 个 portfolio 但 UI 只调 GET / 拿一个 (随机), 用户看到的持仓
  // 一会儿是这盘一会儿是那盘. 现在 UI 应该先调这个 endpoint 拿列表, 再用
  // ?portfolio_id=X 拉具体盘.
  //
  // AT-1 (2026-06-22): 切到 PaperTradingPortfolioCrudService.listForUser, 返回
  // 扩展字段 (strategy_keys + strategy_display + enabled_factors + factor_display +
  // auto_trade_enabled + return_7d_pct + return_30d_pct + total_return_pct +
  // description). 旧字段全部保留 (向后兼容).
  listPortfolios = async (req: Request, res: Response, _next: NextFunction) => {
    try {
      const user = (req as any).user;
      const includeInactive = String(req.query?.include_inactive || '').toLowerCase() === 'true';
      const data = await paperTradingPortfolioCrudService.listForUser(user.id, {
        include_inactive: includeInactive,
      });
      res.json({ success: true, data });
    } catch (error: any) {
      sendError(res, error, '获取 portfolio 列表失败');
    }
  };

  // AT-1 (2026-06-22): GET /api/paper-trading/portfolios/:id — 获取指定 portfolio
  // 详情 (strategy_display + factor_display + 最近 10 笔 trade + risk_profile_overrides)
  getPortfolioDetail = async (req: Request, res: Response, _next: NextFunction) => {
    try {
      const user = (req as any).user;
      const portfolioId = Number(req.params.id);
      if (!Number.isFinite(portfolioId) || portfolioId <= 0) {
        return res.status(400).json({ success: false, message: 'id 无效' });
      }
      const data = await paperTradingPortfolioCrudService.getDetailForUser(user.id, portfolioId);
      res.json({ success: true, data });
    } catch (error: any) {
      sendError(res, error, '获取 portfolio 详情失败');
    }
  };

  // AT-1 (2026-06-22): POST /api/paper-trading/portfolios — 创建新模拟盘
  createPortfolio = async (req: Request, res: Response, _next: NextFunction) => {
    try {
      const user = (req as any).user;
      const body = req.body || {};
      const result = await paperTradingPortfolioCrudService.createForUser(user.id, {
        name: body.name,
        description: body.description,
        initial_capital: Number(body.initial_capital),
        strategy_keys: body.strategy_keys,
        enabled_factors: body.enabled_factors,
        auto_trade_enabled: body.auto_trade_enabled,
        risk_profile_overrides: body.risk_profile_overrides,
      });
      res.status(201).json({
        success: true,
        data: result,
        message: `已创建模拟盘 "${result.name}" (id=${result.id})`,
      });
    } catch (error: any) {
      sendError(res, error, '创建模拟盘失败');
    }
  };

  // AT-1 (2026-06-22): PUT /api/paper-trading/portfolios/:id — 更新模拟盘配置
  // (只允许改 name/description/strategy_keys/enabled_factors/auto_trade_enabled/
  // risk_profile_overrides; 资金字段一律拒绝)
  updatePortfolio = async (req: Request, res: Response, _next: NextFunction) => {
    try {
      const user = (req as any).user;
      const portfolioId = Number(req.params.id);
      if (!Number.isFinite(portfolioId) || portfolioId <= 0) {
        return res.status(400).json({ success: false, message: 'id 无效' });
      }
      const body = req.body || {};
      // 资金字段防御性拦截 (service 层已过滤, 这里 422 提示更早)
      const FORBIDDEN = ['initial_capital', 'current_cash', 'total_value', 'user_id', 'id'];
      for (const k of FORBIDDEN) {
        if (Object.prototype.hasOwnProperty.call(body, k)) {
          return res.status(422).json({
            success: false,
            message: `不允许通过 PUT 修改 ${k} (要重置资金请用 POST /portfolios/:id/reset; 要改规模请删后重建)`,
          });
        }
      }
      await paperTradingPortfolioCrudService.updateForUser(user.id, portfolioId, {
        name: body.name,
        description: body.description,
        strategy_keys: body.strategy_keys,
        enabled_factors: body.enabled_factors,
        auto_trade_enabled: body.auto_trade_enabled,
        risk_profile_overrides: body.risk_profile_overrides,
      });
      res.json({ success: true, message: '模拟盘配置已更新' });
    } catch (error: any) {
      sendError(res, error, '更新模拟盘失败');
    }
  };

  // AT-1 (2026-06-22): DELETE /api/paper-trading/portfolios/:id?hard=true
  // 默认软删 (is_active=false 保留历史); hard=true 物理删 + cascade
  deletePortfolio = async (req: Request, res: Response, _next: NextFunction) => {
    try {
      const user = (req as any).user;
      const portfolioId = Number(req.params.id);
      if (!Number.isFinite(portfolioId) || portfolioId <= 0) {
        return res.status(400).json({ success: false, message: 'id 无效' });
      }
      const hard = String(req.query?.hard || '').toLowerCase() === 'true';
      await paperTradingPortfolioCrudService.deleteForUser(user.id, portfolioId, { hard });
      res.json({
        success: true,
        message: hard
          ? '模拟盘已物理删除 (含所有历史 trade/snapshot)'
          : '模拟盘已停用 (软删, 历史保留)',
      });
    } catch (error: any) {
      sendError(res, error, '删除模拟盘失败');
    }
  };

  // AT-1 (2026-06-22): POST /api/paper-trading/portfolios/:id/reset
  // 清持仓 + cash 还原到 initial_capital (保留 portfolio.id + 历史 trades/snapshots)
  resetPortfolio = async (req: Request, res: Response, _next: NextFunction) => {
    try {
      const user = (req as any).user;
      const portfolioId = Number(req.params.id);
      if (!Number.isFinite(portfolioId) || portfolioId <= 0) {
        return res.status(400).json({ success: false, message: 'id 无效' });
      }
      await paperTradingPortfolioCrudService.resetForUser(user.id, portfolioId);
      res.json({ success: true, message: '模拟盘已重置 (持仓清零, 资金还原)' });
    } catch (error: any) {
      sendError(res, error, '重置模拟盘失败');
    }
  };

  // AT-1 (2026-06-22): GET /api/paper-trading/strategies/available
  // 列出全部已注册策略 + 中文名 + 简介 + risk_level + tags (供创建/编辑 portfolio 时选)
  listAvailableStrategies = async (_req: Request, res: Response, _next: NextFunction) => {
    try {
      const data = paperTradingPortfolioCrudService.listAvailableStrategies();
      res.json({ success: true, data });
    } catch (error: any) {
      sendError(res, error, '获取可选策略列表失败');
    }
  };

  // AT-1 (2026-06-22): GET /api/paper-trading/factors/available
  // 列出全部已注册因子 + 中文描述 + category (供 enabled_factors 选)
  listAvailableFactors = async (_req: Request, res: Response, _next: NextFunction) => {
    try {
      const data = paperTradingPortfolioCrudService.listAvailableFactors();
      res.json({ success: true, data });
    } catch (error: any) {
      sendError(res, error, '获取可选因子列表失败');
    }
  };

  // 获取当前用户的模拟盘及持仓
  getPortfolio = async (req: Request, res: Response, _next: NextFunction) => {
    try {
      const user = (req as any).user;
      // 修复 (2026-06-17): 透传 query.portfolio_id 给 facade 防 UI 串盘.
      // 前端从 /api/paper-trading?portfolio_id=36 这样传; 不传则 facade fallback
      // 到 user 名下 active id ASC 第一个 (稳定但仍是单盘).
      const portfolioIdRaw = req.query?.portfolio_id;
      const portfolio_id = portfolioIdRaw ? Number(portfolioIdRaw) : undefined;
      const data = await paperTradingFacade.getPortfolio({
        view: 'basic',
        user_id: user.id,
        username: user.nickname || user.username,
        portfolio_id: Number.isFinite(portfolio_id as number) ? portfolio_id : undefined,
      });
      res.json({ success: true, data });
    } catch (error: any) {
      sendError(res, error, '获取模拟盘数据失败');
    }
  };

  // 模拟交易下单 (买入/卖出)
  placeTrade = async (req: Request, res: Response, _next: NextFunction) => {
    try {
      const user = (req as any).user;
      // 修复 CRITICAL #C1 (2026-06-17): 透传 portfolio_id 防卖错盘.
      // 之前 UI 点"一键平仓" body 只传 symbol/direction/quantity, controller 不读
      // portfolio_id → facade fallback 到 user 名下 active id ASC 第一个 (portfolio 33),
      // 实际卖 portfolio 33 → 如该盘没该股 throw 持仓不足; 更糟卖到错盘是真金白银事故.
      const { symbol, direction: rawDirection, quantity, portfolio_id, action } = req.body;
      // Batch H (H1+H2, 2026-06-17): 兼容 (a) controller 真用的 direction; (b) OpenAPI 文档写
      // action='buy/sell'. 任一字段大写小写都接, 统一变 'BUY' / 'SELL'. 之前 'buy' 走到 facade
      // 因 !== 'BUY' 抛 generic Error → sendError 500. 现在 400 + 明确 message.
      const directionInput = String(rawDirection || action || '').toUpperCase();
      if (directionInput !== 'BUY' && directionInput !== 'SELL') {
        return res.status(400).json({
          success: false,
          message: '交易方向 direction 必须为 BUY 或 SELL (兼容 action=buy/sell)',
        });
      }
      const parsedQuantity = Number(quantity);
      if (!Number.isFinite(parsedQuantity) || parsedQuantity <= 0) {
        return res
          .status(400)
          .json({ success: false, message: 'quantity 必须是正数 (建议 100 整数倍)' });
      }
      const parsedPortfolioId =
        portfolio_id !== undefined && portfolio_id !== null ? Number(portfolio_id) : undefined;
      const result = await paperTradingFacade.placeOrder({
        user_id: user.id,
        portfolio_id: Number.isFinite(parsedPortfolioId as number) ? parsedPortfolioId : undefined,
        symbol,
        direction: directionInput as 'BUY' | 'SELL',
        quantity: parsedQuantity,
      });
      res.json({ success: true, message: '交易成功', data: result });
    } catch (error: any) {
      sendError(res, error, '模拟交易失败');
    }
  };

  // 获取交易流水历史
  getTradeHistory = async (req: Request, res: Response, _next: NextFunction) => {
    try {
      const user = (req as any).user;
      // 修复 (2026-06-17 串盘 续): controller 之前没透传 req.query.portfolio_id 给 facade,
      // 即使前端传了 ?portfolio_id=X 后端仍走 facade fallback 路径返回任意盘的 trades.
      const portfolioIdRaw = req.query?.portfolio_id;
      const portfolio_id = portfolioIdRaw ? Number(portfolioIdRaw) : undefined;
      const data = await paperTradingFacade.getDailySnapshot({
        action: 'trades',
        user_id: user.id,
        portfolio_id: Number.isFinite(portfolio_id as number) ? portfolio_id : undefined,
      });
      res.json({ success: true, data });
    } catch (error: any) {
      sendError(res, error, '获取交易流水失败');
    }
  };

  // 获取快照历史(资金曲线)
  getSnapshots = async (req: Request, res: Response, _next: NextFunction) => {
    try {
      const user = (req as any).user;
      // 修复 (2026-06-17 串盘 续): 同款透传
      const portfolioIdRaw = req.query?.portfolio_id;
      const portfolio_id = portfolioIdRaw ? Number(portfolioIdRaw) : undefined;
      const data = await paperTradingFacade.getDailySnapshot({
        action: 'list',
        user_id: user.id,
        portfolio_id: Number.isFinite(portfolio_id as number) ? portfolio_id : undefined,
      });
      res.json({ success: true, data });
    } catch (error: any) {
      sendError(res, error, '获取资金曲线快照失败');
    }
  };

  // 从已归档的 AI/量化推荐信号自动生成模拟盘交易
  autoTradeFromSignals = async (req: Request, res: Response, _next: NextFunction) => {
    try {
      const user = (req as any).user;
      const result: any = await paperTradingFacade.applyAutomation({
        action: 'auto_buy',
        user_id: user.id,
        username: user.username || user.nickname,
        body: this.sanitizeAutomationBody(req.body, (req as any).user),
      });
      res.json({
        success: true,
        data: result,
        message: result.dry_run
          ? `预演完成，计划交易 ${result.planned} 笔`
          : `自动跟单完成，成交 ${result.executed} 笔`,
      });
    } catch (error: any) {
      sendError(res, error, '推荐信号自动进入模拟盘失败');
    }
  };

  // 刷新推荐候选、归档信号，并自动执行模拟盘跟单闭环
  autoSyncFromRecommendations = async (req: Request, res: Response, _next: NextFunction) => {
    try {
      const user = (req as any).user;
      const result: any = await paperTradingFacade.applyAutomation({
        action: 'auto_sync',
        user_id: user.id,
        username: user.username || user.nickname,
        body: this.sanitizeAutomationBody(req.body, (req as any).user),
      });
      res.json({
        success: true,
        data: result,
        message: result.dry_run
          ? `推荐闭环预演完成，计划交易 ${result.planned} 笔`
          : `推荐闭环完成，模拟成交 ${result.executed} 笔`,
      });
    } catch (error: any) {
      sendError(res, error, '推荐候选自动归档并进入模拟盘失败');
    }
  };

  // 刷新价格并写入当日资产快照
  refreshSnapshot = async (req: Request, res: Response, _next: NextFunction) => {
    try {
      const user = (req as any).user;
      const portfolioIdRaw = req.query?.portfolio_id;
      const portfolio_id = portfolioIdRaw ? Number(portfolioIdRaw) : undefined;
      const snapshot = await paperTradingFacade.getDailySnapshot({
        action: 'refresh',
        user_id: user.id,
        portfolio_id: Number.isFinite(portfolio_id as number) ? portfolio_id : undefined,
      });
      res.json({ success: true, data: snapshot, message: '模拟盘快照已刷新' });
    } catch (error: any) {
      sendError(res, error, '刷新模拟盘快照失败');
    }
  };

  // 按止损/止盈/卖出信号/最长持有期检查并自动退出
  runRiskCheck = async (req: Request, res: Response, _next: NextFunction) => {
    try {
      const user = (req as any).user;
      const result: any = await paperTradingFacade.applyAutomation({
        action: 'risk_check',
        user_id: user.id,
        username: user.username || user.nickname,
        body: this.sanitizeAutomationBody(req.body, (req as any).user),
      });
      res.json({
        success: true,
        data: result,
        message: result.dry_run
          ? `风控预演完成，计划退出 ${result.planned} 笔`
          : `风控检查完成，模拟卖出 ${result.exited} 笔`,
      });
    } catch (error: any) {
      sendError(res, error, '模拟盘自动风控检查失败');
    }
  };

  // 获取自主荐股模拟盘总览
  getAutonomousDashboard = async (req: Request, res: Response, _next: NextFunction) => {
    try {
      const user = (req as any).user;
      const result: any = await paperTradingFacade.getPortfolio({
        view: 'autonomous_dashboard',
        user_id: user.id,
        username: user.username || user.nickname,
        query: this.sanitizeAutomationBody(req.query as Record<string, any>, (req as any).user),
      });
      const familyOpenCount = Number(
        result.portfolio_family_summary?.summary?.open_position_count ||
          result.summary.open_position_count ||
          0
      );
      res.json({
        success: true,
        data: result,
        message: `自主模拟盘总览已刷新：综合盘持仓 ${result.summary.open_position_count} 只，全部策略账户持仓 ${familyOpenCount} 只`,
      });
    } catch (error: any) {
      sendError(res, error, '获取自主荐股模拟盘总览失败');
    }
  };

  // 获取每日推荐股票追踪页：推荐→模拟持仓→卖出结算→收益
  getRecommendationTracking = async (req: Request, res: Response, _next: NextFunction) => {
    try {
      const user = (req as any).user;
      const result: any = await paperTradingFacade.getPortfolio({
        view: 'recommendation_tracking',
        user_id: user.id,
        username: user.username || user.nickname,
        query: this.sanitizeAutomationBody(req.query as Record<string, any>, (req as any).user),
      });
      res.json({
        success: true,
        data: result,
        message: `每日推荐追踪已刷新：信号 ${result.summary.total_signals} 条，持仓 ${result.summary.open_count} 条，闭环 ${result.summary.closed_count} 条`,
      });
    } catch (error: any) {
      sendError(res, error, '获取每日推荐追踪失败');
    }
  };

  // 获取自主荐股闭环优化台
  getAutonomousOptimization = async (req: Request, res: Response, _next: NextFunction) => {
    try {
      const user = (req as any).user;
      const result: any = await paperTradingFacade.attributePnl({
        action: 'autonomous_optimization',
        user_id: user.id,
        username: user.username || user.nickname,
        query: this.sanitizeAutomationBody(req.query as Record<string, any>, (req as any).user),
      });
      res.json({
        success: true,
        data: result,
        message: `自主闭环优化台已刷新：闭环 ${result.summary.closed_count} 笔，建议评分≥${result.next_policy.recommended_min_score}`,
      });
    } catch (error: any) {
      sendError(res, error, '获取自主荐股闭环优化台失败');
    }
  };

  // 自主闭环专用：全市场推荐→归档信号→模拟跟单
  runAutonomousAutoSync = async (req: Request, res: Response, _next: NextFunction) => {
    try {
      const user = (req as any).user;
      const result: any = await paperTradingFacade.applyAutomation({
        action: 'autonomous_auto_sync',
        user_id: user.id,
        username: user.username || user.nickname,
        body: this.sanitizeAutomationBody(req.body, (req as any).user),
      });
      const { execution, dashboard } = result;
      res.json({
        success: true,
        data: { execution, dashboard },
        message: execution.dry_run
          ? `自主闭环预演完成，计划交易 ${execution.planned} 笔`
          : `自主闭环完成，模拟成交 ${execution.executed} 笔，跳过 ${execution.skipped} 笔`,
      });
    } catch (error: any) {
      sendError(res, error, '自主闭环推荐并模拟跟单失败');
    }
  };

  // 自主闭环专用：卖出信号/止损/止盈/持有期结算
  runAutonomousRiskCheck = async (req: Request, res: Response, _next: NextFunction) => {
    try {
      const user = (req as any).user;
      const result: any = await paperTradingFacade.applyAutomation({
        action: 'autonomous_risk_check',
        user_id: user.id,
        username: user.username || user.nickname,
        body: this.sanitizeAutomationBody(req.body, (req as any).user),
      });
      const { execution, dashboard } = result;
      res.json({
        success: true,
        data: { execution, dashboard },
        message: execution.dry_run
          ? `自主风控预演完成，计划退出 ${execution.planned} 笔`
          : `自主风控结算完成，模拟卖出 ${execution.exited} 笔`,
      });
    } catch (error: any) {
      sendError(res, error, '自主闭环风控结算失败');
    }
  };

  // 获取模拟盘收益归因
  getAttribution = async (req: Request, res: Response, _next: NextFunction) => {
    try {
      const user = (req as any).user;
      const result: any = await paperTradingFacade.attributePnl({
        action: 'compute',
        user_id: user.id,
        query: this.sanitizeAutomationBody(req.query as Record<string, any>, (req as any).user),
      });
      res.json({
        success: true,
        data: result,
        message: `收益归因完成：闭环 ${result.summary.closed_count} 笔，当前持仓 ${result.summary.open_count} 只`,
      });
    } catch (error: any) {
      sendError(res, error, '获取模拟盘收益归因失败');
    }
  };

  // 获取模拟盘组合风险画像
  getRiskProfile = async (req: Request, res: Response, _next: NextFunction) => {
    try {
      const user = (req as any).user;
      const result: any = await paperTradingFacade.getRiskProfile({
        view: 'profile',
        user_id: user.id,
        query: this.sanitizeAutomationBody(req.query as Record<string, any>, (req as any).user),
      });
      res.json({
        success: true,
        data: result,
        message: `组合风险画像：${result.status.label}`,
      });
    } catch (error: any) {
      sendError(res, error, '获取模拟盘组合风险画像失败');
    }
  };

  // 获取模拟交易订单意图/拒单归因
  getOrderIntents = async (req: Request, res: Response, _next: NextFunction) => {
    try {
      const user = (req as any).user;
      const result: any = await paperTradingFacade.getRiskProfile({
        view: 'intents',
        user_id: user.id,
        username: user.username || user.nickname,
        query: this.sanitizeAutomationBody(req.query as Record<string, any>, (req as any).user),
      });
      res.json({
        success: true,
        data: result,
        message: result.summary?.conclusion || '订单意图已刷新',
      });
    } catch (error: any) {
      sendError(res, error, '获取模拟交易订单意图失败');
    }
  };

  // 获取全部策略账户的拒单后验汇总
  getOrderIntentFamilyHindsight = async (req: Request, res: Response, _next: NextFunction) => {
    try {
      const user = (req as any).user;
      const result: any = await paperTradingFacade.getRiskProfile({
        view: 'intent_family_hindsight',
        user_id: user.id,
        username: user.username || user.nickname,
        query: this.sanitizeAutomationBody(req.query as Record<string, any>, (req as any).user),
      });
      res.json({
        success: true,
        data: result,
        message: result.summary?.conclusion || '策略账户拒单后验已刷新',
      });
    } catch (error: any) {
      sendError(res, error, '获取策略账户拒单后验失败');
    }
  };

  // 获取单条模拟交易订单意图的链路钻取
  getOrderIntentTrace = async (req: Request, res: Response, _next: NextFunction) => {
    try {
      const user = (req as any).user;
      const result: any = await paperTradingFacade.getRiskProfile({
        view: 'intent_trace',
        user_id: user.id,
        username: user.username || user.nickname,
        query: this.sanitizeAutomationBody(req.query as Record<string, any>, (req as any).user),
        params: { id: req.params.id },
      });
      if (!result) {
        return res.status(404).json({ success: false, message: '未找到订单意图链路' });
      }
      res.json({ success: true, data: result, message: result.conclusion });
    } catch (error: any) {
      sendError(res, error, '获取模拟交易订单意图链路失败');
    }
  };

  // 刷新订单意图后验快照
  refreshOrderIntentHindsight = async (req: Request, res: Response, _next: NextFunction) => {
    try {
      const user = (req as any).user;
      const result: any = await paperTradingFacade.applyAutomation({
        action: 'hindsight_refresh',
        user_id: user.id,
        username: user.username || user.nickname,
        body: this.sanitizeAutomationBody(req.body, (req as any).user),
      });
      res.json({ success: true, data: result, message: result.message });
    } catch (error: any) {
      sendError(res, error, '刷新模拟交易订单意图后验快照失败');
    }
  };

  // 获取推荐信号→模拟交易→收益结果闭环看板
  getRecommendationOutcomes = async (req: Request, res: Response, _next: NextFunction) => {
    try {
      const user = (req as any).user;
      const result: any = await paperTradingFacade.attributePnl({
        action: 'recommendation_outcomes',
        user_id: user.id,
        query: this.sanitizeAutomationBody(req.query as Record<string, any>, (req as any).user),
      });
      res.json({
        success: true,
        data: result,
        message: `推荐交易收益闭环：跟踪 ${result.summary.total_count} 笔，已闭环 ${result.summary.closed_count} 笔`,
      });
    } catch (error: any) {
      sendError(res, error, '获取推荐交易收益闭环失败');
    }
  };

  // 获取单笔推荐链路
  getRecommendationOutcomeTrace = async (req: Request, res: Response, _next: NextFunction) => {
    try {
      const user = (req as any).user;
      const result: any = await paperTradingFacade.attributePnl({
        action: 'recommendation_outcome_trace',
        user_id: user.id,
        query: this.sanitizeAutomationBody(req.query as Record<string, any>, (req as any).user),
        params: { id: req.params.id },
      });
      if (!result) {
        return res.status(404).json({ success: false, message: '未找到推荐链路详情' });
      }
      res.json({ success: true, data: result, message: result.conclusion });
    } catch (error: any) {
      sendError(res, error, '获取推荐链路详情失败');
    }
  };

  // 刷新推荐信号→模拟交易→收益结果闭环
  refreshRecommendationOutcomes = async (req: Request, res: Response, _next: NextFunction) => {
    try {
      const user = (req as any).user;
      const result: any = await paperTradingFacade.attributePnl({
        action: 'refresh_recommendation_outcomes',
        user_id: user.id,
        body: this.sanitizeAutomationBody(req.body, (req as any).user),
      });
      res.json({
        success: true,
        data: result,
        message: `收益闭环刷新完成：刷新 ${result.refreshed} 条，写入 ${result.created_or_updated} 条`,
      });
    } catch (error: any) {
      sendError(res, error, '刷新推荐交易收益闭环失败');
    }
  };

  // 推荐交易收益闭环报告写入飞书
  reportRecommendationOutcomes = async (req: Request, res: Response, _next: NextFunction) => {
    try {
      const user = (req as any).user;
      const result: any = await paperTradingFacade.attributePnl({
        action: 'report_recommendation_outcomes',
        user_id: user.id,
        body: this.sanitizeAutomationBody(req.body, (req as any).user),
      });
      res.json({
        success: true,
        data: result,
        message: `收益闭环已上报飞书：闭环 ${result.summary.closed_count} 笔，超额胜率 ${result.summary.excess_win_rate}%`,
      });
    } catch (error: any) {
      sendError(res, error, '上报推荐交易收益闭环失败');
    }
  };

  // 生成收益归因并写入飞书多维表格
  reportAttribution = async (req: Request, res: Response, _next: NextFunction) => {
    try {
      const user = (req as any).user;
      const result: any = await paperTradingFacade.attributePnl({
        action: 'report',
        user_id: user.id,
        body: this.sanitizeAutomationBody(req.body, (req as any).user),
      });
      res.json({
        success: true,
        data: result,
        message: `收益归因已上报飞书：闭环 ${result.summary.closed_count} 笔，胜率 ${result.summary.win_rate}%`,
      });
    } catch (error: any) {
      sendError(res, error, '上报模拟盘收益归因失败');
    }
  };

  // 生成模拟盘盘前/盘后交易计划
  getTradingPlan = async (req: Request, res: Response, _next: NextFunction) => {
    try {
      const user = (req as any).user;
      const result: any = await paperTradingFacade.applyAutomation({
        action: 'plan',
        user_id: user.id,
        username: user.username || user.nickname,
        // M7 (Batch H): query 也要过 sanitizer, 否则 ?all_portfolios=true 走 query 仍能注入
        body: this.sanitizeAutomationBody(req.query as Record<string, any>, user),
      });
      res.json({
        success: true,
        data: result,
        message: `交易计划生成完成：动作 ${result.summary.action_count} 条，紧急 ${result.summary.urgent_count} 条`,
      });
    } catch (error: any) {
      sendError(res, error, '生成模拟盘交易计划失败');
    }
  };

  // 生成交易计划并写入飞书多维表格
  reportTradingPlan = async (req: Request, res: Response, _next: NextFunction) => {
    try {
      const user = (req as any).user;
      const result: any = await paperTradingFacade.applyAutomation({
        action: 'plan_report',
        user_id: user.id,
        username: user.username || user.nickname,
        body: this.sanitizeAutomationBody(req.body, (req as any).user),
      });
      res.json({
        success: true,
        data: result,
        message: `交易计划已上报飞书：动作 ${result.summary.action_count} 条，紧急 ${result.summary.urgent_count} 条`,
      });
    } catch (error: any) {
      sendError(res, error, '上报模拟盘交易计划失败');
    }
  };

  // 预览或应用订单意图稳定窗口给出的调参建议
  applyOrderIntentTuning = async (req: Request, res: Response, _next: NextFunction) => {
    try {
      const user = (req as any).user;
      // Batch H (2026-06-17, C6): tuning_apply 直接 update 全局 ScheduledTask
      // (PaperTradingTuningApplyService.ts:375 task.update({parameters})) 影响 cron 配置,
      // 必须 admin. 之前任何登录 user 可改 cron 全局参数.
      if (user?.role !== 'admin') {
        return res.status(403).json({
          success: false,
          message: '仅 admin 可应用订单意图调参 (会改全局 cron 参数)',
        });
      }
      const result: any = await paperTradingFacade.applyAutomation({
        action: 'tuning_apply',
        user_id: user.id,
        username: user.username || user.nickname,
        body: this.sanitizeAutomationBody(req.body, (req as any).user),
      });
      res.json({ success: true, data: result, message: result.message });
    } catch (error: any) {
      sendError(res, error, '应用订单意图调参建议失败');
    }
  };

  // 获取订单意图 Canary 小流量调参的观察状态
  getOrderIntentTuningCanary = async (req: Request, res: Response, _next: NextFunction) => {
    try {
      const user = (req as any).user;
      const result: any = await paperTradingFacade.getRiskProfile({
        view: 'tuning_canary',
        user_id: user.id,
        username: user.username || user.nickname,
        query: this.sanitizeAutomationBody(req.query as Record<string, any>, (req as any).user),
      });
      res.json({
        success: true,
        data: result,
        message: result.summary?.conclusion || '订单意图 Canary 状态已刷新',
      });
    } catch (error: any) {
      sendError(res, error, '获取订单意图 Canary 调参状态失败');
    }
  };

  // 获取订单意图调参只读候选
  getOrderIntentTuningCandidates = async (req: Request, res: Response, _next: NextFunction) => {
    try {
      const user = (req as any).user;
      const result: any = await paperTradingFacade.getRiskProfile({
        view: 'tuning_candidates',
        user_id: user.id,
        username: user.username || user.nickname,
        query: this.sanitizeAutomationBody(req.query as Record<string, any>, (req as any).user),
      });
      res.json({
        success: true,
        data: result,
        message: result.summary?.conclusion || '订单意图调参候选已刷新',
      });
    } catch (error: any) {
      sendError(res, error, '获取订单意图调参候选失败');
    }
  };

  // 获取订单意图 Canary 评审快照时间线
  getOrderIntentTuningCanarySnapshots = async (
    req: Request,
    res: Response,
    _next: NextFunction
  ) => {
    try {
      const user = (req as any).user;
      const result: any = await paperTradingFacade.getRiskProfile({
        view: 'tuning_canary_snapshots',
        user_id: user.id,
        username: user.username || user.nickname,
        query: this.sanitizeAutomationBody(req.query as Record<string, any>, (req as any).user),
      });
      res.json({
        success: true,
        data: result,
        message: result.summary?.conclusion || '订单意图 Canary 快照已刷新',
      });
    } catch (error: any) {
      sendError(res, error, '获取订单意图 Canary 评审快照失败');
    }
  };

  // 预览或强确认回滚订单意图 Canary 小流量调参
  rollbackOrderIntentTuningCanary = async (req: Request, res: Response, _next: NextFunction) => {
    try {
      const user = (req as any).user;
      // Batch H (2026-06-17, C6): 同 applyOrderIntentTuning, admin gate.
      if (user?.role !== 'admin') {
        return res.status(403).json({
          success: false,
          message: '仅 admin 可回滚订单意图 Canary 调参',
        });
      }
      const result: any = await paperTradingFacade.applyAutomation({
        action: 'tuning_rollback',
        user_id: user.id,
        username: user.username || user.nickname,
        body: this.sanitizeAutomationBody(req.body, (req as any).user),
      });
      res.json({ success: true, data: result, message: result.message });
    } catch (error: any) {
      sendError(res, error, '回滚订单意图 Canary 调参失败');
    }
  };

  // US-017 — 设置/清除持仓的硬止损价
  setPositionStopLoss = async (req: Request, res: Response, _next: NextFunction) => {
    try {
      const user = (req as any).user;
      const positionId = Number(req.params.id);
      const { stop_loss_price } = req.body as { stop_loss_price: number | null };
      const result: any = await paperTradingFacade.applyAutomation({
        action: 'set_stop_loss',
        user_id: user.id,
        username: user.username || user.nickname,
        body: { position_id: positionId, stop_loss_price },
      });
      res.json({
        success: true,
        data: result,
        message:
          result.stop_loss_price === null
            ? `已清除 ${result.symbol} 的止损价`
            : `${result.symbol} 止损价设为 ¥${result.stop_loss_price}`,
      });
    } catch (error: any) {
      sendError(res, error, '设置持仓止损价失败');
    }
  };

  // US-076 — 设置/清除持仓的硬止盈价
  setPositionTakeProfit = async (req: Request, res: Response, _next: NextFunction) => {
    try {
      const user = (req as any).user;
      const positionId = Number(req.params.id);
      const { take_profit_price } = req.body as { take_profit_price: number | null };
      const result: any = await paperTradingFacade.applyAutomation({
        action: 'set_take_profit',
        user_id: user.id,
        username: user.username || user.nickname,
        body: { position_id: positionId, take_profit_price },
      });
      res.json({
        success: true,
        data: result,
        message:
          result.take_profit_price === null
            ? `已清除 ${result.symbol} 的止盈价`
            : `${result.symbol} 止盈价设为 ¥${result.take_profit_price}`,
      });
    } catch (error: any) {
      sendError(res, error, '设置持仓止盈价失败');
    }
  };

  /**
   * Sprint 29: 读取当前 user 的 PortfolioConstruction 配置 (default off).
   *
   * GET /api/paper-trading/portfolio-construction-config
   */
  getPortfolioConstructionConfig = async (req: Request, res: Response, _next: NextFunction) => {
    try {
      const user = (req as any).user;
      if (!user?.id) return res.status(401).json({ success: false, message: '未登录' });
      const { User } = await import('../../models/User');
      const { normalizePortfolioConstructionConfig, DEFAULT_PORTFOLIO_CONSTRUCTION_CONFIG } =
        await import('../../portfolio/internal/PortfolioConstructionAdapter');
      const userRow = await User.findByPk(user.id);
      if (!userRow) return res.status(404).json({ success: false, message: 'user 不存在' });
      const raw = (userRow.risk_config || {})['portfolio_construction'];
      const normalized = normalizePortfolioConstructionConfig(raw);
      return res.json({
        success: true,
        data: {
          config: normalized,
          is_default: !raw,
          default: DEFAULT_PORTFOLIO_CONSTRUCTION_CONFIG,
        },
      });
    } catch (error: any) {
      sendError(res, error, '读取 PortfolioConstruction 配置失败');
    }
  };

  /**
   * Sprint 29: 更新 user 的 PortfolioConstruction 配置.
   *
   * PUT /api/paper-trading/portfolio-construction-config
   *   body: { mode, method, lookback_days, max_candidates, max_weight, max_industry_weight }
   *   字段都 lenient — invalid 会被 normalize 退到 default.
   */
  updatePortfolioConstructionConfig = async (req: Request, res: Response, _next: NextFunction) => {
    try {
      const user = (req as any).user;
      if (!user?.id) return res.status(401).json({ success: false, message: '未登录' });
      const { User } = await import('../../models/User');
      const { normalizePortfolioConstructionConfig } = await import(
        '../../portfolio/internal/PortfolioConstructionAdapter'
      );
      const userRow = await User.findByPk(user.id);
      if (!userRow) return res.status(404).json({ success: false, message: 'user 不存在' });
      const normalized = normalizePortfolioConstructionConfig(req.body || {});
      const nextRiskConfig = {
        ...(userRow.risk_config || {}),
        portfolio_construction: normalized,
      };
      userRow.risk_config = nextRiskConfig;
      // US-017 lesson: JSONB 改动必须显式 changed()
      userRow.changed('risk_config', true);
      await userRow.save();
      return res.json({
        success: true,
        data: { config: normalized },
        message: `PortfolioConstruction 模式已设为 ${normalized.mode}`,
      });
    } catch (error: any) {
      sendError(res, error, '更新 PortfolioConstruction 配置失败');
    }
  };

  /**
   * Sprint 27: L1-L8 Activation Summary
   *
   * GET /api/paper-trading/activation-summary
   *   ?portfolio_id=<id>   可选; 缺省 = 当前 user 所有 portfolio 聚合
   *   &days=7              可选; 默认 7, 范围 [1, 90]
   *
   * 聚合 paper_trading_order_intents.metadata.l8_activation:
   *   - 总 signal 数 + 三种 outcome (executed/skipped/rejected) 分布
   *   - 8 层每层 reached / blocked / contributed 计数 + block_rate
   *   - Top 5 block reasons (按 layer + reason 分组)
   *   - 最近 10 笔 trade 的逐层激活快照 (用于 dashboard 表)
   *
   * 性能: paper_trading_order_intents 每用户每天 ~50-200 行, 7 天 < 2000 行,
   * 纯 JS reduce 充裕. 后续若日数据量 > 10K 可加 GIN 索引 (metadata->>'l8_activation').
   */
  getActivationSummary = async (req: Request, res: Response, _next: NextFunction) => {
    try {
      const user = (req as any).user;
      if (!user?.id) {
        return res.status(401).json({ success: false, message: '未登录' });
      }

      // 参数解析
      const rawDays = req.query.days ? parseInt(String(req.query.days), 10) : 7;
      const days = Math.max(1, Math.min(90, Number.isFinite(rawDays) ? rawDays : 7));
      const rawPortfolioId = req.query.portfolio_id
        ? parseInt(String(req.query.portfolio_id), 10)
        : null;
      const explicitPortfolioId =
        Number.isFinite(rawPortfolioId as any) && (rawPortfolioId as any) > 0
          ? (rawPortfolioId as number)
          : null;

      // 解析待查 portfolio_id 集合: 显式传 → 单 id; 否则查用户全部 portfolio.
      let portfolioIds: number[] = [];
      if (explicitPortfolioId) {
        // 安全校验: 显式 id 必须属于当前 user
        const owned = await PaperTradingPortfolio.findOne({
          where: { id: explicitPortfolioId, user_id: user.id },
        });
        if (!owned) {
          return res.status(403).json({ success: false, message: '无权访问该模拟盘' });
        }
        portfolioIds = [explicitPortfolioId];
      } else {
        const rows = await PaperTradingPortfolio.findAll({
          where: { user_id: user.id },
          attributes: ['id'],
        });
        portfolioIds = rows.map((r: any) => r.id);
      }

      if (portfolioIds.length === 0) {
        return res.json({
          success: true,
          data: buildEmptyActivationSummary(days),
        });
      }

      // 查 N 天内所有 order intents — 仅取必要字段 (避免拉巨型 metadata 全文).
      const since = new Date(Date.now() - days * 86400_000);
      const sinceDate = since.toISOString().slice(0, 10);
      const intents = await PaperTradingOrderIntent.findAll({
        where: {
          portfolio_id: { [Op.in]: portfolioIds },
          intent_date: { [Op.gte]: sinceDate },
        },
        attributes: [
          'id',
          'portfolio_id',
          'intent_date',
          'symbol',
          'name',
          'status',
          'reason_text',
          'metadata',
          'created_at',
        ],
        order: [['created_at', 'DESC']],
      });

      const summary = aggregateActivationSummary(intents as any[], days);
      return res.json({ success: true, data: summary });
    } catch (error: any) {
      sendError(res, error, '获取 L1-L8 激活汇总失败');
    }
  };
}

// ---------- ActivationSummary 纯函数 helpers (controller scope, 可单测) ----------
// Sprint 32: 改 export 让单测可独立调用 (controller methods 不导出, 但 helper 是纯函数)

export const ACTIVATION_LAYERS = [
  'L1_data',
  'L2_signal',
  'L3_meta',
  'L4_construction',
  'L5_feasibility',
  'L6_risk',
  'L7_governor',
  'L8_reflection',
] as const;
export type ActivationLayerKey = (typeof ACTIVATION_LAYERS)[number];

interface ActivationLayerStat {
  layer: ActivationLayerKey;
  reached: number;
  blocked: number;
  contributed: number;
  /** reached / total */
  reach_rate: number;
  /** blocked / reached (单层"被拦概率"); reached=0 时为 0 */
  block_rate: number;
  /** contributed / reached (单层"真改了概率"); reached=0 时为 0 */
  contribute_rate: number;
}

interface ActivationRecentTrade {
  order_intent_id: number;
  intent_date: string;
  symbol: string;
  name: string | null;
  outcome: 'executed' | 'skipped' | 'rejected' | 'planned' | 'pending' | 'unknown';
  reached_layer: string | null;
  blocked_at: string | null;
  /** 8 个 layer 的简化状态: ✓ reached / ★ contributed / ✗ blocked / — never */
  layer_marks: Record<ActivationLayerKey, '✓' | '★' | '✗' | '—'>;
  /** Sprint 31: 每层的 detail (来自 activation.<layer>.detail) — 前端 tooltip 展示真实特征 */
  layer_details: Record<ActivationLayerKey, Record<string, any> | null>;
  reason_text: string | null;
}

interface ActivationBlockReason {
  layer: ActivationLayerKey;
  reason: string;
  count: number;
}

interface ActivationSummary {
  window_days: number;
  generated_at: string;
  total_signals: number;
  outcomes: { executed: number; skipped: number; rejected: number; other: number };
  layer_stats: ActivationLayerStat[];
  top_block_reasons: ActivationBlockReason[];
  recent_trades: ActivationRecentTrade[];
}

export function buildEmptyActivationSummary(days: number): ActivationSummary {
  return {
    window_days: days,
    generated_at: new Date().toISOString(),
    total_signals: 0,
    outcomes: { executed: 0, skipped: 0, rejected: 0, other: 0 },
    layer_stats: ACTIVATION_LAYERS.map(layer => ({
      layer,
      reached: 0,
      blocked: 0,
      contributed: 0,
      reach_rate: 0,
      block_rate: 0,
      contribute_rate: 0,
    })),
    top_block_reasons: [],
    recent_trades: [],
  };
}

/**
 * 把一个 order_intent.metadata.l8_activation 压成 layer_marks (8 个图标),
 * 用于 recent_trades 行渲染. ★ 优先级 > ✓ > ✗ > —
 */
export function buildLayerMarks(
  activation: any
): Record<ActivationLayerKey, '✓' | '★' | '✗' | '—'> {
  const marks: Record<string, '✓' | '★' | '✗' | '—'> = {};
  for (const layer of ACTIVATION_LAYERS) {
    const snap = activation?.[layer];
    if (!snap || typeof snap !== 'object') {
      marks[layer] = '—';
      continue;
    }
    if (snap.blocked) marks[layer] = '✗';
    else if (snap.contributed) marks[layer] = '★';
    else if (snap.reached) marks[layer] = '✓';
    else marks[layer] = '—';
  }
  return marks as Record<ActivationLayerKey, '✓' | '★' | '✗' | '—'>;
}

/**
 * Sprint 31: 抽 8 层 detail 给前端 tooltip — null 表示该层未参与或无 detail.
 * 字段截短 80 字符防止巨型 metadata 撑爆 payload (主要为 reasons 数组场景).
 */
export function buildLayerDetails(
  activation: any
): Record<ActivationLayerKey, Record<string, any> | null> {
  const out: Record<string, Record<string, any> | null> = {};
  for (const layer of ACTIVATION_LAYERS) {
    const snap = activation?.[layer];
    if (!snap || typeof snap !== 'object' || !snap.detail) {
      out[layer] = null;
      continue;
    }
    // 浅拷 + 字符串截断 80 字符防巨型 payload
    const safeDetail: Record<string, any> = {};
    for (const [k, v] of Object.entries(snap.detail)) {
      if (typeof v === 'string' && v.length > 80) {
        safeDetail[k] = v.slice(0, 80) + '...';
      } else if (Array.isArray(v) && v.length > 5) {
        safeDetail[k] = [...v.slice(0, 5), `...${v.length - 5} more`];
      } else {
        safeDetail[k] = v;
      }
    }
    out[layer] = safeDetail;
  }
  return out as Record<ActivationLayerKey, Record<string, any> | null>;
}

/**
 * 核心聚合函数 — 纯函数; intents 来自 PaperTradingOrderIntent.findAll(),
 * 但仅依赖 plain object 字段, 可在测试里传 mock 数组.
 */
export function aggregateActivationSummary(intents: any[], days: number): ActivationSummary {
  const layerStats: Record<
    ActivationLayerKey,
    { reached: number; blocked: number; contributed: number }
  > = {
    L1_data: { reached: 0, blocked: 0, contributed: 0 },
    L2_signal: { reached: 0, blocked: 0, contributed: 0 },
    L3_meta: { reached: 0, blocked: 0, contributed: 0 },
    L4_construction: { reached: 0, blocked: 0, contributed: 0 },
    L5_feasibility: { reached: 0, blocked: 0, contributed: 0 },
    L6_risk: { reached: 0, blocked: 0, contributed: 0 },
    L7_governor: { reached: 0, blocked: 0, contributed: 0 },
    L8_reflection: { reached: 0, blocked: 0, contributed: 0 },
  };
  const outcomes = { executed: 0, skipped: 0, rejected: 0, other: 0 };
  // (layer, reasonKey) → count + 原文 reason_text 样本
  const blockReasonMap = new Map<
    string,
    { layer: ActivationLayerKey; reason: string; count: number }
  >();

  for (const intent of intents) {
    const md = intent?.metadata || {};
    const activation = md.l8_activation;
    const status = String(intent?.status || '').toLowerCase();

    // outcome 计数 — 优先用 activation.final_outcome (写入时设置), fallback intent.status
    const finalOutcome = activation?.final_outcome || status;
    if (finalOutcome === 'executed') outcomes.executed++;
    else if (finalOutcome === 'skipped') outcomes.skipped++;
    else if (finalOutcome === 'rejected') outcomes.rejected++;
    else outcomes.other++;

    if (!activation || typeof activation !== 'object') continue;

    for (const layer of ACTIVATION_LAYERS) {
      const snap = activation[layer];
      if (!snap || typeof snap !== 'object') continue;
      if (snap.reached) layerStats[layer].reached++;
      if (snap.blocked) layerStats[layer].blocked++;
      if (snap.contributed) layerStats[layer].contributed++;
    }

    // block reasons — 用 blocked_at + reason_text 截短 80 字符做聚合 key
    if (activation.blocked_at) {
      const blockedLayer = activation.blocked_at as ActivationLayerKey;
      const reasonText = String(intent?.reason_text || '未知原因').slice(0, 80);
      const key = `${blockedLayer}::${reasonText}`;
      const existing = blockReasonMap.get(key);
      if (existing) {
        existing.count++;
      } else {
        blockReasonMap.set(key, { layer: blockedLayer, reason: reasonText, count: 1 });
      }
    }
  }

  const total = intents.length;
  const layer_stats: ActivationLayerStat[] = ACTIVATION_LAYERS.map(layer => {
    const s = layerStats[layer];
    return {
      layer,
      reached: s.reached,
      blocked: s.blocked,
      contributed: s.contributed,
      reach_rate: total > 0 ? Math.round((s.reached / total) * 10000) / 10000 : 0,
      block_rate: s.reached > 0 ? Math.round((s.blocked / s.reached) * 10000) / 10000 : 0,
      contribute_rate: s.reached > 0 ? Math.round((s.contributed / s.reached) * 10000) / 10000 : 0,
    };
  });

  const top_block_reasons: ActivationBlockReason[] = Array.from(blockReasonMap.values())
    .sort((a, b) => b.count - a.count || a.layer.localeCompare(b.layer))
    .slice(0, 5);

  // recent_trades — 最近 10 笔 (intents 已按 created_at DESC sort)
  const recent_trades: ActivationRecentTrade[] = intents.slice(0, 10).map((intent: any) => {
    const md = intent?.metadata || {};
    const activation = md.l8_activation || {};
    const status = String(intent?.status || '').toLowerCase();
    const finalOutcome = (activation.final_outcome || status) as ActivationRecentTrade['outcome'];
    return {
      order_intent_id: Number(intent.id),
      intent_date: String(intent.intent_date || ''),
      symbol: String(intent.symbol || ''),
      name: intent.name || null,
      outcome: ['executed', 'skipped', 'rejected', 'planned'].includes(finalOutcome)
        ? finalOutcome
        : 'unknown',
      reached_layer: activation.reached_layer || null,
      blocked_at: activation.blocked_at || null,
      layer_marks: buildLayerMarks(activation),
      layer_details: buildLayerDetails(activation),
      reason_text: intent.reason_text ? String(intent.reason_text).slice(0, 200) : null,
    };
  });

  return {
    window_days: days,
    generated_at: new Date().toISOString(),
    total_signals: total,
    outcomes,
    layer_stats,
    top_block_reasons,
    recent_trades,
  };
}

export const paperTradingController = new PaperTradingController();
