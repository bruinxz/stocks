import { Request, Response } from 'express';
import { aiInvestmentSignalService } from '../../services/AIInvestmentSignalService';
import { feishuTaskReportService } from '../../services/FeishuTaskReportService';
import { logger } from '../../utils/logger';

export class AISignalController {
  private parseHorizons(value: any): number[] | undefined {
    if (!value) return undefined;
    const raw = Array.isArray(value) ? value : String(value).split(',');
    const horizons = raw
      .map(item => Number(String(item).replace(/[^\d]/g, '')))
      .filter(item => Number.isFinite(item) && item > 0);
    return horizons.length > 0 ? horizons : undefined;
  }

  private buildDiagnosisOptions(source: any) {
    return {
      limit: source?.limit ? Number(source.limit) : 200,
      source_type: source?.source_type,
      agent_session: source?.agent_session,
      task_label: source?.task_label,
      symbol: source?.symbol,
      decision: source?.decision,
      start_date: source?.start_date,
      end_date: source?.end_date,
      horizons: this.parseHorizons(source?.horizons),
      data_source: source?.data_source,
      lookback_days: source?.lookback_days ? Number(source.lookback_days) : undefined,
      sync_concurrency: source?.sync_concurrency ? Number(source.sync_concurrency) : undefined,
    };
  }

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

  diagnoseVerification = async (req: Request, res: Response) => {
    try {
      const result = await aiInvestmentSignalService.diagnoseSignalVerification(
        this.buildDiagnosisOptions(req.query)
      );
      res.json({ success: true, data: result });
    } catch (error: any) {
      logger.error('诊断 AI 信号收益验证失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  };

  repairAndVerifySignals = async (req: Request, res: Response) => {
    try {
      const result = await aiInvestmentSignalService.repairAndVerifySignals({
        ...this.buildDiagnosisOptions(req.body),
        auto_sync_missing: req.body?.auto_sync_missing !== false,
      });
      if (req.body?.report_to_feishu === true) {
        await feishuTaskReportService.reportSignalVerificationRepair(result, {
          record_type: req.body?.record_type || '信号收益验证修复',
        });
      }
      res.json({ success: true, data: result });
    } catch (error: any) {
      logger.error('修复并验证 AI 信号收益失败:', error);
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

  getSignalQualityReport = async (req: Request, res: Response) => {
    try {
      const report = await aiInvestmentSignalService.getSignalQualityReport({
        source_type: req.query?.source_type as string,
        agent_session: req.query?.agent_session as string,
        task_label: req.query?.task_label as string,
        symbol: req.query?.symbol as string,
        decision: req.query?.decision as string,
        start_date: req.query?.start_date as string,
        end_date: req.query?.end_date as string,
        horizon: (req.query?.horizon as string) || '5d',
        lookback_days: req.query?.lookback_days ? Number(req.query.lookback_days) : 30,
        min_samples: req.query?.min_samples ? Number(req.query.min_samples) : 5,
        limit: req.query?.limit ? Number(req.query.limit) : 5000,
        auto_repair_missing_data: req.query?.auto_repair_missing_data === 'true',
        data_source: req.query?.data_source as string,
        repair_lookback_days: req.query?.repair_lookback_days
          ? Number(req.query.repair_lookback_days)
          : undefined,
        sync_concurrency: req.query?.sync_concurrency
          ? Number(req.query.sync_concurrency)
          : undefined,
      });
      res.json({ success: true, data: report });
    } catch (error: any) {
      logger.error('获取信号质量日报失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  };

  reportSignalQualityDaily = async (req: Request, res: Response) => {
    try {
      const report = await aiInvestmentSignalService.getSignalQualityReport({
        source_type: req.body?.source_type,
        agent_session: req.body?.agent_session,
        task_label: req.body?.task_label,
        symbol: req.body?.symbol,
        decision: req.body?.decision,
        start_date: req.body?.start_date,
        end_date: req.body?.end_date,
        horizon: req.body?.horizon || '5d',
        lookback_days: req.body?.lookback_days ? Number(req.body.lookback_days) : 30,
        min_samples: req.body?.min_samples ? Number(req.body.min_samples) : 5,
        limit: req.body?.limit ? Number(req.body.limit) : 5000,
        verify_before_report: req.body?.verify_before_report === true,
        auto_repair_missing_data: req.body?.auto_repair_missing_data === true,
        data_source: req.body?.data_source,
        repair_lookback_days: req.body?.repair_lookback_days
          ? Number(req.body.repair_lookback_days)
          : undefined,
        sync_concurrency: req.body?.sync_concurrency
          ? Number(req.body.sync_concurrency)
          : undefined,
        report_to_feishu: req.body?.report_to_feishu !== false,
        record_type: req.body?.record_type || '信号质量日报',
      });
      res.json({ success: true, data: report, message: '信号质量日报已生成' });
    } catch (error: any) {
      logger.error('生成信号质量日报失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  };
}

export const aiSignalController = new AISignalController();
