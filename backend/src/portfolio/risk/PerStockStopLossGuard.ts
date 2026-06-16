/**
 * PerStockStopLossGuard — US-051
 *
 * **每股最大跌幅止损** — 每日收盘后扫描所有持仓，对每只股票计算
 * `(close - avg_cost) / avg_cost`；若亏损达到阈值（默认 -7%）触发 SELL
 * 信号（写 RiskAlert(level='HIGH') + 返回结构化 trigger）。
 *
 * 与 US-048 TrailingStopGuard 的区别（两者互补）：
 *   - TrailingStopGuard 看的是 **从 high water-mark 回撤**（保利润逃顶）；
 *   - PerStockStopLossGuard 看的是 **从建仓成本下跌**（绝对止损，硬保本）。
 *   两个 guard 共存：浮盈大的票走 trailing（先把利润保住），新仓
 *   还没起来的票走 per-stock stop-loss（避免下隔夜亏 7% 以上）。
 *
 * AC 关键点：
 *   1. 在 `backend/src/portfolio/risk/` 新建 PerStockStopLossGuard.ts；
 *   2. 每日收盘后扫描所有持仓，若 `(close - buy_price) / buy_price ≤ -7%`
 *      触发 SELL 信号；
 *   3. 若触发数 ≥ 持仓总数 50% → 额外触发 **组合级 LEVEL_2 RiskAlert**
 *      (symbol=`SYSTEM:PER_STOCK_STOP_LOSS_MASS`, level='HIGH')；
 *   4. 在 PaperTradingFacade 集成此 guard（re-export 让 controller 可调）；
 *   5. 可在 **策略级** 覆盖默认止损阈值（per-position `stop_loss_pct`
 *      column 优先 > user 全局 > DEFAULT 7%）；
 *   6. 新增单元测试。
 *
 * 触发流程：
 *   `evaluateAfterClose(user_id?, asOfDate?, dry_run?)` — 收盘后定时任务
 *   - 默认 scope = 所有有 PaperTradingPortfolio 的用户；user_id 限定单 user；
 *   - 每个用户独立 try/catch 隔离（同 US-047/US-048/US-049 pattern）；
 *   - per-position：取最新 DailyBar.close → 算 loss_ratio → 比对 effective_pct
 *     → 触发 RiskAlert(level='HIGH', symbol=持仓 symbol) + trigger 返回；
 *   - mass-trigger：若一个用户的 triggered_count ≥ Math.ceil(open_count * 0.5)
 *     → 额外写一行 RiskAlert(level='HIGH', symbol='SYSTEM:PER_STOCK_STOP_LOSS_MASS')
 *     标识 "组合级 LEVEL_2" 群体止损事件。
 *
 * 设计约束 — 沿用 US-047/US-048/US-049 的 7 项 checklist：
 *   - DataSource 接口注入（生产 Sequelize + 测试 fake）；
 *   - 纯函数 helper 全 export 让单测无需 DB；
 *   - 配置在 User.risk_config.per_stock_stop_loss JSONB + Object.freeze 默认；
 *   - 个股触发 = RiskAlert(level='HIGH', symbol=个股 symbol)；
 *     mass 触发 = RiskAlert(level='HIGH', symbol='SYSTEM:PER_STOCK_STOP_LOSS_MASS')；
 *     writeAlert failure 用 logger.warn 不掩盖 trigger（同 US-047 pattern）；
 *   - 单 user 失败 try/catch 隔离不阻塞剩余 user；
 *   - HTTP 入口 GET/PUT /api/risk/per-stock-stop-loss，与现有
 *     /position-limits、/trailing-stop、/drawdown-breaker、/market-regime 同 namespace；
 *   - 不破坏 facade 收敛 — guard 只输出 trigger，调用方（自动撮合 / 人工 /
 *     UI dashboard）决定真实撮合时机。
 *
 * 边界与坑：
 *   - **触发判定 `loss_ratio ≤ -effective_pct`** —— 用 `≤` 包含 boundary
 *     （保护性硬触发立即止血；与 US-048 trigger、US-049 LEVEL_X 阈值一致；
 *     US-047 单股仓位 `>` 是相反方向 — 防御 vs 限制是 2 种 boundary）；
 *   - **avg_cost ≤ 0**（数据脏 / 赠送股）→ 跳过该持仓（除零保护，
 *     同 US-049 computeGainRatio cost_basis 守门）；
 *   - **DailyBar 缺当日 close** → 跳过该持仓 status='skipped_no_bar'
 *     （不退回 current_price — current_price 会被 facade 下单流程 mutate
 *     可能漂移误触发；同 US-048 "数据不足 ≠ 信号" 原则）；
 *   - **mass-trigger 50% 取 `Math.ceil(open_count * 0.5)` 包含等于 50%**
 *     （`Math.ceil(2 × 0.5) = 1`，2 仓位中 1 仓位触发即满足 50% → mass；
 *     此为强 disposal 路径，与 US-049 LEVEL_2 `Math.ceil(N/2)` 同款语义）；
 *   - **effective_pct 三级覆盖**：position.stop_loss_pct > user.risk_config
 *     .per_stock_stop_loss.pct > DEFAULT 0.07，沿用 US-048 pickEffectivePct
 *     模式；
 *   - **PaperTradingPosition.stop_loss_pct 列暂不存在**：本 guard 引入对
 *     `position.trailing_stop_pct` 列的**别名复用**（per-position 止损语义
 *     与追踪止损共享同一字段更精简）。如果未来需要"硬止损"与"追踪止损"
 *     完全独立的 pct，再加一个 `stop_loss_pct` 列升级路径。
 *   - **enabled=false**：整 user 跳过（returns NONE level，不写任何 alert）；
 *   - **触发后不清零** — `stop_loss_pct` / 持仓本身 由 facade.placeOrder SELL
 *     链路负责，guard 不直接动列。
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

export interface PerStockStopLossConfig {
  /** 是否启用（false = 跳过整个 guard）。 */
  enabled: boolean;
  /** 止损阈值 0-1（e.g. 0.07 = 亏损 7% 触发止损）。 */
  pct: number;
  /**
   * Mass-trigger 触发比例 0-1（e.g. 0.5 = 50% 持仓同时触发 → 写
   * 组合级 LEVEL_2 告警）。允许 0 / 1 边界值（0 = 任一触发就 mass；
   * 1 = 全部触发才 mass）。
   */
  mass_threshold_ratio: number;
}

/**
 * 默认配置（AC 指定）：启用 + 7% 止损 + 50% mass 阈值。
 *
 * Object.freeze 防止模块级常量被意外 mutate（US-037 codebase pattern）。
 */
export const DEFAULT_PER_STOCK_STOP_LOSS_CONFIG: PerStockStopLossConfig = Object.freeze({
  enabled: true,
  pct: 0.07,
  mass_threshold_ratio: 0.5,
});

/** 组合级 mass-trigger 哨兵 symbol（同 US-049 / US-050 SYSTEM: 前缀范式）。 */
export const PER_STOCK_STOP_LOSS_MASS_SYMBOL = 'SYSTEM:PER_STOCK_STOP_LOSS_MASS';

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
  /**
   * 策略层覆盖的止损阈值（NULL=继承用户全局配置）。
   * 当前复用 PaperTradingPosition.trailing_stop_pct 列 — 见模块顶 jsdoc
   * "PaperTradingPosition.stop_loss_pct 列暂不存在" 段落的升级路径说明。
   */
  stop_loss_pct: number | null;
}

/** A SELL trigger surfaced by `evaluateAfterClose`. */
export interface PerStockStopLossTrigger {
  user_id: number;
  position_id: number;
  symbol: string;
  name: string;
  quantity: number;
  avg_cost: number;
  /** 触发当日的收盘价。 */
  today_close: number;
  /** (today_close - avg_cost) / avg_cost — 始终为负数（亏损率）。 */
  loss_ratio: number;
  /** 命中的有效止损阈值（避免单测时再去查 pickEffectivePct）。 */
  effective_pct: number;
  /** 中文告警 message（已含 symbol / 亏损率 / 阈值）。 */
  message: string;
}

/** Per-position evaluation result (for reporting / tests). */
export interface PerPositionResult {
  position_id: number;
  symbol: string;
  status:
    | 'triggered'
    | 'no_trigger'
    | 'skipped_no_bar'
    | 'skipped_no_quantity'
    | 'skipped_bad_cost';
  loss_ratio?: number;
  effective_pct?: number;
  today_close?: number;
  avg_cost?: number;
  reason?: string;
}

/** Per-user evaluation result. */
export interface PerStockStopLossUserResult {
  user_id: number;
  portfolio_id: number | null;
  /** "NONE"=无触发；"INDIVIDUAL"=有个股触发但未达 mass；"MASS"=触发数达到 mass 阈值。 */
  level: 'NONE' | 'INDIVIDUAL' | 'MASS';
  open_positions_count: number;
  triggered_count: number;
  results: PerPositionResult[];
  triggers: PerStockStopLossTrigger[];
  /** mass-trigger message（仅 level='MASS' 时存在）。 */
  mass_message?: string;
  error?: string;
}

/** Aggregate result of batch evaluation across all users. */
export interface PerStockStopLossEvaluationResult {
  scanned_users: number;
  triggered_users: number;
  /** 所有用户的 trigger 平铺（方便自动撮合层一次性处理）。 */
  triggers: PerStockStopLossTrigger[];
  per_user: PerStockStopLossUserResult[];
}

// ---------------------------------------------------------------------------
//  Pure helpers (export for unit tests — no DB)
// ---------------------------------------------------------------------------

/**
 * 选定 effective_pct — 三级覆盖（与 US-048 pickEffectivePct 同款）：
 *   1. position.stop_loss_pct (策略层在开仓时按个股波动定制)
 *   2. user_config.pct (用户全局偏好)
 *   3. DEFAULT_PER_STOCK_STOP_LOSS_CONFIG.pct (兜底 0.07)
 *
 * 接受 0 ≤ pct ≤ 1 的合法值；超出范围或非有限数走下一级。
 */
export function pickEffectivePct(
  positionPct: number | null | undefined,
  userPct: number | null | undefined
): number {
  const isValid = (v: any): v is number =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
  if (isValid(positionPct)) return positionPct as number;
  if (isValid(userPct)) return userPct as number;
  return DEFAULT_PER_STOCK_STOP_LOSS_CONFIG.pct;
}

/**
 * 计算亏损率 = (today_close - avg_cost) / avg_cost。
 *
 * - avg_cost ≤ 0 / 非有限 → 返回 null（除零保护，guard 跳过该持仓）；
 * - today_close 非有限 → 返回 null；
 * - 否则返回 (close-cost)/cost，正数=盈利，负数=亏损。
 */
export function computeLossRatio(todayClose: number, avgCost: number): number | null {
  if (!Number.isFinite(avgCost) || avgCost <= 0) return null;
  if (!Number.isFinite(todayClose)) return null;
  return (todayClose - avgCost) / avgCost;
}

/**
 * 触发判定：`loss_ratio ≤ -effective_pct` 算触发。
 *
 * 用 `≤` 包含 boundary（保护性硬触发立即止血；与 US-048 trigger 一致）。
 * effective_pct ≤ 0 → false（pct=0 意味着 "永远不触发"，防御性返回）；
 * loss_ratio null（即 cost 异常）→ false。
 */
export function evaluatePerStockStopLossTrigger(
  lossRatio: number | null,
  effectivePct: number
): boolean {
  if (lossRatio === null || !Number.isFinite(lossRatio)) return false;
  if (!Number.isFinite(effectivePct) || effectivePct <= 0) return false;
  return lossRatio <= -effectivePct;
}

/**
 * 判定 mass-trigger：triggered_count ≥ Math.ceil(open_count * threshold_ratio)。
 *
 * `Math.ceil` 是强 disposal 路径（同 US-049 LEVEL_2 / pickLevel2TrimTargets）：
 * - threshold=0.5, open=2, triggered=1 → ceil(1) = 1 ≤ 1 → mass；
 * - threshold=0.5, open=3, triggered=2 → ceil(1.5) = 2 ≤ 2 → mass；
 * - threshold=0.5, open=4, triggered=2 → ceil(2) = 2 ≤ 2 → mass；
 * - threshold=0.5, open=5, triggered=2 → ceil(2.5) = 3 > 2 → 非 mass；
 *
 * open_count = 0 → false（无持仓不存在 mass 概念）；
 * threshold_ratio ≤ 0 → 任一触发都算 mass（threshold=0 退化）；
 * threshold_ratio > 1 → 永远不算 mass（threshold=2 退化）。
 */
export function evaluateMassTrigger(
  triggeredCount: number,
  openCount: number,
  thresholdRatio: number
): boolean {
  if (!Number.isFinite(openCount) || openCount <= 0) return false;
  if (!Number.isFinite(triggeredCount) || triggeredCount <= 0) return false;
  if (!Number.isFinite(thresholdRatio) || thresholdRatio < 0 || thresholdRatio > 1) return false;
  const threshold = Math.ceil(openCount * thresholdRatio);
  return triggeredCount >= threshold;
}

/**
 * 净化 raw config blob（来自 User.risk_config 或 PUT body）。
 *
 * - 非有限数 / 负 / >1 的 pct / mass_threshold_ratio → 默认；
 * - 非 boolean 的 enabled → 默认 (true)；
 *
 * 与 US-047/US-048/US-049 normalize 同款"沉默退回默认不 4xx"的范式。
 */
export function normalizePerStockStopLossConfig(raw: any): PerStockStopLossConfig {
  const safePct = (v: any, dflt: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 && n <= 1 ? n : dflt;
  };
  const safeBool = (v: any, dflt: boolean) => (typeof v === 'boolean' ? v : dflt);
  return {
    enabled: safeBool(raw?.enabled, DEFAULT_PER_STOCK_STOP_LOSS_CONFIG.enabled),
    pct: safePct(raw?.pct, DEFAULT_PER_STOCK_STOP_LOSS_CONFIG.pct),
    mass_threshold_ratio: safePct(
      raw?.mass_threshold_ratio,
      DEFAULT_PER_STOCK_STOP_LOSS_CONFIG.mass_threshold_ratio
    ),
  };
}

/** 拼装人类可读的个股触发说明（中文）。 */
export function buildPerStockStopLossMessage(input: {
  symbol: string;
  today_close: number;
  avg_cost: number;
  loss_ratio: number;
  effective_pct: number;
}): string {
  return (
    `${input.symbol} 触发每股止损：` +
    `今日收盘 ${input.today_close.toFixed(3)} vs 成本 ${input.avg_cost.toFixed(3)}，` +
    `亏损 ${(input.loss_ratio * 100).toFixed(2)}%（阈值 -${(input.effective_pct * 100).toFixed(
      2
    )}%）。` +
    `建议次日开盘卖出。`
  );
}

/** 拼装组合级 mass-trigger 告警（中文）。 */
export function buildMassTriggerMessage(input: {
  triggered_count: number;
  open_count: number;
  threshold_ratio: number;
}): string {
  return (
    `组合级 LEVEL_2 群体止损：当前 ${input.open_count} 只持仓中 ${input.triggered_count} 只` +
    `（${((input.triggered_count / input.open_count) * 100).toFixed(2)}%）触发每股止损，` +
    `已达 mass 阈值 ${(input.threshold_ratio * 100).toFixed(2)}%。` +
    `建议人工复核后整体降仓。`
  );
}

// ---------------------------------------------------------------------------
//  DataSource — DI seam for unit tests
// ---------------------------------------------------------------------------

export interface PerStockStopLossDataSource {
  /** Load all users with at least one paper-trading portfolio (for batch mode). */
  loadAllUserIdsWithPortfolios(): Promise<number[]>;
  /** Load this user's effective config (defaults if absent). */
  loadConfig(user_id: number): Promise<PerStockStopLossConfig>;
  /** Persist this user's config (UPSERT semantics). */
  saveConfig(user_id: number, config: PerStockStopLossConfig): Promise<PerStockStopLossConfig>;
  /** Load the user's portfolio header (just id). */
  loadPortfolioId(user_id: number): Promise<number | null>;
  /** Load all open positions (quantity > 0) for the user. */
  loadOpenPositions(user_id: number): Promise<PositionSnapshot[]>;
  /**
   * Load the latest available close price for `symbol` on or before `asOfDate`.
   * Returns null if no DailyBar exists in the lookback window.
   */
  loadLatestClose(symbol: string, asOfDate: Date): Promise<{ close: number; date: Date } | null>;
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
 * (DailyBar.symbol via Stock lookup) live here so the guard methods only
 * see snapshot bag types.
 */
export class DefaultPerStockStopLossDataSource implements PerStockStopLossDataSource {
  async loadAllUserIdsWithPortfolios(): Promise<number[]> {
    const rows = await PaperTradingPortfolio.findAll({
      attributes: ['user_id'],
      group: ['user_id'],
    });
    return rows.map(r => r.user_id);
  }

  async loadConfig(user_id: number): Promise<PerStockStopLossConfig> {
    const user = await User.findByPk(user_id);
    const raw = user?.risk_config?.per_stock_stop_loss;
    return normalizePerStockStopLossConfig(raw);
  }

  async saveConfig(
    user_id: number,
    config: PerStockStopLossConfig
  ): Promise<PerStockStopLossConfig> {
    const user = await User.findByPk(user_id);
    if (!user) {
      throw new Error(`saveConfig: user ${user_id} not found`);
    }
    const merged = {
      ...(user.risk_config || {}),
      per_stock_stop_loss: { ...config },
    };
    user.risk_config = merged;
    // JSONB columns require explicit `changed('field', true)` per US-017.
    user.changed('risk_config', true);
    await user.save();
    return { ...config };
  }

  async loadPortfolioId(user_id: number): Promise<number | null> {
    // 修复 (2026-06-16, HIGH H2): 兼容旧 caller; 多 portfolio 应改用 loadOpenPositions.
    const p = await PaperTradingPortfolio.findOne({
      where: { user_id, is_active: true },
      order: [['id', 'ASC']],
    });
    return p ? p.id : null;
  }

  async loadOpenPositions(user_id: number): Promise<PositionSnapshot[]> {
    // 修复 (HIGH H2): 跨所有 active portfolio 拉持仓
    const portfolios = await PaperTradingPortfolio.findAll({
      where: { user_id, is_active: true },
      attributes: ['id'],
    });
    if (portfolios.length === 0) return [];
    const rows = await PaperTradingPosition.findAll({
      where: {
        portfolio_id: { [Op.in]: portfolios.map(p => p.id) },
        quantity: { [Op.gt]: 0 },
      },
    });
    return rows.map<PositionSnapshot>(r => ({
      id: r.id,
      portfolio_id: r.portfolio_id,
      symbol: r.symbol,
      name: r.name,
      quantity: Number(r.quantity),
      avg_cost: Number(r.avg_cost),
      current_price: Number(r.current_price),
      // 复用 trailing_stop_pct 列承载 per-position 止损覆盖（见模块顶 jsdoc）。
      stop_loss_pct: r.trailing_stop_pct === null ? null : Number(r.trailing_stop_pct),
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
      // US-067 — 给 RealtimeAlertDispatcher dedup signature 用。
      rule_id: 'per_stock_stop_loss',
      is_read: false,
    } as any);
  }
}

export const PRODUCTION_PER_STOCK_STOP_LOSS_DATA_SOURCE: PerStockStopLossDataSource =
  new DefaultPerStockStopLossDataSource();

// ---------------------------------------------------------------------------
//  Guard — public entry point
// ---------------------------------------------------------------------------

export interface EvaluateAfterCloseOptions {
  /** If set, only process this user. Otherwise scan all users with portfolios. */
  user_id?: number;
  /** Override the date used to query DailyBar (defaults to "now"). */
  asOfDate?: Date;
  /** If true, do NOT write RiskAlert rows (dry-run mode for UI dashboards). */
  dry_run?: boolean;
}

export class PerStockStopLossGuard {
  private source: PerStockStopLossDataSource;

  constructor(source: PerStockStopLossDataSource = PRODUCTION_PER_STOCK_STOP_LOSS_DATA_SOURCE) {
    this.source = source;
  }

  /**
   * 每日收盘后批量评估所有用户的每股止损触发。
   *
   * - 单 user 失败 try/catch 隔离（同 US-047 / US-048 / US-049 pattern）；
   * - disabled 用户跳过整个评估（returns NONE 不写任何 alert）；
   * - 个股触发 → 写 RiskAlert(level='HIGH', symbol=持仓 symbol) + trigger 返回；
   * - mass 触发 → 额外写一行 RiskAlert(level='HIGH',
   *   symbol='SYSTEM:PER_STOCK_STOP_LOSS_MASS')；
   * - 不直接调用 facade.placeOrder — 由调用方（PaperTradingAutomationService /
   *   人工审批 / UI dashboard）决定真实撮合时机（保持 facade 7-method 收敛）。
   *
   * `dry_run=true` 跳过 RiskAlert 写入但仍返回完整 trigger / per_user 列表
   * （UI 预演用）。
   */
  async evaluateAfterClose(
    options: EvaluateAfterCloseOptions = {}
  ): Promise<PerStockStopLossEvaluationResult> {
    const asOfDate = options.asOfDate ?? new Date();
    const dryRun = Boolean(options.dry_run);
    const userIds = options.user_id
      ? [options.user_id]
      : await this.source.loadAllUserIdsWithPortfolios();

    const result: PerStockStopLossEvaluationResult = {
      scanned_users: userIds.length,
      triggered_users: 0,
      triggers: [],
      per_user: [],
    };

    for (const user_id of userIds) {
      try {
        const userResult = await this.evaluateOneUser(user_id, asOfDate, dryRun);
        result.per_user.push(userResult);
        if (userResult.level !== 'NONE') {
          result.triggered_users += 1;
        }
        result.triggers.push(...userResult.triggers);
      } catch (err) {
        logger.warn(
          `PerStockStopLossGuard.evaluateAfterClose user=${user_id} failed: ` +
            `${(err as Error).message}`
        );
        result.per_user.push({
          user_id,
          portfolio_id: null,
          level: 'NONE',
          open_positions_count: 0,
          triggered_count: 0,
          results: [],
          triggers: [],
          error: (err as Error).message,
        });
      }
    }

    return result;
  }

  /** Single-user evaluation extracted for clarity. */
  private async evaluateOneUser(
    user_id: number,
    asOfDate: Date,
    dryRun: boolean
  ): Promise<PerStockStopLossUserResult> {
    const config = await this.source.loadConfig(user_id);
    const portfolio_id = await this.source.loadPortfolioId(user_id);
    if (portfolio_id === null) {
      return {
        user_id,
        portfolio_id: null,
        level: 'NONE',
        open_positions_count: 0,
        triggered_count: 0,
        results: [],
        triggers: [],
      };
    }
    const positions = await this.source.loadOpenPositions(user_id);
    const open_positions_count = positions.filter(p => p.quantity > 0).length;

    if (!config.enabled) {
      return {
        user_id,
        portfolio_id,
        level: 'NONE',
        open_positions_count,
        triggered_count: 0,
        results: positions.map(p => ({
          position_id: p.id,
          symbol: p.symbol,
          status: 'no_trigger' as const,
          reason: 'per_stock_stop_loss disabled for user',
        })),
        triggers: [],
      };
    }

    const perPosition: PerPositionResult[] = [];
    const triggers: PerStockStopLossTrigger[] = [];

    for (const pos of positions) {
      if (!(pos.quantity > 0)) {
        perPosition.push({
          position_id: pos.id,
          symbol: pos.symbol,
          status: 'skipped_no_quantity',
          reason: 'quantity <= 0',
        });
        continue;
      }
      if (!(pos.avg_cost > 0)) {
        perPosition.push({
          position_id: pos.id,
          symbol: pos.symbol,
          status: 'skipped_bad_cost',
          avg_cost: pos.avg_cost,
          reason: 'avg_cost <= 0',
        });
        continue;
      }
      const bar = await this.source.loadLatestClose(pos.symbol, asOfDate);
      if (!bar) {
        perPosition.push({
          position_id: pos.id,
          symbol: pos.symbol,
          status: 'skipped_no_bar',
          avg_cost: pos.avg_cost,
          reason: 'no DailyBar on/before asOfDate',
        });
        continue;
      }
      const effective_pct = pickEffectivePct(pos.stop_loss_pct, config.pct);
      const loss_ratio = computeLossRatio(bar.close, pos.avg_cost);
      const triggered = evaluatePerStockStopLossTrigger(loss_ratio, effective_pct);

      if (!triggered) {
        perPosition.push({
          position_id: pos.id,
          symbol: pos.symbol,
          status: 'no_trigger',
          loss_ratio: loss_ratio ?? undefined,
          effective_pct,
          today_close: bar.close,
          avg_cost: pos.avg_cost,
        });
        continue;
      }

      const message = buildPerStockStopLossMessage({
        symbol: pos.symbol,
        today_close: bar.close,
        avg_cost: pos.avg_cost,
        loss_ratio: loss_ratio as number,
        effective_pct,
      });
      const trigger: PerStockStopLossTrigger = {
        user_id,
        position_id: pos.id,
        symbol: pos.symbol,
        name: pos.name || pos.symbol,
        quantity: pos.quantity,
        avg_cost: pos.avg_cost,
        today_close: bar.close,
        loss_ratio: loss_ratio as number,
        effective_pct,
        message,
      };
      triggers.push(trigger);
      perPosition.push({
        position_id: pos.id,
        symbol: pos.symbol,
        status: 'triggered',
        loss_ratio: loss_ratio ?? undefined,
        effective_pct,
        today_close: bar.close,
        avg_cost: pos.avg_cost,
      });

      if (!dryRun) {
        try {
          await this.source.writeAlert({
            user_id,
            symbol: pos.symbol,
            name: `每股止损 - ${pos.name || pos.symbol}`,
            message,
          });
        } catch (err) {
          logger.warn(
            `PerStockStopLossGuard.writeAlert user=${user_id} ` +
              `symbol=${pos.symbol}: ${(err as Error).message}`
          );
        }
      }
    }

    const triggered_count = triggers.length;
    const isMass = evaluateMassTrigger(
      triggered_count,
      open_positions_count,
      config.mass_threshold_ratio
    );

    let mass_message: string | undefined;
    if (isMass) {
      mass_message = buildMassTriggerMessage({
        triggered_count,
        open_count: open_positions_count,
        threshold_ratio: config.mass_threshold_ratio,
      });
      if (!dryRun) {
        try {
          await this.source.writeAlert({
            user_id,
            symbol: PER_STOCK_STOP_LOSS_MASS_SYMBOL,
            name: '组合级 LEVEL_2 群体止损',
            message: mass_message,
          });
        } catch (err) {
          logger.warn(
            `PerStockStopLossGuard.writeMassAlert user=${user_id}: ` + `${(err as Error).message}`
          );
        }
      }
    }

    const level: PerStockStopLossUserResult['level'] = isMass
      ? 'MASS'
      : triggered_count > 0
      ? 'INDIVIDUAL'
      : 'NONE';

    return {
      user_id,
      portfolio_id,
      level,
      open_positions_count,
      triggered_count,
      results: perPosition,
      triggers,
      mass_message,
    };
  }

  /** Return the user's effective config (defaults if not customized). */
  async getConfig(user_id: number): Promise<PerStockStopLossConfig> {
    return this.source.loadConfig(user_id);
  }

  /** Persist a (normalized) updated config for the user. */
  async updateConfig(user_id: number, raw: any): Promise<PerStockStopLossConfig> {
    const normalized = normalizePerStockStopLossConfig(raw);
    return this.source.saveConfig(user_id, normalized);
  }
}

/** Singleton — controllers / scheduler / facade reach this instead of `new`-ing per call. */
export const perStockStopLossGuard = new PerStockStopLossGuard();
