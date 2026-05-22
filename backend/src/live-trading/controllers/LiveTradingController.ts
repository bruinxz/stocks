import { Response } from 'express';
import { AuthenticatedRequest } from '../../middlewares/auth';
import { liveTradingService } from '../services/LiveTradingService';
import { liveTradingSafetyService } from '../services/LiveTradingSafetyService';
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
      const data = await liveTradingService.getOverview(Number(req.user?.id));
      res.json({ success: true, data, message: data.summary.conclusion });
    } catch (error: any) {
      logger.error('获取实盘总览失败:', error);
      res.status(500).json({ success: false, message: error.message || '获取实盘总览失败' });
    }
  }

  async getReconciliation(req: AuthenticatedRequest, res: Response) {
    try {
      const data = await liveTradingService.getReconciliation(Number(req.user?.id));
      res.json({ success: true, data, message: data.summary.conclusion });
    } catch (error: any) {
      logger.error('获取实盘只读对账失败:', error);
      res.status(500).json({ success: false, message: error.message || '获取实盘只读对账失败' });
    }
  }

  async getSafety(req: AuthenticatedRequest, res: Response) {
    try {
      const data = liveTradingSafetyService.getStatus();
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
      const data = await liveTradingService.createDraft(Number(req.user?.id), req.body || {});
      res.json({ success: true, data, message: data.risk_check?.conclusion || '实盘订单草稿已创建' });
    } catch (error: any) {
      logger.error('创建实盘订单草稿失败:', error);
      res.status(500).json({ success: false, message: error.message || '创建实盘订单草稿失败' });
    }
  }

  async createDraftFromCandidate(req: AuthenticatedRequest, res: Response) {
    try {
      const data = await liveTradingService.createDraftFromCandidate(Number(req.user?.id), req.body || {});
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
}

export const liveTradingController = new LiveTradingController();
