/**
 * MorningRiskCheckupService — US-054
 *
 * **每日开盘前风险体检报告** — 每天 8:30 触发，输出 6 维度持仓体检快照
 * （持仓数 / 单股最大占比 / 行业最大占比 / 当前回撤 / 本周净值变化 /
 * 未触发告警数）→ 持久化到 MorningRiskCheckup 表 + 推送（依赖 US-080
 * 真发飞书/邮件；本 service 仅落 `dispatch_status='pending'`）。
 *
 * 与 US-047/US-048/US-049/US-050/US-051/US-052/US-053 互补的**第 8 类风控形态** ——
 *   - 前 7 类都是 *触发型* 风控（pre-trade / 持有期 / 收盘后 / event-driven 实时扫描），
 *     输出 *RiskAlert* 让用户感知"刚发生了 X"；
 *   - **MorningRiskCheckup 是 *快照型* 风控**：每日定时把"当前持仓全景"折叠成
 *     一行可读 markdown，让用户开盘前 30 分钟内**一眼看清今天进场前的全局风险**。
 *     不是一个新的告警 —— 是把已经存在的多维度告警 + 持仓暴露聚合成"开盘体检报告"。
 *
 * AC 关键点：
 *   1. 在 backend/src/portfolio/risk/ 新建 MorningRiskCheckupService.ts；
 *   2. 每天 8:30 触发（SchedulerService 注册）；
 *   3. 输出：持仓数、单股最大占比、行业最大占比、当前回撤、本周净值变化、未触发告警数；
 *   4. 结果保存到 MorningRiskCheckup 模型 + 推送（依赖 US-080）；
 *   5. 新增 endpoint：GET /api/risk/morning-checkup/today；
 *   6. 新增单元测试 + typecheck pass + tests pass。
 *
 * 数据来源（**复用现有 service 数据 → 数字与 US-049 / US-052 / RiskAlertController 完全对应**）：
 *   - 单股 / 行业占比：复用 US-052 IndustryConcentrationGuard.aggregateByIndustry
 *     的同款分母（sum(market_value)，*不含 cash*）；
 *   - 回撤：复用 US-049 DrawdownCircuitBreaker.computePeakValue + computeDrawdownPct
 *     （peak = max(snapshots, current_total_value)）；
 *   - 本周净值变化：snapshot 历史中找 ≥ 7 日前的 total_value 作为 baseline；
 *   - 未触发告警数：RiskAlert.count({where: {user_id, is_read: false}})；
 *
 * 设计约束 — 沿用 US-047/US-048/US-049/US-051/US-052/US-053 的 7 项 checklist：
 *   - DataSource 接口注入（生产 Sequelize + 测试 fake）；
 *   - 纯函数 helper 全 export 让单测无需 DB（normalizeMorningRiskCheckupConfig /
 *     computeMaxSingleStockPct / computeMaxIndustryPct / computeWeeklyReturnPct /
 *     buildCheckupMessage 等）；
 *   - 配置在 User.risk_config.morning_checkup JSONB + Object.freeze 默认；
 *   - 持久化到 MorningRiskCheckup 表（(user_id, date) UNIQUE，UPSERT 语义）；
 *   - 单 user 失败 try/catch 隔离不阻塞剩余 user；
 *   - HTTP 入口 GET /api/risk/morning-checkup/today；
 *   - 不破坏 facade 收敛 — service 只读 + 写自己的体检表，**不**走 facade.placeOrder。
 *
 * 边界与坑：
 *   - **新账户 / 0 持仓** → positions_count=0，max_single_pct=null，
 *     max_industry_pct=null，drawdown_pct=null（safe HOLD 不写 zeros 误导用户）；
 *   - **snapshot 历史 < 7 日**（IPO 不足 1 周）→ weekly_return_pct=null；
 *   - **UPSERT semantics**：同一用户同一天重跑覆盖既有行（admin 重跑测试或临时 ops）；
 *   - **fail-OPEN**：单用户计算失败 → 写一行 error=msg 不阻塞 batch（同 US-052/US-053
 *     per-user try/catch isolate 模式）；
 *   - **dry_run=true** 跳过 DB 写入但仍返回完整 checkup 结构（UI dashboard 预演用）；
 *   - **dispatch_status='pending' 写入** — US-080 NotificationService 上线后会更新
 *     该字段为 'sent' / 'failed'，本 service 不直接调推送（解耦计算与通知）；
 *   - **as_of_date 默认本地交易日** — 不依赖 trade-calendar，简单用 ISO date string，
 *     8:30 触发时 toISOString().slice(0, 10) 已是当日；
 *   - **行业 / 单股占比阈值** — *不在本 service 配置*：是否"超标"由 US-052 alert_pct 决定；
 *     本 service 只是把"目前最大占比是多少"展示给用户看，不再触发新告警；
 *   - **复用 US-049 / US-052 helper** — 跨 service 共享纯函数（lazy-require 避免循环 import）。
 */

import { Op } from 'sequelize';
import sequelize from '../../config/database';
import { PaperTradingPosition } from '../../models/PaperTradingPosition';
import { PaperTradingPortfolio } from '../../models/PaperTradingPortfolio';
import { PaperTradingSnapshot } from '../../models/PaperTradingSnapshot';
import { Stock } from '../../models/Stock';
import { RiskAlert } from '../../models/RiskAlert';
import { User } from '../../models/User';
import { MorningRiskCheckup } from '../../models/MorningRiskCheckup';
import { logger } from '../../utils/logger';
import {
  aggregateByIndustry,
  normalizeIndustryName,
  IndustryPositionSnapshot,
  UNKNOWN_INDUSTRY_SENTINEL,
} from './IndustryConcentrationGuard';
import { computePeakValue, computeDrawdownPct } from './DrawdownCircuitBreaker';

// ---------------------------------------------------------------------------
//  Config
// ---------------------------------------------------------------------------

export interface MorningRiskCheckupConfig {
  /** 是否启用（false = 跳过整个 service / 不写体检表 / 不推送）。 */
  enabled: boolean;
  /**
   * 本周净值变化 baseline 回看天数（默认 7 = 1 自然周）。
   * 找 ≥ 该天数前的最近 snapshot 作为 baseline；snapshot 历史 < 该值 → null。
   */
  weekly_lookback_days: number;
  /**
   * 回撤评估 snapshot 历史回看天数（默认 365 = 1 年；与 US-049 默认对齐）。
   */
  drawdown_lookback_days: number;
  /**
   * 是否在 message 里包含 breakdown 明细（per-symbol top 3 / per-industry top 3）。
   * 关闭可让推送通道（飞书 / 邮件）保持极简文本，开启可让长 message 适合 Web UI。
   */
  include_breakdown_in_message: boolean;
}

/**
 * 默认配置（AC 指定）：启用 + 7 日本周 baseline + 365 日回撤 history + 含明细。
 *
 * `Object.freeze` 防止模块级常量被意外 mutate（US-037 codebase pattern）。
 */
export const DEFAULT_MORNING_RISK_CHECKUP_CONFIG: MorningRiskCheckupConfig = Object.freeze({
  enabled: true,
  weekly_lookback_days: 7,
  drawdown_lookback_days: 365,
  include_breakdown_in_message: true,
});

// ---------------------------------------------------------------------------
//  Domain types
// ---------------------------------------------------------------------------

/** Snapshot of one position for checkup (subset of IndustryPositionSnapshot). */
export type CheckupPositionSnapshot = IndustryPositionSnapshot;

/** Snapshot row from PaperTradingSnapshot used in weekly_return / drawdown calc. */
export interface CheckupSnapshotRow {
  date: string;
  total_value: number;
}

/** One per-user checkup result. */
export interface MorningRiskCheckupResult {
  user_id: number;
  portfolio_id: number | null;
  date: string;
  enabled: boolean;
  positions_count: number;
  max_single_pct: number | null;
  max_single_symbol: string | null;
  max_industry_pct: number | null;
  max_industry_name: string | null;
  current_total_value: number | null;
  peak_value: number | null;
  drawdown_pct: number | null;
  weekly_return_pct: number | null;
  unresolved_alerts_count: number;
  message: string;
  breakdown?: Record<string, unknown> | null;
  /** True iff a row was actually persisted (false = disabled / dry_run / error). */
  persisted: boolean;
  /** Error message when calc threw (null when success). */
  error?: string;
}

/**
 * Phase 2+/4+/5+ 健康指标（写入 breakdown.system_health 子字段）。
 *
 * 不改 SQL schema —— 全部塞 breakdown JSONB 让 UI 直接渲染。
 */
export interface SystemHealthSnapshot {
  // Phase 2+ sizing 7 天活跃度
  sizing_7d_count: number;
  sizing_7d_hard_count: number;
  sizing_methods_active: string;
  // Phase 4+ kill switch 当前状态
  strategies_disabled_count: number;
  strategies_with_killswitch: number;
  strategies_total: number;
  // Phase 5+ root_cause 覆盖 + postmortem
  outcomes_closed_count: number;
  outcomes_with_root_cause: number;
  outcomes_with_postmortem: number;
  root_cause_coverage_pct: number;
}

/** Aggregate result of batch evaluation across all users. */
export interface RunMorningCheckupResult {
  scanned_users: number;
  checked_users: number;
  per_user: MorningRiskCheckupResult[];
  /** True iff caller asked for dry_run. */
  dry_run: boolean;
}

// ---------------------------------------------------------------------------
//  Pure helpers (export for unit tests — no DB)
// ---------------------------------------------------------------------------

/**
 * 净化 raw config blob（来自 User.risk_config 或 PUT body）。
 *
 * - 非有限 / 非整数 / ≤ 0 days → 默认；
 * - 非 boolean enabled / include_breakdown_in_message → 默认；
 *
 * 与 US-047/US-048/US-049/US-051/US-052/US-053 normalize 同款"沉默退回默认不 4xx"。
 */
export function normalizeMorningRiskCheckupConfig(raw: any): MorningRiskCheckupConfig {
  const safeBool = (v: any, dflt: boolean) => (typeof v === 'boolean' ? v : dflt);
  const safePosInt = (v: any, dflt: number) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= 1 ? n : dflt;
  };
  return {
    enabled: safeBool(raw?.enabled, DEFAULT_MORNING_RISK_CHECKUP_CONFIG.enabled),
    weekly_lookback_days: safePosInt(
      raw?.weekly_lookback_days,
      DEFAULT_MORNING_RISK_CHECKUP_CONFIG.weekly_lookback_days
    ),
    drawdown_lookback_days: safePosInt(
      raw?.drawdown_lookback_days,
      DEFAULT_MORNING_RISK_CHECKUP_CONFIG.drawdown_lookback_days
    ),
    include_breakdown_in_message: safeBool(
      raw?.include_breakdown_in_message,
      DEFAULT_MORNING_RISK_CHECKUP_CONFIG.include_breakdown_in_message
    ),
  };
}

/**
 * 计算单股最大占比（market_value / sum(all_market_values)，*不含 cash*）。
 *
 * - 分母与 US-052 IndustryConcentrationGuard.aggregateByIndustry 完全一致
 *   ("持仓占比" 而非 "占总账户")，保证两处数字对得上；
 * - 持仓为空 / 总市值 = 0 → 返回 null（safe HOLD 不写 0 误导）；
 * - 多只持仓并列最大 → 取 symbol asc 第一个（stable tie-break，
 *   与 US-049 / US-052 sortByGainDescStable 模式一致）；
 */
export function computeMaxSingleStockPct(
  positions: CheckupPositionSnapshot[]
): { pct: number; symbol: string } | null {
  const valid = positions.filter(
    p =>
      Number.isFinite(p.quantity) &&
      p.quantity > 0 &&
      Number.isFinite(p.market_value) &&
      p.market_value > 0
  );
  if (valid.length === 0) return null;
  const total = valid.reduce((s, p) => s + p.market_value, 0);
  if (total <= 0) return null;
  // sort by market_value DESC, symbol ASC tie-break
  const sorted = [...valid].sort((a, b) => {
    if (b.market_value !== a.market_value) return b.market_value - a.market_value;
    return (a.symbol || '').localeCompare(b.symbol || '');
  });
  const top = sorted[0];
  return { pct: top.market_value / total, symbol: top.symbol };
}

/**
 * 计算行业最大占比 — 复用 US-052 aggregateByIndustry（同款分母 + 同款 industry 归一）。
 *
 * - 持仓为空 → null；
 * - 输出行业按 pct DESC 排序，取第 0 个；
 * - 未分类持仓走 UNKNOWN_INDUSTRY_SENTINEL bucket（保持与 US-052 一致）；
 */
export function computeMaxIndustryPct(
  positions: CheckupPositionSnapshot[]
): { pct: number; industry: string } | null {
  const { breakdown } = aggregateByIndustry(positions);
  if (breakdown.length === 0) return null;
  const top = breakdown[0];
  return { pct: top.pct, industry: top.industry };
}

/**
 * 计算本周净值变化 = (current - baseline) / baseline。
 *
 * - baseline = 最近一条 snapshot.date ≤ (asOfDate - lookbackDays days)；
 * - snapshot 历史 < lookbackDays 日（找不到 baseline） → 返回 null；
 * - baseline ≤ 0 → 返回 null（防御性除零，未注资账户）；
 * - current 非有限 → 返回 null；
 *
 * 这与 US-049 drawdown 的 "peak from snapshots + current" 不同：本指标是 *短期*
 * 趋势（7 日 = 1 周），不是 *历史峰值*。
 */
export function computeWeeklyReturnPct(
  snapshots: CheckupSnapshotRow[],
  currentTotalValue: number,
  asOfDate: Date,
  lookbackDays: number
): number | null {
  if (!Number.isFinite(currentTotalValue)) return null;
  if (!Number.isInteger(lookbackDays) || lookbackDays < 1) return null;
  const cutoffMs = asOfDate.getTime() - lookbackDays * 24 * 60 * 60 * 1000;
  const cutoffIso = new Date(cutoffMs).toISOString().slice(0, 10);
  // Pick the latest snapshot with date ≤ cutoffIso (most recent baseline within window).
  const eligible = snapshots
    .filter(s => typeof s.date === 'string' && s.date <= cutoffIso)
    .filter(s => Number.isFinite(s.total_value) && s.total_value > 0);
  if (eligible.length === 0) return null;
  // sort desc by date — most recent baseline first
  eligible.sort((a, b) => b.date.localeCompare(a.date));
  const baseline = eligible[0].total_value;
  if (baseline <= 0) return null;
  return (currentTotalValue - baseline) / baseline;
}

/**
 * 拼装人类可读的中文 message（用于飞书 / 邮件 / UI 展示）。
 *
 * 短模式（include_breakdown=false）：6 行核心数字。
 * 长模式（include_breakdown=true）：6 行核心数字 + top 3 持仓 + top 3 行业 + 未读告警 hint。
 */
export function buildCheckupMessage(input: {
  date: string;
  positions_count: number;
  max_single_pct: number | null;
  max_single_symbol: string | null;
  max_industry_pct: number | null;
  max_industry_name: string | null;
  drawdown_pct: number | null;
  weekly_return_pct: number | null;
  unresolved_alerts_count: number;
  current_total_value: number | null;
  include_breakdown: boolean;
  top_positions?: Array<{ symbol: string; pct: number }>;
  top_industries?: Array<{ industry: string; pct: number }>;
  /** Phase 2+/4+/5+ 整合：sizing / kill switch / outcome 体检；null = 数据源失败 */
  system_health?: SystemHealthSnapshot | null;
}): string {
  const fmtPct = (v: number | null) =>
    v === null || !Number.isFinite(v) ? '—' : `${(v * 100).toFixed(2)}%`;
  const fmtSignedPct = (v: number | null) => {
    if (v === null || !Number.isFinite(v)) return '—';
    const sign = v >= 0 ? '+' : '';
    return `${sign}${(v * 100).toFixed(2)}%`;
  };
  const fmtMoney = (v: number | null) =>
    v === null || !Number.isFinite(v) ? '—' : `${v.toFixed(2)} 元`;
  const industryLabel = (n: string | null) =>
    n === UNKNOWN_INDUSTRY_SENTINEL ? '未分类' : n || '—';
  const lines: string[] = [
    `📋 持仓体检（${input.date}）`,
    `当前总市值：${fmtMoney(input.current_total_value)}`,
    `持仓数：${input.positions_count} 只`,
    `单股最大占比：${fmtPct(input.max_single_pct)}` +
      (input.max_single_symbol ? `（${input.max_single_symbol}）` : ''),
    `行业最大占比：${fmtPct(input.max_industry_pct)}` +
      (input.max_industry_name ? `（${industryLabel(input.max_industry_name)}）` : ''),
    `当前回撤：${fmtPct(input.drawdown_pct)}`,
    `本周净值变化：${fmtSignedPct(input.weekly_return_pct)}`,
    `未读风控告警：${input.unresolved_alerts_count} 条`,
  ];
  if (input.include_breakdown) {
    if (input.top_positions && input.top_positions.length > 0) {
      const items = input.top_positions
        .slice(0, 3)
        .map(p => `${p.symbol} ${fmtPct(p.pct)}`)
        .join('，');
      lines.push(`持仓占比 Top 3：${items}`);
    }
    if (input.top_industries && input.top_industries.length > 0) {
      const items = input.top_industries
        .slice(0, 3)
        .map(i => `${industryLabel(i.industry)} ${fmtPct(i.pct)}`)
        .join('，');
      lines.push(`行业占比 Top 3：${items}`);
    }
    if (input.unresolved_alerts_count > 0) {
      lines.push(`⚠️ 请打开"风控告警"查看未读告警详情。`);
    }

    // Phase 2+/4+/5+ 系统健康 — 只在 include_breakdown 时附加，避免推送内容爆炸
    if (input.system_health) {
      const sh = input.system_health;
      lines.push(''); // 空行分隔
      lines.push('🔧 系统健康（Phase 2/4/5）:');
      // Phase 2 sizing
      if (sh.sizing_7d_count > 0) {
        const methodTag =
          sh.sizing_methods_active === '—' ? '' : ` method=${sh.sizing_methods_active}`;
        const hardTag = sh.sizing_7d_hard_count > 0 ? ` · ${sh.sizing_7d_hard_count} hard` : '';
        lines.push(`  ⚖️ Sizing：7d ${sh.sizing_7d_count} 决策${hardTag}${methodTag}`);
      } else {
        lines.push(`  ⚖️ Sizing：仍是 equal_pct 默认（未开启多元化）`);
      }
      // Phase 4 kill switch
      if (sh.strategies_disabled_count > 0) {
        lines.push(
          `  🚨 策略熔断：⚠️ ${sh.strategies_disabled_count}/${sh.strategies_total} 策略已禁用`
        );
      } else if (sh.strategies_with_killswitch > 0) {
        lines.push(
          `  🚨 策略熔断：${sh.strategies_with_killswitch}/${sh.strategies_total} 策略带 kill_switch · 全部正常`
        );
      }
      // Phase 5 root_cause coverage
      if (sh.outcomes_closed_count > 0) {
        const cov = sh.root_cause_coverage_pct;
        const covTag = cov >= 80 ? '✅' : cov >= 50 ? '⚠️' : '❌';
        lines.push(
          `  🔬 根因覆盖：${covTag} ${cov.toFixed(1)}% (${sh.outcomes_with_root_cause}/${
            sh.outcomes_closed_count
          } 闭环) · ${sh.outcomes_with_postmortem} 自动复盘`
        );
      }
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
//  DataSource — DI seam for unit tests
// ---------------------------------------------------------------------------

export interface MorningRiskCheckupDataSource {
  /** Load all users with at least one paper-trading portfolio. */
  loadAllUserIdsWithPortfolios(): Promise<number[]>;
  /** Load this user's effective config (defaults if absent). */
  loadConfig(user_id: number): Promise<MorningRiskCheckupConfig>;
  /** Persist this user's config (UPSERT semantics). */
  saveConfig(user_id: number, config: MorningRiskCheckupConfig): Promise<MorningRiskCheckupConfig>;
  /** Load the user's primary portfolio header (or null). */
  loadPortfolioHeader(user_id: number): Promise<{ id: number; total_value: number } | null>;
  /** Load open positions (quantity > 0) for the user, with industry joined. */
  loadOpenPositions(user_id: number): Promise<CheckupPositionSnapshot[]>;
  /**
   * Load the user's recent portfolio snapshots within `[asOfDate - lookback, asOfDate]`.
   * Used for peak-value and weekly_baseline lookup. Should return sorted asc by date.
   */
  loadRecentSnapshots(
    portfolio_id: number,
    asOfDate: Date,
    lookbackDays: number
  ): Promise<CheckupSnapshotRow[]>;
  /** Count unread RiskAlert rows for this user (all levels). */
  countUnresolvedAlerts(user_id: number): Promise<number>;
  /**
   * Phase 2+/4+/5+ 系统健康快照 (sizing audit + kill switch + outcome coverage)。
   * 失败时返回 null (fail-OPEN，不阻塞主 checkup)。
   */
  loadSystemHealthSnapshot(user_id: number): Promise<SystemHealthSnapshot | null>;
  /**
   * Persist one MorningRiskCheckup row (UPSERT on (user_id, date)).
   * `dispatch_status` defaults to 'pending' — US-080 NotificationService updates to
   * 'sent' / 'failed' after actually pushing to feishu / email.
   */
  upsertCheckup(input: {
    user_id: number;
    portfolio_id: number | null;
    date: string;
    positions_count: number;
    max_single_pct: number | null;
    max_single_symbol: string | null;
    max_industry_pct: number | null;
    max_industry_name: string | null;
    current_total_value: number | null;
    peak_value: number | null;
    drawdown_pct: number | null;
    weekly_return_pct: number | null;
    unresolved_alerts_count: number;
    breakdown: Record<string, unknown> | null;
    message: string;
    error: string | null;
  }): Promise<void>;
  /** Fetch the latest checkup for a user (UI uses this for `today` endpoint). */
  loadLatestCheckup(user_id: number): Promise<MorningRiskCheckup | null>;
  /** Fetch a specific date's checkup for a user (returns null if not yet computed). */
  loadCheckupForDate(user_id: number, date: string): Promise<MorningRiskCheckup | null>;
}

/**
 * Production DataSource — backed by Sequelize.
 *
 * Cross-table joins (Stock industry / portfolio total_value) live here so the
 * service sees plain snapshot bag types only.
 */
export class DefaultMorningRiskCheckupDataSource implements MorningRiskCheckupDataSource {
  async loadAllUserIdsWithPortfolios(): Promise<number[]> {
    const rows = await PaperTradingPortfolio.findAll({
      attributes: ['user_id'],
      group: ['user_id'],
    });
    return rows.map(r => r.user_id);
  }

  async loadConfig(user_id: number): Promise<MorningRiskCheckupConfig> {
    const user = await User.findByPk(user_id);
    const raw = user?.risk_config?.morning_checkup;
    return normalizeMorningRiskCheckupConfig(raw);
  }

  async saveConfig(
    user_id: number,
    config: MorningRiskCheckupConfig
  ): Promise<MorningRiskCheckupConfig> {
    const user = await User.findByPk(user_id);
    if (!user) {
      throw new Error(`saveConfig: user ${user_id} not found`);
    }
    const merged = {
      ...(user.risk_config || {}),
      morning_checkup: { ...config },
    };
    user.risk_config = merged;
    // JSONB columns require explicit `changed('field', true)` per US-017.
    user.changed('risk_config', true);
    await user.save();
    return { ...config };
  }

  async loadPortfolioHeader(user_id: number): Promise<{ id: number; total_value: number } | null> {
    // 修复 (2026-06-16, HIGH H2): 聚合所有 active portfolio 的 total_value 给 morning checkup
    const portfolios = await PaperTradingPortfolio.findAll({
      where: { user_id, is_active: true },
      attributes: ['id', 'total_value'],
    });
    if (portfolios.length === 0) return null;
    const totalValue = portfolios.reduce((s, p) => s + Number(p.total_value || 0), 0);
    return { id: portfolios[0].id, total_value: totalValue };
  }

  async loadOpenPositions(user_id: number): Promise<CheckupPositionSnapshot[]> {
    // 修复 (HIGH H2): 跨所有 active portfolio
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
    if (rows.length === 0) return [];
    const symbols = Array.from(new Set(rows.map(r => r.symbol)));
    const stocks = await Stock.findAll({
      where: { symbol: { [Op.in]: symbols } },
      attributes: ['symbol', 'industry'],
    });
    const industryMap = new Map<string, string | null>();
    stocks.forEach(s => industryMap.set(s.symbol, s.industry ?? null));
    return rows.map<CheckupPositionSnapshot>(r => ({
      id: r.id,
      portfolio_id: r.portfolio_id,
      symbol: r.symbol,
      name: r.name,
      quantity: Number(r.quantity),
      avg_cost: Number(r.avg_cost),
      current_price: Number(r.current_price),
      market_value: Number(r.market_value),
      industry: industryMap.get(r.symbol) ?? null,
    }));
  }

  async loadRecentSnapshots(
    portfolio_id: number,
    asOfDate: Date,
    lookbackDays: number
  ): Promise<CheckupSnapshotRow[]> {
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

  async countUnresolvedAlerts(user_id: number): Promise<number> {
    return await RiskAlert.count({ where: { user_id, is_read: false } });
  }

  /**
   * Phase 2+/4+/5+ 系统健康快照：sizing audit + kill switch + outcome coverage。
   *
   * 失败时返回 null (fail-OPEN) 不阻塞主 checkup —— 即使新 phase 还没数据，
   * morning checkup 主流程仍照常出报告。
   */
  async loadSystemHealthSnapshot(user_id: number): Promise<SystemHealthSnapshot | null> {
    try {
      // 三个查询并行
      const [sizingRow, killRow, outcomeRow] = await Promise.all([
        // Phase 2+ sizing — user 自己 7d 决策
        sequelize
          .query(
            `SELECT
              COUNT(*)::int AS recent_count,
              COUNT(*) FILTER (WHERE hard_cutover = true)::int AS hard_count,
              string_agg(DISTINCT method, ',') AS methods
            FROM sizing_decision_audits
            WHERE user_id = :uid AND created_at > NOW() - INTERVAL '7 days'`,
            { replacements: { uid: user_id } }
          )
          .then(r => (r[0] as any[])[0] as any)
          .catch(() => ({})),
        // Phase 4+ kill switch — 全局 (不分 user)
        sequelize
          .query(
            `SELECT
              COUNT(*) FILTER (WHERE edge_hypothesis ? 'kill_switch_metric')::int AS with_killswitch,
              COUNT(*) FILTER (WHERE enabled = false)::int AS disabled,
              COUNT(*)::int AS total
            FROM quant_strategies`
          )
          .then(r => (r[0] as any[])[0] as any)
          .catch(() => ({})),
        // Phase 5+ outcome — user 自己的 portfolio
        sequelize
          .query(
            `SELECT
              COUNT(*) FILTER (WHERE trade_status = 'closed')::int AS closed,
              COUNT(*) FILTER (WHERE trade_status = 'closed' AND root_cause IS NOT NULL)::int AS with_rc,
              COUNT(*) FILTER (WHERE trade_status = 'closed' AND metadata->'postmortem' IS NOT NULL)::int AS with_pm
            FROM recommendation_trade_outcomes
            WHERE portfolio_id IN (SELECT id FROM paper_trading_portfolios WHERE user_id = :uid)`,
            { replacements: { uid: user_id } }
          )
          .then(r => (r[0] as any[])[0] as any)
          .catch(() => ({})),
      ]);

      const closed = Number(outcomeRow.closed || 0);
      const wrc = Number(outcomeRow.with_rc || 0);

      return {
        sizing_7d_count: Number(sizingRow.recent_count || 0),
        sizing_7d_hard_count: Number(sizingRow.hard_count || 0),
        sizing_methods_active: sizingRow.methods || '—',
        strategies_disabled_count: Number(killRow.disabled || 0),
        strategies_with_killswitch: Number(killRow.with_killswitch || 0),
        strategies_total: Number(killRow.total || 0),
        outcomes_closed_count: closed,
        outcomes_with_root_cause: wrc,
        outcomes_with_postmortem: Number(outcomeRow.with_pm || 0),
        root_cause_coverage_pct: closed > 0 ? Math.round((wrc / closed) * 1000) / 10 : 0,
      };
    } catch (err: any) {
      logger.warn(`[morning-checkup] loadSystemHealthSnapshot failed: ${err?.message || err}`);
      return null;
    }
  }

  async upsertCheckup(input: {
    user_id: number;
    portfolio_id: number | null;
    date: string;
    positions_count: number;
    max_single_pct: number | null;
    max_single_symbol: string | null;
    max_industry_pct: number | null;
    max_industry_name: string | null;
    current_total_value: number | null;
    peak_value: number | null;
    drawdown_pct: number | null;
    weekly_return_pct: number | null;
    unresolved_alerts_count: number;
    breakdown: Record<string, unknown> | null;
    message: string;
    error: string | null;
  }): Promise<void> {
    const existing = await MorningRiskCheckup.findOne({
      where: { user_id: input.user_id, date: input.date },
    });
    if (existing) {
      existing.portfolio_id = input.portfolio_id;
      existing.positions_count = input.positions_count;
      existing.max_single_pct = input.max_single_pct;
      existing.max_single_symbol = input.max_single_symbol;
      existing.max_industry_pct = input.max_industry_pct;
      existing.max_industry_name = input.max_industry_name;
      existing.current_total_value = input.current_total_value;
      existing.peak_value = input.peak_value;
      existing.drawdown_pct = input.drawdown_pct;
      existing.weekly_return_pct = input.weekly_return_pct;
      existing.unresolved_alerts_count = input.unresolved_alerts_count;
      existing.breakdown = input.breakdown;
      existing.message = input.message;
      existing.error = input.error;
      // dispatch_status stays as-is on update — US-080 owns its lifecycle.
      await existing.save();
      return;
    }
    await MorningRiskCheckup.create({
      user_id: input.user_id,
      portfolio_id: input.portfolio_id,
      date: input.date,
      positions_count: input.positions_count,
      max_single_pct: input.max_single_pct,
      max_single_symbol: input.max_single_symbol,
      max_industry_pct: input.max_industry_pct,
      max_industry_name: input.max_industry_name,
      current_total_value: input.current_total_value,
      peak_value: input.peak_value,
      drawdown_pct: input.drawdown_pct,
      weekly_return_pct: input.weekly_return_pct,
      unresolved_alerts_count: input.unresolved_alerts_count,
      breakdown: input.breakdown,
      message: input.message,
      error: input.error,
      dispatch_status: 'pending',
    } as any);
  }

  async loadLatestCheckup(user_id: number): Promise<MorningRiskCheckup | null> {
    return await MorningRiskCheckup.findOne({
      where: { user_id },
      order: [['date', 'DESC']],
    });
  }

  async loadCheckupForDate(user_id: number, date: string): Promise<MorningRiskCheckup | null> {
    return await MorningRiskCheckup.findOne({ where: { user_id, date } });
  }
}

export const PRODUCTION_MORNING_RISK_CHECKUP_DATA_SOURCE: MorningRiskCheckupDataSource =
  new DefaultMorningRiskCheckupDataSource();

// ---------------------------------------------------------------------------
//  Service — public entry point
// ---------------------------------------------------------------------------

export interface RunMorningCheckupOptions {
  /** If set, only process this user. Otherwise scan all users with portfolios. */
  user_id?: number;
  /** Override the date (defaults to "today" local). */
  asOfDate?: Date;
  /** If true, do NOT persist rows (dry-run for UI dashboards / cron preview). */
  dry_run?: boolean;
}

export class MorningRiskCheckupService {
  private source: MorningRiskCheckupDataSource;

  constructor(source: MorningRiskCheckupDataSource = PRODUCTION_MORNING_RISK_CHECKUP_DATA_SOURCE) {
    this.source = source;
  }

  /**
   * 每天 8:30 触发批量评估所有用户的开盘前体检报告。
   *
   * - 单 user 失败 try/catch 隔离（同 US-047/US-048/US-049/US-051/US-052/US-053）；
   * - disabled 用户跳过整个评估（returns enabled=false 不写体检表）；
   * - dry_run=true 跳过 DB 写入但仍返回完整 checkup 结构（UI 预演用）；
   * - dispatch_status='pending' 在写入时设置 — US-080 推送通道上线后更新该字段；
   *
   * SchedulerService 用 task type 'PAPER_TRADING_MORNING_CHECKUP' cron 调用本方法。
   */
  async runMorningCheckup(
    options: RunMorningCheckupOptions = {}
  ): Promise<RunMorningCheckupResult> {
    const asOfDate = options.asOfDate ?? new Date();
    const dryRun = Boolean(options.dry_run);
    const userIds = options.user_id
      ? [options.user_id]
      : await this.source.loadAllUserIdsWithPortfolios();

    const result: RunMorningCheckupResult = {
      scanned_users: userIds.length,
      checked_users: 0,
      per_user: [],
      dry_run: dryRun,
    };

    for (const user_id of userIds) {
      try {
        const userResult = await this.checkupOneUser(user_id, asOfDate, dryRun);
        result.per_user.push(userResult);
        if (userResult.persisted || (dryRun && userResult.enabled)) {
          result.checked_users += 1;
        }
      } catch (err) {
        logger.warn(
          `MorningRiskCheckupService.runMorningCheckup user=${user_id} failed: ` +
            `${(err as Error).message}`
        );
        result.per_user.push({
          user_id,
          portfolio_id: null,
          date: asOfDate.toISOString().slice(0, 10),
          enabled: false,
          positions_count: 0,
          max_single_pct: null,
          max_single_symbol: null,
          max_industry_pct: null,
          max_industry_name: null,
          current_total_value: null,
          peak_value: null,
          drawdown_pct: null,
          weekly_return_pct: null,
          unresolved_alerts_count: 0,
          message: '',
          persisted: false,
          error: (err as Error).message,
        });
      }
    }

    return result;
  }

  /** Single-user checkup extracted for clarity. */
  private async checkupOneUser(
    user_id: number,
    asOfDate: Date,
    dryRun: boolean
  ): Promise<MorningRiskCheckupResult> {
    const date = asOfDate.toISOString().slice(0, 10);
    const config = await this.source.loadConfig(user_id);
    const header = await this.source.loadPortfolioHeader(user_id);
    if (!header) {
      return {
        user_id,
        portfolio_id: null,
        date,
        enabled: config.enabled,
        positions_count: 0,
        max_single_pct: null,
        max_single_symbol: null,
        max_industry_pct: null,
        max_industry_name: null,
        current_total_value: null,
        peak_value: null,
        drawdown_pct: null,
        weekly_return_pct: null,
        unresolved_alerts_count: 0,
        message: '',
        persisted: false,
      };
    }
    if (!config.enabled) {
      return {
        user_id,
        portfolio_id: header.id,
        date,
        enabled: false,
        positions_count: 0,
        max_single_pct: null,
        max_single_symbol: null,
        max_industry_pct: null,
        max_industry_name: null,
        current_total_value: header.total_value,
        peak_value: null,
        drawdown_pct: null,
        weekly_return_pct: null,
        unresolved_alerts_count: 0,
        message: '',
        persisted: false,
      };
    }

    // Pull the per-user inputs in parallel — each independent of the others.
    const [positions, snapshots, unresolved_alerts_count, system_health] = await Promise.all([
      this.source.loadOpenPositions(user_id),
      this.source.loadRecentSnapshots(header.id, asOfDate, config.drawdown_lookback_days),
      this.source.countUnresolvedAlerts(user_id),
      // Phase 2+/4+/5+ 系统健康并行拉，失败返回 null 不阻塞主流程
      this.source.loadSystemHealthSnapshot(user_id).catch(() => null),
    ]);

    const positions_count = positions.filter(p => p.quantity > 0).length;
    const singleStock = computeMaxSingleStockPct(positions);
    const industryTop = computeMaxIndustryPct(positions);
    const peak_value = computePeakValue(snapshots, header.total_value);
    const drawdown_raw = computeDrawdownPct(peak_value, header.total_value);
    // drawdown 0 with no snapshots and no positions usually means a brand-new account
    // — surface as null to avoid misleading "perfect health" badge in UI.
    const drawdown_pct = peak_value > 0 ? drawdown_raw : null;
    const weekly_return_pct = computeWeeklyReturnPct(
      snapshots,
      header.total_value,
      asOfDate,
      config.weekly_lookback_days
    );

    // Build breakdown (top 3 positions / top 3 industries) for message + storage.
    const top_positions = buildTopPositions(positions, 3);
    const top_industries = buildTopIndustries(positions, 3);

    const message = buildCheckupMessage({
      date,
      positions_count,
      max_single_pct: singleStock?.pct ?? null,
      max_single_symbol: singleStock?.symbol ?? null,
      max_industry_pct: industryTop?.pct ?? null,
      max_industry_name: industryTop?.industry ?? null,
      drawdown_pct,
      weekly_return_pct,
      unresolved_alerts_count,
      current_total_value: header.total_value,
      include_breakdown: config.include_breakdown_in_message,
      top_positions,
      top_industries,
      system_health, // Phase 2+/4+/5+ — 整合 sizing/kill/outcome 体检
    });

    const breakdown = {
      top_positions,
      top_industries,
      // Phase 2+/4+/5+ 系统健康嵌入 breakdown JSONB (不动 SQL schema)
      system_health,
    };

    const checkup: MorningRiskCheckupResult = {
      user_id,
      portfolio_id: header.id,
      date,
      enabled: true,
      positions_count,
      max_single_pct: singleStock?.pct ?? null,
      max_single_symbol: singleStock?.symbol ?? null,
      max_industry_pct: industryTop?.pct ?? null,
      max_industry_name: industryTop?.industry ?? null,
      current_total_value: header.total_value,
      peak_value: peak_value > 0 ? peak_value : null,
      drawdown_pct,
      weekly_return_pct,
      unresolved_alerts_count,
      message,
      breakdown,
      persisted: false,
    };

    if (!dryRun) {
      try {
        await this.source.upsertCheckup({
          user_id,
          portfolio_id: header.id,
          date,
          positions_count,
          max_single_pct: checkup.max_single_pct,
          max_single_symbol: checkup.max_single_symbol,
          max_industry_pct: checkup.max_industry_pct,
          max_industry_name: checkup.max_industry_name,
          current_total_value: checkup.current_total_value,
          peak_value: checkup.peak_value,
          drawdown_pct: checkup.drawdown_pct,
          weekly_return_pct: checkup.weekly_return_pct,
          unresolved_alerts_count,
          breakdown,
          message,
          error: null,
        });
        checkup.persisted = true;
      } catch (err) {
        // Persistence failure is logged but does NOT mask the in-memory result —
        // caller still receives a complete checkup (parity with US-052 writeAlert
        // try/catch fail-OPEN). UI consumer of `runMorningCheckup` sees the data
        // even when DB is briefly down.
        logger.warn(
          `MorningRiskCheckupService.upsertCheckup user=${user_id}: ${(err as Error).message}`
        );
        checkup.error = (err as Error).message;
      }
    }

    return checkup;
  }

  /** Return the user's effective config (defaults if not customized). */
  async getConfig(user_id: number): Promise<MorningRiskCheckupConfig> {
    return this.source.loadConfig(user_id);
  }

  /** Persist a (normalized) updated config for the user. */
  async updateConfig(user_id: number, raw: any): Promise<MorningRiskCheckupConfig> {
    const normalized = normalizeMorningRiskCheckupConfig(raw);
    return this.source.saveConfig(user_id, normalized);
  }

  /**
   * UI-facing today endpoint: returns the latest checkup row for the user.
   *
   * - If a row exists for today, return it (UPSERT semantics — overwritten if
   *   admin re-ran the morning task);
   * - If no row exists for today (cron hasn't fired yet / new user / disabled),
   *   return the latest row regardless of date (UI can decide whether to render
   *   stale or "not yet computed");
   * - Returns null when the user has never had a checkup.
   */
  async getTodayCheckup(user_id: number): Promise<MorningRiskCheckup | null> {
    const today = new Date().toISOString().slice(0, 10);
    const todayRow = await this.source.loadCheckupForDate(user_id, today);
    if (todayRow) return todayRow;
    return this.source.loadLatestCheckup(user_id);
  }
}

/**
 * Top-N positions by market-value pct (helper exported for unit tests).
 * Returns [] when no valid positions.
 */
export function buildTopPositions(
  positions: CheckupPositionSnapshot[],
  topN: number
): Array<{ symbol: string; pct: number }> {
  const valid = positions.filter(
    p =>
      Number.isFinite(p.quantity) &&
      p.quantity > 0 &&
      Number.isFinite(p.market_value) &&
      p.market_value > 0
  );
  if (valid.length === 0) return [];
  const total = valid.reduce((s, p) => s + p.market_value, 0);
  if (total <= 0) return [];
  const sorted = [...valid].sort((a, b) => {
    if (b.market_value !== a.market_value) return b.market_value - a.market_value;
    return (a.symbol || '').localeCompare(b.symbol || '');
  });
  return sorted.slice(0, Math.max(1, topN)).map(p => ({
    symbol: p.symbol,
    pct: p.market_value / total,
  }));
}

/**
 * Top-N industries by aggregated pct (helper exported for unit tests).
 * Returns [] when no positions.
 */
export function buildTopIndustries(
  positions: CheckupPositionSnapshot[],
  topN: number
): Array<{ industry: string; pct: number }> {
  const { breakdown } = aggregateByIndustry(positions);
  return breakdown.slice(0, Math.max(1, topN)).map(b => ({
    industry: b.industry,
    pct: b.pct,
  }));
}

/** Singleton — controllers / scheduler reach this instead of `new`-ing per call. */
export const morningRiskCheckupService = new MorningRiskCheckupService();

// Re-export the UNKNOWN_INDUSTRY_SENTINEL so tests can assert behavior without
// importing the US-052 module explicitly.
export { UNKNOWN_INDUSTRY_SENTINEL, normalizeIndustryName };
