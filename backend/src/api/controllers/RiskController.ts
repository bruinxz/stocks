import { Request, Response, NextFunction } from 'express';
import { positionLimitGuard } from '../../portfolio/risk/PositionLimitGuard';
import { trailingStopGuard } from '../../portfolio/risk/TrailingStopGuard';
import { drawdownCircuitBreaker } from '../../portfolio/risk/DrawdownCircuitBreaker';
import { marketRegimeAlertService } from '../../portfolio/risk/MarketRegimeAlertService';
import { perStockStopLossGuard } from '../../portfolio/risk/PerStockStopLossGuard';
import { industryConcentrationGuard } from '../../portfolio/risk/IndustryConcentrationGuard';
import { blackSwanWatchdog } from '../../portfolio/risk/BlackSwanWatchdog';
import { morningRiskCheckupService } from '../../portfolio/risk/MorningRiskCheckupService';
import { sizingPolicyService } from '../../portfolio/risk/SizingPolicyService';
import { logger } from '../../utils/logger';

/**
 * RiskController — US-047 (position limits) + US-048 (trailing stop)
 *   + US-049 (drawdown circuit breaker) + US-050 (market regime alert)
 *   + US-051 (per-stock stop loss) + US-052 (industry concentration)
 *   + US-053 (black-swan watchdog) + US-054 (morning risk checkup)
 *
 * Exposes the pre-trade risk-policy configuration to the client.  Mounted at
 * `/api/risk/*` from `index.ts`.
 *
 * Why not folded into `RiskAlertController`?  That controller is concerned
 * with consuming/clearing already-emitted alerts (the bell view).  Position
 * limits + trailing stop + drawdown breaker + market regime + per-stock stop
 * loss + industry concentration + black-swan watchdog + morning checkup are
 * separate, *pre*-trade policy surfaces — keeping them in their own controller
 * makes the route map (`/api/risk-alerts` vs `/api/risk`) easy to scan.
 */
export class RiskController {
  /**
   * GET /api/risk/position-limits
   * Returns the user's effective position-limit config (defaults if the
   * user has never customized it).
   */
  async getPositionLimits(req: Request, res: Response, _next: NextFunction) {
    try {
      const user_id = (req as any).user.id;
      const config = await positionLimitGuard.getConfig(user_id);
      res.json({ success: true, data: config });
    } catch (error: any) {
      logger.error('获取仓位限制配置失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  /**
   * PUT /api/risk/position-limits
   * Persist user's new position-limit thresholds.  Input is normalized
   * (`normalizePositionLimitsConfig`) so invalid fields silently revert to
   * defaults rather than poisoning the persistent state.
   */
  async updatePositionLimits(req: Request, res: Response, _next: NextFunction) {
    try {
      const user_id = (req as any).user.id;
      const saved = await positionLimitGuard.updateConfig(user_id, req.body || {});
      res.json({ success: true, data: saved, message: '仓位限制已保存' });
    } catch (error: any) {
      logger.error('更新仓位限制配置失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  /**
   * GET /api/risk/trailing-stop  (US-048)
   * Return the user's effective trailing-stop config (defaults: enabled=true,
   * pct=0.10 when not customized).
   */
  async getTrailingStop(req: Request, res: Response, _next: NextFunction) {
    try {
      const user_id = (req as any).user.id;
      const config = await trailingStopGuard.getConfig(user_id);
      res.json({ success: true, data: config });
    } catch (error: any) {
      logger.error('获取追踪止损配置失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  /**
   * PUT /api/risk/trailing-stop  (US-048)
   * Persist user's trailing-stop config — input normalized
   * (`normalizeTrailingStopConfig`) so invalid `pct`/`enabled` silently
   * revert to defaults instead of corrupting `User.risk_config`.
   */
  async updateTrailingStop(req: Request, res: Response, _next: NextFunction) {
    try {
      const user_id = (req as any).user.id;
      const saved = await trailingStopGuard.updateConfig(user_id, req.body || {});
      res.json({ success: true, data: saved, message: '追踪止损配置已保存' });
    } catch (error: any) {
      logger.error('更新追踪止损配置失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  /**
   * GET /api/risk/drawdown-breaker  (US-049)
   * Return the user's effective drawdown-circuit-breaker config (defaults:
   * enabled=true, level1=0.10 / level2=0.15 / level3=0.20, pause_ms=24h
   * when not customized).
   */
  async getDrawdownBreaker(req: Request, res: Response, _next: NextFunction) {
    try {
      const user_id = (req as any).user.id;
      const config = await drawdownCircuitBreaker.getConfig(user_id);
      res.json({ success: true, data: config });
    } catch (error: any) {
      logger.error('获取组合回撤熔断配置失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  /**
   * PUT /api/risk/drawdown-breaker  (US-049)
   * Persist user's drawdown-breaker config — input normalized
   * (`normalizeDrawdownBreakerConfig`) so invalid pct/pause_ms silently
   * revert to defaults instead of corrupting `User.risk_config`.
   */
  async updateDrawdownBreaker(req: Request, res: Response, _next: NextFunction) {
    try {
      const user_id = (req as any).user.id;
      const saved = await drawdownCircuitBreaker.updateConfig(user_id, req.body || {});
      res.json({ success: true, data: saved, message: '组合回撤熔断配置已保存' });
    } catch (error: any) {
      logger.error('更新组合回撤熔断配置失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  /**
   * POST /api/risk/drawdown-breaker/clear-pause  (US-049)
   * Manually clear an active LEVEL_1 pause (admin override / risk reset).
   */
  async clearDrawdownBreakerPause(req: Request, res: Response, _next: NextFunction) {
    try {
      const user_id = (req as any).user.id;
      await drawdownCircuitBreaker.clearPause(user_id);
      res.json({ success: true, message: '已解除组合回撤熔断暂停状态' });
    } catch (error: any) {
      logger.error('清除组合回撤熔断暂停失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  /**
   * GET /api/risk/market-regime-status  (US-050)
   * Return the **current** market-regime snapshot (latest close, 3-day / 20-day
   * return, MA20 vs MA60, death-cross status, and the alerts that would fire
   * given the caller's effective config).  Read-only — does NOT write RiskAlert
   * rows.  Used by the UI dashboard / 风控面板 to render real-time market
   * health.  Optional `?as_of=YYYY-MM-DD` and `?lookback_days=N` query params
   * support historical replay / debugging.
   */
  async getMarketRegimeStatus(req: Request, res: Response, _next: NextFunction) {
    try {
      const user_id = (req as any).user.id;
      const asOfQuery = (req.query.as_of as string | undefined) ?? undefined;
      const lookbackQuery = (req.query.lookback_days as string | undefined) ?? undefined;
      const asOfDate = asOfQuery ? new Date(asOfQuery) : undefined;
      // 防 NaN / invalid date — fall through to default by treating as undefined.
      const safeAsOf = asOfDate && !Number.isNaN(asOfDate.getTime()) ? asOfDate : undefined;
      const lookbackParsed = lookbackQuery !== undefined ? Number(lookbackQuery) : NaN;
      const safeLookback =
        Number.isInteger(lookbackParsed) && lookbackParsed > 0 ? lookbackParsed : undefined;
      const status = await marketRegimeAlertService.getMarketRegimeStatus({
        user_id,
        asOfDate: safeAsOf,
        lookback_days: safeLookback,
      });
      res.json({ success: true, data: status });
    } catch (error: any) {
      logger.error('获取市场环境预警状态失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  /**
   * GET /api/risk/market-regime  (US-050)
   * Return the user's effective market-regime alert config (defaults if the
   * user has never customized it).
   */
  async getMarketRegimeConfig(req: Request, res: Response, _next: NextFunction) {
    try {
      const user_id = (req as any).user.id;
      const config = await marketRegimeAlertService.getConfig(user_id);
      res.json({ success: true, data: config });
    } catch (error: any) {
      logger.error('获取市场环境预警配置失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  /**
   * PUT /api/risk/market-regime  (US-050)
   * Persist user's market-regime alert config — input normalized
   * (`normalizeMarketRegimeAlertConfig`) so invalid pct / benchmark_symbol /
   * enabled / enable_death_cross silently revert to defaults instead of
   * corrupting `User.risk_config`.
   */
  async updateMarketRegimeConfig(req: Request, res: Response, _next: NextFunction) {
    try {
      const user_id = (req as any).user.id;
      const saved = await marketRegimeAlertService.updateConfig(user_id, req.body || {});
      res.json({ success: true, data: saved, message: '市场环境预警配置已保存' });
    } catch (error: any) {
      logger.error('更新市场环境预警配置失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  /**
   * GET /api/risk/per-stock-stop-loss  (US-051)
   * Return the user's effective per-stock stop-loss config (defaults: enabled=true,
   * pct=0.07, mass_threshold_ratio=0.5 when not customized).
   */
  async getPerStockStopLoss(req: Request, res: Response, _next: NextFunction) {
    try {
      const user_id = (req as any).user.id;
      const config = await perStockStopLossGuard.getConfig(user_id);
      res.json({ success: true, data: config });
    } catch (error: any) {
      logger.error('获取每股止损配置失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  /**
   * PUT /api/risk/per-stock-stop-loss  (US-051)
   * Persist user's per-stock stop-loss config — input normalized
   * (`normalizePerStockStopLossConfig`) so invalid pct / mass_threshold_ratio /
   * enabled silently revert to defaults instead of corrupting `User.risk_config`.
   */
  async updatePerStockStopLoss(req: Request, res: Response, _next: NextFunction) {
    try {
      const user_id = (req as any).user.id;
      const saved = await perStockStopLossGuard.updateConfig(user_id, req.body || {});
      res.json({ success: true, data: saved, message: '每股止损配置已保存' });
    } catch (error: any) {
      logger.error('更新每股止损配置失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  /**
   * GET /api/risk/industry-concentration  (US-052)
   * Return the user's effective industry-concentration config (defaults:
   * enabled=true, alert_pct=0.35, rebalance_target_pct=0.30,
   * rebalance_max_sell_count=2 when not customized).
   */
  async getIndustryConcentration(req: Request, res: Response, _next: NextFunction) {
    try {
      const user_id = (req as any).user.id;
      const config = await industryConcentrationGuard.getConfig(user_id);
      res.json({ success: true, data: config });
    } catch (error: any) {
      logger.error('获取行业集中度配置失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  /**
   * PUT /api/risk/industry-concentration  (US-052)
   * Persist user's industry-concentration config — input normalized
   * (`normalizeIndustryConcentrationConfig`) so invalid pct / max_sell_count /
   * enabled silently revert to defaults instead of corrupting `User.risk_config`.
   */
  async updateIndustryConcentration(req: Request, res: Response, _next: NextFunction) {
    try {
      const user_id = (req as any).user.id;
      const saved = await industryConcentrationGuard.updateConfig(user_id, req.body || {});
      res.json({ success: true, data: saved, message: '行业集中度配置已保存' });
    } catch (error: any) {
      logger.error('更新行业集中度配置失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  /**
   * GET /api/risk/black-swan  (US-053)
   * Return the user's effective black-swan watchdog config (defaults: enabled=true,
   * scan_st / scan_suspended / scan_news / dedupe_enabled = true,
   * news_keywords = [立案/退市/重大违规/处罚/问询函], news_lookback_hours=24,
   * news_per_stock_limit=50 when not customized).
   */
  async getBlackSwan(req: Request, res: Response, _next: NextFunction) {
    try {
      const user_id = (req as any).user.id;
      const config = await blackSwanWatchdog.getConfig(user_id);
      res.json({ success: true, data: config });
    } catch (error: any) {
      logger.error('获取黑天鹅监控配置失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  /**
   * PUT /api/risk/black-swan  (US-053)
   * Persist user's black-swan config — input normalized
   * (`normalizeBlackSwanConfig`) so invalid scan_* / keywords / lookback /
   * dedupe / enabled silently revert to defaults instead of corrupting
   * `User.risk_config`.
   */
  async updateBlackSwan(req: Request, res: Response, _next: NextFunction) {
    try {
      const user_id = (req as any).user.id;
      const saved = await blackSwanWatchdog.updateConfig(user_id, req.body || {});
      res.json({ success: true, data: saved, message: '黑天鹅监控配置已保存' });
    } catch (error: any) {
      logger.error('更新黑天鹅监控配置失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  /**
   * GET /api/risk/morning-checkup/today  (US-054)
   * Return the user's latest morning risk checkup (preferring today's row when
   * available, falling back to the most recent persisted row otherwise).  The
   * payload includes the 6 core metrics (positions / max single / max industry /
   * drawdown / weekly return / unresolved alerts) plus a rendered Chinese
   * message ready for UI display.  Returns `data: null` when the user has
   * never had a checkup row (new account / cron has not yet fired).
   */
  async getMorningCheckupToday(req: Request, res: Response, _next: NextFunction) {
    try {
      const user_id = (req as any).user.id;
      const row = await morningRiskCheckupService.getTodayCheckup(user_id);
      res.json({ success: true, data: row });
    } catch (error: any) {
      logger.error('获取开盘前风险体检报告失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  /**
   * GET /api/risk/morning-checkup  (US-054)
   * Return the user's effective morning-checkup config (defaults: enabled=true,
   * weekly_lookback_days=7, drawdown_lookback_days=365,
   * include_breakdown_in_message=true when not customized).
   */
  async getMorningCheckupConfig(req: Request, res: Response, _next: NextFunction) {
    try {
      const user_id = (req as any).user.id;
      const config = await morningRiskCheckupService.getConfig(user_id);
      res.json({ success: true, data: config });
    } catch (error: any) {
      logger.error('获取开盘前风险体检配置失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  /**
   * PUT /api/risk/morning-checkup  (US-054)
   * Persist user's morning-checkup config — input normalized
   * (`normalizeMorningRiskCheckupConfig`) so invalid days / enabled silently
   * revert to defaults instead of corrupting `User.risk_config`.
   */
  async updateMorningCheckupConfig(req: Request, res: Response, _next: NextFunction) {
    try {
      const user_id = (req as any).user.id;
      const saved = await morningRiskCheckupService.updateConfig(user_id, req.body || {});
      res.json({ success: true, data: saved, message: '开盘前风险体检配置已保存' });
    } catch (error: any) {
      logger.error('更新开盘前风险体检配置失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  // ============================================================
  // Phase 2: Position Sizing Policy
  // ============================================================

  /**
   * GET /api/risk/sizing-policy  (Phase 2)
   * 返回用户当前 sizing 配置 (含 default 对比，方便 UI "恢复默认" 按钮)
   */
  async getSizingPolicy(req: Request, res: Response, _next: NextFunction) {
    try {
      const user_id = (req as any).user.id;
      const data = await sizingPolicyService.getConfigWithDefaults(user_id);
      res.json({ success: true, data });
    } catch (error: any) {
      logger.error('获取 sizing policy 失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }

  /**
   * PUT /api/risk/sizing-policy  (Phase 2)
   * 更新用户 sizing 配置 — input 经 normalize 防脏数据。
   */
  async updateSizingPolicy(req: Request, res: Response, _next: NextFunction) {
    try {
      const user_id = (req as any).user.id;
      const saved = await sizingPolicyService.updateConfig(user_id, req.body || {});
      res.json({ success: true, data: saved, message: 'Sizing 配置已保存' });
    } catch (error: any) {
      logger.error('更新 sizing policy 失败:', error);
      res.status(500).json({ success: false, message: error.message });
    }
  }
}

export const riskController = new RiskController();
