import { Request, Response, NextFunction } from 'express';
import {
  paperTradingFacade,
  AUTONOMOUS_PORTFOLIO_NAME,
  DEFAULT_AUTONOMOUS_INITIAL_CAPITAL,
  QUANT_ONLY_PORTFOLIO_NAME,
} from '../../portfolio/PaperTradingFacade';
import { logger } from '../../utils/logger';

// AUTONOMOUS_PORTFOLIO_NAME / DEFAULT_AUTONOMOUS_INITIAL_CAPITAL / QUANT_ONLY_PORTFOLIO_NAME
// are re-exported from the facade for legacy reasons (some routes/tests may still
// reference them directly).  All actual operations go through `paperTradingFacade`.
export { AUTONOMOUS_PORTFOLIO_NAME, DEFAULT_AUTONOMOUS_INITIAL_CAPITAL, QUANT_ONLY_PORTFOLIO_NAME };

function sendError(res: Response, error: any, fallbackMessage: string) {
  logger.error(fallbackMessage, error);
  const status = error?.statusCode || 500;
  return res.status(status).json({ success: false, message: error?.message || fallbackMessage });
}

export class PaperTradingController {
  // 获取当前用户的模拟盘及持仓
  getPortfolio = async (req: Request, res: Response, _next: NextFunction) => {
    try {
      const user = (req as any).user;
      const data = await paperTradingFacade.getPortfolio({
        view: 'basic',
        user_id: user.id,
        username: user.nickname || user.username,
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
      const { symbol, direction, quantity } = req.body;
      const result = await paperTradingFacade.placeOrder({
        user_id: user.id,
        symbol,
        direction,
        quantity,
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
      const data = await paperTradingFacade.getDailySnapshot({
        action: 'trades',
        user_id: user.id,
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
      const data = await paperTradingFacade.getDailySnapshot({
        action: 'list',
        user_id: user.id,
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
        body: req.body,
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
        body: req.body,
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
      const snapshot = await paperTradingFacade.getDailySnapshot({
        action: 'refresh',
        user_id: user.id,
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
        body: req.body,
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
        query: req.query as Record<string, any>,
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
        query: req.query as Record<string, any>,
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
        query: req.query as Record<string, any>,
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
        body: req.body,
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
        body: req.body,
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
        query: req.query as Record<string, any>,
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
        query: req.query as Record<string, any>,
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
        query: req.query as Record<string, any>,
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
        query: req.query as Record<string, any>,
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
        query: req.query as Record<string, any>,
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
        body: req.body,
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
        query: req.query as Record<string, any>,
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
        query: req.query as Record<string, any>,
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
        body: req.body,
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
        body: req.body,
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
        body: req.body,
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
        body: req.query as Record<string, any>,
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
        body: req.body,
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
      const result: any = await paperTradingFacade.applyAutomation({
        action: 'tuning_apply',
        user_id: user.id,
        username: user.username || user.nickname,
        body: req.body,
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
        query: req.query as Record<string, any>,
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
        query: req.query as Record<string, any>,
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
        query: req.query as Record<string, any>,
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
      const result: any = await paperTradingFacade.applyAutomation({
        action: 'tuning_rollback',
        user_id: user.id,
        username: user.username || user.nickname,
        body: req.body,
      });
      res.json({ success: true, data: result, message: result.message });
    } catch (error: any) {
      sendError(res, error, '回滚订单意图 Canary 调参失败');
    }
  };
}

export const paperTradingController = new PaperTradingController();
