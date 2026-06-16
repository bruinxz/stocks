/**
 * TrailingStopGuard — US-048
 *
 * 追踪止损守卫 — 在持仓建仓后追踪 close 高水位 (`highest_price`)，
 * 每日收盘后重算 `trailing_stop_price = highest_price * (1 - pct)`；
 * 次日开盘前若 prev_close ≤ trailing_stop_price，触发 SELL 信号
 * （通过 RiskAlert 写入 + 返回结构化 trigger，由调用方决定撮合时机）。
 *
 * 2 个生命周期阶段，由 SchedulerService 分别 cron：
 *   (1) **updatePositionsAfterClose(user_id?)** — 每日 ~15:30 收盘后跑：
 *       - 取每只持仓的当日 DailyBar.close（缺则跳过）；
 *       - `highest_price = max(prev_highest_price ?? avg_cost, today_close)`；
 *       - `trailing_stop_price = highest_price * (1 - effective_pct)`；
 *       - 写回 PaperTradingPosition。
 *   (2) **evaluateNextDayTriggers(user_id?)** — 次日 ~9:00 开盘前跑：
 *       - 取每只持仓最近一日 DailyBar.close (prev_close)；
 *       - 若 prev_close ≤ trailing_stop_price 则触发 SELL：
 *         · 写 RiskAlert(level='HIGH', symbol=..., message=...);
 *         · 返回 trigger 数组让调用方（PaperTradingAutomationService /
 *           手动 dry-run / UI dashboard）决定真实下单时机；
 *
 * 设计约束 — 沿用 US-047 PositionLimitGuard 的 7 条 checklist：
 *   - DataSource 接口注入（生产 Sequelize + 测试 fake bag）；
 *   - 纯函数 helper 全 export 让单测无需 DB；
 *   - 配置 in `User.risk_config.trailing_stop` JSONB + 全局默认
 *     `DEFAULT_TRAILING_STOP_CONFIG` Object.freeze；
 *   - SELL 触发 = `RiskAlert(level='HIGH')` 写入，failure 仅 logger.warn
 *     不掩盖 trigger（同 PositionLimitGuard.writeAlert）；
 *   - 单 user 跑时单 try/catch 隔离不阻塞其他用户（同 FactorICReport /
 *     PositionLimitGuard）；
 *   - HTTP 入口在 `/api/risk/trailing-stop`（GET/PUT），mounted via
 *     `risk.routes.ts`，与 PositionLimitGuard 同 namespace；
 *   - 不破坏 facade 收敛：guard 自己持仓 RiskAlert 写入 + 返回 trigger 列表，
 *     调用方（PaperTradingAutomationService）按 trigger 走 facade.placeOrder
 *     正常下单链路（保持 facade 7 method 收敛 + risk profile / automation hook
 *     正常触发，US-018 同款）。
 *
 * 边界与坑：
 *   - `effective_pct` 优先级：position.trailing_stop_pct (策略层覆盖)
 *     → user.risk_config.trailing_stop.pct → DEFAULT 0.10。
 *   - `highest_price` 初始化：开仓首日 (highest_price IS NULL) 用 avg_cost
 *     作为初值与 today_close 比较，避免 close 当日就低于 entry 被强制止损。
 *   - 触发判定 `prev_close ≤ trailing_stop_price` 用 `≤`（与 US-047 单股
 *     boundary 用 `>` 镜像）— 止损是保护性硬触发，命中边界要立即止血。
 *   - DailyBar 缺当日数据：updatePositionsAfterClose 跳过该持仓（不强制
 *     回退到 current_price，避免 current_price 漂移导致 highest 跳水）；
 *     evaluateNextDayTriggers 同样跳过（无可比价 prev_close，安全 hold）。
 *   - 卖出 trigger 后 highest_price / trailing_stop_price 保留不清零 —
 *     由 facade.placeOrder SELL 链路负责删除持仓行，guard 不直接清字段。
 */

import { Op } from 'sequelize';
import { PaperTradingPosition } from '../../models/PaperTradingPosition';
import { PaperTradingPortfolio } from '../../models/PaperTradingPortfolio';
import { Stock } from '../../models/Stock';
import { DailyBar } from '../../models/DailyBar';
import { RiskAlert } from '../../models/RiskAlert';
import { User } from '../../models/User';
import { logger } from '../../utils/logger';

// ---------------------------------------------------------------------------
//  Config
// ---------------------------------------------------------------------------

export interface TrailingStopConfig {
  /** 是否启用追踪止损（false = 跳过整个 guard）。 */
  enabled: boolean;
  /** 回撤比例 0-1（e.g. 0.10 = 高位回撤 10% 触发止损）。 */
  pct: number;
}

/**
 * 全局默认 — 启用 + 10% 回撤（AC 规定的默认值）。
 *
 * `Object.freeze` 防止 caller 在 module 级意外 mutate 默认值，沿用
 * US-037 codebase pattern。
 */
export const DEFAULT_TRAILING_STOP_CONFIG: TrailingStopConfig = Object.freeze({
  enabled: true,
  pct: 0.1,
});

// ---------------------------------------------------------------------------
//  Domain types
// ---------------------------------------------------------------------------

/** Snapshot of one position for guard evaluation. */
export interface PositionSnapshot {
  id: number;
  portfolio_id: number;
  symbol: string;
  name?: string | null;
  quantity: number;
  avg_cost: number;
  current_price: number;
  /** Trailing-stop high water-mark; null = not yet established. */
  highest_price: number | null;
  /** Per-position override of pct; null = inherit user's config. */
  trailing_stop_pct: number | null;
  /** Cached trigger price; null = not yet computed. */
  trailing_stop_price: number | null;
}

/** Update payload written back via DataSource.updatePositionTrailingFields. */
export interface PositionTrailingUpdate {
  id: number;
  highest_price: number;
  trailing_stop_price: number;
  effective_pct: number;
}

/** Result of a single per-position update (for reporting / tests). */
export interface UpdateResult {
  position_id: number;
  symbol: string;
  status: 'updated' | 'skipped_no_bar' | 'skipped_disabled' | 'skipped_no_quantity';
  prior_highest_price: number | null;
  new_highest_price?: number;
  new_trailing_stop_price?: number;
  effective_pct?: number;
  today_close?: number;
  reason?: string;
}

/** A SELL trigger surfaced by `evaluateNextDayTriggers`. */
export interface TrailingStopTrigger {
  user_id: number;
  position_id: number;
  symbol: string;
  name: string;
  quantity: number;
  prev_close: number;
  highest_price: number;
  trailing_stop_price: number;
  effective_pct: number;
  message: string;
}

// ---------------------------------------------------------------------------
//  Pure helpers (export for unit tests — no DB)
// ---------------------------------------------------------------------------

/**
 * 选定 effective_pct — 三级覆盖：
 *   1. position.trailing_stop_pct (策略层在开仓时按个股波动定制)
 *   2. user_config.pct (用户全局偏好)
 *   3. DEFAULT_TRAILING_STOP_CONFIG.pct (兜底 10%)
 *
 * 接受 0 <= pct <= 1 的合法值；超出范围或非有限数走下一级。
 */
export function pickEffectivePct(
  positionPct: number | null | undefined,
  userPct: number | null | undefined
): number {
  const isValid = (v: any): v is number =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
  if (isValid(positionPct)) return positionPct as number;
  if (isValid(userPct)) return userPct as number;
  return DEFAULT_TRAILING_STOP_CONFIG.pct;
}

/**
 * 计算新的 highest_price：
 *   - 当 prior_highest 为 null（建仓首日）用 fallback (通常 = avg_cost)
 *     与 today_close 求 max — 避免开仓当日就 highest=close 让 trailing 误触发；
 *   - 否则 max(prior_highest, today_close)。
 */
export function computeNewHighestPrice(
  priorHighest: number | null,
  todayClose: number,
  fallbackInit: number
): number {
  const base =
    priorHighest !== null && Number.isFinite(priorHighest)
      ? priorHighest
      : Number.isFinite(fallbackInit)
      ? fallbackInit
      : todayClose;
  return Math.max(base, todayClose);
}

/**
 * 计算 trailing_stop_price = highest * (1 - pct)，结果四舍五入到 3 位小数
 * 与 PaperTradingPosition 的 DECIMAL(10,3) 列定义对齐避免 DB round-trip
 * 出现 0.001 漂移让单测难写。
 */
export function computeTrailingStopPrice(highest: number, pct: number): number {
  const raw = highest * (1 - pct);
  return Math.round(raw * 1000) / 1000;
}

/**
 * 触发判定：prev_close ≤ trailing_stop_price 算触发（保护性硬触发用
 * ≤，命中 boundary 立即止血；与 PositionLimitGuard 单股 > 的镜像反向）。
 *
 * trailing_stop_price 必须 > 0 才有意义；highest_price 必须存在才能判定。
 */
export function evaluateTrailingStopTrigger(
  prevClose: number,
  trailingStopPrice: number | null,
  highestPrice: number | null
): boolean {
  if (!Number.isFinite(prevClose)) return false;
  if (trailingStopPrice === null || !Number.isFinite(trailingStopPrice) || trailingStopPrice <= 0) {
    return false;
  }
  if (highestPrice === null || !Number.isFinite(highestPrice) || highestPrice <= 0) {
    return false;
  }
  return prevClose <= trailingStopPrice;
}

/**
 * 净化 raw config blob（来自 User.risk_config 或 PUT body）成合法
 * `TrailingStopConfig`：
 *   - 非有限数 / 负 / >1 的 pct → 默认；
 *   - 非 boolean 的 enabled → 默认 (true)；
 *
 * 与 PositionLimitGuard.normalizePositionLimitsConfig 同款模式。
 */
export function normalizeTrailingStopConfig(raw: any): TrailingStopConfig {
  const safePct = (v: any, dflt: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 && n <= 1 ? n : dflt;
  };
  const safeBool = (v: any, dflt: boolean) => (typeof v === 'boolean' ? v : dflt);
  return {
    enabled: safeBool(raw?.enabled, DEFAULT_TRAILING_STOP_CONFIG.enabled),
    pct: safePct(raw?.pct, DEFAULT_TRAILING_STOP_CONFIG.pct),
  };
}

/** 内部 helper — 拼装人类可读的触发说明（中文）。 */
export function buildTriggerMessage(input: {
  symbol: string;
  prev_close: number;
  highest_price: number;
  trailing_stop_price: number;
  effective_pct: number;
}): string {
  return (
    `${input.symbol} 触发追踪止损：` +
    `昨收 ${input.prev_close.toFixed(3)} ≤ 触发价 ${input.trailing_stop_price.toFixed(3)} ` +
    `(高位 ${input.highest_price.toFixed(3)} × (1 - ${(input.effective_pct * 100).toFixed(
      2
    )}%))。` +
    `建议次日开盘卖出。`
  );
}

// ---------------------------------------------------------------------------
//  DataSource — DI seam for unit tests
// ---------------------------------------------------------------------------

export interface TrailingStopDataSource {
  /** Load all users with at least one paper-trading portfolio (for batch mode). */
  loadAllUserIdsWithPortfolios(): Promise<number[]>;
  /** Load this user's effective config; falls back to defaults if absent. */
  loadConfig(user_id: number): Promise<TrailingStopConfig>;
  /** Persist this user's config (UPSERT semantics). */
  saveConfig(user_id: number, config: TrailingStopConfig): Promise<TrailingStopConfig>;
  /** Load all open positions (quantity > 0) for the user. */
  loadOpenPositions(user_id: number): Promise<PositionSnapshot[]>;
  /**
   * Load the latest available close price for `symbol` on or before `asOfDate`.
   * Returns null if no DailyBar exists in the lookback window.
   */
  loadLatestClose(symbol: string, asOfDate: Date): Promise<{ close: number; date: Date } | null>;
  /** Write back updated trailing fields on a position. */
  updatePositionTrailingFields(update: PositionTrailingUpdate): Promise<void>;
  /** Write a single RiskAlert row (level='HIGH'). */
  writeAlert(input: {
    user_id: number;
    symbol: string;
    name: string;
    message: string;
  }): Promise<void>;
}

/**
 * Production DataSource — backed by Sequelize.  Cross-table joins
 * (DailyBar.symbol via Stock lookup) live here so the guard itself only sees
 * snapshot bag types.
 */
export class DefaultTrailingStopDataSource implements TrailingStopDataSource {
  async loadAllUserIdsWithPortfolios(): Promise<number[]> {
    const rows = await PaperTradingPortfolio.findAll({
      attributes: ['user_id'],
      group: ['user_id'],
    });
    return rows.map(r => r.user_id);
  }

  async loadConfig(user_id: number): Promise<TrailingStopConfig> {
    const user = await User.findByPk(user_id);
    const raw = user?.risk_config?.trailing_stop;
    return normalizeTrailingStopConfig(raw);
  }

  async saveConfig(user_id: number, config: TrailingStopConfig): Promise<TrailingStopConfig> {
    const user = await User.findByPk(user_id);
    if (!user) {
      throw new Error(`saveConfig: user ${user_id} not found`);
    }
    const merged = {
      ...(user.risk_config || {}),
      trailing_stop: { ...config },
    };
    user.risk_config = merged;
    // JSONB columns require explicit `changed('field', true)` after in-place
    // mutation per the project's US-017 pattern.
    user.changed('risk_config', true);
    await user.save();
    return { ...config };
  }

  async loadOpenPositions(user_id: number): Promise<PositionSnapshot[]> {
    // 修复 (2026-06-16, HIGH H2): 之前 findOne({user_id}) 只取第一个 portfolio,
    // user_id=4 有 9 个 portfolio → 永远只扫 portfolio 24 (空仓), 其它 8 个真有持仓盘
    // 完全没被 trailing stop 监控. 改成 findAll 拉所有 portfolio 的 positions.
    const portfolios = await PaperTradingPortfolio.findAll({
      where: { user_id, is_active: true },
      attributes: ['id'],
    });
    if (portfolios.length === 0) return [];
    const portfolioIds = portfolios.map(p => p.id);
    const rows = await PaperTradingPosition.findAll({
      where: { portfolio_id: { [Op.in]: portfolioIds }, quantity: { [Op.gt]: 0 } },
    });
    return rows.map<PositionSnapshot>(r => ({
      id: r.id,
      portfolio_id: r.portfolio_id,
      symbol: r.symbol,
      name: r.name,
      quantity: Number(r.quantity),
      avg_cost: Number(r.avg_cost),
      current_price: Number(r.current_price),
      highest_price: r.highest_price === null ? null : Number(r.highest_price),
      trailing_stop_pct: r.trailing_stop_pct === null ? null : Number(r.trailing_stop_pct),
      trailing_stop_price: r.trailing_stop_price === null ? null : Number(r.trailing_stop_price),
    }));
  }

  async loadLatestClose(
    symbol: string,
    asOfDate: Date
  ): Promise<{ close: number; date: Date } | null> {
    const stock = await Stock.findOne({ where: { symbol }, attributes: ['id'] });
    if (!stock) return null;
    const bar = await DailyBar.findOne({
      where: { stock_id: stock.id, time: { [Op.lte]: asOfDate } },
      order: [['time', 'DESC']],
    });
    if (!bar) return null;
    const close = Number(bar.close);
    if (!Number.isFinite(close) || close <= 0) return null;
    return { close, date: bar.time };
  }

  async updatePositionTrailingFields(update: PositionTrailingUpdate): Promise<void> {
    await PaperTradingPosition.update(
      {
        highest_price: update.highest_price,
        trailing_stop_price: update.trailing_stop_price,
        // We deliberately do NOT overwrite per-position trailing_stop_pct
        // here — that's the strategy/user input and should only change via
        // explicit applyAutomation actions.  effective_pct is recorded for
        // audit on the update result, not back to the row.
      },
      { where: { id: update.id } }
    );
  }

  async writeAlert(input: {
    user_id: number;
    symbol: string;
    name: string;
    message: string;
  }): Promise<void> {
    await RiskAlert.create({
      user_id: input.user_id,
      symbol: input.symbol,
      name: input.name,
      level: 'HIGH',
      message: input.message,
      // US-067 — 给 RealtimeAlertDispatcher dedup signature 用，避免不同 guard
      // 的 HIGH 告警在 30 min 窗口内被 unknown::symbol::HIGH 互相吃掉。
      rule_id: 'trailing_stop',
      is_read: false,
    } as any);
  }
}

export const PRODUCTION_TRAILING_STOP_DATA_SOURCE: TrailingStopDataSource =
  new DefaultTrailingStopDataSource();

// ---------------------------------------------------------------------------
//  Guard — public entry point
// ---------------------------------------------------------------------------

export interface UpdatePositionsAfterCloseOptions {
  /** If set, only process this user. Otherwise scan all users with portfolios. */
  user_id?: number;
  /** Override the date used to query DailyBar (defaults to "now"). */
  asOfDate?: Date;
}

export interface UpdatePositionsAfterCloseResult {
  scanned_users: number;
  total_positions: number;
  updated_positions: number;
  skipped_positions: number;
  per_user: Array<{
    user_id: number;
    results: UpdateResult[];
    error?: string;
  }>;
}

export interface EvaluateNextDayTriggersOptions {
  /** If set, only process this user. Otherwise scan all users with portfolios. */
  user_id?: number;
  /** Override the date used to query DailyBar prev_close (defaults to "now"). */
  asOfDate?: Date;
  /** If true, do NOT write RiskAlert rows (dry-run mode for UI dashboards). */
  dry_run?: boolean;
}

export interface EvaluateNextDayTriggersResult {
  scanned_users: number;
  total_positions: number;
  triggered_positions: number;
  triggers: TrailingStopTrigger[];
  per_user_errors: Array<{ user_id: number; error: string }>;
}

export class TrailingStopGuard {
  private source: TrailingStopDataSource;

  constructor(source: TrailingStopDataSource = PRODUCTION_TRAILING_STOP_DATA_SOURCE) {
    this.source = source;
  }

  /**
   * 收盘后批量刷新 highest_price 与 trailing_stop_price。
   *
   * - 单 user 失败 try/catch 隔离，不阻塞剩余 user（同 FactorICReport /
   *   PositionLimitGuard pattern）；
   * - 当用户的 trailing_stop.enabled = false 时，整 user 跳过（per_user
   *   results 标记 skipped_disabled）；
   * - DailyBar 缺当日 close 时跳过该持仓（不强制回退到 current_price）。
   */
  async updatePositionsAfterClose(
    options: UpdatePositionsAfterCloseOptions = {}
  ): Promise<UpdatePositionsAfterCloseResult> {
    const asOfDate = options.asOfDate ?? new Date();
    const userIds = options.user_id
      ? [options.user_id]
      : await this.source.loadAllUserIdsWithPortfolios();

    const result: UpdatePositionsAfterCloseResult = {
      scanned_users: userIds.length,
      total_positions: 0,
      updated_positions: 0,
      skipped_positions: 0,
      per_user: [],
    };

    for (const user_id of userIds) {
      try {
        const config = await this.source.loadConfig(user_id);
        const positions = await this.source.loadOpenPositions(user_id);
        result.total_positions += positions.length;

        if (!config.enabled) {
          // Whole user opted out → mark all positions skipped_disabled.
          const results: UpdateResult[] = positions.map(p => ({
            position_id: p.id,
            symbol: p.symbol,
            status: 'skipped_disabled' as const,
            prior_highest_price: p.highest_price,
            reason: 'trailing_stop disabled for user',
          }));
          result.skipped_positions += positions.length;
          result.per_user.push({ user_id, results });
          continue;
        }

        const perPosition: UpdateResult[] = [];
        for (const pos of positions) {
          if (!(pos.quantity > 0)) {
            perPosition.push({
              position_id: pos.id,
              symbol: pos.symbol,
              status: 'skipped_no_quantity',
              prior_highest_price: pos.highest_price,
              reason: 'quantity <= 0',
            });
            result.skipped_positions += 1;
            continue;
          }
          const bar = await this.source.loadLatestClose(pos.symbol, asOfDate);
          if (!bar) {
            perPosition.push({
              position_id: pos.id,
              symbol: pos.symbol,
              status: 'skipped_no_bar',
              prior_highest_price: pos.highest_price,
              reason: 'no DailyBar on/before asOfDate',
            });
            result.skipped_positions += 1;
            continue;
          }
          const effective_pct = pickEffectivePct(pos.trailing_stop_pct, config.pct);
          const new_highest_price = computeNewHighestPrice(
            pos.highest_price,
            bar.close,
            pos.avg_cost
          );
          const new_trailing_stop_price = computeTrailingStopPrice(
            new_highest_price,
            effective_pct
          );
          await this.source.updatePositionTrailingFields({
            id: pos.id,
            highest_price: new_highest_price,
            trailing_stop_price: new_trailing_stop_price,
            effective_pct,
          });
          perPosition.push({
            position_id: pos.id,
            symbol: pos.symbol,
            status: 'updated',
            prior_highest_price: pos.highest_price,
            new_highest_price,
            new_trailing_stop_price,
            effective_pct,
            today_close: bar.close,
          });
          result.updated_positions += 1;
        }
        result.per_user.push({ user_id, results: perPosition });
      } catch (err) {
        logger.warn(
          `TrailingStopGuard.updatePositionsAfterClose user=${user_id} failed: ` +
            `${(err as Error).message}`
        );
        result.per_user.push({
          user_id,
          results: [],
          error: (err as Error).message,
        });
      }
    }

    return result;
  }

  /**
   * 次日开盘前扫描触发条件。
   *
   * 返回触发列表（让调用方决定撮合时机：自动跟单走 placeOrder / dry-run
   * 仅看 dashboard / 人工审批）。**不**直接调用 placeOrder — 保持单一
   * 职责 + 与 PositionLimitGuard 镜像（guard 只输出 violation/trigger，
   * 由 facade 决定动作）。
   *
   * 默认写 RiskAlert(level='HIGH')；`dry_run=true` 时跳过写入（UI 预演）。
   */
  async evaluateNextDayTriggers(
    options: EvaluateNextDayTriggersOptions = {}
  ): Promise<EvaluateNextDayTriggersResult> {
    const asOfDate = options.asOfDate ?? new Date();
    const dryRun = Boolean(options.dry_run);
    const userIds = options.user_id
      ? [options.user_id]
      : await this.source.loadAllUserIdsWithPortfolios();

    const result: EvaluateNextDayTriggersResult = {
      scanned_users: userIds.length,
      total_positions: 0,
      triggered_positions: 0,
      triggers: [],
      per_user_errors: [],
    };

    for (const user_id of userIds) {
      try {
        const config = await this.source.loadConfig(user_id);
        if (!config.enabled) continue;
        const positions = await this.source.loadOpenPositions(user_id);
        result.total_positions += positions.length;

        for (const pos of positions) {
          if (!(pos.quantity > 0)) continue;
          if (pos.trailing_stop_price === null || pos.highest_price === null) {
            // updatePositionsAfterClose hasn't run for this position yet
            // (e.g. brand-new BUY between close and next morning).  Safe HOLD.
            continue;
          }
          const bar = await this.source.loadLatestClose(pos.symbol, asOfDate);
          if (!bar) continue;
          const effective_pct = pickEffectivePct(pos.trailing_stop_pct, config.pct);
          const triggered = evaluateTrailingStopTrigger(
            bar.close,
            pos.trailing_stop_price,
            pos.highest_price
          );
          if (!triggered) continue;
          const message = buildTriggerMessage({
            symbol: pos.symbol,
            prev_close: bar.close,
            highest_price: pos.highest_price,
            trailing_stop_price: pos.trailing_stop_price,
            effective_pct,
          });
          const trigger: TrailingStopTrigger = {
            user_id,
            position_id: pos.id,
            symbol: pos.symbol,
            name: pos.name || pos.symbol,
            quantity: pos.quantity,
            prev_close: bar.close,
            highest_price: pos.highest_price,
            trailing_stop_price: pos.trailing_stop_price,
            effective_pct,
            message,
          };
          result.triggers.push(trigger);
          result.triggered_positions += 1;
          if (!dryRun) {
            try {
              await this.source.writeAlert({
                user_id,
                symbol: pos.symbol,
                name: `追踪止损触发 - ${pos.name || pos.symbol}`,
                message,
              });
            } catch (err) {
              logger.warn(
                `TrailingStopGuard.writeAlert user=${user_id} ` +
                  `symbol=${pos.symbol}: ${(err as Error).message}`
              );
            }
          }
        }
      } catch (err) {
        logger.warn(
          `TrailingStopGuard.evaluateNextDayTriggers user=${user_id} failed: ` +
            `${(err as Error).message}`
        );
        result.per_user_errors.push({
          user_id,
          error: (err as Error).message,
        });
      }
    }

    return result;
  }

  /** Return the user's effective trailing-stop config (defaults if not customized). */
  async getConfig(user_id: number): Promise<TrailingStopConfig> {
    return this.source.loadConfig(user_id);
  }

  /** Persist a (normalized) updated config for the user. */
  async updateConfig(user_id: number, raw: any): Promise<TrailingStopConfig> {
    const normalized = normalizeTrailingStopConfig(raw);
    return this.source.saveConfig(user_id, normalized);
  }
}

/** Singleton — controllers / scheduler reach this instead of `new`-ing per call. */
export const trailingStopGuard = new TrailingStopGuard();
