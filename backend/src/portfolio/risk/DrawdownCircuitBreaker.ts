/**
 * DrawdownCircuitBreaker — US-049
 *
 * 组合级回撤熔断 — 当组合的当前总资产相对历史峰值的回撤超过阈值时按 3 个
 * 等级累进触发风控动作：
 *
 *   LEVEL_1  drawdown ≥ 10%  →  暂停新开仓 24h（不影响减仓/平仓）
 *   LEVEL_2  drawdown ≥ 15%  →  减仓至 50%（卖出涨幅最大的 50% 标的）
 *   LEVEL_3  drawdown ≥ 20%  →  清仓（卖出全部持仓）
 *
 * 与 US-047 (PositionLimitGuard) / US-048 (TrailingStopGuard) 互补的第三类
 * 风控形态：**组合级而非个股级**。前两者关注 "新单是否允许 / 单股是否止损"，
 * 本 guard 关注 "整体组合何时进入应急模式"。
 *
 * 触发流程：
 *   (1) `evaluateAfterClose(user_id?)` — 每日收盘后定时任务：
 *       - 从 PaperTradingSnapshot 历史 + 当前 portfolio.total_value 取 max(peak_value)
 *       - drawdown = (peak_value - current_value) / peak_value
 *       - 按 LEVEL_3 → LEVEL_2 → LEVEL_1 优先匹配，写 RiskAlert(level='HIGH')
 *       - LEVEL_1 命中：把 `paused_until = now + 24h` 落库到
 *         User.risk_config.drawdown_breaker.paused_until（让下一次 BUY 检查能看到）
 *       - LEVEL_2/LEVEL_3 命中：返回结构化 trigger（symbols + qty + reason），
 *         **不**直接调用 facade.placeOrder（保持 facade 7-method 收敛 + 与 US-048
 *         同款"guard 输出 trigger / caller 决定撮合"）
 *   (2) `checkBuyAllowed(user_id, symbol)` — placeOrder BUY 链路 inline：
 *       - 若 User.risk_config.drawdown_breaker.paused_until > now → 阻断新开仓
 *       - 仅阻断"开新仓"（symbol 不在持仓内）；加仓允许（避免误伤策略加仓）
 *       - 注意 SELL 永远放行（即使在 LEVEL_3 期间也允许平仓）
 *
 * 设计约束 — 沿用 US-047/US-048 的 7 项 checklist：
 *   - DataSource 接口注入（生产 Sequelize + 测试 fake）；
 *   - 纯函数 helper 全 export 让单测无需 DB；
 *   - 配置在 User.risk_config.drawdown_breaker JSONB + Object.freeze 默认；
 *   - LEVEL_X 告警 = RiskAlert(level='HIGH') 写入，failure logger.warn 不掩盖 trigger；
 *   - 单 user 失败 try/catch 隔离不阻塞剩余 user；
 *   - HTTP 入口 GET/PUT /api/risk/drawdown-breaker，与现有 /position-limits、
 *     /trailing-stop 同 namespace；
 *   - 不破坏 facade 收敛 — guard 输出 trigger / pause 状态，调用方（自动撮合 /
 *     人工审批 / UI dashboard）决定真实下单时机。
 *
 * 优先级链（LEVEL_3 > LEVEL_2 > LEVEL_1）镜像 US-047 单一 violation 短路链 —
 * 一次只发一个最高 level 告警 + 一组 trigger 让用户面对清晰的一种应急动作，
 * 不要 cascade 三件套混淆决策。
 *
 * 边界与坑：
 *   - peak_value 取 max(snapshots.total_value, current_total_value) — 包含
 *     当前未落 snapshot 的实时总值，防止 "今天涨破历史峰但 snapshot 还没生成"
 *     的窗口期内回撤被低估；
 *   - drawdown ≥ 阈值用 `≥` 包含 boundary（保护性硬触发，与 US-048 触发
 *     语义一致；US-047 单股限制用 `>` 是反向 — 防御 vs 限制是两种 boundary）；
 *   - LEVEL_2 涨幅排序按 `(market_value - cost_basis) / cost_basis` desc，
 *     symbol asc 稳定 tie-break（与 US-025 GameTraderRelay 稳定排序模式一致）；
 *   - LEVEL_2 卖 50% 用 `Math.ceil(N/2)` 让 N=3 时卖 2 只（强 disposal 路径），
 *     N=1 时卖 1 只（剩 0），N=0 时不报错；
 *   - peak_value <= 0（账户初始化未注资）safe HOLD 不算回撤，避免除零；
 *   - paused_until 是 ISO timestamp string（不是 epoch ms）以便审计跨时区可读；
 *     比较时统一 `new Date(s).getTime()` 保证 timezone-safe。
 */

import { Op } from 'sequelize';
import { sequelize } from '../../config/database';
import { PaperTradingPosition } from '../../models/PaperTradingPosition';
import { PaperTradingPortfolio } from '../../models/PaperTradingPortfolio';
import { PaperTradingSnapshot } from '../../models/PaperTradingSnapshot';
import { RiskAlert } from '../../models/RiskAlert';
import { User } from '../../models/User';
import { logger } from '../../utils/logger';
import { RiskGuardUnavailableError, wrapFailClosed } from './RiskGuardFailClosed';

// ---------------------------------------------------------------------------
//  Back-compat re-export — US-011 (PR-006) moved the canonical declaration
//  to RiskGuardFailClosed.ts. Existing imports of RiskGuardUnavailableError
//  from DrawdownCircuitBreaker keep working (preTradeGuards / PaperTradingFacade
//  / multiple .test.ts files), but new code should import from the new home.
// ---------------------------------------------------------------------------

export { RiskGuardUnavailableError };

// ---------------------------------------------------------------------------
//  Config
// ---------------------------------------------------------------------------

export interface DrawdownBreakerConfig {
  /** 是否启用（false = 跳过整个 guard）。 */
  enabled: boolean;
  /** LEVEL_1 阈值，0-1（e.g. 0.10 = 回撤 10% 暂停新开仓 24h）。 */
  level1_pct: number;
  /** LEVEL_2 阈值，0-1（e.g. 0.15 = 回撤 15% 减仓至 50%）。 */
  level2_pct: number;
  /** LEVEL_3 阈值，0-1（e.g. 0.20 = 回撤 20% 清仓）。 */
  level3_pct: number;
  /** LEVEL_1 暂停时长（毫秒），默认 24h = 86400000。 */
  level1_pause_ms: number;
}

/**
 * 默认配置（AC 指定）：LEVEL_1=10% / LEVEL_2=15% / LEVEL_3=20% / 暂停 24h。
 *
 * Object.freeze 防止模块级常量被意外 mutate（US-037 codebase pattern）。
 */
export const DEFAULT_DRAWDOWN_BREAKER_CONFIG: DrawdownBreakerConfig = Object.freeze({
  enabled: true,
  level1_pct: 0.1,
  level2_pct: 0.15,
  level3_pct: 0.2,
  level1_pause_ms: 24 * 60 * 60 * 1000,
});

// ---------------------------------------------------------------------------
//  Domain types
// ---------------------------------------------------------------------------

/** Snapshot used to find historical peak. */
export interface PortfolioSnapshotRow {
  /** Calendar date 'YYYY-MM-DD'. */
  date: string;
  total_value: number;
}

/** Current portfolio header used in drawdown calc. */
export interface PortfolioHeader {
  id: number;
  total_value: number;
}

/** Position snapshot for LEVEL_2 trim selection. */
export interface DrawdownPositionSnapshot {
  id: number;
  /** Batch J (2026-06-17): 让 trigger 能 propagate portfolio_id 给 GuardSellExecutor. */
  portfolio_id: number;
  symbol: string;
  name?: string | null;
  quantity: number;
  /** Average cost basis per share. */
  avg_cost: number;
  /** Latest market price (close). */
  current_price: number;
  /** Latest market value = quantity * current_price. */
  market_value: number;
}

/** Drawdown evaluation level. */
export type DrawdownLevel = 'NONE' | 'LEVEL_1' | 'LEVEL_2' | 'LEVEL_3';

/** Sell trigger surfaced by `evaluateAfterClose` for LEVEL_2/LEVEL_3. */
export interface DrawdownSellTrigger {
  user_id: number;
  position_id: number;
  /** Batch J (2026-06-17): 接 GuardSellExecutor 必须的 portfolio_id, 防多盘用户串盘. */
  portfolio_id: number;
  symbol: string;
  name: string;
  quantity: number;
  /** "(market - cost)/cost" gain ratio at trigger time (sort key). */
  gain_ratio: number;
  reason: string;
}

/** Result of one user's drawdown evaluation (returned by `evaluateAfterClose`). */
export interface DrawdownEvaluationResult {
  user_id: number;
  portfolio_id: number | null;
  level: DrawdownLevel;
  peak_value: number;
  current_value: number;
  drawdown_pct: number;
  message?: string;
  /** Newly applied `paused_until` ISO timestamp (LEVEL_1 only). */
  paused_until?: string;
  /** SELL triggers for LEVEL_2/LEVEL_3 (caller decides撮合 timing). */
  triggers: DrawdownSellTrigger[];
  error?: string;
}

/** Aggregate result of batch evaluation across all users. */
export interface EvaluateAfterCloseResult {
  scanned_users: number;
  triggered_users: number;
  /** All triggers across all users — convenient flat list for automation. */
  triggers: DrawdownSellTrigger[];
  per_user: DrawdownEvaluationResult[];
}

// ---------------------------------------------------------------------------
//  Pure helpers (export for unit tests — no DB)
// ---------------------------------------------------------------------------

/**
 * 计算 peak_value = max(snapshots.total_value, current_total_value)。
 *
 * 包含当前实时值是为了防止 "今天总值刚破历史峰但 snapshot 还没落库"
 * 的窗口期内回撤被低估（snapshot 是 EOD 周期数据，期间多次评估时不能
 * 让 peak 落后于实时值，否则 drawdown 永远 = 0 后从下次 snapshot 才回正）。
 *
 * 防御性：snapshot 中的非有限数 / 负数被过滤掉，避免 max 被 garbage 拉高。
 */
export function computePeakValue(
  snapshots: PortfolioSnapshotRow[],
  currentTotalValue: number
): number {
  const safeCurrent =
    Number.isFinite(currentTotalValue) && currentTotalValue > 0 ? currentTotalValue : 0;
  const validSnapshotValues = snapshots
    .map(s => Number(s.total_value))
    .filter(v => Number.isFinite(v) && v > 0);
  return Math.max(safeCurrent, ...validSnapshotValues, 0);
}

/**
 * 计算回撤百分比 = (peak - current) / peak。
 *
 * - peak_value ≤ 0 → 0（账户初始化未注资，不算回撤；防御性除零）；
 * - current ≥ peak → 0（创新高时显示无回撤而非负数）；
 * - 否则返回 [0, 1) 的小数。
 */
export function computeDrawdownPct(peakValue: number, currentValue: number): number {
  if (!Number.isFinite(peakValue) || peakValue <= 0) return 0;
  if (!Number.isFinite(currentValue) || currentValue >= peakValue) return 0;
  return (peakValue - currentValue) / peakValue;
}

/**
 * 按 LEVEL_3 → LEVEL_2 → LEVEL_1 → NONE 优先匹配单一 level。
 *
 * 使用 `≥` 包含 boundary（保护性硬触发；与 US-048 trigger 语义一致 —
 * 命中阈值立即生效，不要因 strict `>` 让正好回撤 10% 的用户不触发 LEVEL_1）。
 *
 * 一次只返回一个 level：高 level 自动 supersede 低 level（不重复告警）。
 */
export function pickDrawdownLevel(
  drawdownPct: number,
  config: DrawdownBreakerConfig
): DrawdownLevel {
  if (!Number.isFinite(drawdownPct) || drawdownPct <= 0) return 'NONE';
  if (drawdownPct >= config.level3_pct) return 'LEVEL_3';
  if (drawdownPct >= config.level2_pct) return 'LEVEL_2';
  if (drawdownPct >= config.level1_pct) return 'LEVEL_1';
  return 'NONE';
}

/**
 * 计算单个持仓的 gain_ratio = (market_value - cost_basis) / cost_basis。
 *
 * - cost_basis = avg_cost * quantity。cost_basis ≤ 0 → 返回 0（防御性除零，
 *   避免赠送股 / 数据 corruption 导致排序异常）。
 */
export function computeGainRatio(position: DrawdownPositionSnapshot): number {
  const costBasis = position.avg_cost * position.quantity;
  if (!Number.isFinite(costBasis) || costBasis <= 0) return 0;
  const marketValue = Number.isFinite(position.market_value) ? position.market_value : 0;
  return (marketValue - costBasis) / costBasis;
}

/**
 * 选 LEVEL_2 trim 标的：涨幅最大的 50% 持仓。
 *
 * - 排序：gain_ratio desc，symbol asc 稳定 tie-break（与 US-025 模式一致）；
 * - 数量：Math.ceil(N/2) 让 N=3 卖 2 (强 disposal 路径)，N=1 卖 1，N=0 返回空；
 * - 只考虑 quantity > 0 的持仓（防御性，避免空仓被错误纳入）。
 *
 * 这是一个纯函数：caller 把当前 positions 列表传进来，得到要卖的子集。
 */
export function pickLevel2TrimTargets(
  positions: DrawdownPositionSnapshot[]
): DrawdownPositionSnapshot[] {
  const open = positions.filter(p => p.quantity > 0);
  if (open.length === 0) return [];
  const sorted = [...open].sort((a, b) => {
    const ga = computeGainRatio(a);
    const gb = computeGainRatio(b);
    if (gb !== ga) return gb - ga; // gain desc
    return (a.symbol || '').localeCompare(b.symbol || '');
  });
  const halfCount = Math.ceil(sorted.length / 2);
  return sorted.slice(0, halfCount);
}

/**
 * 选 LEVEL_3 清仓标的 — 全部 quantity > 0 的持仓，按 symbol asc 稳定排序。
 *
 * 稳定排序便于审计 / 自动撮合按确定性顺序下单（避免 V8 排序不稳定让多次
 * 评估顺序不一致影响测试 / replay）。
 */
export function pickLevel3LiquidateTargets(
  positions: DrawdownPositionSnapshot[]
): DrawdownPositionSnapshot[] {
  return positions
    .filter(p => p.quantity > 0)
    .sort((a, b) => (a.symbol || '').localeCompare(b.symbol || ''));
}

/**
 * 净化 raw config blob（来自 User.risk_config 或 PUT body）。
 *
 * - 非有限数 / 负 / >1 的 pct → 默认；
 * - 非正整数的 pause_ms → 默认（24h）；
 * - 非 boolean 的 enabled → 默认 (true)；
 * - 不强制 level1 < level2 < level3 — 用户可以 "把 LEVEL_2 阈值改成 25%
 *   让 LEVEL_3 永远不触发" 作为保守用法，强制递增反而限制定制能力。
 *
 * 与 US-047/US-048 normalize 同款"沉默退回默认不 4xx"的范式。
 */
export function normalizeDrawdownBreakerConfig(raw: any): DrawdownBreakerConfig {
  const safePct = (v: any, dflt: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 && n <= 1 ? n : dflt;
  };
  const safePosInt = (v: any, dflt: number) => {
    const n = Number(v);
    return Number.isFinite(n) && Number.isInteger(n) && n > 0 ? n : dflt;
  };
  const safeBool = (v: any, dflt: boolean) => (typeof v === 'boolean' ? v : dflt);
  return {
    enabled: safeBool(raw?.enabled, DEFAULT_DRAWDOWN_BREAKER_CONFIG.enabled),
    level1_pct: safePct(raw?.level1_pct, DEFAULT_DRAWDOWN_BREAKER_CONFIG.level1_pct),
    level2_pct: safePct(raw?.level2_pct, DEFAULT_DRAWDOWN_BREAKER_CONFIG.level2_pct),
    level3_pct: safePct(raw?.level3_pct, DEFAULT_DRAWDOWN_BREAKER_CONFIG.level3_pct),
    level1_pause_ms: safePosInt(
      raw?.level1_pause_ms,
      DEFAULT_DRAWDOWN_BREAKER_CONFIG.level1_pause_ms
    ),
  };
}

/** 拼装人类可读的告警 message（中文）。 */
export function buildDrawdownMessage(input: {
  level: DrawdownLevel;
  peak_value: number;
  current_value: number;
  drawdown_pct: number;
  threshold_pct: number;
  action_detail: string;
}): string {
  return (
    `组合回撤触发 ${input.level}：` +
    `当前 ${input.current_value.toFixed(2)} 元 vs 历史峰值 ${input.peak_value.toFixed(2)} 元，` +
    `回撤 ${(input.drawdown_pct * 100).toFixed(2)}%（阈值 ${(input.threshold_pct * 100).toFixed(
      2
    )}%）。${input.action_detail}`
  );
}

/**
 * 判定 paused_until 是否仍在生效中（now < paused_until）。
 *
 * `paused_until` 是 ISO timestamp string；非法 / null / 过期都返回 false。
 */
export function isPauseActive(pausedUntil: string | null | undefined, nowMs: number): boolean {
  if (!pausedUntil || typeof pausedUntil !== 'string') return false;
  const expiresMs = new Date(pausedUntil).getTime();
  if (!Number.isFinite(expiresMs)) return false;
  return nowMs < expiresMs;
}

// ---------------------------------------------------------------------------
//  DataSource — DI seam for unit tests
// ---------------------------------------------------------------------------

export interface DrawdownBreakerDataSource {
  /** Load all users with at least one paper-trading portfolio (for batch mode). */
  loadAllUserIdsWithPortfolios(): Promise<number[]>;
  /** Load this user's effective config (defaults if absent). */
  loadConfig(user_id: number): Promise<DrawdownBreakerConfig>;
  /** Persist this user's config (UPSERT semantics). */
  saveConfig(user_id: number, config: DrawdownBreakerConfig): Promise<DrawdownBreakerConfig>;
  /** Load the user's current portfolio header. */
  loadPortfolio(user_id: number): Promise<PortfolioHeader | null>;
  /**
   * Load the user's recent snapshots within `[asOfDate - lookbackDays, asOfDate]`
   * (date-only window).  Default lookback = 365d should cover the historical peak.
   */
  loadRecentSnapshots(
    portfolio_id: number,
    asOfDate: Date,
    lookbackDays: number
  ): Promise<PortfolioSnapshotRow[]>;

  /**
   * Batch J (2026-06-17, H3 fix): cross-portfolio snapshot aggregation by date.
   * 之前 loadRecentSnapshots 只取 portfolio[0].id 的 snapshot, user_id=4 有 9 个盘
   * 但只看 portfolio 24 → peak_value 错估为 0 → drawdown 永远 ≈ 0 → LEVEL_1/2/3
   * 永不触发. 现在 evaluateAfterClose 改调本方法, 把同 user 所有 active portfolio
   * 的 snapshot 按 date GROUP 累加.
   */
  loadRecentSnapshotsByUser?(
    user_id: number,
    asOfDate: Date,
    lookbackDays: number
  ): Promise<PortfolioSnapshotRow[]>;
  /** Load open positions (quantity > 0) for the user. */
  loadOpenPositions(user_id: number): Promise<DrawdownPositionSnapshot[]>;
  /**
   * Load the current `paused_until` ISO timestamp (or null if absent).
   * Used by `checkBuyAllowed` to gate new BUYs without re-reading the whole
   * config blob.
   */
  loadPausedUntil(user_id: number): Promise<string | null>;
  /** Persist a new `paused_until` ISO timestamp on the user's risk_config. */
  savePausedUntil(user_id: number, pausedUntil: string | null): Promise<void>;
  /** Check whether the user already has an open position in `symbol`. */
  hasExistingPosition(user_id: number, symbol: string): Promise<boolean>;
  /** Write a single RiskAlert row (level='HIGH'). */
  writeAlert(input: {
    user_id: number;
    symbol: string;
    name: string;
    message: string;
  }): Promise<void>;
}

/**
 * Production DataSource — backed by Sequelize.  Cross-table joins live here
 * so the guard methods see snapshot bag types only.
 */
export class DefaultDrawdownBreakerDataSource implements DrawdownBreakerDataSource {
  async loadAllUserIdsWithPortfolios(): Promise<number[]> {
    const rows = await PaperTradingPortfolio.findAll({
      attributes: ['user_id'],
      group: ['user_id'],
    });
    return rows.map(r => r.user_id);
  }

  async loadConfig(user_id: number): Promise<DrawdownBreakerConfig> {
    const user = await User.findByPk(user_id);
    const raw = user?.risk_config?.drawdown_breaker;
    return normalizeDrawdownBreakerConfig(raw);
  }

  async saveConfig(user_id: number, config: DrawdownBreakerConfig): Promise<DrawdownBreakerConfig> {
    const user = await User.findByPk(user_id);
    if (!user) {
      throw new Error(`saveConfig: user ${user_id} not found`);
    }
    const merged = {
      ...(user.risk_config || {}),
      drawdown_breaker: {
        ...(user.risk_config?.drawdown_breaker || {}),
        ...config,
      },
    };
    user.risk_config = merged;
    // JSONB columns require explicit `changed('field', true)` per US-017.
    user.changed('risk_config', true);
    await user.save();
    return { ...config };
  }

  async loadPortfolio(user_id: number): Promise<PortfolioHeader | null> {
    // 修复 (2026-06-16, HIGH H2): 之前 findOne 取第一个 portfolio. user_id=4 有 9 portfolio,
    // 总仅看 portfolio 24 空仓 → 永远 0 drawdown → LEVEL_1/2/3 永不触发 → portfolio 36 跌
    // 20% 也不暂停 BUY. 改成聚合所有 active portfolio 的 total_value 作为 user 级权益.
    // (与 user.risk_config.drawdown_breaker.paused_until 是 per-user 的语义保持一致.)
    const portfolios = await PaperTradingPortfolio.findAll({
      where: { user_id, is_active: true },
      attributes: ['id', 'total_value'],
    });
    if (portfolios.length === 0) return null;
    const totalValue = portfolios.reduce((s, p) => s + Number(p.total_value || 0), 0);
    // id 用第一个 portfolio (向下兼容; 内部 loadRecentSnapshots 需要 portfolio_id 拉 snapshot,
    // 但这里 portfolio_id 实际不再决定语义, snapshot 也按 user 级聚合更合理). 暂保持单 portfolio
    // snapshot 路径, 后续优化为 multi-portfolio snapshot 聚合.
    return { id: portfolios[0].id, total_value: totalValue };
  }

  async loadRecentSnapshots(
    portfolio_id: number,
    asOfDate: Date,
    lookbackDays: number
  ): Promise<PortfolioSnapshotRow[]> {
    const startDate = new Date(asOfDate.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
    const startIso = startDate.toISOString().slice(0, 10);
    const endIso = asOfDate.toISOString().slice(0, 10);
    const rows = await PaperTradingSnapshot.findAll({
      where: {
        portfolio_id,
        date: { [Op.between]: [startIso, endIso] },
      },
      attributes: ['date', 'total_value'],
      order: [['date', 'ASC']],
      raw: true,
    });
    return rows.map(r => ({
      date: String((r as any).date),
      total_value: Number((r as any).total_value),
    }));
  }

  /**
   * Batch J (2026-06-17, H3): cross-portfolio snapshot 聚合.
   * 按 (user_id, date) GROUP, total_value = SUM(snapshot.total_value).
   * Missing date in any portfolio → 该日 total 仅含其他盘 (Sequelize SUM 会自动忽略
   * 缺行), 这是 ok 的近似 (snapshot 完整性已经由 syncLatestPricesAndSnapshot per-portfolio
   * 保证, 极少出现某盘缺日的情况).
   */
  async loadRecentSnapshotsByUser(
    user_id: number,
    asOfDate: Date,
    lookbackDays: number
  ): Promise<PortfolioSnapshotRow[]> {
    const portfolios = await PaperTradingPortfolio.findAll({
      where: { user_id, is_active: true },
      attributes: ['id'],
    });
    if (portfolios.length === 0) return [];
    const portfolioIds = portfolios.map(p => p.id);
    const startDate = new Date(asOfDate.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
    const startIso = startDate.toISOString().slice(0, 10);
    const endIso = asOfDate.toISOString().slice(0, 10);
    const rows = await PaperTradingSnapshot.findAll({
      where: {
        portfolio_id: { [Op.in]: portfolioIds },
        date: { [Op.between]: [startIso, endIso] },
      },
      attributes: ['date', [sequelize.fn('SUM', sequelize.col('total_value')), 'total_value']],
      group: ['date'],
      order: [['date', 'ASC']],
      raw: true,
    });
    return rows.map(r => ({
      date: String((r as any).date),
      total_value: Number((r as any).total_value),
    }));
  }

  async loadOpenPositions(user_id: number): Promise<DrawdownPositionSnapshot[]> {
    // 修复 (HIGH H2 同款): 跨所有 portfolio 拉 positions, 不再只看 first portfolio.
    const portfolios = await PaperTradingPortfolio.findAll({
      where: { user_id, is_active: true },
      attributes: ['id'],
    });
    if (portfolios.length === 0) return [];
    const portfolioIds = portfolios.map(p => p.id);
    const rows = await PaperTradingPosition.findAll({
      where: { portfolio_id: { [Op.in]: portfolioIds }, quantity: { [Op.gt]: 0 } },
    });
    return rows.map<DrawdownPositionSnapshot>(r => ({
      id: r.id,
      portfolio_id: r.portfolio_id,
      symbol: r.symbol,
      name: r.name,
      quantity: Number(r.quantity),
      avg_cost: Number(r.avg_cost),
      current_price: Number(r.current_price),
      market_value: Number(r.market_value),
    }));
  }

  async loadPausedUntil(user_id: number): Promise<string | null> {
    const user = await User.findByPk(user_id);
    const v = user?.risk_config?.drawdown_breaker?.paused_until;
    return typeof v === 'string' ? v : null;
  }

  async savePausedUntil(user_id: number, pausedUntil: string | null): Promise<void> {
    const user = await User.findByPk(user_id);
    if (!user) {
      throw new Error(`savePausedUntil: user ${user_id} not found`);
    }
    const merged = {
      ...(user.risk_config || {}),
      drawdown_breaker: {
        ...(user.risk_config?.drawdown_breaker || {}),
        paused_until: pausedUntil,
      },
    };
    user.risk_config = merged;
    user.changed('risk_config', true);
    await user.save();
  }

  async hasExistingPosition(user_id: number, symbol: string): Promise<boolean> {
    // 修复 (HIGH H2 同款): 跨所有 portfolio 检查持仓
    const portfolios = await PaperTradingPortfolio.findAll({
      where: { user_id, is_active: true },
      attributes: ['id'],
    });
    if (portfolios.length === 0) return false;
    const pos = await PaperTradingPosition.findOne({
      where: {
        portfolio_id: { [Op.in]: portfolios.map(p => p.id) },
        symbol,
        quantity: { [Op.gt]: 0 },
      },
    });
    return !!pos;
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
      rule_id: 'drawdown_breaker',
      is_read: false,
    } as any);
  }
}

export const PRODUCTION_DRAWDOWN_BREAKER_DATA_SOURCE: DrawdownBreakerDataSource =
  new DefaultDrawdownBreakerDataSource();

// ---------------------------------------------------------------------------
//  Guard — public entry point
// ---------------------------------------------------------------------------

export interface EvaluateAfterCloseOptions {
  /** If set, only process this user. Otherwise scan all users with portfolios. */
  user_id?: number;
  /** Override the snapshot lookback window (default 365 days). */
  lookback_days?: number;
  /** Override the date used for the snapshot window (defaults to "now"). */
  asOfDate?: Date;
  /** If true, do NOT write RiskAlert rows or paused_until (dry-run mode). */
  dry_run?: boolean;
}

export interface CheckBuyAllowedInput {
  user_id: number;
  symbol: string;
}

export interface CheckBuyAllowedResult {
  /** true = order may proceed; false = caller should reject the BUY. */
  ok: boolean;
  /** Human-readable reason (when ok=false). */
  reason?: string;
  /** ISO timestamp the pause expires at (when ok=false). */
  paused_until?: string;
  /** True iff this would be opening a new position (not adding to existing). */
  is_new_holding?: boolean;
}

export class DrawdownCircuitBreaker {
  private source: DrawdownBreakerDataSource;

  constructor(source: DrawdownBreakerDataSource = PRODUCTION_DRAWDOWN_BREAKER_DATA_SOURCE) {
    this.source = source;
  }

  /**
   * 每日收盘后批量评估所有用户的回撤等级。
   *
   * - 单 user 失败 try/catch 隔离（同 PositionLimitGuard / TrailingStopGuard）；
   * - disabled 用户跳过整个评估；
   * - 一次只取最高 level（LEVEL_3 > LEVEL_2 > LEVEL_1），不重复告警；
   * - LEVEL_1 命中 → 写 paused_until = now + 24h，告警 message 中说明原因；
   * - LEVEL_2 命中 → 选涨幅最大的 50% 持仓输出 SELL trigger + 告警；
   * - LEVEL_3 命中 → 全持仓输出 SELL trigger + 告警；
   * - 不直接调用 facade.placeOrder — 由调用方（PaperTradingAutomationService /
   *   人工审批 / UI dashboard）决定真实撮合时机（保持 facade 7-method 收敛）。
   *
   * `dry_run=true` 跳过 RiskAlert 写入 + paused_until 落库（UI 预演用）。
   */
  async evaluateAfterClose(
    options: EvaluateAfterCloseOptions = {}
  ): Promise<EvaluateAfterCloseResult> {
    const asOfDate = options.asOfDate ?? new Date();
    const lookbackDays =
      Number.isInteger(options.lookback_days) && (options.lookback_days as number) > 0
        ? (options.lookback_days as number)
        : 365;
    const dryRun = Boolean(options.dry_run);
    const userIds = options.user_id
      ? [options.user_id]
      : await this.source.loadAllUserIdsWithPortfolios();

    const result: EvaluateAfterCloseResult = {
      scanned_users: userIds.length,
      triggered_users: 0,
      triggers: [],
      per_user: [],
    };

    for (const user_id of userIds) {
      try {
        const evaluation = await this.evaluateOneUser(user_id, asOfDate, lookbackDays, dryRun);
        result.per_user.push(evaluation);
        if (evaluation.level !== 'NONE') {
          result.triggered_users += 1;
        }
        result.triggers.push(...evaluation.triggers);
      } catch (err) {
        logger.warn(
          `DrawdownCircuitBreaker.evaluateAfterClose user=${user_id} failed: ` +
            `${(err as Error).message}`
        );
        result.per_user.push({
          user_id,
          portfolio_id: null,
          level: 'NONE',
          peak_value: 0,
          current_value: 0,
          drawdown_pct: 0,
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
    lookbackDays: number,
    dryRun: boolean
  ): Promise<DrawdownEvaluationResult> {
    const config = await this.source.loadConfig(user_id);
    const portfolio = await this.source.loadPortfolio(user_id);
    if (!portfolio) {
      return {
        user_id,
        portfolio_id: null,
        level: 'NONE',
        peak_value: 0,
        current_value: 0,
        drawdown_pct: 0,
        triggers: [],
      };
    }
    if (!config.enabled) {
      return {
        user_id,
        portfolio_id: portfolio.id,
        level: 'NONE',
        peak_value: portfolio.total_value,
        current_value: portfolio.total_value,
        drawdown_pct: 0,
        triggers: [],
      };
    }

    // Batch J (2026-06-17, H3): 多盘 snapshot 聚合 — 之前 loadRecentSnapshots(portfolio.id)
    // 只看 portfolio[0] (空仓系统观测盘) → peak 错估 → drawdown 永远 0 → LEVEL_1/2/3
    // 永不触发. 现在按 user 聚合. fallback 到旧 API 让单测 / fake source 仍兼容.
    const snapshots =
      typeof (this.source as any).loadRecentSnapshotsByUser === 'function'
        ? await (this.source as any).loadRecentSnapshotsByUser(user_id, asOfDate, lookbackDays)
        : await this.source.loadRecentSnapshots(portfolio.id, asOfDate, lookbackDays);
    const peak_value = computePeakValue(snapshots, portfolio.total_value);
    const drawdown_pct = computeDrawdownPct(peak_value, portfolio.total_value);
    const level = pickDrawdownLevel(drawdown_pct, config);

    if (level === 'NONE') {
      return {
        user_id,
        portfolio_id: portfolio.id,
        level: 'NONE',
        peak_value,
        current_value: portfolio.total_value,
        drawdown_pct,
        triggers: [],
      };
    }

    const triggers: DrawdownSellTrigger[] = [];
    let action_detail = '';
    let threshold_pct = 0;
    let paused_until: string | undefined;

    if (level === 'LEVEL_1') {
      threshold_pct = config.level1_pct;
      const expires = new Date(asOfDate.getTime() + config.level1_pause_ms);
      paused_until = expires.toISOString();
      action_detail = `已暂停新开仓 24 小时（至 ${paused_until}）。`;
      if (!dryRun) {
        try {
          await this.source.savePausedUntil(user_id, paused_until);
        } catch (err) {
          logger.warn(
            `DrawdownCircuitBreaker.savePausedUntil user=${user_id}: ${(err as Error).message}`
          );
        }
      }
    } else {
      const positions = await this.source.loadOpenPositions(user_id);
      const targets =
        level === 'LEVEL_2'
          ? pickLevel2TrimTargets(positions)
          : pickLevel3LiquidateTargets(positions);
      threshold_pct = level === 'LEVEL_2' ? config.level2_pct : config.level3_pct;
      const actionLabel = level === 'LEVEL_2' ? '减仓至 50%' : '清仓';
      action_detail = `已建议${actionLabel}（${targets.length} 只标的）。`;
      const reasonPrefix = level === 'LEVEL_2' ? '减仓 (LEVEL_2)' : '清仓 (LEVEL_3)';
      for (const pos of targets) {
        triggers.push({
          user_id,
          position_id: pos.id,
          portfolio_id: pos.portfolio_id,
          symbol: pos.symbol,
          name: pos.name || pos.symbol,
          quantity: pos.quantity,
          gain_ratio: computeGainRatio(pos),
          reason: reasonPrefix,
        });
      }
    }

    const message = buildDrawdownMessage({
      level,
      peak_value,
      current_value: portfolio.total_value,
      drawdown_pct,
      threshold_pct,
      action_detail,
    });

    if (!dryRun) {
      try {
        await this.source.writeAlert({
          user_id,
          symbol: `SYSTEM:DRAWDOWN_${level}`,
          name: `组合回撤熔断 - ${level}`,
          message,
        });
      } catch (err) {
        logger.warn(
          `DrawdownCircuitBreaker.writeAlert user=${user_id} level=${level}: ` +
            `${(err as Error).message}`
        );
      }
    }

    return {
      user_id,
      portfolio_id: portfolio.id,
      level,
      peak_value,
      current_value: portfolio.total_value,
      drawdown_pct,
      message,
      paused_until,
      triggers,
    };
  }

  /**
   * placeOrder BUY 链路 inline hook — 检查 LEVEL_1 暂停期是否生效。
   *
   * - 若暂停期未生效：返回 `{ok: true}` 放行；
   * - 若暂停期生效 + 是新开仓（symbol 不在持仓内）：返回 `{ok: false, reason, paused_until}`；
   * - 若暂停期生效但 symbol 已在持仓内（加仓）：放行（与策略层加仓兼容，
   *   避免误伤已开仓的策略加仓动作）；
   * - SELL 永远不需要走此 hook（评估器只暂停 BUY，平仓总是允许）。
   *
   * BETA-7 (2026-06-18, audit M-13): **fail-CLOSED** — DB 抖动时抛
   * `RiskGuardUnavailableError`。US-011 (PR-006): 统一走
   * `RiskGuardFailClosed.wrapFailClosed`，让 caller (PaperTradingFacade /
   * preTradeGuards) catch 并按业务规则决定是阻塞 BUY (硬风控不可用 = 不下单)
   * 或写 RiskAlert HIGH 告警。
   */
  async checkBuyAllowed(input: CheckBuyAllowedInput): Promise<CheckBuyAllowedResult> {
    return wrapFailClosed(
      'drawdown_breaker',
      async () => {
        const config = await this.source.loadConfig(input.user_id);
        if (!config.enabled) return { ok: true };

        const paused_until = await this.source.loadPausedUntil(input.user_id);
        const nowMs = Date.now();
        if (!isPauseActive(paused_until, nowMs)) {
          return { ok: true };
        }

        const isExisting = await this.source.hasExistingPosition(input.user_id, input.symbol);
        if (isExisting) {
          // Allow add-on to existing position even during pause.
          return { ok: true, is_new_holding: false };
        }

        return {
          ok: false,
          is_new_holding: true,
          paused_until: paused_until ?? undefined,
          reason:
            `组合处于回撤熔断暂停期（至 ${paused_until}），` +
            `禁止新开仓 ${input.symbol}。可在期满后再交易，或平仓现有持仓。`,
        };
      },
      { user_id: input.user_id, symbol: input.symbol }
    );
  }

  /** Return the user's effective config (defaults if not customized). */
  async getConfig(user_id: number): Promise<DrawdownBreakerConfig> {
    return this.source.loadConfig(user_id);
  }

  /** Persist a (normalized) updated config for the user. */
  async updateConfig(user_id: number, raw: any): Promise<DrawdownBreakerConfig> {
    const normalized = normalizeDrawdownBreakerConfig(raw);
    return this.source.saveConfig(user_id, normalized);
  }

  /**
   * Clear an active LEVEL_1 pause manually (e.g. admin override / risk reset).
   * Use when operator confirms the drawdown was a benchmark dislocation rather
   * than a real strategy issue.
   */
  async clearPause(user_id: number): Promise<void> {
    await this.source.savePausedUntil(user_id, null);
  }
}

/** Singleton — controllers / scheduler / facade reach this instead of `new`-ing per call. */
export const drawdownCircuitBreaker = new DrawdownCircuitBreaker();
