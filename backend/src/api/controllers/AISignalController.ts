import { Request, Response } from 'express';
import { aiInvestmentSignalService } from '../../services/AIInvestmentSignalService';
import { logger } from '../../utils/logger';

export class AISignalController {
  syncFromScreeners = async (req: Request, res: Response) => {
    try {
      const result = await aiInvestmentSignalService.syncFromDailyScreeners();
      const verification =
        req.query.verify !== 'false'
          ? await aiInvestmentSignalService.verifySignals({ limit: 200 })
          : null;
      res.json({ success: true, data: { sync: result, verification } });
    } catch (error: any) {
      logger.error('同步 AI 信号失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  };

  listSignals = async (req: Request, res: Response) => {
    try {
      const {
        symbol,
        decision,
        source_type,
        start_date,
        end_date,
        limit = '50',
        offset = '0',
      } = req.query;
      const result = await aiInvestmentSignalService.listSignals({
        symbol: symbol as string,
        decision: decision as string,
        source_type: source_type as string,
        start_date: start_date as string,
        end_date: end_date as string,
        limit: parseInt(limit as string, 10),
        offset: parseInt(offset as string, 10),
      });
      res.json({
        success: true,
        data: {
          signals: result.rows,
          pagination: {
            total: result.count,
            limit: result.limit,
            offset: result.offset,
          },
        },
      });
    } catch (error: any) {
      logger.error('获取 AI 信号列表失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  };

  getSignalStats = async (req: Request, res: Response) => {
    try {
      const { symbol, decision, source_type, start_date, end_date } = req.query;
      const stats = await aiInvestmentSignalService.getSignalStats({
        symbol: symbol as string,
        decision: decision as string,
        source_type: source_type as string,
        start_date: start_date as string,
        end_date: end_date as string,
      });
      res.json({ success: true, data: stats });
    } catch (error: any) {
      logger.error('获取 AI 信号统计失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  };

  getPerformanceDashboard = async (req: Request, res: Response) => {
    try {
      const {
        symbol,
        decision,
        source_type,
        agent_session,
        task_label,
        start_date,
        end_date,
        horizon = '5d',
        limit = '1000',
      } = req.query;
      const dashboard = await aiInvestmentSignalService.getPerformanceDashboard({
        symbol: symbol as string,
        decision: decision as string,
        source_type: source_type as string,
        agent_session: agent_session as string,
        task_label: task_label as string,
        start_date: start_date as string,
        end_date: end_date as string,
        horizon: horizon as string,
        limit: Number(limit),
      });
      res.json({ success: true, data: dashboard });
    } catch (error: any) {
      logger.error('获取推荐绩效看板失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  };

  verifySignals = async (req: Request, res: Response) => {
    try {
      const limit = req.body?.limit ? Number(req.body.limit) : 200;
      const result = await aiInvestmentSignalService.verifySignals({
        limit,
        source_type: req.body?.source_type,
        agent_session: req.body?.agent_session,
        task_label: req.body?.task_label,
        symbol: req.body?.symbol,
        decision: req.body?.decision,
        start_date: req.body?.start_date,
        end_date: req.body?.end_date,
        report_to_feishu: req.body?.report_to_feishu === true,
      });
      res.json({ success: true, data: result });
    } catch (error: any) {
      logger.error('验证 AI 信号收益失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  };

  refreshPerformance = async (req: Request, res: Response) => {
    try {
      const limit = req.body?.limit ? Number(req.body.limit) : 500;
      const result = await aiInvestmentSignalService.refreshPerformance({
        limit,
        source_type: req.body?.source_type,
        agent_session: req.body?.agent_session,
        task_label: req.body?.task_label,
        symbol: req.body?.symbol,
        decision: req.body?.decision,
        start_date: req.body?.start_date,
        end_date: req.body?.end_date,
        horizon: req.body?.horizon,
        record_type: req.body?.record_type,
        report_to_feishu: req.body?.report_to_feishu !== false,
      });
      res.json({ success: true, data: result });
    } catch (error: any) {
      logger.error('刷新推荐绩效失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  };
}

export const aiSignalController = new AISignalController();
