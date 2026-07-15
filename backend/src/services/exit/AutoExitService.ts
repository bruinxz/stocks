/**
 * AutoExitService (§4.2 卫星自动退出)
 * ------------------------------------------------------------------
 * 主线转型「Signal-First + 核心-卫星」的卫星层自动退出执行器.
 *
 * 卫星退出规则 (§4.2):
 *   1. -15% 硬止损   无条件立即强平 (不缓冲)
 *   2. +20% 止盈     达到即卖出
 *   3. 21 交易日     时间硬退出
 *   4. -7%  主动止损 带缓冲: 若 detector 仍报 launch/outbreak 且盘中反弹 >3%,
 *                    允许 T+1 复核; 否则次日集合竞价卖出
 *   5. 60 日滚动窗口 卫星累计亏损 > 组合 5% -> 冻结 30 天 (risk_profile_overrides)
 *   6. 自然月连续 3 月 alpha<0 -> 永久停用卫星, 资金归核心
 *
 * 执行走 executeGuardSells (facade.placeOrder), 保留完整记账链
 * (锁现金 / 印花税 / 佣金 / outcome 关闭).
 *
 * 保持 detector 为纯软层不动, 本服务是独立的硬退出执行器 (可回滚).
 */
import { Op } from 'sequelize';
import { logger } from '../../utils/logger';
import { countTradingDaysBetween, getShanghaiDate } from '../../utils/tradingCalendar';
import { PaperTradingPortfolio } from '../../models/PaperTradingPortfolio';
import { PaperTradingPosition } from '../../models/PaperTradingPosition';
import { RecommendationTradeOutcome } from '../../models/RecommendationTradeOutcome';
import { AISignalSourceType } from '../../models/AIInvestmentSignal';

// ---- §4.2 常量 (全部集中在此, 便于回测 / 调参) ----
export const SATELLITE_HARD_STOP_PCT = -15;
export const SATELLITE_SOFT_STOP_PCT = -7;
export const SATELLITE_TAKE_PROFIT_PCT = 20;
export const SATELLITE_TIME_EXIT_TRADING_DAYS = 21;
export const SATELLITE_SOFT_STOP_REBOUND_PCT = 3; // 盘中反弹 >3% 才给缓冲
export const SATELLITE_ROLLING_WINDOW_DAYS = 60;
export const SATELLITE_ROLLING_LOSS_FREEZE_PCT = 5; // 占组合 5%
export const SATELLITE_FREEZE_DAYS = 30;
export const SATELLITE_ALPHA_STOP_MONTHS = 3;

export type ExitReason =
  | 'hard_stop_15'
  | 'take_profit_20'
  | 'time_exit_21d'
  | 'soft_stop_7'
  | 'none';

export interface ExitDecision {
  reason: ExitReason;
  should_exit: boolean;
  buffered: boolean; // soft stop 命中但因主题仍活跃+反弹而缓冲 -> 不立即卖
  detail: Record<string, any>;
}

export interface SatellitePositionView {
  portfolio_id: number;
  user_id: number;
  symbol: string;
  quantity: number;
  entry_price: number;
  current_price: number;
  entry_date?: string;
  industry?: string;
  intraday_rebound_pct?: number; // 盘中自低点反弹, 无数据时 undefined
}

/** entry->current 盈亏百分比 (100 基准) */
export function computePnlPct(entryPrice: number, currentPrice: number): number {
  if (!entryPrice || entryPrice <= 0) return 0;
  return ((currentPrice - entryPrice) / entryPrice) * 100;
}

/** ExitReason -> GuardSellExecutor trigger_kind (仅日志/汇总用) */
export function exitReasonToTriggerKind(reason: ExitReason): string {
  switch (reason) {
    case 'hard_stop_15':
      return 'satellite_hard_stop_15';
    case 'take_profit_20':
      return 'satellite_take_profit_20';
    case 'time_exit_21d':
      return 'satellite_time_exit_21d';
    case 'soft_stop_7':
      return 'satellite_soft_stop_7';
    default:
      return 'satellite_exit';
  }
}

/**
 * 纯函数: 单仓退出裁决 (§4.2 优先级).
 * 优先级: 硬止损 > 止盈 > 时间退出 > 主动止损(带缓冲).
 */
export function decideExit(
  pnlPct: number,
  holdingTradingDays: number,
  themeStillActive: boolean,
  intradayReboundPct?: number
): ExitDecision {
  // 1) -15% 硬止损, 无条件
  if (pnlPct <= SATELLITE_HARD_STOP_PCT) {
    return {
      reason: 'hard_stop_15',
      should_exit: true,
      buffered: false,
      detail: { pnl_pct: pnlPct, threshold: SATELLITE_HARD_STOP_PCT },
    };
  }
  // 2) +20% 止盈
  if (pnlPct >= SATELLITE_TAKE_PROFIT_PCT) {
    return {
      reason: 'take_profit_20',
      should_exit: true,
      buffered: false,
      detail: { pnl_pct: pnlPct, threshold: SATELLITE_TAKE_PROFIT_PCT },
    };
  }
  // 3) 21 交易日时间硬退出
  if (holdingTradingDays >= SATELLITE_TIME_EXIT_TRADING_DAYS) {
    return {
      reason: 'time_exit_21d',
      should_exit: true,
      buffered: false,
      detail: {
        holding_trading_days: holdingTradingDays,
        threshold: SATELLITE_TIME_EXIT_TRADING_DAYS,
      },
    };
  }
  // 4) -7% 主动止损带缓冲
  if (pnlPct <= SATELLITE_SOFT_STOP_PCT) {
    const rebounded = (intradayReboundPct ?? 0) > SATELLITE_SOFT_STOP_REBOUND_PCT;
    const buffered = themeStillActive && rebounded;
    return {
      reason: 'soft_stop_7',
      should_exit: !buffered, // 缓冲 -> 不立即卖, 留 T+1 复核
      buffered,
      detail: {
        pnl_pct: pnlPct,
        threshold: SATELLITE_SOFT_STOP_PCT,
        theme_still_active: themeStillActive,
        intraday_rebound_pct: intradayReboundPct ?? null,
      },
    };
  }
  return { reason: 'none', should_exit: false, buffered: false, detail: { pnl_pct: pnlPct } };
}

export interface AutoExitRunOptions {
  tradeDate?: string; // 默认上海今日
  dryRun?: boolean;
  userId?: number; // 限定单用户, 不传扫全部 active 组合
}

export interface AutoExitRunResult {
  trade_date: string;
  dry_run: boolean;
  scanned_positions: number;
  exit_triggers: number;
  buffered: number;
  sell_result: any;
  rolling_freezes: number;
  alpha_permanent_stops: number;
}

export class AutoExitService {
  /** 主入口: 单次跑一遍所有卫星仓的退出裁决 + 风控冻结/永久停 */
  async runOnce(options: AutoExitRunOptions = {}): Promise<AutoExitRunResult> {
    const tradeDate = options.tradeDate || getShanghaiDate(new Date());
    const dryRun = options.dryRun === true;

    const activeThemes = await this.loadActiveThemeIndustries(tradeDate);
    const positions = await this.loadSatellitePositions(options.userId);

    const triggers: any[] = [];
    let buffered = 0;

    for (const pos of positions) {
      const pnlPct = computePnlPct(pos.entry_price, pos.current_price);
      const holdingDays = pos.entry_date ? countTradingDaysBetween(pos.entry_date, tradeDate) : 0;
      const themeStillActive = pos.industry ? activeThemes.has(pos.industry) : false;
      const decision = decideExit(pnlPct, holdingDays, themeStillActive, pos.intraday_rebound_pct);

      if (decision.buffered) buffered += 1;
      if (!decision.should_exit) continue;

      triggers.push({
        user_id: pos.user_id,
        symbol: pos.symbol,
        quantity: pos.quantity,
        portfolio_id: pos.portfolio_id,
        trigger_kind: exitReasonToTriggerKind(decision.reason),
        detail: { ...decision.detail, exit_reason: decision.reason },
      });
    }

    let sellResult: any = { attempted: 0, succeeded: 0, skipped: 0, failed: 0, executions: [] };
    if (triggers.length) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { executeGuardSells } = require('../../portfolio/risk/GuardSellExecutor');
      sellResult = await executeGuardSells(triggers, {
        scenario: 'satellite_auto_exit',
        dry_run: dryRun,
      });
    }

    // 组合级风控: 60 日滚动亏损冻结 + 3 月 alpha 永久停
    let rollingFreezes = 0;
    let alphaStops = 0;
    const portfolios = await this.loadActivePortfolios(options.userId);
    for (const pf of portfolios) {
      const froze = await this.checkRollingLossFreeze(pf, tradeDate, dryRun);
      if (froze) rollingFreezes += 1;
      const stopped = await this.checkAlphaPermanentStop(pf, tradeDate, dryRun);
      if (stopped) alphaStops += 1;
    }

    logger.info(
      `[AUTO_EXIT] date=${tradeDate} dry=${dryRun} scanned=${positions.length} ` +
        `triggers=${triggers.length} buffered=${buffered} ` +
        `freezes=${rollingFreezes} alphaStops=${alphaStops}`
    );

    return {
      trade_date: tradeDate,
      dry_run: dryRun,
      scanned_positions: positions.length,
      exit_triggers: triggers.length,
      buffered,
      sell_result: sellResult,
      rolling_freezes: rollingFreezes,
      alpha_permanent_stops: alphaStops,
    };
  }

  /** detector 当前仍活跃 (launch/outbreak) 的行业集合, 用于 soft-stop 缓冲判定 */
  async loadActiveThemeIndustries(tradeDate: string): Promise<Set<string>> {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { ThemeFermentationPhase } = require('../../models/ThemeFermentationPhase');
    const rows = await ThemeFermentationPhase.findAll({
      where: { trade_date: tradeDate, phase: { [Op.in]: ['launch', 'outbreak'] } },
      attributes: ['industry'],
    });
    const set = new Set<string>();
    for (const r of rows) if (r.industry) set.add(r.industry);
    return set;
  }

  /** 当前持有的卫星仓: open 的 theme_event outcome ∩ 现有 PaperTradingPosition (qty>0) */
  async loadSatellitePositions(userId?: number): Promise<SatellitePositionView[]> {
    const outcomeWhere: any = {
      source_type: AISignalSourceType.THEME_EVENT,
      trade_status: { [Op.in]: ['open', 'executed', 'closing'] },
    };
    const outcomes = await RecommendationTradeOutcome.findAll({ where: outcomeWhere });
    if (!outcomes.length) return [];

    // portfolio -> user 映射
    const pfIds = Array.from(new Set(outcomes.map(o => o.portfolio_id).filter(Boolean)));
    const pfWhere: any = { id: { [Op.in]: pfIds } };
    if (userId) pfWhere.user_id = userId;
    const portfolios = await PaperTradingPortfolio.findAll({ where: pfWhere });
    const pfMap = new Map<number, PaperTradingPortfolio>();
    for (const pf of portfolios) pfMap.set(pf.id, pf);

    const views: SatellitePositionView[] = [];
    for (const o of outcomes) {
      const pf = pfMap.get(o.portfolio_id);
      if (!pf) continue; // userId 过滤 / 组合不存在
      const pos = await PaperTradingPosition.findOne({
        where: { portfolio_id: o.portfolio_id, symbol: o.symbol, quantity: { [Op.gt]: 0 } },
      });
      if (!pos) continue;
      views.push({
        portfolio_id: o.portfolio_id,
        user_id: pf.user_id,
        symbol: o.symbol,
        quantity: pos.quantity,
        entry_price: Number(o.entry_price ?? pos.avg_cost ?? 0),
        current_price: Number(pos.current_price ?? o.latest_price ?? 0),
        entry_date: o.entry_date,
        industry: o.industry,
        // 盘中反弹数据当前无实时源, 留空 -> 缓冲判定按无反弹处理 (保守卖出)
        intraday_rebound_pct: undefined,
      });
    }
    return views;
  }

  async loadActivePortfolios(userId?: number): Promise<PaperTradingPortfolio[]> {
    const where: any = { is_active: true };
    if (userId) where.user_id = userId;
    return PaperTradingPortfolio.findAll({ where });
  }

  /**
   * §4.2-5: 60 日滚动窗口卫星累计亏损 > 组合 5% -> 冻结 30 天.
   * 起点 = 每个 EOD 计算 (today-60, today] 已实现 PnL + 未平仓浮亏.
   * 冻结释放不重置起点.
   */
  async checkRollingLossFreeze(
    pf: PaperTradingPortfolio,
    tradeDate: string,
    dryRun: boolean
  ): Promise<boolean> {
    const overrides = (pf.risk_profile_overrides || {}) as Record<string, any>;
    // 已在冻结期内 -> 不重复冻结
    if (overrides.satellite_freeze_until && overrides.satellite_freeze_until >= tradeDate) {
      return false;
    }

    const windowStart = this.shiftDays(tradeDate, -SATELLITE_ROLLING_WINDOW_DAYS);

    // 已实现: 窗口内 closed 的卫星仓 realized_pnl
    const closed = await RecommendationTradeOutcome.findAll({
      where: {
        portfolio_id: pf.id,
        source_type: AISignalSourceType.THEME_EVENT,
        trade_status: 'closed',
        exit_date: { [Op.gt]: windowStart, [Op.lte]: tradeDate },
      },
      attributes: ['realized_pnl'],
    });
    let realized = 0;
    for (const c of closed) realized += Number(c.realized_pnl || 0);

    // 未平仓浮亏 (仅计负值)
    const open = await RecommendationTradeOutcome.findAll({
      where: {
        portfolio_id: pf.id,
        source_type: AISignalSourceType.THEME_EVENT,
        trade_status: { [Op.in]: ['open', 'executed', 'closing'] },
      },
      attributes: ['unrealized_pnl'],
    });
    let unrealizedLoss = 0;
    for (const o of open) {
      const u = Number(o.unrealized_pnl || 0);
      if (u < 0) unrealizedLoss += u;
    }

    const totalPnl = realized + unrealizedLoss;
    const base = Number(pf.total_value || pf.initial_capital || 0);
    if (base <= 0) return false;
    const lossPct = (-totalPnl / base) * 100; // 亏损为正数

    if (totalPnl < 0 && lossPct > SATELLITE_ROLLING_LOSS_FREEZE_PCT) {
      const freezeUntil = this.shiftDays(tradeDate, SATELLITE_FREEZE_DAYS);
      logger.warn(
        `[AUTO_EXIT] rolling-loss freeze pf=${pf.id} lossPct=${lossPct.toFixed(2)}% ` +
          `> ${SATELLITE_ROLLING_LOSS_FREEZE_PCT}% -> freeze until ${freezeUntil}`
      );
      if (!dryRun) {
        await this.mergeRiskOverrides(pf, {
          satellite_freeze_until: freezeUntil,
          satellite_freeze_reason: `rolling_loss_${lossPct.toFixed(1)}pct`,
          satellite_freeze_set_at: tradeDate,
        });
      }
      return true;
    }
    return false;
  }

  /**
   * §4.2-6: 自然月连续 3 月 alpha<0 -> 永久停用卫星, 资金归核心.
   * alpha = 卫星月度 PnL% - CSI300 月度%; 用 outcome.excess_return_pct 作为 alpha 代理.
   * 严格连续: 任一月 alpha>=0 清零; 冻结月仍计数.
   */
  async checkAlphaPermanentStop(
    pf: PaperTradingPortfolio,
    tradeDate: string,
    dryRun: boolean
  ): Promise<boolean> {
    const overrides = (pf.risk_profile_overrides || {}) as Record<string, any>;
    if (overrides.satellite_permanent_stop === true) return false; // 已停

    const months = this.recentMonths(tradeDate, SATELLITE_ALPHA_STOP_MONTHS);
    let consecutiveNeg = 0;
    for (const m of months) {
      const monthStart = `${m}-01`;
      const monthEnd = this.monthEnd(m);
      const closed = await RecommendationTradeOutcome.findAll({
        where: {
          portfolio_id: pf.id,
          source_type: AISignalSourceType.THEME_EVENT,
          trade_status: 'closed',
          exit_date: { [Op.gte]: monthStart, [Op.lte]: monthEnd },
        },
        attributes: ['excess_return_pct', 'realized_pnl_pct'],
      });
      if (!closed.length) {
        // 无平仓样本 -> 当月无法判定, 视为非负 (不推进永久停), 保守
        consecutiveNeg = 0;
        continue;
      }
      let alphaSum = 0;
      for (const c of closed) {
        const ex =
          c.excess_return_pct != null
            ? Number(c.excess_return_pct)
            : Number(c.realized_pnl_pct || 0);
        alphaSum += ex;
      }
      if (alphaSum < 0) consecutiveNeg += 1;
      else consecutiveNeg = 0;
    }

    if (consecutiveNeg >= SATELLITE_ALPHA_STOP_MONTHS) {
      logger.warn(
        `[AUTO_EXIT] alpha permanent-stop pf=${pf.id} consecutiveNegMonths=${consecutiveNeg} ` +
          `-> disable satellite, funds to core`
      );
      if (!dryRun) {
        await this.mergeRiskOverrides(pf, {
          satellite_permanent_stop: true,
          satellite_permanent_stop_at: tradeDate,
          satellite_permanent_stop_reason: `alpha_neg_${consecutiveNeg}_months`,
        });
      }
      return true;
    }
    return false;
  }

  async mergeRiskOverrides(pf: PaperTradingPortfolio, patch: Record<string, any>): Promise<void> {
    const merged = { ...(pf.risk_profile_overrides || {}), ...patch };
    pf.risk_profile_overrides = merged;
    await pf.save();
  }

  /** yyyy-mm-dd +/- 自然日 */
  shiftDays(dateStr: string, delta: number): string {
    const d = new Date(`${dateStr}T00:00:00+08:00`);
    d.setDate(d.getDate() + delta);
    return getShanghaiDate(d);
  }

  /** 最近 n 个自然月 (含当前月), 返回 ['YYYY-MM', ...] 从旧到新 */
  recentMonths(dateStr: string, n: number): string[] {
    const out: string[] = [];
    const d = new Date(`${dateStr}T00:00:00+08:00`);
    for (let i = n - 1; i >= 0; i--) {
      const t = new Date(d.getFullYear(), d.getMonth() - i, 1);
      const y = t.getFullYear();
      const m = String(t.getMonth() + 1).padStart(2, '0');
      out.push(`${y}-${m}`);
    }
    return out;
  }

  /** 'YYYY-MM' -> 当月最后一天 'YYYY-MM-DD' */
  monthEnd(month: string): string {
    const [y, m] = month.split('-').map(x => parseInt(x, 10));
    const last = new Date(y, m, 0).getDate();
    return `${month}-${String(last).padStart(2, '0')}`;
  }
}

export const autoExitService = new AutoExitService();
