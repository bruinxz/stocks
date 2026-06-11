import { Response } from 'express';
import { AuthenticatedRequest } from '../../middlewares/auth';
import { liveTradingService } from '../services/LiveTradingService';
import { killSwitchService } from '../services/KillSwitchService';
import { logger } from '../../utils/logger';

class LiveTradingController {
  async getReadiness(req: AuthenticatedRequest, res: Response) {
    try {
      const data = await liveTradingService.getReadiness(req.user?.id);
      res.json({ success: true, data, message: data.conclusion });
    } catch (error: any) {
      logger.error('获取实盘能力状态失败:', error);
      res.status(500).json({ success: false, message: error.message || '获取实盘能力状态失败' });
    }
  }

  async getOverview(req: AuthenticatedRequest, res: Response) {
    try {
      const data = await liveTradingService.getOverview(Number(req.user?.id), {
        account_role: typeof req.query.account_role === 'string' ? req.query.account_role : undefined,
      });
      res.json({ success: true, data, message: data.summary.conclusion });
    } catch (error: any) {
      logger.error('获取实盘总览失败:', error);
      res.status(500).json({ success: false, message: error.message || '获取实盘总览失败' });
    }
  }

  async getReconciliation(req: AuthenticatedRequest, res: Response) {
    try {
      const data = await liveTradingService.getReconciliation(Number(req.user?.id), {
        account_role: typeof req.query.account_role === 'string' ? req.query.account_role : undefined,
      });
      res.json({ success: true, data, message: data.summary.conclusion });
    } catch (error: any) {
      logger.error('获取实盘只读对账失败:', error);
      res.status(500).json({ success: false, message: error.message || '获取实盘只读对账失败' });
    }
  }

  async getSafety(req: AuthenticatedRequest, res: Response) {
    try {
      const data = liveTradingService.getSafetyStatus();
      res.json({ success: true, data, message: data.can_submit_orders ? '实盘提交能力处于受限启用状态' : '实盘提交能力默认关闭' });
    } catch (error: any) {
      logger.error('获取实盘安全边界失败:', error);
      res.status(500).json({ success: false, message: error.message || '获取实盘安全边界失败' });
    }
  }

  async getDraftCandidates(req: AuthenticatedRequest, res: Response) {
    try {
      const data = await liveTradingService.getDraftCandidates(Number(req.user?.id), {
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        account_role: typeof req.query.account_role === 'string' ? req.query.account_role : undefined,
      });
      res.json({ success: true, data, message: data.summary.conclusion });
    } catch (error: any) {
      logger.error('获取实盘草稿候选失败:', error);
      res.status(500).json({ success: false, message: error.message || '获取实盘草稿候选失败' });
    }
  }

  async listDrafts(req: AuthenticatedRequest, res: Response) {
    try {
      const data = await liveTradingService.listDrafts(Number(req.user?.id), {
        status: req.query.status as string,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
      });
      res.json({ success: true, data });
    } catch (error: any) {
      logger.error('获取实盘订单草稿失败:', error);
      res.status(500).json({ success: false, message: error.message || '获取实盘订单草稿失败' });
    }
  }

  async createDraft(req: AuthenticatedRequest, res: Response) {
    try {
      const body = req.body || {};
      const data = await liveTradingService.createDraft(Number(req.user?.id), {
        ...body,
        // 显式允许 account_role 由前端 query 或 body 指定（默认 main）
        account_role:
          typeof body.account_role === 'string'
            ? body.account_role
            : typeof req.query.account_role === 'string'
              ? req.query.account_role
              : undefined,
      });
      res.json({ success: true, data, message: data.risk_check?.conclusion || '实盘订单草稿已创建' });
    } catch (error: any) {
      logger.error('创建实盘订单草稿失败:', error);
      res.status(500).json({ success: false, message: error.message || '创建实盘订单草稿失败' });
    }
  }

  async createDraftFromCandidate(req: AuthenticatedRequest, res: Response) {
    try {
      const body = req.body || {};
      const data = await liveTradingService.createDraftFromCandidate(Number(req.user?.id), {
        ...body,
        account_role:
          typeof body.account_role === 'string'
            ? body.account_role
            : typeof req.query.account_role === 'string'
              ? req.query.account_role
              : undefined,
      });
      res.json({ success: true, data, message: data.risk_check?.conclusion || '策略候选已生成实盘订单草稿' });
    } catch (error: any) {
      logger.warn('策略候选生成实盘草稿被阻断:', error?.message || error);
      res.status(400).json({ success: false, message: error.message || '策略候选生成实盘草稿失败' });
    }
  }

  async runShadowAutopilot(req: AuthenticatedRequest, res: Response) {
    try {
      const data = await liveTradingService.runShadowAutopilot(Number(req.user?.id), {
        limit: req.body?.limit ? Number(req.body.limit) : undefined,
        source: req.body?.source,
        dry_run: req.body?.dry_run === true,
        account_role: typeof req.body?.account_role === 'string' ? req.body.account_role : undefined,
      });
      res.json({ success: true, data, message: data.summary.conclusion });
    } catch (error: any) {
      logger.warn('无人影子执行被阻断:', error?.message || error);
      res.status(400).json({ success: false, message: error.message || '无人影子执行失败' });
    }
  }

  async runDraftShadowExecution(req: AuthenticatedRequest, res: Response) {
    try {
      const data = await liveTradingService.markDraftShadowExecuted(
        Number(req.user?.id),
        Number(req.params.id),
        req.body || {}
      );
      res.json({ success: true, data, message: '影子执行已记录，未提交真实券商委托' });
    } catch (error: any) {
      logger.warn('订单草稿影子执行被阻断:', error?.message || error);
      res.status(400).json({ success: false, message: error.message || '订单草稿影子执行失败' });
    }
  }

  async getShadowOutcomes(req: AuthenticatedRequest, res: Response) {
    try {
      const horizons = req.query.horizons
        ? String(req.query.horizons)
            .split(',')
            .map(item => Number(item.trim()))
            .filter(Number.isFinite)
        : undefined;
      const data = await liveTradingService.getShadowAutopilotOutcomes(Number(req.user?.id), {
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        horizons,
      });
      res.json({ success: true, data, message: data.summary.conclusion });
    } catch (error: any) {
      logger.error('获取影子执行收益闭环失败:', error);
      res.status(500).json({ success: false, message: error.message || '获取影子执行收益闭环失败' });
    }
  }

  async getShadowTrend(req: AuthenticatedRequest, res: Response) {
    try {
      const data = await liveTradingService.getShadowAutopilotTrend(Number(req.user?.id), {
        limit: req.query.limit ? Number(req.query.limit) : undefined,
      });
      res.json({ success: true, data, message: data.summary.conclusion });
    } catch (error: any) {
      logger.error('获取影子执行趋势失败:', error);
      res.status(500).json({ success: false, message: error.message || '获取影子执行趋势失败' });
    }
  }

  async getShadowBudgetAttribution(req: AuthenticatedRequest, res: Response) {
    try {
      const data = await liveTradingService.getShadowBudgetAttribution(Number(req.user?.id), {
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        lookback_days: req.query.lookback_days ? Number(req.query.lookback_days) : undefined,
        window_days: req.query.window_days ? Number(req.query.window_days) : undefined,
      });
      res.json({ success: true, data, message: data.summary.conclusion });
    } catch (error: any) {
      logger.error('获取影子预算效果归因失败:', error);
      res.status(500).json({ success: false, message: error.message || '获取影子预算效果归因失败' });
    }
  }

  async approveDraft(req: AuthenticatedRequest, res: Response) {
    try {
      const data = await liveTradingService.approveDraft(Number(req.user?.id), Number(req.params.id), req.body || {});
      res.json({ success: true, data, message: '实盘订单草稿已确认并提交券商' });
    } catch (error: any) {
      logger.warn('确认实盘订单草稿被阻断:', error?.message || error);
      res.status(400).json({ success: false, message: error.message || '确认实盘订单草稿失败' });
    }
  }

  async rejectDraft(req: AuthenticatedRequest, res: Response) {
    try {
      const data = await liveTradingService.rejectDraft(Number(req.user?.id), Number(req.params.id), req.body?.reason);
      res.json({ success: true, data, message: '实盘订单草稿已拒绝' });
    } catch (error: any) {
      logger.error('拒绝实盘订单草稿失败:', error);
      res.status(500).json({ success: false, message: error.message || '拒绝实盘订单草稿失败' });
    }
  }

  async syncReadonly(req: AuthenticatedRequest, res: Response) {
    try {
      const data = await liveTradingService.syncReadonlyAccount(Number(req.user?.id), req.body || {});
      res.json({ success: true, data, message: '实盘只读账户同步完成' });
    } catch (error: any) {
      logger.warn('实盘只读账户同步被阻断:', error?.message || error);
      res.status(400).json({ success: false, message: error.message || '实盘只读账户同步失败' });
    }
  }

  async getAuditLogs(req: AuthenticatedRequest, res: Response) {
    try {
      const data = await liveTradingService.getAuditLogs(Number(req.user?.id), req.query.limit ? Number(req.query.limit) : 50);
      res.json({ success: true, data });
    } catch (error: any) {
      logger.error('获取实盘审计日志失败:', error);
      res.status(500).json({ success: false, message: error.message || '获取实盘审计日志失败' });
    }
  }

  async getQuotes(req: AuthenticatedRequest, res: Response) {
    try {
      const symbols = String(req.query.symbols || req.query.symbol || '')
        .split(',')
        .map(item => item.trim())
        .filter(Boolean);
      const data = await liveTradingService.getQuotes(symbols);
      res.json({ success: true, data });
    } catch (error: any) {
      logger.error('获取实盘行情快照失败:', error);
      res.status(500).json({ success: false, message: error.message || '获取实盘行情快照失败' });
    }
  }

  async getKillSwitch(req: AuthenticatedRequest, res: Response) {
    try {
      const active = await killSwitchService.getActiveState();
      res.json({
        success: true,
        data: { active: Boolean(active), state: active },
        message: active ? `服务端 kill switch 处于熔断 (${active.reason_code})` : '服务端 kill switch 未触发',
      });
    } catch (error: any) {
      logger.error('查询 kill switch 状态失败:', error);
      res.status(500).json({ success: false, message: error.message || '查询 kill switch 状态失败' });
    }
  }

  async triggerKillSwitch(req: AuthenticatedRequest, res: Response) {
    try {
      const body = req.body || {};
      const reasonDetail = String(body.reason_detail || body.reason || '').trim();
      if (!reasonDetail) {
        return res.status(400).json({ success: false, message: '缺少触发原因 reason_detail' });
      }
      const result = await killSwitchService.trigger({
        reason_code: String(body.reason_code || 'manual'),
        reason_detail: reasonDetail,
        source: 'manual',
        triggered_by: req.user?.id ? `user:${req.user.id}` : 'unknown',
        metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : {},
      });
      res.json({
        success: true,
        data: result,
        message: result.created ? 'Kill switch 已触发' : 'Kill switch 已处于熔断，已追加触发记录',
      });
    } catch (error: any) {
      logger.error('触发 kill switch 失败:', error);
      res.status(500).json({ success: false, message: error.message || '触发 kill switch 失败' });
    }
  }

  async resolveKillSwitch(req: AuthenticatedRequest, res: Response) {
    try {
      const body = req.body || {};
      const resolved = await killSwitchService.resolve({
        resolved_by: req.user?.id ? `user:${req.user.id}` : 'unknown',
        note: typeof body.note === 'string' ? body.note : undefined,
      });
      if (!resolved) {
        return res.json({ success: true, data: { resolved: false }, message: 'Kill switch 当前未处于熔断，无需解除' });
      }
      res.json({ success: true, data: { resolved: true, last_state: resolved }, message: 'Kill switch 已解除' });
    } catch (error: any) {
      logger.error('解除 kill switch 失败:', error);
      res.status(500).json({ success: false, message: error.message || '解除 kill switch 失败' });
    }
  }

  async cancelOrder(req: AuthenticatedRequest, res: Response) {
    try {
      const orderId = Number(req.params.id);
      if (!Number.isFinite(orderId)) {
        return res.status(400).json({ success: false, message: 'order id 不合法' });
      }
      const body = req.body || {};
      const data = await liveTradingService.requestOrderCancellation(Number(req.user?.id), orderId, {
        reason: typeof body.reason === 'string' ? body.reason : undefined,
        account_id: body.account_id ? Number(body.account_id) : undefined,
      });
      res.json({ success: true, data, message: '撤单已入队，等待本地桥执行' });
    } catch (error: any) {
      logger.error('撤单失败:', error);
      res.status(400).json({ success: false, message: error.message || '撤单失败' });
    }
  }

  /** 列出当前账户活跃实盘委托，前端撤单 UI 使用 */
  async listLiveOrders(req: AuthenticatedRequest, res: Response) {
    try {
      const data = await liveTradingService.listLiveOrders(Number(req.user?.id), {
        account_role: typeof req.query.account_role === 'string' ? req.query.account_role : undefined,
        active_only: req.query.active_only !== 'false',
        limit: req.query.limit ? Number(req.query.limit) : undefined,
      });
      res.json({ success: true, data });
    } catch (error: any) {
      logger.error('查询实盘委托列表失败:', error);
      res.status(500).json({ success: false, message: error.message || '查询实盘委托列表失败' });
    }
  }
}

export const liveTradingController = new LiveTradingController();
